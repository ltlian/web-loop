import './style.css'
import { AudioEngine } from './engine.js'
import { WaveformView } from './waveform.js'
import { bakeLoop } from './loopbake.js'
import { computePeaks } from './peaks.js'
import { createFileDrop } from './file-drop.js'

const $ = (id) => document.getElementById(id)
const el = {
  meta: $('meta'), timeline: $('timeline'), wave: $('wave'),
  playhead: $('playhead'), loading: $('loading'), play: $('play'), restart: $('restart'),
  loop: $('loop'), time: $('time'), duration: $('duration'), barpos: $('barpos'), status: $('status'),
  loopIn: $('loopIn'), loopOut: $('loopOut'), fade: $('fade'), fadeVal: $('fadeVal'),
  mode: $('mode'), curve: $('curve'), loopInfo: $('loopInfo'),
  bpm: $('bpm'), barLenInfo: $('barLenInfo'), fitLoop: $('fitLoop'),
  gridMs: $('gridMs'), gridVal: $('gridVal'), gM2: $('gM2'), gM1: $('gM1'), gP1: $('gP1'), gP2: $('gP2'), g0: $('g0'),
  mini: $('minimap'), zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomFit: $('zoomFit'), zoomInfo: $('zoomInfo'),
  loadAudio: $('loadAudio'), audioFile: $('audioFile'),
  copySetup: $('copySetup'), loadSetup: $('loadSetup'),
  setupDialog: $('setupDialog'), setupText: $('setupText'), setupError: $('setupError'),
  cancelSetup: $('cancelSetup'), applySetup: $('applySetup'),
}

const SETUP_FORMAT = 'web-loop/setup'

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
let fadeTimer = 0
let gridMs = 0
let bpm = 120
let miniDrag = false
let panStart = null
const GRID_KEY = 'web-loop.gridOffsetMs'
const saveGrid = () => {
  try { localStorage.setItem(GRID_KEY, String(gridMs)) } catch {}
}

const loop = { enabled: false, start: 0, end: 0, fadeMs: 120, mode: 'keep', curve: 'equal-power' }
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
  el.gridVal.textContent = `${Math.round(gridMs)} ms`
}

function renderControls() {
  el.play.textContent = engine.playing ? '❚❚ Pause' : '▶ Play'
}

function currentSourceTime() {
  if (loopBuffer && engine.buffer === loopBuffer) return loop.start + engine.position()
  return engine.position()
}

function updateReadout(t) {
  el.time.textContent = fmt(t)
  const b = barsAt(t)
  el.barpos.textContent = b < 0 ? 'pre-grid' : `bar ${b.toFixed(2)}`
}

function updateLoopInfo() {
  el.fadeVal.textContent = `${loop.fadeMs} ms`
  el.loopIn.textContent = `in ${labelFor(loop.start)}`
  el.loopOut.textContent = `out ${labelFor(loop.end)}`
  if (!baked || !sourceBuffer) { el.loopInfo.textContent = ''; return }
  const bars = baked.loopLength / barLenNow()
  const fade = (baked.fadeSeconds * 1000).toFixed(0)
  const ms = (baked.loopLength * 1000).toFixed(1)
  const smp = Math.round(baked.loopLength * (sourceBuffer?.sampleRate ?? 48000))
  const region = loop.end - loop.start
  const short = Math.abs(baked.loopLength - region) > 0.0005 ? ` · region ${(region * 1000).toFixed(0)} ms` : ''
  const modeLabel = baked.mode === 'keep' ? 'post-roll' : baked.mode === 'lead' ? 'lead-in' : 'shorten'
  let text = `${modeLabel} · ${bars.toFixed(3)} bars · ${ms} ms · ${smp} smp · fade ${fade} ms${short}`
  let warn = baked.fadeSeconds > baked.loopLength * 0.08
  const req = (baked.requestedFadeSeconds * 1000).toFixed(0)
  if (baked.mode === 'keep' && baked.tailClipped) {
    warn = true
    if (baked.tailAvailableSeconds <= 0.00001) text += ` · ⚠ no audio after loop end (requested ${req} ms)`
    else text += ` · ⚠ tail limited to ${(baked.tailAvailableSeconds * 1000).toFixed(0)} of ${req} ms requested`
  }
  if (baked.mode === 'lead' && baked.preClipped) {
    warn = true
    if (baked.preAvailableSeconds <= 0.00001) text += ` · ⚠ no audio before loop start (requested ${req} ms)`
    else text += ` · ⚠ lead-in limited to ${(baked.preAvailableSeconds * 1000).toFixed(0)} of ${req} ms (pre-roll ends)`
  }
  if (baked.fadeClipped) text += ` · ⚠ fade capped at half the loop`
  if (baked.mode === 'keep' && !baked.tailClipped && baked.tailAvailableSeconds > 0) text += ` · post-roll ${baked.tailAvailableSeconds.toFixed(2)} s`
  if (baked.mode === 'lead' && !baked.preClipped && baked.preAvailableSeconds > 0) text += ` · pre-roll ${baked.preAvailableSeconds.toFixed(2)} s`
  el.loopInfo.textContent = text
  el.loopInfo.classList.toggle('warn', warn)
}

/** Every source position that is audible right now. */
function computeHeads(t = currentSourceTime()) {
  const heads = [{ t, kind: 'main' }]
  if (loop.enabled && baked && loopBuffer && engine.buffer === loopBuffer && baked.fadeSeconds > 1e-4) {
    const p = engine.position()
    const fade = baked.fadeSeconds
    if (baked.mode === 'keep' || baked.mode === 'shorten') {
      if (p < fade) {
        const otherT = baked.mode === 'keep' ? loop.end + p : loop.end - fade + p
        const u = p / fade
        const gain = loop.curve === 'equal-power' ? Math.cos((u * Math.PI) / 2) : 1 - u
        if (otherT >= 0 && track && otherT <= track.duration) heads.push({ t: otherT, kind: 'tail', gain, label: 'tail' })
      }
    } else if (baked.mode === 'lead') {
      const L = baked.loopLength
      if (p >= L - fade) {
        const u = (p - (L - fade)) / fade
        const gain = loop.curve === 'equal-power' ? Math.sin((u * Math.PI) / 2) : u
        const leadT = loop.start + p - L
        if (leadT >= 0 && track && leadT <= track.duration) heads.push({ t: leadT, kind: 'tail', gain, label: 'lead' })
      }
    }
  }
  return heads
}

function redraw(t = currentSourceTime()) {
  const loopView = loop.enabled
    ? {
        ...loop,
        fade: baked?.fadeSeconds ?? loop.fadeMs / 1000,
        effectiveEnd: loop.start + (baked?.loopLength ?? loop.end - loop.start),
      }
    : null
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
  if (free) return clamp(Math.round(t * 20) / 20, 0, track.duration)
  const b = barLenNow()
  const g = gridOriginNow()
  return clamp(g + Math.round((t - g) / b) * b, 0, track.duration)
}

const minLoop = () => barLenNow()

function bakeNow() {
  if (!sourceBuffer || !engine.ctx) return
  baked = bakeLoop(engine.ctx, sourceBuffer, {
    start: loop.start, end: loop.end,
    fade: loop.fadeMs / 1000, mode: loop.mode, curve: loop.curve,
  })
  loopBuffer = baked.buffer
  updateLoopInfo()
}

function applyLoopBuffer(srcTime, wasPlaying) {
  engine.setBuffer(loopBuffer)
  engine.setLoop(true)
  const pos = clamp(srcTime - loop.start, 0, Math.max(0, baked.loopLength - 0.0005))
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
}

/** Onset (attack) time near t, using a 150 Hz low-band energy rise. */
function findOnsetNear(buffer, t, radius = 0.15) {
  const sr = buffer.sampleRate
  const ch = buffer.getChannelData(0)
  const a = 1 - Math.exp((-2 * Math.PI * 150) / sr)
  const pre = Math.round(0.06 * sr)
  const start = Math.max(0, Math.floor((t - radius) * sr))
  const end = Math.min(ch.length, Math.floor((t + radius) * sr))
  let lp = 0
  for (let i = Math.max(0, start - pre); i < start; i++) lp += a * (ch[i] - lp)
  const frame = Math.max(1, Math.round(0.002 * sr))
  const times = [], energy = []
  for (let i = start; i < end; i += frame) {
    let e = 0, c = 0
    for (let j = i; j < Math.min(end, i + frame); j++) { lp += a * (ch[j] - lp); e += lp * lp; c++ }
    times.push((i + frame / 2) / sr)
    energy.push(e / (c || 1))
  }
  let bestT = t, best = -Infinity
  const lag = 5
  for (let i = lag; i < energy.length; i++) {
    const s = energy[i] - energy[i - lag]
    if (s > best) { best = s; bestT = times[i] }
  }
  return bestT
}

/** Fit BPM + grid phase so both loop boundaries sit on the detected onsets. */
function fitLoopToAudio() {
  if (!track || !sourceBuffer) return
  if (!loop.enabled) { setStatus('enable Loop region first'); return }
  const startBar = barsAt(loop.start)
  const endBar = barsAt(loop.end)
  const nBars = Math.max(1, Math.round(endBar - startBar))
  const tS = findOnsetNear(sourceBuffer, loop.start)
  const tE = findOnsetNear(sourceBuffer, loop.end)
  if (!(tE > tS + nBars * 0.1)) { setStatus('could not find onsets at both loop ends'); return }
  bpm = clamp((240 * nBars) / (tE - tS), 40, 240)
  saveBpm()
  const bl = barLenNow()
  const k = Math.round(startBar)
  gridMs = (tS - k * bl) * 1000
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
  setStatus(`fitted ${bpm.toFixed(2)} BPM · ${nBars} bars · ${(loop.end - loop.start).toFixed(3)} s`, 'ok')
}

function setSetupEnabled(on) {
  el.copySetup.disabled = !on
  el.loadSetup.disabled = !on
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
    loop.fadeMs = 120
    loop.mode = 'keep'
    loop.curve = 'equal-power'
    baked = null
    loopBuffer = null
    view.setBuffer(sourceBuffer)
    view.setTrack(track, barLenNow(), gridOriginNow())
    view.setGrid(gridOriginNow())
    syncTempoUi()
    syncGridUi()
    el.fade.value = '120'
    el.fadeVal.textContent = '120 ms'
    el.mode.value = 'keep'
    el.curve.value = 'equal-power'
    el.loop.checked = false

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
    setSetupEnabled(true)
    renderControls()
    redraw(0)
    setLoading(false)
  } catch (err) {
    if (my !== loadToken) return
    setStatus(`could not load ${file.name}: ${err.message || err}`, 'error')
    if (track) setLoading(false)
    else { el.loading.textContent = 'choose audio · or drop a file'; setLoading(true) }
  }
}

function currentSetup() {
  if (!track) return null
  return {
    format: SETUP_FORMAT,
    version: 1,
    track: sourceName || null,
    bpm: +bpm.toFixed(4),
    gridOffsetMs: +gridMs.toFixed(2),
    loop: {
      enabled: loop.enabled,
      start: +loop.start.toFixed(6),
      end: +loop.end.toFixed(6),
      fadeMs: loop.fadeMs,
      mode: loop.mode,
      curve: loop.curve,
    },
  }
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

async function copySetup() {
  if (!track) { setStatus('load audio first', 'error'); return }
  const text = JSON.stringify(currentSetup(), null, 2)
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
    else if (!fallbackCopy(text)) throw new Error('clipboard unavailable')
    setStatus('setup copied to clipboard', 'ok')
  } catch (err) {
    if (fallbackCopy(text)) { setStatus('setup copied to clipboard', 'ok'); return }
    setStatus(`could not copy: ${err.message || err}`, 'error')
  }
}

function showSetupError(message) {
  el.setupError.textContent = message
}

function openSetupDialog() {
  if (!track) { setStatus('load audio first', 'error'); return }
  el.setupError.textContent = ''
  el.setupText.value = ''
  el.setupDialog.showModal()
  el.setupText.focus()
}

async function applySetup() {
  if (!track) { showSetupError('load audio first'); return }
  const raw = el.setupText.value.trim()
  if (!raw) { showSetupError('paste a setup JSON first'); return }
  let data
  try {
    data = JSON.parse(raw)
  } catch (err) {
    showSetupError(`invalid JSON: ${err.message}`)
    return
  }
  if (!data || typeof data !== 'object') { showSetupError('the setup must be a JSON object'); return }
  if (data.format && data.format !== SETUP_FORMAT) {
    showSetupError(`unexpected format "${data.format}" (expected "${SETUP_FORMAT}")`)
    return
  }
  const l = data.loop && typeof data.loop === 'object' ? data.loop : {}
  const start = Number(l.start)
  const end = Number(l.end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) { showSetupError('loop.start and loop.end must be numbers'); return }
  if (end <= start + 0.001) { showSetupError('loop.end must be after loop.start'); return }
  const mode = l.mode === 'lead' ? 'lead' : 'keep'
  const curve = l.curve === 'linear' ? 'linear' : 'equal-power'
  const fadeMs = clamp(Number(l.fadeMs) || 0, 0, 3000)
  const nextBpm = Number(data.bpm)
  const nextGrid = Number(data.gridOffsetMs)

  try {
    if (Number.isFinite(nextBpm) && nextBpm > 0) setBpm(clamp(nextBpm, 40, 240), { snapLoop: false })
    if (Number.isFinite(nextGrid)) setGridMs(nextGrid)
    const max = track.duration
    const span = Math.min(minLoop(), max)
    loop.start = clamp(start, 0, Math.max(0, max - span))
    loop.end = clamp(end, loop.start + span, max)
    loop.fadeMs = fadeMs
    loop.mode = mode
    loop.curve = curve
    el.fade.value = String(fadeMs)
    el.fadeVal.textContent = `${fadeMs} ms`
    el.mode.value = mode
    el.curve.value = curve
    el.loop.checked = !!l.enabled
    baked = null
    loopBuffer = null
    if (l.enabled) setLoopEnabled(true)
    else { rebake(); redraw(loop.start) }
    updateMeta()
    el.setupDialog.close()
    setStatus('setup loaded', 'ok')
  } catch (err) {
    showSetupError(String(err.message || err))
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
    engine.seek(clamp(target - loop.start, 0, Math.max(0, baked.loopLength - 0.0005)))
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
    const t = snapBar(view.timeForX(e.clientX - rect.left), e.altKey)
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
el.bpm.addEventListener('change', () => setBpm(Number(el.bpm.value)))
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
el.mode.addEventListener('change', () => { loop.mode = el.mode.value; rebake() })
el.curve.addEventListener('change', () => { loop.curve = el.curve.value; rebake() })
el.fade.addEventListener('input', () => {
  loop.fadeMs = Number(el.fade.value)
  el.fadeVal.textContent = `${loop.fadeMs} ms`
  clearTimeout(fadeTimer)
  fadeTimer = setTimeout(rebake, 140)
})

const fileDrop = createFileDrop(document, {
  stage: el.timeline,
  onFile: (file) => loadAudioFile(file),
  onError: (msg) => setStatus(msg, 'error'),
})
el.loadAudio.addEventListener('click', () => fileDrop.openPicker())
el.loading.addEventListener('click', () => { if (!track) fileDrop.openPicker() })
el.copySetup.addEventListener('click', copySetup)
el.loadSetup.addEventListener('click', openSetupDialog)
el.cancelSetup.addEventListener('click', () => el.setupDialog.close())
el.applySetup.addEventListener('click', applySetup)
el.setupDialog.addEventListener('click', (e) => { if (e.target === el.setupDialog) el.setupDialog.close() })
el.setupText.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); applySetup() }
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
    get baked() { return baked && { mode: baked.mode, loopLength: baked.loopLength, fadeSeconds: baked.fadeSeconds, requestedFadeSeconds: baked.requestedFadeSeconds, tailAvailableSeconds: baked.tailAvailableSeconds, tailClipped: baked.tailClipped, preAvailableSeconds: baked.preAvailableSeconds, preClipped: baked.preClipped, fadeClipped: baked.fadeClipped } },
    get setup() { return currentSetup() },
    get sourceTime() { return currentSourceTime() },
    get barLen() { return barLenNow() },
    get hasLoopBuffer() { return !!loopBuffer },
    get gridMs() { return gridMs },
    get gridOrigin() { return gridOriginNow() },
    get bpm() { return bpm },
    get heads() { return computeHeads(currentSourceTime()) },
    redraw,
    get viewSpan() { return view.windowSpan() },
    get viewStart() { return view.viewStart },
    loadAudio: loadAudioFile,
  }
}

boot()
