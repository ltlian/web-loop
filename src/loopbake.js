/**
 * Builds one loop iteration from a source buffer and a bar-aligned region
 * [start, end].
 *
 *  - left marker: incoming fade-in over [start - inPre, start + inPost], 0 -> 1
 *  - right marker: outgoing fade-out over [end - outPre, end + outPost], 1 -> 0
 *
 * The period is the region itself: the post-roll after the end overlays the
 * head at the start, and the pre-roll before the start overlays the loop tail
 * at the end. The crossfade window is the union of the two windows around the
 * seam; the body is the region trimmed by max(inPre, outPre) at the tail and
 * max(inPost, outPost) at the head. A zero-length window is a hard edge. The
 * author owns the gain sum and any seam click; `wrapStep` reports it.
 *
 * Curves: "equal-power" (sin/cos) or "linear".
 */
export function bakeLoop(ctx, source, { start, end, inPre = 0, inPost = 0, outPre = 0, outPost = 0, curve = 'equal-power' }) {
  const sr = source.sampleRate
  const nch = source.numberOfChannels
  const S = Math.max(0, Math.round(start * sr))
  const E = Math.min(source.length, Math.round(end * sr))
  const L = E - S
  if (L <= 0) throw new Error('loop region is empty')

  const inGain = (t) => (curve === 'equal-power' ? Math.sin((t * Math.PI) / 2) : t)
  const outGain = (t) => (curve === 'equal-power' ? Math.cos((t * Math.PI) / 2) : 1 - t)

  // requested window lengths, then what the source and the region can give
  const reqInPre = Math.max(0, Math.round(inPre * sr))
  const reqInPost = Math.max(0, Math.round(inPost * sr))
  const reqOutPre = Math.max(0, Math.round(outPre * sr))
  const reqOutPost = Math.max(0, Math.round(outPost * sr))
  const preAvailable = S
  const postAvailable = Math.max(0, source.length - E)
  const inPreEff = Math.min(reqInPre, preAvailable)
  const inPostEff = Math.min(reqInPost, L)
  const outPreEff = Math.min(reqOutPre, L)
  const outPostEff = Math.min(reqOutPost, postAvailable)
  const inPreClipped = reqInPre > preAvailable
  const outPostClipped = reqOutPost > postAvailable
  const fadeInClipped = reqInPost > L
  const fadeOutClipped = reqOutPre > L
  let maxPre = Math.max(inPreEff, outPreEff)
  let maxPost = Math.max(inPostEff, outPostEff)
  let windowClipped = false
  if (maxPre + maxPost > L) {
    const scale = L / (maxPre + maxPost)
    maxPre = Math.floor(maxPre * scale)
    maxPost = L - maxPre
    windowClipped = true
  }
  const bodyEnd = L - maxPre
  const out = ctx.createBuffer(nch, L, sr)
  const inGainAt = (u) => {
    if (inPreEff + inPostEff === 0) return u < 0 ? 0 : 1
    if (u <= -inPreEff) return 0
    if (u >= inPostEff) return 1
    return inGain((u + inPreEff) / (inPreEff + inPostEff))
  }
  const outGainAt = (u) => {
    if (outPreEff + outPostEff === 0) return u < 0 ? 1 : 0
    if (u <= -outPreEff) return 1
    if (u >= outPostEff) return 0
    return outGain((u + outPreEff) / (outPreEff + outPostEff))
  }
  for (let ch = 0; ch < nch; ch++) {
    const src = source.getChannelData(ch)
    const dst = out.getChannelData(ch)
    // after the wrap: incoming head (hard unless inPost) + outgoing post-roll
    for (let i = 0; i < maxPost; i++) {
      let v = src[S + i] * inGainAt(i)
      if (i < outPostEff) v += src[E + i] * outGainAt(i)
      dst[i] = v
    }
    // the untouched middle of the region
    for (let i = maxPost; i < bodyEnd; i++) dst[i] = src[S + i]
    // before the wrap: outgoing loop tail + incoming pre-roll
    for (let i = bodyEnd; i < L; i++) {
      const u = i - L
      let v = src[E + u] * outGainAt(u)
      if (u >= -inPreEff) v += src[S + u] * inGainAt(u)
      dst[i] = v
    }
  }
  let wrapStep = 0
  for (let ch = 0; ch < nch; ch++) {
    const d = out.getChannelData(ch)
    wrapStep = Math.max(wrapStep, Math.abs(d[0] - d[L - 1]))
  }
  return {
    buffer: out,
    inPreSeconds: inPreEff / sr,
    inPostSeconds: inPostEff / sr,
    outPreSeconds: outPreEff / sr,
    outPostSeconds: outPostEff / sr,
    windowPreSeconds: maxPre / sr,
    windowPostSeconds: maxPost / sr,
    windowSeconds: (maxPre + maxPost) / sr,
    bodySeconds: (L - maxPre - maxPost) / sr,
    periodSeconds: L / sr,
    loopLength: L / sr,
    inPreClipped,
    outPostClipped,
    fadeInClipped,
    fadeOutClipped,
    windowClipped,
    wrapStep,
  }
}
