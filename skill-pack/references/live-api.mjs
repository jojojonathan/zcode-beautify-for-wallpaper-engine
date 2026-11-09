// Live-tuning server for the injected beautify theme.
//
//   node live-api.mjs <target-exe-or-skip>  — or import { startServe } and call it.
//
// Responsibilities (all distilled from a working tool):
//   - localhost-only HTTP API (CORS open: the renderer origin is not localhost)
//   - persistent CDP sessions so addScriptToEvaluateOnNewDocument survives reloads
//   - poll for new renderer targets (app restart / new windows) and inject them
//   - in-memory theme cache so slider ticks do not re-decode the image
//
// The injected settings panel (or any local UI) calls the endpoints below.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { listTargets, pickRenderer, connect, send, evaluate } from "./cdp-minimal.mjs";
import { extractTheme, buildTokenCss } from "./monet-color.mjs";

const CDP_PORT = Number(process.env.BEAUTIFY_CDP_PORT ?? 9223);
const API_PORT = Number(process.env.BEAUTIFY_API_PORT ?? 9224);
const MARKER = "beautify";
const CONFIG_FILE = path.join(process.cwd(), "beautify.config.json");

// --- state -------------------------------------------------------------------

let themeCache = null; // { file, mtimeMs, theme, dataUri }
const sessions = new Map(); // targetId -> WebSocket (kept OPEN on purpose)
const defaults = { blur: 0, dim: 25, wallpaperVisible: true };

function loadConfig() {
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
  } catch {
    return { ...defaults };
  }
}
const saveConfig = (config) =>
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

async function getWallpaper(config) {
  if (!config.wallpaper || !fs.existsSync(config.wallpaper)) return null;
  const mtimeMs = fs.statSync(config.wallpaper).mtimeMs;
  if (themeCache?.file === config.wallpaper && themeCache.mtimeMs === mtimeMs) return themeCache;
  const extracted = await extractTheme(config.wallpaper);
  themeCache = { file: config.wallpaper, mtimeMs, ...extracted };
  return themeCache;
}

// --- bootstrap assembly --------------------------------------------------------

function buildBootstrap(config, themeCacheEntry) {
  const cssParts = [wallpaperLayerCss(config)];
  if (themeCacheEntry) {
    cssParts.push(buildTokenCss(themeCacheEntry.theme, {
      wallpaperVisible: config.wallpaperVisible,
      dim: config.dim,
    }));
  }
  // Fill the template from inject-bootstrap.js (JSON.stringify → safe literals).
  const template = fs.readFileSync(new URL("./inject-bootstrap.js", import.meta.url), "utf8");
  const match = template.match(/var BOOTSTRAP = `([\s\S]*?)`;/);
  if (!match) throw new Error("inject-bootstrap.js: BOOTSTRAP template not found");
  return match[1]
    .replace("__MARKER__", JSON.stringify(MARKER))
    .replace("__CSS__", JSON.stringify(cssParts.join("\n")))
    .replace("__DATA_URI__", JSON.stringify(config.wallpaperVisible ? themeCacheEntry?.dataUri ?? "" : ""));
}

function wallpaperLayerCss(config) {
  return `html, body { background: transparent !important; }
#${MARKER}-wallpaper {
  position: fixed; inset: 0; z-index: -2147483646;
  background-size: cover; background-position: center; background-repeat: no-repeat;
  pointer-events: none;
  filter: blur(${config.blur}px);
  transform: scale(${config.blur > 0 ? 1.04 : 1});
}
#${MARKER}-wallpaper::after {
  content: ''; position: absolute; inset: 0;
  background: rgb(0 0 0 / var(--beautify-dim, ${config.dim / 100}));
}`;
}

// --- injection sessions ---------------------------------------------------------

async function pushToSessions(config) {
  const bootstrap = buildBootstrap(config, await getWallpaper(config));
  let ok = 0;
  for (const [id, ws] of sessions) {
    try {
      await evaluate(ws, bootstrap); // idempotent; the reload-registration is already in place
      ok++;
    } catch {
      try { ws.close(); } catch {}
      sessions.delete(id);
    }
  }
  return ok;
}

async function poll(config) {
  try {
    const targets = (await listTargets(CDP_PORT)).filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
    for (const target of targets) {
      if (!sessions.has(target.id)) {
        try {
          const bootstrap = buildBootstrap(config, await getWallpaper(config));
          const ws = await connect(target.webSocketDebuggerUrl);
          await send(ws, "Page.enable");
          await send(ws, "Page.addScriptToEvaluateOnNewDocument", { source: bootstrap });
          await evaluate(ws, bootstrap);
          sessions.set(target.id, ws);
          console.log(`injected into ${target.url.slice(0, 60)}`);
        } catch { /* retry next tick */ }
      }
    }
    for (const id of [...sessions.keys()]) {
      if (!targets.some((t) => t.id === id)) {
        try { sessions.get(id).close(); } catch {}
        sessions.delete(id);
      }
    }
  } catch { /* app not running */ }
}

// --- HTTP API -------------------------------------------------------------------

function json(res, code, body) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(body));
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 21 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

export async function startServe() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "OPTIONS") return json(res, 204, {});
      if (req.method === "GET" && url.pathname === "/api/config") return json(res, 200, loadConfig());

      if (req.method === "POST" && url.pathname === "/api/config") {
        const patch = JSON.parse(await readBody(req));
        const config = { ...loadConfig(), ...patch };
        saveConfig(config);
        return json(res, 200, { ok: true, windows: await pushToSessions(config), ...config });
      }

      if (req.method === "POST" && url.pathname === "/api/wallpaper") {
        const body = JSON.parse(await readBody(req));
        const m = /^data:image\/(?:jpeg|png|webp|gif|bmp);base64,(.+)$/.exec(body.dataUri ?? "");
        if (!m) throw new Error("dataUri must be a base64 image data URI");
        const bytes = Buffer.from(m[1], "base64");
        if (bytes.length > 20 * 1024 * 1024) throw new Error("image too large (max 20 MB)");
        const config = loadConfig();
        const dest = path.join(path.dirname(CONFIG_FILE), "wallpaper" + ".jpg");
        fs.writeFileSync(dest, bytes);
        themeCache = { file: dest, mtimeMs: fs.statSync(dest).mtimeMs, ...(await extractTheme(dest)) };
        config.wallpaper = dest;
        saveConfig(config);
        return json(res, 200, { ok: true, windows: await pushToSessions(config), ...config });
      }

      if (req.method === "POST" && url.pathname === "/api/reset") {
        const config = loadConfig();
        // Back up before clearing so /api/restore can bring it back without re-importing.
        if (config.wallpaper) fs.copyFileSync(CONFIG_FILE, CONFIG_FILE + ".backup");
        delete config.wallpaper;
        saveConfig(config);
        themeCache = null;
        const reset = `(function(){
          document.getElementById('${MARKER}-style')?.remove();
          document.getElementById('${MARKER}-wallpaper')?.remove();
          if (window.__beautify) window.__beautify.cssText = null;
        })();`;
        for (const ws of sessions.values()) await evaluate(ws, reset).catch(() => {});
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/restore") {
        try {
          fs.accessSync(CONFIG_FILE + ".backup");
        } catch {
          throw new Error("no wallpaper backup available");
        }
        fs.copyFileSync(CONFIG_FILE + ".backup", CONFIG_FILE);
        const config = loadConfig();
        themeCache = null;
        return json(res, 200, { ok: true, windows: await pushToSessions(config), ...config });
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 400, { error: String(err.message ?? err) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(API_PORT, "127.0.0.1", resolve);
  });
  console.log(`live API on http://127.0.0.1:${API_PORT} — Ctrl+C to stop`);

  await poll(loadConfig());
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    await poll(loadConfig());
  }
}

// CLI entry: `node live-api.mjs`
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  startServe().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
