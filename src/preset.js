/**
 * The preset JSON: the workbench's only external format. `buildPreset` is the
 * emitter; `public/preset.schema.json` is the published contract, served at
 * PRESET_SCHEMA. Keep the two in sync — `test/preset.test.mjs` fails if they drift.
 */
export const PRESET_FORMAT = 'web-loop/preset'
export const PRESET_SCHEMA = 'https://loop.ltlian.com/preset.schema.json'
export const PRESET_VERSION = 1

/** Snapshot the current state as a preset object, or null before audio loads. */
export function buildPreset({ track, sourceName, bpm, gridMs, loop }) {
  if (!track) return null
  return {
    $schema: PRESET_SCHEMA,
    format: PRESET_FORMAT,
    version: PRESET_VERSION,
    track: sourceName || null,
    bpm: +bpm.toFixed(4),
    gridOffsetMs: +gridMs.toFixed(2),
    loop: {
      enabled: loop.enabled,
      start: +loop.start.toFixed(6),
      end: +loop.end.toFixed(6),
      inPreMs: loop.inPreMs,
      inPostMs: loop.inPostMs,
      outPreMs: loop.outPreMs,
      outPostMs: loop.outPostMs,
      curve: loop.curve,
    },
  }
}
