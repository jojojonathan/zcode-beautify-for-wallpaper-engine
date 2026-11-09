# Mapping the target app's CSS variables

The injection only recolors an app if you override the variables it *actually
styles with*. This is a one-time recon per app; the rest of the skill is
app-agnostic.

## How to discover the tokens (10 minutes)

1. Launch the app with the debug port (`cdp-minimal.mjs`) and attach DevTools:
   open `http://127.0.0.1:9223/json/list`, copy the page target's
   `webSocketDebuggerUrl` into a WebSocket client, then
   `Runtime.evaluate('window.location.href')` — or simply open
   `chrome://inspect` in a regular Chrome and connect to the port. Some Electron
   builds also respond to the app's built-in devtools shortcut.
2. In the Elements panel, select the body/root and inspect **Computed styles**
   filtered to `--`: Electron UIs built on Tailwind v4 (and many hand-rolled
   design systems) declare semantic variables like `--color-background`,
   `--color-panel`, `--color-primary` on `:root` and override them in `.dark`.
3. Note **which block defines them** (`:root`, `.dark`, `.dark-theme`,
   `[data-theme]`) — your override CSS must target the same selectors, twice
   (light + dark), or the app's theme switch will fight you.
4. Grep the app's `resources/app.asar` unpacked styles (or toggle dark mode and
   diff computed variables) as a fallback.

## Mapping rules that worked in production

- **Window/page backgrounds → `transparent`** so the wallpaper layer shows.
- **Panel/surface/sidebar/card/input tokens → MD3 neutral tones with alpha**
  (panel ≈ 0.62, surface ≈ 0.72, popover ≈ 0.92, input ≈ 0.5). Alpha keeps the
  wallpaper visible while text stays readable; with the wallpaper hidden use
  alpha = 1.
- **Foreground/primary/accent tokens → MD3 scheme roles** (`onSurface`,
  `primary`, `onPrimary`, `tertiary`, `outlineVariant`, …). Don't touch
  functional colors (success/warning/destructive) — red error text must stay red.
- **When the app has no token system** (hard-coded colors), fall back to a
  generic filter-based recolor of `body` (e.g. `filter: hue-rotate()`) or
  accept wallpaper-only beautification. CSS variable discovery is the
  high-value path; skip it rather than guessing.
- **Dark scheme surfaceContainer tones** are missing from
  material-color-utilities 0.3.0 schemes; derive them from the neutral tonal
  palette at the official MD3 tones — light `100/96/94/92/90`, dark
  `4/10/12/17/22` (see `monet-color.mjs`).

## Verifying the mapping

Inject the generated CSS, then toggle the app between light and dark: both
schemes must change, text must stay readable over the wallpaper, and the dim
slider (`--beautify-dim`) must visibly darken the wallpaper only.
