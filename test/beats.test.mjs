import test from 'node:test'
import assert from 'node:assert/strict'
import {
  analyze,
  estimateTempo,
  estimateGrid,
  onsetEnvelope,
  lowBandEnvelope,
} from '../src/beats.js'

const SR = 48000

// Deterministic material: no Math.random, so a failure is always reproducible.
function lcg(seed = 12345) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s / 0x100000000) * 2 - 1
  }
}

function track(seconds) {
  return new Float32Array(Math.ceil(seconds * SR))
}

function kick(ch, t, amp = 0.9) {
  const i0 = Math.round(t * SR)
  for (let i = 0; i < 0.12 * SR; i++) {
    const tt = i / SR
    const f = 150 * Math.exp(-tt * 30) + 50
    ch[i0 + i] += amp * Math.exp(-tt * 18) * Math.sin(2 * Math.PI * f * tt)
  }
}

function snare(ch, t, noise, amp = 0.5) {
  const i0 = Math.round(t * SR)
  for (let i = 0; i < 0.1 * SR; i++) {
    const tt = i / SR
    ch[i0 + i] += amp * Math.exp(-tt * 35) * noise() * Math.sin(2 * Math.PI * 190 * tt)
  }
}

function hat(ch, t, noise, amp = 0.25) {
  const i0 = Math.round(t * SR)
  for (let i = 0; i < 0.03 * SR; i++) {
    const tt = i / SR
    ch[i0 + i] += amp * Math.exp(-tt * 120) * noise() * Math.sin(2 * Math.PI * 8500 * tt)
  }
}

/** Kick on the downbeat only, snare elsewhere: an unambiguous 4/4 pattern. */
function groove(bpm, { bars = 6, start = 0.5, hats = 2 } = {}) {
  const beat = 60 / bpm
  const ch = track(bars * 4 * beat + 1)
  const noise = lcg()
  for (let b = 0; b < bars * 4; b++) {
    const t = start + b * beat
    if (b % 4 === 0) kick(ch, t)
    else snare(ch, t, noise)
    for (let h = 0; h < hats; h++) hat(ch, t + (h * beat) / hats, noise)
  }
  return ch
}

const wrapDistance = (a, b, period) => {
  const d = ((a - b) % period + period) % period
  return Math.min(d, period - d)
}

test('onsetEnvelope reports the frame rate and window offset', () => {
  const { env, fps, offset } = onsetEnvelope(track(2), SR, { hop: 256, win: 1024 })
  assert.equal(fps, SR / 256)
  assert.ok(Math.abs(offset - 1024 / (2 * SR)) < 1e-9)
  assert.ok(env.length > 300)
})

test('estimateTempo lands within 0.5% on a clear 4/4 groove', () => {
  for (const bpm of [90, 128, 140]) {
    const ch = groove(bpm)
    const { env, fps } = onsetEnvelope(ch, SR)
    const { bpm: got, candidates } = estimateTempo(env, fps)
    assert.ok(Math.abs(got / bpm - 1) < 0.005, `${bpm} BPM read as ${got.toFixed(2)}`)
    assert.ok(Math.abs(candidates[0].bpm - got) < 1e-6, 'the chosen tempo leads the candidate list')
  }
})

test('the candidate list offers the competing metrical levels', () => {
  const ch = groove(128)
  const { env, fps } = onsetEnvelope(ch, SR)
  const { candidates } = estimateTempo(env, fps)
  assert.ok(candidates.length >= 2)
  assert.ok(candidates.some((c) => Math.abs(c.bpm - 64) < 2), 'half-time is offered')
})

test('estimateGrid passes through the downbeat', () => {
  // Phase is defined modulo one beat, so the grid starts wherever the first
  // beat above t=0 falls; the bar origin is chosen later, from the downbeat.
  for (const bpm of [90, 128, 140]) {
    const ch = groove(bpm, { start: 0.5 })
    const { env, fps, offset } = onsetEnvelope(ch, SR)
    const { bpm: tempo } = estimateTempo(env, fps)
    const grid = estimateGrid(env, fps, tempo, { offset })
    assert.ok(
      grid.beats.slice(0, 4).some((b) => Math.abs(b - 0.5) < 0.02),
      `${bpm} BPM: no grid beat near the 0.5 s downbeat (${grid.beats.slice(0, 4).map((b) => b.toFixed(3)).join(', ')})`,
    )
  }
})

test('analyze picks the downbeat from low-band energy', () => {
  const ch = groove(128)
  const r = analyze(ch, SR)
  const barMs = r.barLen * 1000
  assert.ok(Math.abs(r.bpm / 128 - 1) < 0.005, `bpm ${r.bpm.toFixed(2)}`)
  assert.ok(wrapDistance(r.gridOffsetMs, 500, barMs) < 20, `gridOffset ${r.gridOffsetMs.toFixed(0)} ms`)
  assert.ok(r.downbeatMargin > 0.05, 'the kick makes the downbeat unambiguous')
  assert.ok(r.confidence > 2, 'the grid sits on strong onsets')
})

test('a syncopated pattern is read at a metrical relative, and the true level is offered', () => {
  // 174 with a kick/snare backbeat is the three-against-two case; the analyser
  // may pick 2/3 of it, so the contract is that 174 appears as a candidate.
  const ch = groove(174)
  const r = analyze(ch, SR)
  assert.ok(r.candidates.some((c) => Math.abs(c.bpm - 174) < 3), '174 is offered')
  assert.ok(
    Math.abs(r.bpm / 174 - 1) < 0.01 || Math.abs(r.bpm / (174 * 2) - 1) < 0.01 || Math.abs(r.bpm / (174 * 2 / 3) - 1) < 0.01,
    `bpm ${r.bpm.toFixed(2)} is not a metrical relative of 174`,
  )
})

test('lowBandEnvelope follows the kick', () => {
  const ch = groove(128, { bars: 2 })
  const low = lowBandEnvelope(ch, SR, 256)
  const atKick = Math.max(...low.slice(Math.round(0.5 * SR / 256), Math.round(0.54 * SR / 256)))
  const between = Math.max(...low.slice(Math.round(0.6 * SR / 256), Math.round(0.64 * SR / 256)))
  assert.ok(atKick > between * 2, `kick ${atKick.toExponential(2)} vs gap ${between.toExponential(2)}`)
})
