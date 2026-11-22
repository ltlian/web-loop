import './style.css'
import { AudioEngine } from './engine.js'
import { WaveformView } from './waveform.js'
import { bakeLoop } from './loopbake.js'
import { computePeaks } from './peaks.js'
import { createFileDrop } from './file-drop.js'
import { buildPreset, PRESET_FORMAT } from './preset.js'
import { findOnsetNear } from './beats.js'

const $ = (id) => document.getElementById(id)
const el = {
  meta: $('meta'), timeline: $('timeline'), wave: $('wave'),
  playhead: $('playhead'), loading: $('loading'), play: $('play'), restart: $('restart'),
  loop: $('loop'), time: $('time'), duration: $('duration'), barpos: $('barpos'), status: $('status'),
  loopIn: $('loopIn'), loopOut: $('loopOut'),
  inPre: $('inPre'), inPreVal: $('inPreVal'), inPost: $('inPost'), inPostVal: $('inPostVal'),
  outPre: $('outPre'), outPreVal: $('outPreVal'), outPost: $('outPost'), outPostVal: $('outPostVal'),
  curve: $('curve'), loopInfo: $('loopInfo'),
  bpm: $('bpm'), barLenInfo: $('barLenInfo'), fitLoop: $('fitLoop'),
  bpmX2: $('bpmX2'), bpmD2: $('bpmD2'), tempoAlt: $('tempoCandidates'), tempoAltLabel: $('tempoAltLabel'),
  gridMs: $('gridMs'), gM2: $('gM2'), gM1: $('gM1'), gP1: $('gP1'), gP2: $('gP2'), g0: $('g0'),
  mini: $('minimap'), zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomFit: $('zoomFit'), zoomInfo: $('zoomInfo'),
  loadAudio: $('loadAudio'), audioFile: $('audioFile'),
  copyPreset: $('copyPreset'), loadPreset: $('loadPreset'),
  presetDialog: $('presetDialog'), presetText: $('presetText'), presetError: $('presetError'),
  cancelPreset: $('cancelPreset'), applyPreset: $('applyPreset'),
}

const engine = new AudioEngine()
const view = new WaveformView(el.wave, el.playhead, el.timeline, el.mini)
let track = null
let sourceName = ''
let sourceBuffer = null
let loopBuffer = null
let baked = null
let scrubbing = false
let resumeAfter = false
let drag = null
let lastDrawn = -1
let envelopeTimer = 0
let gridMs = 0
let bpm = 120
// where the current tempo came from: 'default' | 'pending' | 'auto' | 'manual' | 'preset'.
// A measurement only lands while it is still 'pending', so a preset or a user
// edit is never overwritten by a late worker result.
let tempoSource = 'default'
let tempoCandidates = []
let analysisId = 0
let beatWorker = null
// onset envelope of the current track, measured by the worker and reused by
// fit loop; null until the analysis lands or when it could not run.
let beatEnv = null
let beatFps = 0
let beatOffset = 0
let beatEnvMean = 0
let miniDrag = false
let panStart = null
const GRID_KEY = 'web-loop.gridOffsetMs'
const saveGrid = () => {
  try { localStorage.setItem(GRID_KEY, String(gridMs)) } catch {}
}

const loop = { enabled: false, start: 0, end: 0, inPreMs: 0, inPostMs: 0, outPreMs: 0, outPostMs: 120, curve: 'equal-power' }
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

const fmt = (t) => {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(3).padStart(6, '0')}`
}

const BPM_KEY = 'web-loop.bpm'
const barLenNow = () => 240 / bpm

const gridOriginNow = () => gridMs / 1000
const barsAt = (t) => (t - gridOriginNow()) / barLenNow()

const labelFor = (t) => {
  const b = barsAt(t)
  if (b < 0) return 'pre-grid'
  return `bar ${b.toFixed(2)}`
}

const setStatus = (msg, kind = '') => {
  el.status.textContent = msg || ''
  el.status.classList.toggle('error', kind === 'error')
  el.status.classList.toggle('ok', kind === 'ok')
}
const setLoading = (on) => el.loading.classList.toggle('hidden', !on)

function syncGridUi() {
  el.gridMs.value = String(Math.round(gridMs))
}

/** Keep the four edge sliders in step with the loop state. */
function syncEnvelopeUi() {
  el.inPre.value = String(loop.inPreMs)
  el.inPreVal.textContent = `${loop.inPreMs} ms`
  el.inPost.value = String(loop.inPostMs)
  el.inPostVal.textContent = `${loop.inPostMs} ms`
  el.outPre.value = String(loop.outPreMs)
  el.outPreVal.textContent = `${loop.outPreMs} ms`
  el.outPost.value = String(loop.outPostMs)
  el.outPostVal.textContent = `${loop.outPostMs} ms`
}

function renderControls() {
  el.play.textContent = engine.playing ? '❚❚ Pause' : '▶ Play'
}

/** The baked period starts on the in-marker; pre/post are overlaid inside it. */
function loopOrigin() {
  return loop.start
}

function currentSourceTime() {
  if (loopBuffer && engine.buffer === loopBuffer) return loopOrigin() + engine.position()
  return engine.position()
}

function updateReadout(t) {
  el.time.textContent = fmt(t)
  const b = barsAt(t)
  el.barpos.textContent = b < 0 ? 'pre-grid' : `bar ${b.toFixed(2)}`
}

function updateLoopInfo() {
  el.loopIn.textContent = `in ${labelFor(loop.start)}`
  el.loopOut.textContent = `out ${labelFor(loop.end)}`
  if (!baked || !sourceBuffer) { el.loopInfo.textContent = ''; return }
  const bars = baked.loopLength / barLenNow()
  const periodMs = (baked.periodSeconds * 1000).toFixed(0)
  const windowMs = (baked.windowSeconds * 1000).toFixed(0)
  const bodyMs = (baked.bodySeconds * 1000).toFixed(0)
  const inPre = (baked.inPreSeconds * 1000).toFixed(0)
  const inPost = (baked.inPostSeconds * 1000).toFixed(0)
  const outPre = (baked.outPreSeconds * 1000).toFixed(0)
  const outPost = (baked.outPostSeconds * 1000).toFixed(0)
  const seamDb = baked.wrapStep > 1e-9 ? (20 * Math.log10(baked.wrapStep)).toFixed(1) : '−∞'
  let text = `period ${periodMs} ms · ${bars.toFixed(3)} bars · window ${windowMs} ms · body ${bodyMs} ms · in ${inPre}+${inPost} ms · out ${outPre}+${outPost} ms · seam ${seamDb} dBFS`
  let warn = false
  if (baked.inPreClipped) { warn = true; text += ` · ⚠ in pre limited to ${inPre} ms` }
  if (baked.outPostClipped) { warn = true; text += ` · ⚠ out post limited to ${outPost} ms` }
  if (baked.fadeInClipped) { warn = true; text += ' · ⚠ fade-in window clipped' }
  if (baked.fadeOutClipped) { warn = true; text += ' · ⚠ fade-out window clipped' }
  if (baked.windowClipped) { warn = true; text += ' · ⚠ windows exceed the loop' }
  if (baked.wrapStep > 0.05) { warn = true; text += ' · ⚠ seam step is audible' }
  el.loopInfo.textContent = text
  el.loopInfo.classList.toggle('warn', warn)
}

/** Every source position that is audible right now. */
function edgeInGain(u) {
  const pre = baked.inPreSeconds, post = baked.inPostSeconds
  if (pre + post <= 0) return u < 0 ? 0 : 1
  if (u <= -pre) return 0
  if (u >= post) return 1
  const t = (u + pre) / (pre + post)
  return loop.curve === 'equal-power' ? Math.sin((t * Math.PI) / 2) : t
}

function edgeOutGain(u) {
  const pre = baked.outPreSeconds, post = baked.outPostSeconds
  if (pre + post <= 0) return u < 0 ? 1 : 0
  if (u <= -pre) return 1
  if (u >= post) return 0
  const t = (u + pre) / (pre + post)
  return loop.curve === 'equal-power' ? Math.cos((t * Math.PI) / 2) : 1 - t
}

function computeHeads(t = currentSourceTime()) {
  const heads = [{ t, kind: 'main' }]
  if (!(loop.enabled && baked && loopBuffer && engine.buffer === loopBuffer)) return heads
  const p = engine.position()
  const L = baked.loopLength
  if (p < baked.windowPostSeconds) {
    // post-roll is still sounding under the restarted head
    if (p < baked.outPostSeconds) {
      heads.push({ t: loop.end + p, kind: 'tail', gain: edgeOutGain(p), label: 'tail' })
    }
  } else if (p >= L - baked.windowPreSeconds) {
    // pre-roll has already started under the loop tail
    const u = p - L
    if (u >= -baked.inPreSeconds) {
      heads.push({ t: loop.start + u, kind: 'tail', gain: edgeInGain(u), label: 'lead' })
    }
  }
  return heads
}

function redraw(t = currentSourceTime()) {
  const loopView = loop.enabled
    ? {
        ...loop,
        inPre: baked?.inPreSeconds ?? loop.inPreMs / 1000,
        inPost: baked?.inPostSeconds ?? loop.inPostMs / 1000,
        outPre: baked?.outPreSeconds ?? loop.outPreMs / 1000,
        outPost: baked?.outPostSeconds ?? loop.outPostMs / 1000,
        effectiveEnd: loop.start + (baked?.loopLength ?? loop.end - loop.start),
      }
    : null
  view.setLoopEnvelope(loopView)
  view.drawOverlay({ position: t, loop: loopView, heads: computeHeads(t) })
  view.drawMinimap(loopView, t)
  updateReadout(t)
  lastDrawn = t
}

function updateZoomInfo() {
  if (!track) { el.zoomInfo.textContent = ''; return }
  const span = view.windowSpan()
  if (span >= track.duration - 1e-6) el.zoomInfo.textContent = 'full'
  else el.zoomInfo.textContent = `${(span / barLenNow()).toFixed(2)} bars`
}

function snapBar(t, free = false) {
  if (!track) return t
  if (free) return clamp(Math.round(t * 1000) / 1000, 0, track.duration)
  const b = barLenNow()
  const g = gridOriginNow()
  return clamp(g + Math.round((t - g) / b) * b, 0, track.duration)
}

const minLoop = () => barLenNow()

function bakeNow() {
  if (!sourceBuffer || !engine.ctx) return
  baked = bakeLoop(engine.ctx, sourceBuffer, {
    start: loop.start, end: loop.end,
    inPre: loop.inPreMs / 1000, inPost: loop.inPostMs / 1000,
    outPre: loop.outPreMs / 1000, outPost: loop.outPostMs / 1000,
    curve: loop.curve,
  })
  loopBuffer = baked.buffer
  updateLoopInfo()
}

function applyLoopBuffer(srcTime, wasPlaying) {
  engine.setBuffer(loopBuffer)
  engine.setLoop(true)
  const pos = clamp(srcTime - loopOrigin(), 0, Math.max(0, baked.loopLength - 0.0005))
  engine.seek(pos)
  if (wasPlaying) engine.play(pos)
}

/** Rebuild the baked loop and keep playback coherent. */
function rebake() {
  if (!sourceBuffer) return
  const wasPlaying = engine.playing
  const srcTime = currentSourceTime()
  engine.pause()
  bakeNow()
  if (loop.enabled) applyLoopBuffer(srcTime, wasPlaying)
  else if (wasPlaying) engine.play(clamp(srcTime, 0, sourceBuffer.duration))
  renderControls()
  redraw()
}

function setLoopEnabled(enabled) {
  if (!sourceBuffer) { el.loop.checked = false; return }
  const wasPlaying = engine.playing
  const srcTime = currentSourceTime()
  engine.pause()
  loop.enabled = enabled
  if (enabled) {
    if (!baked) bakeNow()
    applyLoopBuffer(srcTime, wasPlaying)
  } else {
    engine.setBuffer(sourceBuffer)
    engine.setLoop(false)
    const pos = clamp(srcTime, 0, sourceBuffer.duration)
    engine.seek(pos)
    if (wasPlaying) engine.play(pos)
  }
  renderControls()
  redraw()
}

function saveBpm() { try { localStorage.setItem(BPM_KEY, String(bpm)) } catch {} }

function syncTempoUi() {
  el.bpm.value = bpm.toFixed(2)
  el.barLenInfo.textContent = `${barLenNow().toFixed(3)} s/bar`
}

function setBpm(value, { snapLoop = true } = {}) {
  bpm = clamp(Number(value) || bpm, 40, 240)
  saveBpm()
  syncTempoUi()
  if (!track) return
  view.setBarLen(barLenNow())
  view.setGrid(gridOriginNow())
  if (snapLoop) {
    const s = snapBar(loop.start)
    const e = Math.max(snapBar(loop.end), s + barLenNow())
    loop.start = clamp(s, 0, track.duration)
    loop.end = clamp(e, 0, track.duration)
  }
  updateZoomInfo()
  rebake()
  updateMeta()
  syncTempoAlt()
}

/** Downmix to mono for analysis; playback keeps the original buffer. */
function downmix(buffer) {
  const n = buffer.length
  const out = new Float32Array(n)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c)
    for (let i = 0; i < n; i++) out[i] += d[i]
  }
  const gain = 1 / Math.max(1, buffer.numberOfChannels)
  for (let i = 0; i < n; i++) out[i] *= gain
  return out
}

function ensureBeatWorker() {
  if (!beatWorker) {
    beatWorker = new Worker(new URL('./beats.worker.js', import.meta.url), { type: 'module' })
    beatWorker.onmessage = onAnalysis
    beatWorker.onerror = (e) => {
      beatWorker = null
      setStatus(`tempo measurement failed: ${e.message || 'worker error'}`, 'error')
    }
  }
  return beatWorker
}

/** Measure the track in the background; the result lands in onAnalysis. */
function startAnalysis(buffer) {
  beatEnv = null
  tempoCandidates = []
  syncTempoAlt()
  const samples = downmix(buffer)
  const id = ++analysisId
  setStatus('measuring tempo…')
  try {
    ensureBeatWorker().postMessage({ samples: samples.buffer, sr: buffer.sampleRate, id }, [samples.buffer])
  } catch (err) {
    setStatus(`tempo measurement failed: ${err.message || err}`, 'error')
  }
}

/** Adopt the measurement only while the tempo is still unclaimed. */
function onAnalysis(e) {
  const data = e.data
  if (!data || data.id !== analysisId) return
  if (!data.ok) {
    setStatus(`could not measure the tempo: ${data.reason}`, 'error')
    return
  }
  beatEnv = data.env
  beatFps = data.fps
  beatOffset = data.offset
  let sum = 0
  for (const v of beatEnv) sum += v
  beatEnvMean = beatEnv.length ? sum / beatEnv.length : 0
  tempoCandidates = (data.candidates || [])
    .map((c) => c.bpm)
    .filter((v) => Number.isFinite(v) && v >= 40 && v <= 240)
  syncTempoAlt()
  if (tempoSource !== 'pending') return
  applyDetectedTempo(data.bpm, data.gridOffsetMs)
  tempoSource = 'auto'
  const phase = data.downbeatMargin > 0.05 ? 'downbeat found' : 'bar phase unsure'
  setStatus(`auto ${bpm.toFixed(2)} BPM · ${data.confidence.toFixed(1)}× onset strength · ${phase}`, 'ok')
}

/** Set tempo and grid together, then put the loop back on whole bars. */
function applyDetectedTempo(nextBpm, nextGridMs) {
  bpm = clamp(nextBpm, 40, 240)
  gridMs = nextGridMs
  saveBpm()
  saveGrid()
  syncTempoUi()
  syncGridUi()
  if (!track) return
  view.setBarLen(barLenNow())
  view.setGrid(gridOriginNow())
  const s = snapBar(loop.start)
  const e = Math.max(snapBar(loop.end), s + barLenNow())
  loop.start = clamp(s, 0, track.duration)
  loop.end = clamp(e, 0, track.duration)
  updateZoomInfo()
  rebake()
  updateMeta()
  redraw()
}

/** Offer the tempos that competed with the measurement; picking one is how a
 *  half-time or three-against-two reading gets corrected. */
function syncTempoAlt() {
  if (!el.tempoAlt) return
  const list = tempoCandidates.slice(0, 4)
  el.tempoAlt.hidden = list.length < 2
  if (el.tempoAltLabel) el.tempoAltLabel.hidden = el.tempoAlt.hidden
  el.tempoAlt.replaceChildren()
  if (list.length < 2) return
  for (const c of list) {
    const option = document.createElement('option')
    option.value = String(c)
    option.textContent = c.toFixed(2)
    el.tempoAlt.append(option)
  }
  const match = list.find((c) => Math.abs(c - bpm) < 0.06)
  el.tempoAlt.value = match == null ? '' : String(match)
}

/** The grid beat nearest to t under the current tempo. */
function nearestBeat(t, beatLen) {
  return gridOriginNow() + Math.round((t - gridOriginNow()) / beatLen) * beatLen
}

/**
 * Onset at the beat nearest a marker. The search is guided by the grid on
 * purpose: a pickup can be louder than the bar line, so the loudest transient
 * in a wide window is the wrong answer even though it looks right.
 */
function onsetForMarker(t, beatLen) {
  const pred = nearestBeat(t, beatLen)
  const floor = beatEnvMean * 0.5
  const narrow = findOnsetNear(beatEnv, beatFps, pred, 0.03, { offset: beatOffset, floor })
  if (narrow.found) return { ...narrow, sure: true }
  const wide = findOnsetNear(beatEnv, beatFps, pred, 0.09, { offset: beatOffset, floor })
  return wide.found ? { ...wide, sure: false } : { found: false }
}

/** Fit BPM + grid phase so both loop boundaries sit on measured onsets. */
function fitLoopToAudio() {
  if (!track || !sourceBuffer) return
  if (!loop.enabled) { setStatus('enable Loop region first'); return }
  if (!beatEnv) { setStatus('tempo analysis is still running — try again in a moment'); return }
  const startBar = barsAt(loop.start)
  const endBar = barsAt(loop.end)
  const nBars = Math.max(1, Math.round(endBar - startBar))
  const tS = onsetForMarker(loop.start, 60 / bpm)
  const tE = onsetForMarker(loop.end, 60 / bpm)
  if (!tS.found || !tE.found) {
    setStatus('no clear beat near a loop end — nudge the marker and try again', 'error')
    return
  }
  if (!(tE.time > tS.time + nBars * 0.1)) {
    setStatus('the two loop ends are too close to fit a tempo', 'error')
    return
  }
  const fitted = clamp((240 * nBars) / (tE.time - tS.time), 40, 240)
  // a two-point fit always hits its endpoints; check the beats in between
  const beatLen = 60 / fitted
  const floor = beatEnvMean * 0.5
  let hits = 0
  const total = Math.max(0, nBars * 4 - 1)
  for (let k = 1; k < nBars * 4; k++) {
    const at = findOnsetNear(beatEnv, beatFps, tS.time + k * beatLen, 0.03, { offset: beatOffset, floor })
    if (at.found) hits++
  }
  const aligned = total ? hits / total : 1
  bpm = fitted
  saveBpm()
  const bl = barLenNow()
  const k = Math.round(startBar)
  gridMs = (tS.time - k * bl) * 1000
  saveGrid()
  syncGridUi()
  const g = gridOriginNow()
  loop.start = clamp(g + k * bl, 0, track.duration)
  loop.end = clamp(loop.start + nBars * bl, 0, track.duration)
  view.setBarLen(bl)
  view.setGrid(g)
  syncTempoUi()
  updateZoomInfo()
  rebake()
  updateMeta()
  tempoSource = 'manual'
  syncTempoAlt()
  const weak = aligned < 0.5
  const loose = !tS.sure || !tE.sure
  const notes = []
  if (weak) notes.push(`⚠ only ${Math.round(aligned * 100)}% of interior beats line up`)
  if (loose) notes.push('⚠ weak onset near a loop end')
  const note = notes.length ? ` · ${notes.join(' · ')}` : ''
  setStatus(`fitted ${bpm.toFixed(2)} BPM · ${nBars} bars · ${(loop.end - loop.start).toFixed(3)} s${note}`, weak ? 'error' : 'ok')
}

function setPresetEnabled(on) {
  el.copyPreset.disabled = !on
  el.loadPreset.disabled = !on
}

function updateMeta() {
  if (!track) return
  const first = Math.max(0, gridOriginNow())
  const bars = track.duration > first ? (track.duration - first) / barLenNow() : 0
  const prefix = sourceName ? `${sourceName} · ` : ''
  el.meta.textContent = `${prefix}${bpm.toFixed(2)} BPM · ${barLenNow().toFixed(3)} s/bar · ${bars.toFixed(2)} bars · ${track.duration.toFixed(2)} s`
}

let loadToken = 0

/**
 * Decode the chosen file and use it as the track. Nothing leaves the browser:
 * there is no audio in the app and nothing is uploaded.
 */
async function loadAudioFile(file) {
  if (!file) return
  const my = ++loadToken
  setStatus('')
  setLoading(true)
  el.loading.textContent = 'decoding…'
  try {
    const buffer = await engine.decode(await file.arrayBuffer())
    if (my !== loadToken) return
    const peaks = computePeaks(buffer)
    if (my !== loadToken) return
    engine.stop()
    sourceBuffer = buffer
    sourceName = file.name
    track = { duration: buffer.duration, peaks }
    bpm = clamp(Number(localStorage.getItem(BPM_KEY)) || 120, 40, 240)
    gridMs = Number(localStorage.getItem(GRID_KEY)) || 0
    loop.enabled = false
    loop.inPreMs = 0
    loop.inPostMs = 0
    loop.outPreMs = 0
    loop.outPostMs = 120
    loop.curve = 'equal-power'
    baked = null
    loopBuffer = null
    view.setBuffer(sourceBuffer)
    view.setTrack(track, barLenNow(), gridOriginNow())
    view.setGrid(gridOriginNow())
    syncTempoUi()
    syncGridUi()
    el.curve.value = loop.curve
    el.loop.checked = false
    syncEnvelopeUi()

    // Default to whole bars, leaving a little tail after the last one.
    const bar = barLenNow()
    const origin = gridOriginNow()
    const first = origin >= 0 ? origin : origin + Math.ceil(-origin / bar) * bar
    const start = clamp(first, 0, track.duration)
    const limit = track.duration - Math.min(0.25, bar * 0.5)
    let end = start + Math.floor((limit - start) / bar + 1e-6) * bar
    if (!(end > start + 1e-6)) end = track.duration
    loop.start = start
    loop.end = clamp(end, 0, track.duration)

    engine.setBuffer(sourceBuffer)
    engine.setLoop(false)
    view.setWindow(0, track.duration)
    updateZoomInfo()
    bakeNow()
    el.duration.textContent = fmt(track.duration)
    updateMeta()
    setPresetEnabled(true)
    renderControls()
    redraw(0)
    setLoading(false)
    // measure after the UI is up; the result lands in onAnalysis
    tempoSource = 'pending'
    startAnalysis(buffer)
  } catch (err) {
    if (my !== loadToken) return
    setStatus(`could not load ${file.name}: ${err.message || err}`, 'error')
    if (track) setLoading(false)
    else { el.loading.textContent = 'choose audio · or drop a file'; setLoading(true) }
  }
}

function currentPreset() {
  return buildPreset({ track, sourceName, bpm, gridMs, loop })
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.append(ta)
  ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch {}
  ta.remove()
  return ok
}

async function copyPreset() {
  if (!track) { setStatus('load audio first', 'error'); return }
  const text = JSON.stringify(currentPreset(), null, 2)
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
    else if (!fallbackCopy(text)) throw new Error('clipboard unavailable')
    setStatus('preset copied to clipboard', 'ok')
  } catch (err) {
    if (fallbackCopy(text)) { setStatus('preset copied to clipboard', 'ok'); return }
    setStatus(`could not copy: ${err.message || err}`, 'error')
  }
}

function showPresetError(message) {
  el.presetError.textContent = message
}

function openPresetDialog() {
  if (!track) { setStatus('load audio first', 'error'); return }
  el.presetError.textContent = ''
  el.presetText.value = ''
  el.presetDialog.showModal()
  el.presetText.focus()
}

async function applyPreset() {
  if (!track) { showPresetError('load audio first'); return }
  const raw = el.presetText.value.trim()
  if (!raw) { showPresetError('paste a preset JSON first'); return }
  let data
  try {
    data = JSON.parse(raw)
  } catch (err) {
    showPresetError(`invalid JSON: ${err.message}`)
    return
  }
  if (!data || typeof data !== 'object') { showPresetError('the preset must be a JSON object'); return }
  if (data.format && data.format !== PRESET_FORMAT) {
    showPresetError(`unexpected format "${data.format}" (expected "${PRESET_FORMAT}")`)
    return
  }
  const l = data.loop && typeof data.loop === 'object' ? data.loop : {}
  const start = Number(l.start)
  const end = Number(l.end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) { showPresetError('loop.start and loop.end must be numbers'); return }
  if (end <= start + 0.001) { showPresetError('loop.end must be after loop.start'); return }
  const curve = l.curve === 'linear' ? 'linear' : 'equal-power'
  const edgeMs = (key) => clamp(Number(l[key]) || 0, 0, 3000)
  const nextBpm = Number(data.bpm)
  const nextGrid = Number(data.gridOffsetMs)

  try {
    if (Number.isFinite(nextBpm) && nextBpm > 0) setBpm(clamp(nextBpm, 40, 240), { snapLoop: false })
    if (Number.isFinite(nextGrid)) setGridMs(nextGrid)
    const max = track.duration
    const span = Math.min(minLoop(), max)
    loop.start = clamp(start, 0, Math.max(0, max - span))
    loop.end = clamp(end, loop.start + span, max)
    loop.inPreMs = edgeMs('inPreMs')
    loop.inPostMs = edgeMs('inPostMs')
    loop.outPreMs = edgeMs('outPreMs')
    loop.outPostMs = edgeMs('outPostMs')
    loop.curve = curve
    el.curve.value = curve
    syncEnvelopeUi()
    el.loop.checked = !!l.enabled
    baked = null
    loopBuffer = null
    if (l.enabled) setLoopEnabled(true)
    else { rebake(); redraw(loop.start) }
    updateMeta()
    // the preset owns the tempo now; a late measurement must not replace it
    tempoSource = 'preset'
    syncTempoAlt()
    el.presetDialog.close()
    setStatus('preset loaded', 'ok')
  } catch (err) {
    showPresetError(String(err.message || err))
  }
}

async function togglePlay() {
  try {
    if (engine.playing) engine.pause()
    else { await engine.resume(); engine.play() }
  } catch (err) { setStatus(String(err.message || err), 'error') }
  renderControls()
  redraw()
}

function seekSource(t) {
  const target = clamp(t, 0, track?.duration ?? 0)
  if (loopBuffer && engine.buffer === loopBuffer) {
    engine.seek(clamp(target - loopOrigin(), 0, Math.max(0, baked.loopLength - 0.0005)))
  } else {
    engine.seek(target)
  }
  redraw(target)
}

function seekToClientX(clientX) {
  const rect = el.timeline.getBoundingClientRect()
  seekSource(view.timeForX(clientX - rect.left))
}

function handleNear(clientX) {
  if (!loop.enabled) return null
  const rect = el.timeline.getBoundingClientRect()
  const x = clientX - rect.left
  const clampX = (x) => Math.min(view.w - 2, Math.max(2, x))
  const xs = clampX(view.xForTime(loop.start))
  const xe = clampX(view.xForTime(loop.end))
  if (Math.abs(x - xs) <= 8) return 'start'
  if (Math.abs(x - xe) <= 8) return 'end'
  return null
}

el.timeline.addEventListener('pointerdown', (e) => {
  if (e.shiftKey && track) {
    panStart = { x: e.clientX, start: view.viewStart, end: view.viewEnd }
    el.timeline.setPointerCapture(e.pointerId)
    el.timeline.style.cursor = 'grabbing'
    return
  }
  const near = handleNear(e.clientX)
  el.timeline.setPointerCapture(e.pointerId)
  if (near) {
    drag = near
    tempoSource = 'manual' // the user is placing the loop; a late measurement must not move it
    return
  }
  scrubbing = true
  resumeAfter = engine.playing
  if (engine.playing) engine.pause()
  seekToClientX(e.clientX)
  renderControls()
})

el.timeline.addEventListener('pointermove', (e) => {
  if (panStart) {
    const rect = el.timeline.getBoundingClientRect()
    const span = panStart.end - panStart.start
    const dt = -((e.clientX - panStart.x) / rect.width) * span
    view.setWindow(panStart.start + dt, panStart.end + dt)
    updateZoomInfo()
    redraw()
    return
  }
  if (drag) {
    const rect = el.timeline.getBoundingClientRect()
    // ctrl as well as alt: many Linux window managers claim alt-drag to move
    // the window, so the page never sees it
    const free = e.altKey || e.ctrlKey || e.metaKey
    const t = snapBar(view.timeForX(e.clientX - rect.left), free)
    if (drag === 'start') loop.start = clamp(t, 0, loop.end - minLoop())
    else loop.end = clamp(t, loop.start + minLoop(), track.duration)
    updateLoopInfo()
    redraw()
    return
  }
  if (scrubbing) { seekToClientX(e.clientX); return }
  el.timeline.style.cursor = handleNear(e.clientX) ? 'ew-resize' : 'crosshair'
})

function endPointer(e) {
  if (panStart) {
    panStart = null
    el.timeline.style.cursor = 'crosshair'
    return
  }
  if (drag) {
    const wasDrag = drag
    drag = null
    if (wasDrag) rebake()
    return
  }
  if (!scrubbing) return
  scrubbing = false
  if (resumeAfter) engine.play()
  resumeAfter = false
  renderControls()
}
el.timeline.addEventListener('pointerup', endPointer)
el.timeline.addEventListener('pointercancel', endPointer)

function setGridMs(ms) {
  const delta = (ms - gridMs) / 1000
  gridMs = ms
  saveGrid()
  syncGridUi()
  if (!track) return
  view.setGrid(gridOriginNow())
  if (delta !== 0) {
    let s = clamp(loop.start + delta, 0, track.duration)
    let e = clamp(loop.end + delta, 0, track.duration)
    if (e - s < minLoop()) e = Math.min(track.duration, s + minLoop())
    loop.start = s
    loop.end = e
  }
  updateLoopInfo()
  rebake()
  updateMeta()
}

const nudgeBeats = (n) => setGridMs(gridMs + n * (barLenNow() / 4) * 1000)
el.gM2.addEventListener('click', () => nudgeBeats(-2))
el.gM1.addEventListener('click', () => nudgeBeats(-1))
el.gP1.addEventListener('click', () => nudgeBeats(1))
el.gP2.addEventListener('click', () => nudgeBeats(2))
el.g0.addEventListener('click', () => setGridMs(0))
el.gridMs.addEventListener('change', () => setGridMs(Number(el.gridMs.value) || 0))
el.bpm.addEventListener('change', () => {
  tempoSource = 'manual'
  setBpm(Number(el.bpm.value))
})

/** Metrical corrections: the measurement cannot always tell 128 from 64 or
 *  from 85, so offer the two most common moves and the candidates themselves. */
function scaleTempo(factor) {
  if (!track) return
  const next = clamp(bpm * factor, 40, 240)
  if (Math.abs(next - bpm) < 1e-6) { setStatus(`cannot scale ${bpm.toFixed(2)} BPM by ${factor}× inside 40–240`, 'error'); return }
  tempoSource = 'manual'
  setBpm(next)
  syncTempoAlt()
}
el.bpmX2.addEventListener('click', () => scaleTempo(2))
el.bpmD2.addEventListener('click', () => scaleTempo(0.5))
el.tempoAlt.addEventListener('change', () => {
  const next = Number(el.tempoAlt.value)
  if (!Number.isFinite(next) || next <= 0) return
  tempoSource = 'manual'
  setBpm(next)
})

el.fitLoop.addEventListener('click', fitLoopToAudio)

el.timeline.addEventListener('wheel', (e) => {
  if (!track) return
  e.preventDefault()
  const rect = el.timeline.getBoundingClientRect()
  if (e.shiftKey) {
    view.panBy((e.deltaY / 800) * view.windowSpan())
  } else {
    const t = view.timeForX(e.clientX - rect.left)
    view.zoomAt(t, Math.exp(e.deltaY * 0.0015))
  }
  updateZoomInfo()
  redraw()
}, { passive: false })

function minimapTo(e) {
  if (!track) return
  const rect = el.mini.getBoundingClientRect()
  const t = clamp(((e.clientX - rect.left) / rect.width) * track.duration, 0, track.duration)
  const span = view.windowSpan()
  view.setWindow(clamp(t - span / 2, 0, track.duration - span), clamp(t - span / 2, 0, track.duration - span) + span)
  updateZoomInfo()
  redraw()
}
el.mini.addEventListener('pointerdown', (e) => {
  miniDrag = true
  el.mini.setPointerCapture(e.pointerId)
  minimapTo(e)
})
el.mini.addEventListener('pointermove', (e) => { if (miniDrag) minimapTo(e) })
const endMini = () => { miniDrag = false }
el.mini.addEventListener('pointerup', endMini)
el.mini.addEventListener('pointercancel', endMini)

const zoomBy = (factor) => {
  if (!track) return
  view.zoomAt(view.viewStart + view.windowSpan() / 2, factor)
  updateZoomInfo()
  redraw()
}
el.zoomIn.addEventListener('click', () => zoomBy(1 / 1.5))
el.zoomOut.addEventListener('click', () => zoomBy(1.5))
el.zoomFit.addEventListener('click', () => { if (track) { view.setWindow(0, track.duration); updateZoomInfo(); redraw() } })

el.play.addEventListener('click', togglePlay)
el.restart.addEventListener('click', () => seekSource(0))
el.loop.addEventListener('change', () => setLoopEnabled(el.loop.checked))
el.curve.addEventListener('change', () => { loop.curve = el.curve.value; rebake() })

const bindEdge = (key, input, label) => {
  input.addEventListener('input', () => {
    loop[key] = Number(input.value)
    label.textContent = `${loop[key]} ms`
    clearTimeout(envelopeTimer)
    envelopeTimer = setTimeout(rebake, 140)
  })
}
bindEdge('inPreMs', el.inPre, el.inPreVal)
bindEdge('inPostMs', el.inPost, el.inPostVal)
bindEdge('outPreMs', el.outPre, el.outPreVal)
bindEdge('outPostMs', el.outPost, el.outPostVal)

const fileDrop = createFileDrop(document, {
  stage: el.timeline,
  onFile: (file) => loadAudioFile(file),
  onError: (msg) => setStatus(msg, 'error'),
})
el.loadAudio.addEventListener('click', () => fileDrop.openPicker())
el.loading.addEventListener('click', () => { if (!track) fileDrop.openPicker() })
el.copyPreset.addEventListener('click', copyPreset)
el.loadPreset.addEventListener('click', openPresetDialog)
el.cancelPreset.addEventListener('click', () => el.presetDialog.close())
el.applyPreset.addEventListener('click', applyPreset)
el.presetDialog.addEventListener('click', (e) => { if (e.target === el.presetDialog) el.presetDialog.close() })
el.presetText.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); applyPreset() }
})

window.addEventListener('keydown', (e) => {
  const tag = (e.target?.tagName || '').toLowerCase()
  if (tag === 'select' || tag === 'input' || tag === 'textarea' || tag === 'button') return
  if (e.code === 'Space') { e.preventDefault(); togglePlay() }
  if (e.code === 'Home') { e.preventDefault(); seekSource(0) }
  if (e.key === '[') { e.preventDefault(); nudgeBeats(-1) }
  if (e.key === ']') { e.preventDefault(); nudgeBeats(1) }
  if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1 / 1.5) }
  if (e.key === '-') { e.preventDefault(); zoomBy(1.5) }
  if (e.key === '0') { e.preventDefault(); if (track) { view.setWindow(0, track.duration); updateZoomInfo(); redraw() } }
})

engine.onEnded = () => { renderControls(); redraw(currentSourceTime()) }

new ResizeObserver(() => { if (track) { view.resize(); redraw() } }).observe(el.timeline)

function tick() {
  const t = currentSourceTime()
  if (engine.playing && track && view.windowSpan() < track.duration - 1e-6 && !scrubbing && !drag && !panStart && !miniDrag) {
    if (t < view.viewStart || t > view.viewEnd) {
      const span = view.windowSpan()
      const s = clamp(t - span * 0.25, 0, track.duration - span)
      view.setWindow(s, s + span)
      updateZoomInfo()
    }
  }
  if (Math.abs(t - lastDrawn) > 0.0005) redraw(t)
  requestAnimationFrame(tick)
}

function boot() {
  bpm = clamp(Number(localStorage.getItem(BPM_KEY)) || 120, 40, 240)
  gridMs = Number(localStorage.getItem(GRID_KEY)) || 0
  syncTempoUi()
  syncGridUi()
  el.meta.textContent = 'load the audio file to begin'
  el.loading.textContent = 'choose audio · or drop a file'
  setLoading(true)
  requestAnimationFrame(tick)
  window.__workbench = {
    engine,
    get loaded() { return !!track },
    get track() { return sourceName },
    get duration() { return track?.duration ?? 0 },
    get loop() { return { ...loop } },
    get baked() { return baked && { loopLength: baked.loopLength, periodSeconds: baked.periodSeconds, inPreSeconds: baked.inPreSeconds, inPostSeconds: baked.inPostSeconds, outPreSeconds: baked.outPreSeconds, outPostSeconds: baked.outPostSeconds, windowPreSeconds: baked.windowPreSeconds, windowPostSeconds: baked.windowPostSeconds, windowSeconds: baked.windowSeconds, bodySeconds: baked.bodySeconds, wrapStep: baked.wrapStep, inPreClipped: baked.inPreClipped, outPostClipped: baked.outPostClipped, fadeInClipped: baked.fadeInClipped, fadeOutClipped: baked.fadeOutClipped, windowClipped: baked.windowClipped } },
    get preset() { return currentPreset() },
    get sourceTime() { return currentSourceTime() },
    get barLen() { return barLenNow() },
    get hasLoopBuffer() { return !!loopBuffer },
    get gridMs() { return gridMs },
    get gridOrigin() { return gridOriginNow() },
    get bpm() { return bpm },
    get tempoSource() { return tempoSource },
    get tempoCandidates() { return tempoCandidates.slice() },
    get heads() { return computeHeads(currentSourceTime()) },
    redraw,
    get viewSpan() { return view.windowSpan() },
    get viewStart() { return view.viewStart },
    loadAudio: loadAudioFile,
  }
}

boot()
