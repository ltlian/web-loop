/**
 * Runs the tempo analysis off the main thread. The decoded mono channel is
 * transferred in, and the onset envelope is transferred back so fit loop can
 * reuse it without recomputing.
 */
import { analyze } from './beats.js'

self.onmessage = (e) => {
  const { samples, sr, id } = e.data
  const ch = samples instanceof Float32Array ? samples : new Float32Array(samples)
  const t0 = performance.now()
  try {
    const r = analyze(ch, sr)
    if (!r) {
      self.postMessage({ id, ok: false, reason: 'no analysable audio' })
      return
    }
    self.postMessage(
      {
        id,
        ok: true,
        bpm: r.bpm,
        gridOffsetMs: r.gridOffsetMs,
        candidates: r.candidates,
        confidence: r.confidence,
        downbeatIndex: r.downbeatIndex,
        downbeatMargin: r.downbeatMargin,
        beats: r.beats,
        env: r.env,
        fps: r.fps,
        offset: r.offset,
        ms: performance.now() - t0,
      },
      [r.env.buffer],
    )
  } catch (err) {
    self.postMessage({ id, ok: false, reason: String((err && err.message) || err) })
  }
}
