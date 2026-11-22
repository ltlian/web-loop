/**
 * Tempo, beat grid and downbeat estimation over decoded PCM.
 *
 * Pure functions over Float32Array: no DOM, no dependencies, no I/O. The same
 * code runs on the main thread, inside the Worker and under `node --test`.
 *
 * Pipeline: spectral-flux onset envelope -> autocorrelation tempo with a
 * log-Gaussian prior -> a fixed-period grid whose phase maximises onset
 * strength -> a 4/4 downbeat picked from low-band energy. The grid period is
 * global, so the grid cannot wander; that is the point for a loop workbench.
 */

const TAU = Math.PI * 2
const FOUR_FOUR = 4

/** In-place iterative radix-2 FFT. */
function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const ti = im[i]; im[i] = im[j]; im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -TAU / len
    const wr = Math.cos(ang), wi = Math.sin(ang)
    const half = len / 2
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr; im[b] = im[a] - xi
        re[a] += xr; im[a] += xi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

/**
 * Spectral-flux onset envelope. `env[i]` is the flux of the window starting at
 * sample i*hop, so the frame's energy is centred at i/fps + offset seconds.
 */
export function onsetEnvelope(samples, sr, { hop = 256, win = 1024, gamma = 10 } = {}) {
  const n = 1 << Math.ceil(Math.log2(win))
  const hann = new Float32Array(n)
  for (let i = 0; i < n; i++) hann[i] = 0.5 - 0.5 * Math.cos((TAU * i) / n)
  const frames = Math.max(0, Math.floor((samples.length - n) / hop) + 1)
  const env = new Float32Array(frames)
  const prev = new Float32Array(n / 2)
  const re = new Float32Array(n), im = new Float32Array(n)
  for (let f = 0; f < frames; f++) {
    const off = f * hop
    for (let i = 0; i < n; i++) {
      const v = off + i < samples.length ? samples[off + i] : 0
      re[i] = v * hann[i]
      im[i] = 0
    }
    fft(re, im)
    let flux = 0
    for (let b = 1; b < n / 2; b++) {
      const mag = Math.log1p(gamma * Math.hypot(re[b], im[b]))
      const d = mag - prev[b]
      if (d > 0) flux += d
      prev[b] = mag
    }
    env[f] = flux / (n / 2)
  }
  return { env, fps: sr / hop, offset: n / (2 * sr) }
}

/** Low-band (kick) energy per envelope frame, for the downbeat choice. */
export function lowBandEnvelope(samples, sr, hop = 256, cutoff = 150, windowMs = 30) {
  const a = 1 - Math.exp((-TAU * cutoff) / sr)
  const w = Math.max(1, Math.round((windowMs * sr) / 1000))
  const ring = new Float32Array(w)
  const frames = Math.floor(samples.length / hop)
  const out = new Float32Array(frames)
  let lp = 0, acc = 0, pos = 0, f = 0
  for (let i = 0; i < samples.length; i++) {
    lp += a * (samples[i] - lp)
    const sq = lp * lp
    acc += sq - ring[pos]
    ring[pos] = sq
    pos = pos + 1 === w ? 0 : pos + 1
    if (i % hop === 0) {
      out[f++] = acc / w
      if (f >= frames) break
    }
  }
  return out
}

const mean = (a) => {
  let s = 0
  for (const v of a) s += v
  return a.length ? s / a.length : 0
}

function median(a) {
  if (!a.length) return 0
  const b = Float32Array.from(a).sort()
  const m = b.length >> 1
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2
}

/**
 * Tempo by autocorrelation of the onset envelope, weighted by a log-Gaussian
 * prior around `prior`. Returns the winning tempo and the other local maxima
 * that competed with it, so callers can offer metrical alternatives.
 */
export function estimateTempo(env, fps, { minBpm = 55, maxBpm = 200, prior = 120, priorOct = 0.5, count = 4 } = {}) {
  const n = env.length
  if (n < 8) return { bpm: prior, candidates: [] }
  const avg = mean(env)
  const ac = new Float32Array(n)
  const lo = Math.max(1, Math.floor((fps * 60) / maxBpm))
  const hi = Math.min(n - 2, Math.ceil((fps * 60) / minBpm))
  for (let lag = lo; lag <= hi; lag++) {
    let s = 0
    for (let i = 0; i + lag < n; i++) s += (env[i] - avg) * (env[i + lag] - avg)
    ac[lag] = s / (n - lag)
  }
  const weight = (bpm) => Math.exp(-0.5 * Math.pow(Math.log2(bpm / prior) / priorOct, 2))
  let bestLag = lo, best = -Infinity
  for (let lag = lo; lag <= hi; lag++) {
    const v = ac[lag] * weight((60 * fps) / lag)
    if (v > best) { best = v; bestLag = lag }
  }
  const y0 = ac[bestLag - 1] ?? ac[bestLag]
  const y1 = ac[bestLag]
  const y2 = ac[bestLag + 1] ?? ac[bestLag]
  const den = y0 - 2 * y1 + y2
  const shift = den !== 0 ? (0.5 * (y0 - y2)) / den : 0

  const peaks = []
  for (let lag = lo + 1; lag < hi; lag++) {
    if (ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1]) peaks.push({ bpm: (60 * fps) / lag, strength: ac[lag] })
  }
  peaks.sort((a, b) => b.strength - a.strength)
  const chosen = { bpm: (60 * fps) / (bestLag + shift), strength: best }
  const candidates = [chosen]
  for (const p of peaks) {
    if (candidates.every((c) => Math.abs(c.bpm / p.bpm - 1) > 0.02)) candidates.push(p)
    if (candidates.length >= count) break
  }
  return { bpm: chosen.bpm, candidates }
}

/**
 * The fixed-period grid: search the beat phase that maximises onset strength at
 * the grid points. A global period means no phase slips and no drift.
 */
export function estimateGrid(env, fps, bpm, { offset = 0, step = 0.5 } = {}) {
  const period = (fps * 60) / bpm
  if (!(period > 1) || env.length < period * FOUR_FOUR) return null
  const avg = mean(env)
  const strengthAt = (i) => {
    const a = Math.max(0, Math.round(i) - 1)
    const b = Math.min(env.length - 1, Math.round(i) + 1)
    let m = 0
    for (let j = a; j <= b; j++) if (env[j] > m) m = env[j]
    return m
  }
  const scoreAt = (phase) => {
    let s = 0, n = 0
    for (let k = 0; ; k++) {
      const i = phase + k * period
      if (i >= env.length) break
      s += strengthAt(i)
      n++
    }
    return n ? { score: s / n, n } : { score: 0, n: 0 }
  }
  let bestPhase = 0, bestScore = -Infinity
  for (let phase = 0; phase < period; phase += step) {
    const { score } = scoreAt(phase)
    if (score > bestScore) { bestScore = score; bestPhase = phase }
  }
  // refine around the winning phase at quarter-frame resolution
  for (let d = -step; d <= step; d += step / 4) {
    const phase = bestPhase + d
    if (phase < 0 || phase >= period) continue
    const { score } = scoreAt(phase)
    if (score > bestScore) { bestScore = score; bestPhase = phase }
  }
  const beats = []
  for (let k = 0; ; k++) {
    const i = bestPhase + k * period
    if (i >= env.length) break
    beats.push(i / fps + offset)
  }
  return {
    period,
    phase: bestPhase,
    beats,
    score: bestScore,
    strength: avg > 0 ? bestScore / avg : 0,
  }
}

/**
 * Which of the four beats carries the most low-band energy, i.e. which beat is
 * the downbeat of a 4/4 bar. Returns the index and the margin over the runner
 * up, so a flat result can be reported as such.
 */
export function estimateDownbeat(low, grid) {
  if (!grid || !low.length || grid.beats.length < FOUR_FOUR) return { index: 0, margin: 0, scores: [] }
  const { period, phase } = grid
  const scores = []
  for (let q = 0; q < FOUR_FOUR; q++) {
    let s = 0, n = 0
    for (let i = phase + q * period; i < low.length; i += period * FOUR_FOUR) {
      // the attack lands a few frames after the beat, so take the local peak
      let peak = 0
      for (let d = 0; d <= 4; d++) peak = Math.max(peak, low[Math.round(i) + d] || 0)
      s += peak
      n++
    }
    scores.push(n ? s / n : 0)
  }
  let index = 0
  for (let q = 1; q < FOUR_FOUR; q++) if (scores[q] > scores[index]) index = q
  const sorted = [...scores].sort((a, b) => b - a)
  const margin = sorted[0] > 0 ? 1 - sorted[1] / sorted[0] : 0
  return { index, margin, scores }
}

/**
 * Strongest onset within `radius` seconds of t, and whether it is convincing
 * against the local floor. Used by fit loop instead of a low-band-only probe.
 */
export function findOnsetNear(env, fps, t, radius = 0.15, { offset = 0, floor } = {}) {
  const a = Math.max(0, Math.floor((t - radius - offset) * fps))
  const b = Math.min(env.length - 1, Math.ceil((t + radius - offset) * fps))
  if (b <= a) return { time: t, found: false, strength: 0, floor: 0 }
  let best = -Infinity, bestI = a
  for (let i = a; i <= b; i++) if (env[i] > best) { best = env[i]; bestI = i }
  // an absolute floor is stable when the window holds several transients;
  // the local median is the fallback for callers that have no track reference
  const gate = floor ?? Math.max(median(env.subarray(a, b + 1)) * 2.5, 1e-9)
  return { time: bestI / fps + offset, found: best > gate, strength: best, floor: gate }
}

/** Everything the app needs from one decoded mono channel. */
export function analyze(samples, sr, opts = {}) {
  const { env, fps, offset } = onsetEnvelope(samples, sr, opts)
  if (!env.length) return null
  const { bpm, candidates } = estimateTempo(env, fps)
  const grid = estimateGrid(env, fps, bpm, { offset })
  if (!grid) return null
  const low = lowBandEnvelope(samples, sr, opts.hop ?? 256)
  const downbeat = estimateDownbeat(low, grid)
  const beatLen = 60 / bpm
  const barLen = beatLen * FOUR_FOUR
  const origin = grid.beats[downbeat.index] ?? grid.beats[0]
  const gridOffsetMs = (((origin % barLen) + barLen) % barLen) * 1000
  return {
    bpm,
    barLen,
    gridOffsetMs,
    beats: grid.beats,
    candidates,
    confidence: grid.strength,
    downbeatIndex: downbeat.index,
    downbeatMargin: downbeat.margin,
    env,
    fps,
    offset,
  }
}
