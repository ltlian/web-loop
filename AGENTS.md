# AGENTS.md (web-loop)

Browser loop workbench: a Vite + vanilla-JS page for finding bar-aligned loop
points in a track and hearing seam alternatives.

- `src/main.js` — state machine, controls, setup JSON; exposes `window.__workbench`.
- `src/peaks.js` — downmixed min/max buckets for the minimap.
- `src/loopbake.js` — seam baker; the `keep` and `lead` modes are the product.

## Conventions

- **No audio in the repo, by design.** The user loads a file at runtime.
- **One `AudioContext`, position from `ctx.currentTime`**, bake-then-play. Not
  `<audio>`; sample-accurate seams and bar-snapped cuts require decoded PCM.

## Deploy

- Worker `web-loop`, asset-only, serves `dist/` at <https://loop.ltlian.com>
  (custom domain in `wrangler.jsonc`). `npm run deploy` builds first through
  `build.command`; pushes to `main` deploy the same way in CI.
- The build stamps `<meta name="git-commit">` with `git rev-parse --short HEAD`
  from `vite.config.js`; read it back with
  `curl -s https://loop.ltlian.com | grep git-commit`.

