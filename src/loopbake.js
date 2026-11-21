/**
 * Builds one loop iteration from a source buffer and a bar-aligned region
 * [start, end]. Three seam treatments:
 *
 *  - "keep" (post-roll): keep the loop length. Audio *after* end (end .. end+fade)
 *    is blended over the head, fading out while the head fades in. Needs
 *    post-roll material beyond the loop end.
 *
 *  - "lead" (pre-roll): keep the loop length. The loop's own tail
 *    (end-fade .. end) is blended into the audio *before* the start
 *    (start-fade .. start), so the lead-in happens before marker 1 and the head
 *    marker plays at full level. Needs pre-roll material before the loop start.
 *
 *  - "shorten": legacy symmetric crossfade using the loop's own tail and head;
 *    the loop gets shorter by the fade length.
 *
 * Keeping the length means borrowing audio from outside the region: post-roll
 * for "keep", pre-roll for "lead". Curves: "equal-power" (sin/cos) or "linear".
 */
export function bakeLoop(ctx, source, { start, end, fade = 0.1, mode = 'keep', curve = 'equal-power' }) {
  const sr = source.sampleRate
  const nch = source.numberOfChannels
  const S = Math.max(0, Math.round(start * sr))
  const E = Math.min(source.length, Math.round(end * sr))
  const L = E - S
  if (L <= 0) throw new Error('loop region is empty')

  const requestedSamples = Math.max(0, Math.min(Math.round(fade * sr), L))
  const tailAvailableSamples = Math.max(0, source.length - E)
  const preAvailableSamples = S
  const modeMap = { keep: 'keep', lead: 'lead', preroll: 'lead', shorten: 'shorten', tail: 'keep', crossfade: 'shorten' }
  const eff = modeMap[mode] ?? 'keep'

  let X = requestedSamples
  let tailClipped = false
  let preClipped = false
  let fadeClipped = false
  if (eff === 'keep') {
    if (X > tailAvailableSamples) { X = tailAvailableSamples; tailClipped = true }
  } else if (eff === 'lead') {
    if (X > preAvailableSamples) { X = preAvailableSamples; preClipped = true }
    X = Math.min(X, L)
  } else {
    const cap = Math.floor(L / 2)
    if (X > cap) { X = cap; fadeClipped = true }
  }

  const outLen = eff === 'shorten' ? L - X : L
  const out = ctx.createBuffer(nch, Math.max(1, outLen), sr)
  const fadeIn = (t) => (curve === 'equal-power' ? Math.sin((t * Math.PI) / 2) : t)
  const fadeOut = (t) => (curve === 'equal-power' ? Math.cos((t * Math.PI) / 2) : 1 - t)

  for (let ch = 0; ch < nch; ch++) {
    const src = source.getChannelData(ch)
    const dst = out.getChannelData(ch)

    if (eff === 'lead') {
      // body plays unchanged; the last fade is a crossfade from the loop's
      // own tail into the pre-roll, ending exactly on the start marker
      for (let i = 0; i < outLen; i++) dst[i] = src[S + i]
      if (X > 0) {
        for (let i = L - X; i < L; i++) {
          const t = (i - (L - X)) / X
          dst[i] = src[S + i] * fadeOut(t) + src[S + i - L] * fadeIn(t)
        }
      }
      continue
    }

    // keep / shorten: crossfade at the head (S .. S+X)
    if (X > 0) {
      for (let i = 0; i < X; i++) {
        const t = i / X
        const head = src[S + i]
        const other = eff === 'keep' ? src[E + i] : src[E - X + i]
        dst[i] = head * fadeIn(t) + other * fadeOut(t)
      }
    }
    for (let i = X; i < outLen; i++) dst[i] = src[S + i]
  }

  return {
    buffer: out,
    mode: eff,
    fadeSeconds: X / sr,
    requestedFadeSeconds: requestedSamples / sr,
    tailAvailableSeconds: tailAvailableSamples / sr,
    preAvailableSeconds: preAvailableSamples / sr,
    tailClipped,
    preClipped,
    fadeClipped,
    loopLength: outLen / sr,
    sourceStart: S / sr,
    sourceEnd: E / sr,
  }
}
