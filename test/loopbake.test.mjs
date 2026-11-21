import test from 'node:test'
import assert from 'node:assert/strict'
import { bakeLoop } from '../src/loopbake.js'

const SR = 1000
const S = 1000
const E = 2000
const L = E - S
const DURATION = 3

function source(channels = 1) {
  const length = DURATION * SR
  const data = Array.from({ length: channels }, () => new Float32Array(length))
  for (let ch = 0; ch < channels; ch++) {
    for (let i = 0; i < length; i++) data[ch][i] = 0.7 * Math.sin((2 * Math.PI * 7.3 * i) / SR)
  }
  return {
    sampleRate: SR,
    numberOfChannels: channels,
    length,
    duration: DURATION,
    getChannelData: (ch) => data[ch],
  }
}

function ctx() {
  return {
    createBuffer(channels, length, rate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length))
      return {
        numberOfChannels: channels,
        length,
        sampleRate: rate,
        getChannelData: (ch) => data[ch],
      }
    },
  }
}

function bake(options = {}, src = source()) {
  return bakeLoop(ctx(), src, {
    start: S / SR,
    end: E / SR,
    ...options,
  })
}

const eq = (a, b, tol = 1e-6) => Math.abs(a - b) < tol

test('no fades is the bare region and keeps the period', () => {
  const src = source()
  const baked = bake({}, src)
  assert.equal(baked.periodSeconds, 1)
  assert.equal(baked.buffer.length, L)
  assert.equal(baked.buffer.getChannelData(0)[0], src.getChannelData(0)[S])
  const raw = Math.abs(src.getChannelData(0)[S] - src.getChannelData(0)[E - 1])
  assert.ok(Math.abs(baked.wrapStep - raw) < 1e-6)
})

test('out post overlays the post-roll under a hard head', () => {
  const src = source()
  const baked = bake({ outPost: 0.1 }, src)
  const d = baked.buffer.getChannelData(0)
  assert.equal(baked.periodSeconds, 1)
  assert.equal(baked.bodySeconds, 0.9)
  assert.equal(baked.windowSeconds, 0.1)
  assert.ok(eq(d[0], src.getChannelData(0)[S] + src.getChannelData(0)[E]))
  assert.ok(eq(d[L - 1], src.getChannelData(0)[E - 1]))
  assert.ok(eq(d[100], src.getChannelData(0)[S + 100]))
})

test('in pre fades the pre-roll in under the hard tail', () => {
  const src = source()
  const baked = bake({ inPre: 0.1 }, src)
  const d = baked.buffer.getChannelData(0)
  assert.equal(baked.periodSeconds, 1)
  assert.equal(baked.bodySeconds, 0.9)
  assert.equal(baked.windowSeconds, 0.1)
  assert.ok(eq(d[0], src.getChannelData(0)[S]))
  assert.ok(Math.abs(d[L - 1] - (src.getChannelData(0)[E - 1] + src.getChannelData(0)[S - 1])) < 0.02)
})

test('in post fades the head in after the start', () => {
  const src = source()
  const baked = bake({ inPost: 0.1 }, src)
  const d = baked.buffer.getChannelData(0)
  assert.equal(baked.periodSeconds, 1)
  assert.equal(baked.bodySeconds, 0.9)
  assert.ok(Math.abs(d[0]) < 1e-12)
  assert.ok(eq(d[100], src.getChannelData(0)[S + 100]))
})

test('out pre fades the loop tail out before the end', () => {
  const src = source()
  const baked = bake({ outPre: 0.1 }, src)
  const d = baked.buffer.getChannelData(0)
  assert.equal(baked.periodSeconds, 1)
  assert.equal(baked.bodySeconds, 0.9)
  assert.ok(eq(d[900], src.getChannelData(0)[E - 100]))
  assert.ok(Math.abs(d[L - 1]) < 0.01)
})

test('out post and in pre overlay at both ends without growing the period', () => {
  const src = source()
  const baked = bake({ outPost: 0.1, inPre: 0.1 }, src)
  const d = baked.buffer.getChannelData(0)
  assert.equal(baked.periodSeconds, 1)
  assert.equal(baked.bodySeconds, 0.8)
  assert.equal(baked.windowSeconds, 0.2)
  assert.ok(eq(d[0], src.getChannelData(0)[S] + src.getChannelData(0)[E]))
  assert.ok(Math.abs(d[L - 1] - (src.getChannelData(0)[E - 1] + src.getChannelData(0)[S - 1])) < 0.02)
})

test('outside windows clip at the file edges', () => {
  const pre = bake({ inPre: 1.5 })
  assert.equal(pre.inPreClipped, true)
  assert.equal(pre.inPreSeconds, 1)
  assert.equal(pre.periodSeconds, 1)
  assert.equal(pre.bodySeconds, 0)
  assert.equal(pre.windowSeconds, 1)

  const post = bake({ outPost: 1.5 })
  assert.equal(post.outPostClipped, true)
  assert.equal(post.outPostSeconds, 1)
  assert.equal(post.periodSeconds, 1)
  assert.equal(post.bodySeconds, 0)
})

test('windows that exceed the loop are scaled and flagged', () => {
  const baked = bake({ inPre: 0.6, inPost: 0.6, outPre: 0.6, outPost: 0.6 })
  assert.equal(baked.windowClipped, true)
  assert.equal(baked.periodSeconds, 1)
  assert.equal(baked.bodySeconds, 0)
  assert.equal(baked.windowSeconds, 1)
})
