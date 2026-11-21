# web-loop

A local workbench for finding and auditioning loop points in an audio file.

Vite + vanilla JS, Web Audio.

The browser decodes the file you choose and computes the waveform peaks locally.

## Requirements

- Node 20.19+ or 22.12+ (Vite 7).
- A browser with Web Audio and the File API; any format it can decode works.
- Your own audio file.

## Quick start

```bash
npm install
npm run dev        # http://127.0.0.1:5180
```

Click **load audio** or drop a file on the page. After the first decode the
waveform and loop controls are live; loading another file replaces the track.
Audio is decoded at runtime, so there is no asset build step.

## What it does

- **Waveform** with a bar grid. The detail view renders from the decoded
  `AudioBuffer`; the minimap uses browser-computed peaks. With a loop, the
  waveform is a blue→amber gradient from the in-marker to the out-marker, its
  amplitude follows the fade envelopes, and the other marker's post-roll or
  pre-roll waveform is projected where it will be heard.
- **Loop region** with draggable bar-snapped handles, click-to-seek and
  space to play/pause.
- **Edge envelopes** with four sliders (0–3000 ms), equal-power or linear. The
  left marker fades in over `in pre → in post`; the right marker fades out over
  `out pre → out post`. The period is the loop region itself: the post-roll
  after the end overlays the restarted head, and the pre-roll before the start
  overlays the loop tail at the end. The crossfade window is the union of the
  four windows around the seam; the body is the region trimmed by the larger
  window on each side. Zero lengths are hard edges, and the author owns the
  gain sum and any seam click. The readout reports the period, window, body and
  seam step.
- **Tempo**: starts at 120 BPM and is editable and persisted. **fit loop**
  recalibrates tempo and phase from onsets at both loop ends. Grid nudge
  (`−2♩ … +2♩`, ms) and free placement with `alt`-drag.
- **Playheads**: white for the main position; amber for the post-roll stream and
  blue for the pre-roll stream while overlaid. The fade panels and handles use
  the same left-blue / right-amber coding.
- Keyboard: `space` play/pause, `home` start, `[` / `]` nudge grid, `+` / `−` /
  `0` zoom, wheel zooms at the cursor, shift+wheel pans.

## Copying and loading a preset

**copy preset** puts the current configuration on the clipboard as JSON:

```json
{
  "format": "web-loop/preset",
  "version": 1,
  "track": "your-track.wav",
  "bpm": 120,
  "gridOffsetMs": 0,
  "loop": {
    "enabled": true,
    "start": 2.0,
    "end": 10.0,
    "inPreMs": 0,
    "inPostMs": 0,
    "outPreMs": 0,
    "outPostMs": 120,
    "curve": "equal-power"
  }
}
```

**load preset** opens a dialog where the same JSON can be pasted. It applies the
BPM, grid offset, loop region, four edge ranges, curve and loop toggle, then
rebakes. Invalid JSON leaves the current state untouched. The audio file is not
part of the preset.

BPM and grid offset are remembered in the browser under the `web-loop.bpm` and
`web-loop.gridOffsetMs` localStorage keys. They are not stored per file.
