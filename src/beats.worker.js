/**
 * Runs the tempo analysis off the main thread. The decoded mono channel is
 * transferred in; the measured tempo, grid offset, metrical candidates and
 * how sure the downbeat is come back.
 */
import { analyze } from './beats.js'

self.onmessage = (e) => {
  const { samples, sr, id } = e.data
  const ch = samples instanceof Float32Array ? samples : new Float32Array(samples)
  try {
    const r = analyze(ch, sr)
    if (!r) {
      self.postMessage({ id, ok: false, reason: 'no analysable audio' })
      return
    }
    self.postMessage({
      id,
      ok: true,
      bpm: r.bpm,
      gridOffsetMs: r.gridOffsetMs,
      candidates: r.candidates,
      downbeatMargin: r.downbeatMargin,
    })
  } catch (err) {
    self.postMessage({ id, ok: false, reason: String((err && err.message) || err) })
  }
}
