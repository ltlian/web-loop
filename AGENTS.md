# AGENTS.md (web-loop)

Browser loop workbench: a Vite + vanilla-JS page for finding bar-aligned loop
points in a track and hearing seam alternatives.

- `src/main.js` — state machine, controls; exposes `window.__workbench`.
- `src/preset.js` — preset JSON emitter; schema lives in `public/preset.schema.json`.
- `src/beats.js` — onset envelope, tempo, beat grid and downbeat; pure functions.
- `src/beats.worker.js` — runs `beats.js` off the main thread.
- `src/waveform.js` — gradient detail waveform + projected cross-source + overlay.
- `src/peaks.js` — downmixed min/max buckets for the minimap.
- `src/loopbake.js` — seam baker.

## Conventions

- **No audio in the repo, by design.** The user loads a file at runtime.
- **One `AudioContext`, position from `ctx.currentTime`**, bake-then-play. Not
  `<audio>`; sample-accurate seams and bar-snapped cuts require decoded PCM.

## Deploy

- Worker `web-loop`, asset-only, serves `dist/` at <https://loop.ltlian.com>
  (custom domain in `wrangler.jsonc`). `npm run deploy` builds first through
  `build.command`; pushes to `main` deploy the same way in CI.
