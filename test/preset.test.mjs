import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import { buildPreset, PRESET_SCHEMA, PRESET_VERSION } from '../src/preset.js'

const schema = JSON.parse(readFileSync(new URL('../public/preset.schema.json', import.meta.url), 'utf8'))
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema)

function state() {
  return {
    track: { duration: 64 },
    sourceName: 'your-track.wav',
    bpm: 120,
    gridMs: 0,
    loop: { enabled: true, start: 2, end: 10, inPreMs: 0, inPostMs: 0, outPreMs: 0, outPostMs: 120, curve: 'equal-power' },
  }
}

const errors = () => validate.errors?.map((e) => `${e.instancePath} ${e.message}`).join(', ')

test('the schema $id is the URL copy preset writes', () => {
  assert.equal(schema.$id, PRESET_SCHEMA)
})

test('the schema version matches the emitter', () => {
  assert.equal(schema.properties.version.const, PRESET_VERSION)
})

test('buildPreset output validates against the schema', () => {
  assert.ok(validate(buildPreset(state())), errors())
})

test('buildPreset returns null before audio loads', () => {
  assert.equal(buildPreset({ ...state(), track: null }), null)
})

test('each marker emits its own pre/post pair', () => {
  const preset = buildPreset(state())
  assert.equal(preset.loop.inPreMs, 0)
  assert.equal(preset.loop.inPostMs, 0)
  assert.equal(preset.loop.outPreMs, 0)
  assert.equal(preset.loop.outPostMs, 120)
  assert.ok(validate(preset), errors())

  const asymmetric = { ...state(), loop: { ...state().loop, inPreMs: 80, inPostMs: 20, outPreMs: 40, outPostMs: 300 } }
  assert.ok(validate(buildPreset(asymmetric)), errors())
})

test('the README preset example is what copy preset emits', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const block = readme.match(/```json\n([\s\S]*?)```/)
  assert.ok(block, 'README.md should show a json preset example')
  const example = JSON.parse(block[1])
  assert.ok(validate(example), 'README example should validate against the schema')
  const { $schema, ...emitted } = buildPreset(state())
  assert.deepEqual(example, emitted, 'README example should match copy preset field for field')
})

test('the schema rejects values the format cannot carry', () => {
  const badBpm = buildPreset(state())
  badBpm.bpm = 480
  assert.equal(validate(badBpm), false, 'bpm is clamped to 40..240')

  const badPre = buildPreset(state())
  badPre.loop.inPreMs = 4000
  assert.equal(validate(badPre), false, 'windows are capped at 3000 ms')

  const badCurve = buildPreset(state())
  badCurve.loop.curve = 'smoothstep'
  assert.equal(validate(badCurve), false, 'curve is limited to two values')
})
