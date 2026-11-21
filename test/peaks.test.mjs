import test from 'node:test'
import assert from 'node:assert/strict'
import { computePeaks } from '../src/peaks.js'

/** Minimal AudioBuffer stub: enough for computePeaks, no Web Audio needed. */
class FakeBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels
    this.length = length
    this.sampleRate = sampleRate
    this.duration = length / sampleRate
    this.channels = Array.from({ length: channels }, () => new Float32Array(length))
  }

  getChannelData(channel) {
    return this.channels[channel]
  }
}

function ramp(seconds = 4, channels = 2) {
  const buffer = new FakeBuffer(channels, seconds * 1000, 1000)
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < buffer.length; i++) buffer.channels[c][i] = Math.sin((2 * Math.PI * i) / 100)
  }
  return buffer
}

test('computePeaks emits 2200 min/max pairs inside [-1, 1]', () => {
  const peaks = computePeaks(ramp())
  assert.equal(peaks.length, 4400)
  assert.ok(peaks.every((v) => Number.isFinite(v) && v >= -1 && v <= 1))
  assert.ok(peaks.some((v) => v !== 0))
})

test('computePeaks downmixes channels', () => {
  const buffer = new FakeBuffer(2, 4, 1000)
  buffer.channels[0].set([1, -1, 1, -1])
  buffer.channels[1].set([-1, 1, -1, 1])
  const peaks = computePeaks(buffer, 2)
  assert.deepEqual(peaks, [0, 0, 0, 0])
})

test('computePeaks handles an empty buffer', () => {
  const peaks = computePeaks(new FakeBuffer(1, 0, 1000), 4)
  assert.deepEqual(peaks, [0, 0, 0, 0, 0, 0, 0, 0])
})
