---
name: electron-beautify
description: Beautify any Electron desktop app with a wallpaper layer and Material Design 3 (Monet) dynamic color, injected over the Chrome DevTools Protocol. Use when the user wants to set a background image in an Electron app, re-color its UI from a picture, or build such a tool. Works generically for any Electron app (ZCode, VS Code forks, chat clients, editors) — no app-specific plugin system required.
version: 0.2.0
---

# Electron Beautify over CDP

Wallpaper + Monet dynamic color for **any Electron desktop app**, without touching
its installation files. This skill distills a production-proven implementation
into the minimum viable path: spawn the app with a debug port, connect over the
Chrome DevTools Protocol (CDP), and inject a self-contained bootstrap script.

**Deliverable mindset**: you are building a small local tool (one folder, two npm
deps, a few hundred lines), not a plugin. Do not install anything into the target
app. Everything is injected at runtime.

## First: is this the right package?

This repository ships **two different things**. Do not confuse them:

| | **Plugin package** (`INSTALL-FOR-AI.md`) | **Skill pack** (you are here) |
|---|---|---|
| Target | The user's **ZCode desktop client** | **Any** Electron app |
| Your role | **Installer** — set up a ready-made plugin | **Developer** — build the tool yourself |
| User says | "Install this beautify plugin in my ZCode" | "Build wallpaper/color beautification for my XX app" |
| Result | Working `/beautify` command + MCP tools in ZCode | A new local tool the user runs themselves |

If the user only wants their **ZCode** beautified with zero development →
install the plugin instead: read `INSTALL-FOR-AI.md` at the repository root
(<https://github.com/Logocceai/zcode-beautify>). Otherwise continue below.

**If the user just handed you the repository link** for this skill: clone it
(`git clone https://github.com/Logocceai/zcode-beautify.git`), work inside
`skill-pack/` (this file and `references/`), and follow the workflow.

## Prerequisites

- Node.js ≥ 20 (global `fetch` + `WebSocket`; on Node < 22 install `ws` and swap the WebSocket constructor).
- The target Electron app's executable path.
- `npm i jimp @material/material-color-utilities` in your working folder (decode + MD3 color).

## Architecture (5 moving parts)

```
┌────────────┐  spawn --remote-debugging-port   ┌──────────────┐
│ launcher   │ ───────────────────────────────▶ │ Electron app │
└────────────┘                                  └──────┬───────┘
┌────────────┐     GET /json/list → pick page          │ HTTP
│ cdp client │ ◀────────────────────────────────────── ┘
│ (WebSocket)│  Page.addScriptToEvaluateOnNewDocument + Runtime.evaluate
└─────┬──────┘
      │ injects
┌─────▼───────────────────────────────────────┐
│ bootstrap in renderer:                      │
│  wallpaper layer + dim overlay + token CSS  │
│  (+ optional settings panel + localStorage) │
└─────────────────────────────────────────────┘
┌────────────┐   optional: localhost API for live tuning
│ live API   │ ◀── settings panel inside the app
└────────────┘
```

| File in `references/` | Role |
|---|---|
| `cdp-minimal.mjs` | Zero-dep CDP client: launch+wait, list targets, connect, evaluate, persistent injection |
| `monet-color.mjs` | MD3 source color from an image + light/dark token CSS generation |
| `inject-bootstrap.js` | The script injected into the renderer (wallpaper layer, dim, tokens, idempotent, self-healing) |
| `token-mapping.md` | How to discover and map the target app's CSS variables |
| `live-api.mjs` | Minimal localhost API so an in-app panel can tune blur/dim live |

## Workflow

### Step 0 — Recon the target app

1. Find the executable (Windows: `%LOCALAPPDATA%\Programs\<App>\<App>.exe` or `Program Files`; macOS: `/Applications/<App>.app/Contents/MacOS/<App>`).
2. Ask the user to fully quit the app first (see the single-instance trap below).
3. Optional recon: open the app's DevTools once to identify its styling system
   (Tailwind v4 apps expose `--color-*` variables on `:root` and `.dark` — see
   `token-mapping.md`).

### Step 1 — Launch with the debug port

```js
import { launchAndWait } from './references/cdp-minimal.mjs';
await launchAndWait('C:/Program Files/<App>/<App>.exe', 9223);
```

**Trap — single-instance lock (do not skip this).** Electron apps usually
enforce one instance. If an instance is already running, the newly spawned
process forwards its args to the old one and exits — but it binds the CDP port
*briefly* on the way out. A naive "poll until port is up" check will report
success and then lose the port milliseconds later. Guard both ways:

- before spawning, check for a running process (`tasklist /FI "IMAGENAME eq <App>.exe"` on Windows, `pgrep -x <App>` elsewhere) and refuse with a clear message if found;
- after the port answers, wait ~2 s and check it *again* before declaring success.

**Trap — other flags.** Pass only `--remote-debugging-port=<port>`. Some apps
need their default flags preserved; when in doubt, read the app's shortcuts.

### Step 2 — Connect and pick the renderer

```js
import { listTargets, pickRenderer, connect, send } from './references/cdp-minimal.mjs';
const target = pickRenderer(await listTargets(9223)); // type=page, has webSocketDebuggerUrl, not devtools
const ws = await connect(target.webSocketDebuggerUrl);
```

### Step 3 — Inject the bootstrap

Build the CSS (wallpaper layer + token overrides) with `monet-color.mjs`, wrap it
in the bootstrap template from `inject-bootstrap.js`, then:

```js
await send(ws, 'Page.enable');
await send(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: bootstrap }); // survives reloads…
await evaluate(ws, bootstrap);                                                  // …and apply right now
```

**Trap — session lifetime.** `addScriptToEvaluateOnNewDocument` registrations die
with the WebSocket session. If you close the connection, the script will NOT
re-run on reload. Either keep the socket open for the tool's lifetime (see
`live-api.mjs`), or re-inject on a poll loop.

### Step 4 — Wallpaper + colors

- Wallpaper layer: `position: fixed; inset: 0; z-index: -2147483646;`
  `pointer-events: none; background-size: cover;` — put the image as a data URI
  on `background-image`. With blur > 0 add `filter: blur(Npx)` and
  `transform: scale(1.04)` to hide blurred edges.
- Dim overlay: a `::after` on the wallpaper layer using
  `rgb(0 0 0 / var(--beautify-dim))` so the panel can tune it live via one
  CSS variable.
- Colors: `monet-color.mjs` extracts the source color (Celebi quantization +
  MD3 scoring) and emits two override blocks (`:root,:host{}` light, `.dark{}`
  dark) so the app's own dark-mode toggle keeps working. Surfaces get alpha
  (panel ≈ 0.62, popover ≈ 0.92) so the wallpaper shows through; window
  background goes `transparent`.
- Keep functional colors (success/warning/destructive) untouched.

### Step 5 — Keep it alive

Two complementary mechanisms, in increasing strength:

1. **localStorage self-heal** (in the bootstrap): save the CSS + wallpaper data
   URI; the `SELF_HEAL` snippet in `inject-bootstrap.js` restores them if the
   style element disappears. Best-effort — big wallpapers can exceed the
   localStorage quota, so wrap in try/catch and store at least the CSS.
2. **Persistent sessions**: keep one WebSocket per renderer open with the
   bootstrap registered; poll `/json/list` every ~1.5 s for new renderer targets
   (app restarts, new windows) and inject those too. This is what makes the
   theme survive app restarts *while the tool runs*.

Without either, the theme is wiped on every app restart (CDP injection is
session-scoped) — warn the user about this.

### Step 6 — Live tuning panel (optional but recommended)

Start a localhost-only HTTP API (`live-api.mjs`, bind `127.0.0.1`, CORS
`*` because the app's renderer origin is not localhost) exposing:

- `GET /api/config` — current blur/dim/… (the panel bootstraps its controls from this)
- `POST /api/config` — merge patch, save to a JSON config file, re-inject
- `POST /api/wallpaper` — replace the image (base64 data URI, cap at ~20 MB)
- `POST /api/reset` — clear overrides (backs up the config so nothing is lost)
- `POST /api/restore` — bring the wallpaper back from the backup, no re-import

Then inject a small draggable panel (sliders for blur/dim, toggles, file input)
into the renderer; it previews locally by editing the wallpaper element's
inline styles, and debounce-POSTs (~300 ms) to the API. Cache the decoded image
+ theme in the API process, or every slider tick will re-decode a multi-MP image.

## Acceptance checklist

- [ ] App launches with the debug port; an already-running instance is detected and reported, not raced.
- [ ] `/json/list` reachable; renderer target picked (page type, no devtools URLs).
- [ ] Wallpaper visible behind the UI; UI surfaces translucent; text still readable.
- [ ] Dark-mode toggle still works (both `:root` and `.dark` blocks injected).
- [ ] Reload keeps the theme (addScriptToEvaluateOnNewDocument with a held-open session).
- [ ] App restart re-injects automatically while the tool runs.
- [ ] Uninstall = close the tool + run the reset script; the app's files were never touched.

## Pitfall list (each one bit a real implementation)

1. **Single-instance race** — fake "launched successfully" from a dying second process. Check first, re-check after.
2. **Registration dies with the session** — close the socket and reload wipes the theme.
3. **z-index wars** — wallpaper must be behind everything (`-2147483646`), any injected panel in front of everything (`2147483647`); both `pointer-events: none` except interactive elements.
4. **Blur edges** — blur samples beyond the layer edge look washed; `scale(1.04)` fixes it.
5. **Tailwind v4 apps** define tokens on `:root` AND `.dark` — override both or dark mode breaks.
6. **localStorage quota** — a 2560px JPEG data URI can exceed ~5 MB; try/catch, prefer CSS-only fallback.
7. **CORS** — the renderer origin (often `file://` or an `app://`-style scheme) needs `Access-Control-Allow-Origin: *` on the localhost API.
8. **PowerShell `<`** — `apply < "C:\path"` is a parse error; always quote paths as plain arguments.
9. **Big images** — downscale to ≤ 2560px long side before extracting colors and embedding (speed + memory).
10. **data URI MIME** — re-encode to JPEG q≈82 regardless of source format; PNG screenshots can be 10× larger.
11. **The user WILL restart the app** — CDP injection is session-scoped, so without a kept-alive tool the theme vanishes on restart and users report "it stopped working". Persist the fix into the app's shortcuts: append `--remote-debugging-port=<port>` to the target's arguments (Windows: edit the `.lnk` `Arguments` via WScript.Shell; the all-users Start Menu copy needs elevation, a Desktop shortcut does not). Pair with `serve`/watch so re-injection is automatic.
12. **A panel that renders plausible defaults is a lie, not a state** — a `fetch`-driven panel whose request never resolves keeps its static markup on screen: `0px`, `0%`, unchecked toggles. The user reads that as "my settings were reset", not "the service is dead". Ship an explicit offline state (zero the controls, dim the body, show the fix command) and re-check on a heartbeat while the panel is open so it self-heals. Never let a value-less `<input type="range">` stand in for real data — it defaults to the *midpoint* of min/max, which draws a slider at half travel next to a `0` label.
13. **A background-service lifecycle is part of the design** — a `serve`-style helper started as a child of a terminal or an agent session is reaped with it: no stderr, no stack trace, a clean stdout tail. Detach it (`spawn(process.execPath, argv, { detached: true, stdio: ["ignore", out, out] })` + `unref()`), then poll your own health endpoint to confirm it actually came up, since a detached spawn reports nothing. Refuse a duplicate start by probing that health endpoint first and naming the pid that owns the port.
14. **A CDP `Runtime.evaluate` that throws still "succeeds"** — a JS error inside the evaluated expression arrives in `exceptionDetails`, never as a protocol error, so your injection can report success while executing nothing. Check `msg.result.exceptionDetails` and fail loudly, or fingerprint the injected artifact (a version string, a sentinel element) and verify it is the build you think it is.

## Deliverable

A folder containing: this SKILL.md, `references/` (copy the files, adapt names),
the user's chosen wallpaper, and a README with run instructions. Version the
skill with the tool you build so they evolve together.
