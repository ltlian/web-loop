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

Click **load audio** or drop a file on the page. It is decoded, and the tempo is
measured off the main thread. When the measurement lands the app arms a four-bar
loop on the first bar line and zooms to it, so pressing play immediately shows
what the tool is for — and whether the bar lines are right. Loading another file
replaces the track. Audio is decoded at runtime, so there is no asset build step.

The transport and the panel stay inert until the measurement lands — first there
is no track, then the grid is still being measured. In between, a veiled
*measuring tempo…* shimmer sits over the decoded waveform, and the header reports
the file's duration rather than a tempo it has not measured yet.

## What it does

- **Waveform** with a bar grid. The detail view renders from the decoded
  `AudioBuffer`; the minimap uses browser-computed peaks. With a loop, the
  waveform is a blue→amber gradient from the in-marker to the out-marker, its
  amplitude follows the fade envelopes, and the other marker's post-roll or
  pre-roll waveform is projected where it will be heard. With the loop off, the
  region still shows as a dim band, so the toggle has a visible subject.
- **Loop region** with draggable bar-snapped handles, click-to-seek and
  space to play/pause. A four-bar region is armed automatically from the first
  bar line, with a short 10 ms seam fade so a bar cut a few milliseconds into an
  attack does not click; drag the handles or the fades to taste. Grab a handle
  and hold `ctrl` (or `alt`) while dragging to place it off the bar grid, in
  1 ms steps.
- **Edge envelopes** with four sliders (0–3000 ms), equal-power or linear. The
  left marker fades in over `in pre → in post`; the right marker fades out over
  `out pre → out post`. The period is the loop region itself: the post-roll
  after the end overlays the restarted head, and the pre-roll before the start
  overlays the loop tail at the end. The crossfade window is the union of the
  four windows around the seam; the body is the region trimmed by the larger
  window on each side. Zero lengths are hard edges, and the author owns the
  gain sum and any seam click. The readout under the panel reports the loop in
  bars and seconds; the full period, window, body and seam numbers are in its
  tooltip, and clipped windows or an audible seam are called out inline.
- **Tempo**: measured from the audio on load, off the main thread. The
  analyser builds a spectral-flux onset envelope, takes the tempo by
  autocorrelation under a metrical prior, fits a fixed beat grid and picks the
  4/4 downbeat from low-band energy. The result lands as an editable BPM and a
  grid offset. A tag beside the tempo says where the number came from —
  `auto`, `set`, `preset`, `measuring` or `not measured` — and when the downbeat
  was a guess it says so. The candidate selector lists the other measured
  metrical levels, and `×2` / `÷2` correct half and double time.
  **Bar lines** shift bar 0 in whole beats (`−2 … +2`, reset) or place it at the
  playhead with **set here**; free placement is `ctrl`/`alt`-drag on a handle.
- **Playheads**: white for the main position; amber for the post-roll stream and
  blue for the pre-roll stream while overlaid. The fade panels and handles use
  the same left-blue / right-amber coding.
- Keyboard: `space` play/pause, `home` start, `[` / `]` nudge grid, `+` / `−` /
  `0` zoom, wheel zooms at the cursor, shift+wheel pans.

## Copying and loading a preset

**copy preset** and **load preset** sit in the page header, next to **load audio**. **copy preset** puts
the current configuration on the clipboard as JSON:

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
`web-loop.gridOffsetMs` localStorage keys. They are the fallback for a track the
analyser cannot measure: when it succeeds, the measured tempo and grid replace
them. They are not stored per file.
