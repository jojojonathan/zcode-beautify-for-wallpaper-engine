/**
 * Seamless-loop processing for scene wallpaper captures.
 *
 * Construction (mathematically seam-free, verified by SSIM first-vs-last
 * frame check in test/t5-verify.ts):
 *
 *   output = crossfade( tail=input[D-f..D] (head image fades IN over it)
 *                     , main=input[f..D-f] )
 *   total duration = D - f
 *
 * The fade f is normally the caller's fadeSec, but shrinks adaptively for
 * very short sources (f = D/4, 0.2s floor) and falls back to a plain
 * re-encode when even that fade doesn't fit (hard floor D > 0.2s) — see the
 * checks at the top of makeSeamless.
 *
 * Seams: output(0) is exactly input(D-f) (crossfade alpha 0), which equals
 * output(D-f) (main's last frame) -> the wrap is the same frame. At t=f the
 * crossfade ends on input(f), where main picks up. Every frame of the source
 * appears exactly once.
 *
 * Note: the originally specced chain ([b]trim=1 as base, fading head overlay
 * setpts-shifted to [D-1..D]) drops the overlay frames entirely — overlay
 * output ends with its main input, so frames past the main's end are never
 * composited. See docs/spike-notes.md.
 *
 * Audio is stripped (WE scenes may carry audio; a wallpaper must be silent)
 * and +faststart is applied for immediate playback when served over HTTP.
 *
 * Memory: the single-pass graph above parks the WHOLE main body in concat's
 * second-input queue (its first input only starts at D-f, so every [f..D-f]
 * frame decodes and buffers at SOURCE resolution before the first output
 * frame). A 60s 4K@72fps source needs ~50GB there — ENOMEM on any desktop.
 * Big inputs therefore stream through a two-pass build with identical output
 * layout (crossfade segment, then the body, concat-copied together); each
 * pass holds only a handful of frames regardless of resolution.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkFfmpeg } from "./dependencyCheck.js";
import { execFileP } from "./exec.js";

const exec = execFileP;

export class LoopError extends Error {}

/** Queued-frame budget the single-pass graph may hold (see header note). */
const SINGLE_PASS_BUDGET = 2 * 1024 ** 3;

export interface SeamlessOptions {
  /** Cut the source from startAt for `seconds` before looping (long inputs). */
  startAt?: number;
  seconds?: number;
  /** Downscale so width <= maxWidth (keeps aspect, even heights). Default no scaling. */
  maxWidth?: number;
}

export async function makeSeamless(
  input: string,
  output: string,
  fadeSec: number,
  ffmpegPath?: string,
  options: SeamlessOptions = {},
): Promise<{ inputDuration: number; outputDuration: number }> {
  const ffmpeg = ffmpegPath ?? (await checkFfmpeg()).path;
  if (!ffmpeg) throw new LoopError("ffmpeg not found — cannot process loop");

  const info = await probeVideoInfo(input, ffmpeg);
  const fullDuration = info?.duration ?? (await probeDuration(input, ffmpeg));
  if (!Number.isFinite(fullDuration) || fullDuration <= 0.2) {
    throw new LoopError(`Input too short to loop (duration ${fullDuration}s)`);
  }
  // Adaptive crossfade: the fade needs D > 2*fade (a tail AND a non-empty
  // body). A source shorter than the requested fade can still loop with a
  // proportionally shorter fade (fade = D/4 leaves a D/2 body; 0.2s floor).
  // Slow-capture scene records (see recorder.ts) used to die here with
  // "Input too short for a 1s crossfade"; tiny video wallpapers benefit too.
  let fade = fadeSec;
  if (fullDuration <= fade * 2 + 0.1) {
    fade = Math.max(0.2, fullDuration / 4);
  }
  // Long inputs are truncated to a middle segment before the crossfade; the
  // whole file would balloon the cache for minutes-long sources.
  const duration = Math.min(fullDuration, options.seconds ?? fullDuration);
  const startAt = Math.min(options.startAt ?? 0, fullDuration - duration);
  if (duration <= fade * 2 + 0.1) {
    if (fullDuration <= fade * 2 + 0.1) {
      // Even the 0.2s-floor fade doesn't fit: straight re-encode keeps the
      // import working — loop point not guaranteed seamless, still far
      // better than failing.
      await makeSeamlessPlain(input, output, ffmpeg, { maxWidth: options.maxWidth });
      const plainDuration = await probeDuration(output, ffmpeg);
      return { inputDuration: fullDuration, outputDuration: plainDuration };
    }
    throw new LoopError(`Truncated input too short for a ${fade}s crossfade (duration ${duration}s)`);
  }

  mkdirSync(path.dirname(path.resolve(output)), { recursive: true });

  // Peak bytes the single-pass concat queue would hold at source resolution.
  // Unknown probe data -> Infinity: fall to the two-pass build, never OOM.
  const mainSeconds = Math.max(0, duration - 2 * fade);
  const queueBytes = info
    ? info.fps * mainSeconds * info.width * info.height * 1.5
    : Infinity;
  if (queueBytes > SINGLE_PASS_BUDGET) {
    await makeSeamlessTwoPass(input, output, ffmpeg, {
      duration,
      startAt,
      fadeSec: fade,
      maxWidth: options.maxWidth,
    });
    const twoPassDuration = await probeDuration(output, ffmpeg);
    return { inputDuration: duration, outputDuration: twoPassDuration };
  }

  const tailStart = duration - fade;
  const mainEnd = duration - fade;
  const scale =
    options.maxWidth && options.maxWidth > 0
      ? `scale=w='min(${options.maxWidth}\\,iw)':h=-2,`
      : "";
  const filter = [
    `[0:v]split[base][src]`,
    // crossfade base: the source tail, head image fades in over it
    `[src]trim=start=${tailStart.toFixed(4)},setpts=PTS-STARTPTS[tail]`,
    `[base]trim=end=${fade.toFixed(4)},setpts=PTS-STARTPTS,format=yuva420p,fade=t=in:d=${fade.toFixed(4)}:alpha=1[head]`,
    `[tail][head]overlay=format=auto[xfade]`,
    // main body: the source between the crossfade end and the tail start
    `[base]trim=start=${fade.toFixed(4)}:end=${mainEnd.toFixed(4)},setpts=PTS-STARTPTS[main]`,
    `[xfade][main]concat=n=2:v=1:a=0[joined]`,
    `[joined]${scale}format=yuv420p[out]`,
  ].join(";");

  await exec(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "warning",
    // -ss/-t BEFORE -i: they must limit what the FILTERS see (an output-side
    // -t would cap the result while the trims ran on the whole stream).
    ...(options.startAt ? ["-ss", startAt.toFixed(3)] : []),
    ...(options.seconds ? ["-t", duration.toFixed(3)] : []),
    "-i", input,
    "-filter_complex", filter,
    "-map", "[out]",
    "-c:v", "libx264",
    "-crf", "18",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-an",
    output,
  ], { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });

  const outputDuration = await probeDuration(output, ffmpeg);
  return { inputDuration: duration, outputDuration };
}

/**
 * Two-pass build for sources too big for the single-pass graph: identical
 * output layout (crossfade segment + main body, concat'd), but each pass
 * streams frame-by-frame, so memory stays flat regardless of resolution.
 * Pass 1 renders only the fadeSec-long crossfade (source tail + fading head
 * via input-side -ss/-t, no trim queues); pass 2 re-encodes the body [f..D-f]
 * as a plain stream; pass 3 stream-copies both segments together.
 */
async function makeSeamlessTwoPass(
  input: string,
  output: string,
  ffmpeg: string,
  spec: { duration: number; startAt: number; fadeSec: number; maxWidth?: number },
): Promise<void> {
  const { duration, startAt, fadeSec, maxWidth } = spec;
  const tailStart = duration - fadeSec;
  const bodyDur = duration - 2 * fadeSec;
  const scale = maxWidth && maxWidth > 0 ? `scale=w='min(${maxWidth}\\,iw)':h=-2,` : "";
  const enc = ["-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an"];
  // Input-side seek+limit: -ss only when nonzero, -t always (matches what the
  // single-pass trims would have seen).
  const seek = (t: number, secs: number) => [
    ...(t > 0 ? ["-ss", t.toFixed(4)] : []),
    "-t", secs.toFixed(4),
  ];

  const seg1 = `${output}.seg1.mp4`;
  const seg2 = `${output}.seg2.mp4`;
  const list = `${output}.concat.txt`;
  try {
    await exec(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "warning",
      ...seek(startAt + tailStart, fadeSec), "-i", input,
      ...seek(startAt, fadeSec), "-i", input,
      "-filter_complex", [
        `[1:v]format=yuva420p,fade=t=in:d=${fadeSec.toFixed(4)}:alpha=1[head]`,
        `[0:v][head]overlay=format=auto[xf]`,
        `[xf]${scale}format=yuv420p[out]`,
      ].join(";"),
      "-map", "[out]",
      ...enc,
      seg1,
    ], { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });

    if (bodyDur >= 0.1) {
      await exec(ffmpeg, [
        "-y", "-hide_banner", "-loglevel", "warning",
        ...seek(startAt + fadeSec, bodyDur), "-i", input,
        "-vf", `${scale}format=yuv420p`,
        ...enc,
        seg2,
      ], { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
    }

    const esc = (p: string) => `'${p.replaceAll("'", "'\\''")}'`;
    const files = bodyDur >= 0.1 ? [seg1, seg2] : [seg1];
    writeFileSync(list, files.map((f) => `file ${esc(f)}\n`).join(""));
    await exec(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "warning",
      "-f", "concat", "-safe", "0", "-i", list,
      "-c", "copy", "-movflags", "+faststart",
      output,
    ], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  } finally {
    for (const f of [seg1, seg2, list]) {
      try { rmSync(f, { force: true }); } catch { /* best effort */ }
    }
  }
}

/**
 * Fallback for sources too short to hold even the 0.2s-floor crossfade:
 * plain re-encode with the usual normalization, loop point NOT guaranteed
 * seamless — keeps tiny clips importable instead of failing the whole job.
 */
async function makeSeamlessPlain(
  input: string,
  output: string,
  ffmpeg: string,
  spec: { maxWidth?: number },
): Promise<void> {
  const scale = spec.maxWidth && spec.maxWidth > 0 ? `scale=w='min(${spec.maxWidth}\\,iw)':h=-2,` : "";
  await exec(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "warning",
    "-i", input,
    "-vf", `${scale}format=yuv420p`,
    "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-an",
    output,
  ], { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
}

/** width/height/fps/duration via one ffprobe call; null when probing fails. */
async function probeVideoInfo(
  file: string,
  ffmpegPath: string,
): Promise<{ width: number; height: number; fps: number; duration: number } | null> {
  const ffprobe = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  try {
    const { stdout } = await exec(ffprobe, [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,r_frame_rate:format=duration",
      "-of", "json", file,
    ], { timeout: 30_000 });
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{ width?: number; height?: number; r_frame_rate?: string }>;
      format?: { duration?: string };
    };
    const s = parsed.streams?.[0];
    const duration = Number(parsed.format?.duration);
    if (!s?.width || !s.height || !s.r_frame_rate || !Number.isFinite(duration)) return null;
    const [n, d] = s.r_frame_rate.split("/").map(Number);
    const fps = d ? n / d : NaN;
    if (!Number.isFinite(fps) || fps <= 0) return null;
    return { width: s.width, height: s.height, fps, duration };
  } catch {
    return null;
  }
}

/** First-frame vs last-frame SSIM: ~1.0 proves the loop wraps on the same frame. */
export async function loopSeamSsim(file: string, ffmpegPath?: string): Promise<number> {
  const ffmpeg = ffmpegPath ?? (await checkFfmpeg()).path;
  if (!ffmpeg) throw new LoopError("ffmpeg not found");

  const tmpLast = `${file}.last.png`;
  const tmpFirst = `${file}.first.png`;
  try {
    await exec(ffmpeg, ["-y", "-loglevel", "error", "-i", file, "-frames:v", "1", "-update", "1", tmpFirst], { timeout: 30_000 });
    // -sseof grabs the very last frame regardless of container duration rounding.
    await exec(ffmpeg, ["-y", "-loglevel", "error", "-sseof", "-0.05", "-i", file, "-frames:v", "1", "-update", "1", tmpLast], { timeout: 30_000 });
    const { stderr } = await exec(ffmpeg, [
      "-hide_banner", "-loglevel", "info",
      "-i", tmpFirst, "-i", tmpLast,
      "-filter_complex", "ssim", "-f", "null", "-",
    ], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    const m = /All:(\d+\.?\d*)/.exec(stderr);
    return m ? Number(m[1]) : -1;
  } finally {
    for (const f of [tmpLast, tmpFirst]) {
      try { await exec("cmd", ["/c", "del", "/q", path.resolve(f)], { timeout: 5000 }); } catch { /* temp file */ }
    }
  }
}

/** Container duration in seconds (ffprobe with an ffmpeg -i fallback). */
export async function probeDuration(file: string, ffmpegPath: string): Promise<number> {
  // ffprobe ships next to ffmpeg in standard distributions; fall back to ffmpeg -i.
  const ffprobe = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  try {
    const { stdout } = await exec(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { timeout: 30_000 });
    return Number(stdout.trim());
  } catch {
    const { stderr } = await exec(ffmpegPath, ["-hide_banner", "-i", file, "-f", "null", "-"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number.NaN;
  }
}
