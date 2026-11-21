import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildPreset, PRESET_FORMAT, PRESET_SCHEMA, PRESET_VERSION } from '../src/preset.js'

const schema = JSON.parse(readFileSync(new URL('../public/preset.schema.json', import.meta.url), 'utf8'))
const loopSchema = schema.properties.loop.properties

// The preset copy emits for a known state, pinned field for field. A field
// added, dropped or renamed is a format change and must fail here.
const EXPECTED = {
  $schema: PRESET_SCHEMA,
  format: PRESET_FORMAT,
  version: PRESET_VERSION,
  track: 'your-track.wav',
  bpm: 120,
  gridOffsetMs: 0,
  loop: {
    enabled: true,
    start: 2,
    end: 10,
    inPreMs: 0,
    inPostMs: 0,
    outPreMs: 0,
    outPostMs: 120,
    curve: 'equal-power',
  },
}

function state() {
  return {
    track: { duration: 64 },
    sourceName: 'your-track.wav',
    bpm: 120,
    gridMs: 0,
    loop: { enabled: true, start: 2, end: 10, inPreMs: 0, inPostMs: 0, outPreMs: 0, outPostMs: 120, curve: 'equal-power' },
  }
}

test('buildPreset emits exactly the pinned preset', () => {
  assert.deepEqual(buildPreset(state()), EXPECTED)
})

test('the emitted shape is the shape the schema documents', () => {
  const preset = buildPreset(state())
  assert.deepEqual(Object.keys(preset).sort(), Object.keys(schema.properties).sort())
  assert.deepEqual(Object.keys(preset.loop).sort(), Object.keys(loopSchema).sort())
})

test('the published schema still states the app bounds', () => {
  assert.equal(schema.$id, PRESET_SCHEMA)
  assert.equal(schema.properties.format.const, PRESET_FORMAT)
  assert.equal(schema.properties.version.const, PRESET_VERSION)
  assert.equal(schema.properties.bpm.minimum, 40)
  assert.equal(schema.properties.bpm.maximum, 240)
  for (const key of ['inPreMs', 'inPostMs', 'outPreMs', 'outPostMs']) {
    assert.equal(loopSchema[key].minimum, 0)
    assert.equal(loopSchema[key].maximum, 3000)
  }
  assert.deepEqual(loopSchema.curve.enum, ['equal-power', 'linear'])
  assert.deepEqual(schema.properties.loop.required, ['start', 'end'])
})

test('buildPreset returns null before audio loads', () => {
  assert.equal(buildPreset({ ...state(), track: null }), null)
})

test('each marker emits its own pre/post pair', () => {
  const asymmetric = { ...state(), loop: { ...state().loop, inPreMs: 80, inPostMs: 20, outPreMs: 40, outPostMs: 300 } }
  assert.deepEqual(buildPreset(asymmetric).loop, {
    enabled: true, start: 2, end: 10, inPreMs: 80, inPostMs: 20, outPreMs: 40, outPostMs: 300, curve: 'equal-power',
  })
})

test('the README preset example is what copy preset emits', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const block = readme.match(/```json\n([\s\S]*?)```/)
  assert.ok(block, 'README.md should show a json preset example')
  const { $schema, ...emitted } = EXPECTED
  assert.deepEqual(JSON.parse(block[1]), emitted, 'README example should match copy preset field for field')
})
