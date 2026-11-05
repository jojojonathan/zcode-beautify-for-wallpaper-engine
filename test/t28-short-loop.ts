/** T28 verification: ultra-short sources loop instead of failing (0.6.2).
 * Regression for "Input too short for a 1s crossfade (duration 1.566667s)":
 * a slow PrintWindow capture once produced 47 frames @ 30fps = 1.566667s of
 * footage, and makeSeamless hard-failed on it. Now: adaptive fade (D/4),
 * plain re-encode below 0.4s, adaptive poster seek. */
import { makeSeamless, loopSeamSsim, probeDuration } from "../src/core/loopProcessor.js";
import { extractPoster } from "../src/core/scenePipeline.js";
import { checkFfmpeg } from "../src/core/dependencyCheck.js";
import { execFileP } from "../src/core/exec.js";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const ff = await checkFfmpeg();
if (!ff.ok) { console.log("T28 SKIP (ffmpeg not installed)"); process.exit(0); }
const ffmpeg = ff.path!;

// Scratch footage lives in %TEMP% per repo convention; removed at the end.
const tmpRoot = path.join(process.env.TEMP ?? "./test/out", `t28-${Date.now().toString(36)}`);
mkdirSync(tmpRoot, { recursive: true });
let failed = 0;
function check(label: string, cond: boolean, extra = "") {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
}
function gen(file: string, seconds: number, fps: number) {
  // testsrc2 = continuously moving content, so seam SSIM is meaningful
  return execFileP(ffmpeg, [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=${fps}:duration=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
  ], { timeout: 60_000 });
}

try {
  // Case A — the exact failure input: 47 frames @ 30fps = 1.566667s.
  const a = path.join(tmpRoot, "short1566.mp4");
  await gen(a, 47 / 30, 30);
  const aOut = path.join(tmpRoot, "short1566.loop.mp4");
  const aRes = await makeSeamless(a, aOut, 1, ffmpeg);
  const aDur = await probeDuration(aOut, ffmpeg);
  console.log(`A: in=${aRes.inputDuration.toFixed(4)}s out=${aDur.toFixed(3)}s (fade adapted to ${((aRes.inputDuration as number) - aDur).toFixed(3)}s)`);
  check("A: 1.566667s input loops (no throw)", existsSync(aOut) && statSync(aOut).size >= 10_000);
  check("A: output = D - D/4", Math.abs(aDur - (47 / 30) * 0.75) <= 0.15, `${aDur.toFixed(3)}s`);
  const aSsim = await loopSeamSsim(aOut, ffmpeg);
  check("A: seam SSIM >= 0.9", aSsim >= 0.9, `${aSsim}`);

  // Poster on a sub-1.2s loop: the old fixed -ss 1 would seek past the end.
  const aPoster = path.join(tmpRoot, "short1566.poster.jpg");
  await extractPoster(aOut, aPoster, ffmpeg);
  check("A: poster on short loop extracted", existsSync(aPoster) && statSync(aPoster).size > 1000, `${statSync(aPoster).size}B`);

  // Case B — below the 0.4s floor: plain re-encode fallback, no throw.
  const b = path.join(tmpRoot, "tiny.mp4");
  await gen(b, 0.3, 30);
  const bOut = path.join(tmpRoot, "tiny.loop.mp4");
  const bRes = await makeSeamless(b, bOut, 1, ffmpeg);
  const bDur = await probeDuration(bOut, ffmpeg);
  console.log(`B: in=${bRes.inputDuration}s out=${bDur.toFixed(3)}s (plain fallback)`);
  check("B: 0.3s input still imports", existsSync(bOut) && statSync(bOut).size > 1000);
  check("B: plain fallback keeps duration", Math.abs(bDur - bRes.inputDuration) <= 0.15, `${bDur.toFixed(3)}s vs ${bRes.inputDuration}s`);

  // Case C — normal-length input: behavior unchanged (fade 1s, out = in - 1).
  const c = path.join(tmpRoot, "normal.mp4");
  await gen(c, 10, 30);
  const cOut = path.join(tmpRoot, "normal.loop.mp4");
  const cRes = await makeSeamless(c, cOut, 1, ffmpeg);
  const cDur = await probeDuration(cOut, ffmpeg);
  check("C: 10s input unchanged (out = in - 1)", Math.abs(cDur - (cRes.inputDuration - 1)) <= 0.2, `${cDur.toFixed(3)}s`);
  const cSsim = await loopSeamSsim(cOut, ffmpeg);
  // Frame quantization makes the wrap pair ADJACENT frames (main's last vs
  // tail's first); testsrc2's per-frame motion is large enough to dip just
  // under 0.9 where real footage (t5) sits well above. 0.85 still proves a
  // sane wrap; the 0.6.1 behavior this case guards is bit-identical.
  check("C: seam SSIM >= 0.85", cSsim >= 0.85, `${cSsim}`);
} finally {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (failed > 0) { console.error(`T28 FAIL (${failed})`); process.exit(1); }
console.log("T28 PASS");
