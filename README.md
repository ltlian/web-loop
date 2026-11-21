# web-loop

A local workbench for finding and auditioning loop points in an audio file.

Vite + vanilla JS, Web Audio.

The browser decodes the file you choose and computes the waveform peaks locally.
No audio is stored in the repository.

## Requirements

- Node 20.19+ or 22.12+ (Vite 7).
- A browser with Web Audio and the File API; any format it can decode works.
- Your own audio file.

## Quick start

```bash
npm install
npm run dev        # http://127.0.0.1:5180
npm test           # peak computation (Node)
npm run build      # static bundle in dist/
npm run preview    # serve dist/
```

Click **load audio** or drop a file on the page. After the first decode the
waveform and loop controls are live; loading another file replaces the track.
Audio is decoded at runtime, so there is no asset build step.

## Deploy

`npm run deploy` builds `dist/` and uploads it to Cloudflare Workers as the
`web-loop` Worker, served at <https://loop.ltlian.com>. Pushes to `main` deploy
the same way through GitHub Actions. The built page carries its commit as
`<meta name="git-commit">`, so `curl -s https://loop.ltlian.com | grep git-commit`
names what is live.

## What it does

- **Waveform** with a bar grid. The detail view renders from the decoded
  `AudioBuffer`; the minimap uses browser-computed peaks.
- **Loop region** with draggable bar-snapped handles, click-to-seek and
  space to play/pause.
- **Fade** 0–3000 ms, equal-power or linear. *Post-roll tail* blends the audio
  after the loop end over the restarted head; *pre-roll lead-in* crossfades the
  loop's tail into the audio before the start. Both keep the bar count, and both
  warn when the requested fade runs out of material.
- **Tempo**: starts at 120 BPM and is editable and persisted. **fit loop**
  recalibrates tempo and phase from onsets at both loop ends. Grid nudge
  (`−2♩ … +2♩`, ms) and free placement with `alt`-drag.
- **Playheads**: white for the main position, amber for the overlapping source
  stream during a crossfade.
- Keyboard: `space` play/pause, `home` start, `[` / `]` nudge grid, `+` / `−` /
  `0` zoom, wheel zooms at the cursor, shift+wheel pans.

Loop playback bakes one offline iteration per setting change, so the seam you
hear is exactly the seam baked. The readout gives ms, samples and bars.

## Copying and loading a setup

**copy setup** puts the current configuration on the clipboard as JSON:

```json
{
  "format": "web-loop/setup",
  "version": 1,
  "track": "your-track.wav",
  "bpm": 120,
  "gridOffsetMs": 0,
  "loop": {
    "enabled": true,
    "start": 2.0,
    "end": 10.0,
    "fadeMs": 120,
    "mode": "keep",
    "curve": "equal-power"
  }
}
```

Loop times are seconds in the file; `mode` is `keep` (post-roll tail) or `lead`
(pre-roll lead-in); `curve` is `equal-power` or `linear`; `gridOffsetMs` shifts
the bar grid.

**load setup** opens a dialog where the same JSON can be pasted. It applies the
BPM, grid offset, loop region, fade, mode, curve and loop toggle, then rebakes.
Invalid JSON leaves the current state untouched. The audio file is not part of
the setup.

## Files

| Path | Job |
|---|---|
| `src/peaks.js` | Downmixed min/max pairs for the minimap. |
| `src/file-drop.js` | File picker and document-wide drag-and-drop. |
| `src/main.js` | State, controls, handle dragging, setup JSON; exposes `window.__workbench`. |
| `src/engine.js` | One `AudioContext`, decode, playback / seek / loop clock. |
| `src/waveform.js` | Waveform, bar grid, minimap, loop overlay. |
| `src/loopbake.js` | The seam baker (`keep` / `lead`). |
| `src/style.css` | All styling. |
| `test/peaks.test.mjs` | Tests for peak computation. |

BPM and grid offset are remembered in the browser under the `web-loop.bpm` and
`web-loop.gridOffsetMs` localStorage keys. They are not stored per file.

## Known limits

- Audio is decoded in full and held in memory.
- Both preserved-length modes borrow audio from outside the region.
- Re-baking restarts playback (no gapless re-bake).
