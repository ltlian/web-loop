/**
 * Downmixed min/max pairs for the minimap.
 *
 * The detail waveform is drawn from the decoded samples; these 2200 buckets are
 * only the overview (and the fallback before a buffer reaches the view).
 */
export function computePeaks(buffer, buckets = 2200) {
  const chans = []
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c))
  const n = buffer.length
  const per = Math.max(1, Math.ceil(n / buckets))
  const out = new Array(buckets * 2)
  for (let b = 0; b < buckets; b++) {
    const a = b * per
    const z = Math.min(n, a + per)
    let lo = 0
    let hi = 0
    if (a < z) {
      lo = Infinity
      hi = -Infinity
      for (let i = a; i < z; i++) {
        let v = 0
        for (let c = 0; c < chans.length; c++) v += chans[c][i]
        v /= chans.length
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    out[b * 2] = +lo.toFixed(3)
    out[b * 2 + 1] = +hi.toFixed(3)
  }
  return out
}
