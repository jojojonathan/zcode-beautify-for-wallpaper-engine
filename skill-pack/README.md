# electron-beautify skill pack (v0.2.0)

A self-contained skill for AI coding agents: beautify **any Electron desktop
app** with a wallpaper layer and Material Design 3 (Monet) dynamic color over
the Chrome DevTools Protocol — no plugin system, no app modifications.

**Hand this folder — or just the repository link
<https://github.com/Logocceai/zcode-beautify> — to your AI** (Claude, DeepSeek,
Codex, Doubao, …) and ask it to follow `SKILL.md`.

> **Two packages live in this repo — pick the right one:**
>
> | | **Plugin package** (`INSTALL-FOR-AI.md`) | **Skill pack** (here) |
> |---|---|---|
> | Target | ZCode desktop client only | Any Electron app |
> | AI's role | Install the ready-made plugin | Build the tool from scratch |
> | Pick this when | "Just make my ZCode pretty" | "Beautify my XX app" / other AI platform |

## Contents

```
├─ SKILL.md                    # the skill: workflow, code, pitfalls, acceptance checklist
└─ references/
   ├─ cdp-minimal.mjs          # zero-dep CDP client (launch+wait, targets, inject)
   ├─ monet-color.mjs          # MD3 color extraction + light/dark token CSS
   ├─ inject-bootstrap.js      # renderer-side injection template (idempotent, self-healing)
   ├─ live-api.mjs             # localhost API + persistent sessions + in-app tuning
   └─ token-mapping.md         # one-time recon: find the app's CSS variables
```

## Requirements

- Node.js ≥ 20
- `npm i jimp @material/material-color-utilities` (color extraction only)
- The Electron app you want to beautify

## Quick check (with any running Electron app)

```bash
node --input-type=module -e "
import { listTargets, pickRenderer, connect, evaluate } from './references/cdp-minimal.mjs';
const t = pickRenderer(await listTargets(9223));
const ws = await connect(t.webSocketDebuggerUrl);
console.log(await evaluate(ws, 'navigator.userAgent'));
"
```

This repo's own `dist/cli.js` is the production-grade reference implementation
of exactly what this skill teaches; read `src/` alongside `SKILL.md` when in
doubt.

## License

MIT — same as the repository.
