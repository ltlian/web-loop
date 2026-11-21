/**
 * Detail waveform + overview minimap.
 *
 * The detail canvas is rendered live from the decoded AudioBuffer for the
 * current view window, at one min/max pair per pixel (or a sample polyline
 * when zoomed past ~2 samples/px). The prerendered peak buckets are used for
 * the minimap and as a pre-decode fallback.
 *
 * Two stacked canvases in the timeline: static detail (redrawn on zoom/pan)
 * and an overlay (loop region, fade zones, handles, playhead) redrawn per frame.
 */
const FADE = 'rgba(251,191,36,0.16)'
const FADE_LINE = 'rgba(251,191,36,0.55)'
const LOOP_FILL = 'rgba(125,211,252,0.07)'
const HANDLE = '#7dd3fc'
const MIN_SPAN = 0.05

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function drawEdgeIndicator(ctx, w, h, x, label, color, alpha = 1) {
  const left = x < 0
  const ex = left ? 0 : w
  const dir = left ? 1 : -1
  ctx.globalAlpha = alpha
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(ex, h / 2 - 7)
  ctx.lineTo(ex + dir * 9, h / 2)
  ctx.lineTo(ex, h / 2 + 7)
  ctx.closePath()
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.fillRect(ex === 0 ? 0 : w - 2, 0, 2, h)
  ctx.font = '9px ui-monospace, monospace'
  ctx.textAlign = left ? 'left' : 'right'
  ctx.fillText(label, left ? 12 : w - 12, 12)
  ctx.textAlign = 'left'
}
const timeLabel = (t) => {
  if (t < 60) return `${t.toFixed(t < 10 ? 3 : 2)}s`
  const m = Math.floor(t / 60)
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`
}

export class WaveformView {
  constructor(waveCanvas, overlayCanvas, timelineEl, minimapCanvas) {
    this.wave = waveCanvas
    this.overlay = overlayCanvas
    this.timeline = timelineEl
    this.mini = minimapCanvas
    this.buffer = null
    this.peaks = []
    this.duration = 1
    this.barLen = 0
    this.gridOrigin = null
    this.viewStart = 0
    this.viewEnd = 1
  }

  setBuffer(buffer) {
    this.buffer = buffer
    this.drawWave()
  }

  setTrack(track, barLen, gridOrigin) {
    this.peaks = track.peaks
    this.duration = track.duration
    this.barLen = barLen
    this.gridOrigin = gridOrigin
    this.viewStart = 0
    this.viewEnd = track.duration
    this.resize()
  }

  setGrid(origin) {
    this.gridOrigin = origin
    this.drawWave()
  }

  setBarLen(barLen) {
    this.barLen = barLen
    this.drawWave()
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const rect = this.timeline.getBoundingClientRect()
    for (const c of [this.wave, this.overlay]) {
      c.width = Math.max(1, Math.floor(rect.width * dpr))
      c.height = Math.max(1, Math.floor(rect.height * dpr))
      c.style.width = `${rect.width}px`
      c.style.height = `${rect.height}px`
    }
    this.dpr = dpr
    this.w = rect.width
    this.h = rect.height
    this.drawWave()
  }

  windowSpan() { return this.viewEnd - this.viewStart }

  setWindow(start, end) {
    const span = clamp(end - start, MIN_SPAN, this.duration)
    const s = clamp(start, 0, this.duration - span)
    this.viewStart = s
    this.viewEnd = s + span
    this.drawWave()
  }

  zoomAt(t, factor) {
    const span = this.windowSpan()
    const next = clamp(span * factor, MIN_SPAN, this.duration)
    const ratio = (t - this.viewStart) / span
    this.setWindow(t - ratio * next, t - ratio * next + next)
  }

  panBy(dt) { this.setWindow(this.viewStart + dt, this.viewEnd + dt) }

  xForTime(t) { return ((t - this.viewStart) / this.windowSpan()) * this.w }
  timeForX(x) { return this.viewStart + (x / this.w) * this.windowSpan() }

  drawWave() {
    const ctx = this.wave.getContext('2d')
    const { dpr, w, h } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#0b1220'
    ctx.fillRect(0, 0, w, h)

    this.drawGrid(ctx)

    // timeout-safe guard before a track is loaded
    if (!this.duration) return

    if (this.buffer) this.drawFromSamples(ctx)
    else this.drawFromPeaks(ctx)

    this.drawLabels(ctx)
  }

  drawGrid(ctx) {
    const { w, h } = this
    if (this.gridOrigin == null || !this.barLen) return
    const beatLen = this.barLen / 4
    const k0 = Math.floor((this.viewStart - this.gridOrigin) / beatLen) - 1
    const k1 = Math.ceil((this.viewEnd - this.gridOrigin) / beatLen) + 1
    for (let k = k0; k <= k1; k++) {
      const t = this.gridOrigin + k * beatLen
      if (t < this.viewStart || t > this.viewEnd) continue
      const x = Math.round(this.xForTime(t)) + 0.5
      const isBar = k % 4 === 0
      ctx.strokeStyle = isBar
        ? (k % 16 === 0 ? 'rgba(148,163,184,0.34)' : 'rgba(148,163,184,0.18)')
        : 'rgba(148,163,184,0.055)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
    }
  }

  drawFromSamples(ctx) {
    const buf = this.buffer
    const sr = buf.sampleRate
    const ch = buf.getChannelData(0)
    const { w, h } = this
    const a = Math.max(0, Math.floor(this.viewStart * sr))
    const z = Math.min(ch.length, Math.ceil(this.viewEnd * sr))
    const spp = (z - a) / w
    const mid = h / 2
    const amp = h * 0.46
    ctx.fillStyle = '#7dd3fc'
    if (spp >= 2) {
      for (let x = 0; x < w; x++) {
        const i0 = a + Math.floor(x * spp)
        const i1 = Math.min(z, a + Math.floor((x + 1) * spp) + 1)
        let lo = 0, hi = 0
        for (let i = i0; i < i1; i++) {
          const v = ch[i]
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
        const y0 = mid - hi * amp
        const y1 = mid - lo * amp
        ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0))
      }
    } else {
      ctx.strokeStyle = '#7dd3fc'
      ctx.lineWidth = 1.25
      ctx.beginPath()
      for (let x = 0; x <= w; x++) {
        const i = Math.min(z - 1, a + Math.floor((x / w) * (z - a)))
        const y = mid - ch[i] * amp
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  }

  drawFromPeaks(ctx) {
    const n = this.peaks.length / 2
    if (!n) return
    const { w, h } = this
    const mid = h / 2, amp = h * 0.46
    const d = this.duration
    ctx.fillStyle = '#7dd3fc'
    for (let x = 0; x < w; x++) {
      const t0 = this.viewStart + (x / w) * this.windowSpan()
      const t1 = this.viewStart + ((x + 1) / w) * this.windowSpan()
      const a = clamp(Math.floor((t0 / d) * n), 0, n - 1)
      const b = clamp(Math.ceil((t1 / d) * n), a + 1, n)
      let lo = 0, hi = 0
      for (let i = a; i < b; i++) {
        const mn = this.peaks[i * 2], mx = this.peaks[i * 2 + 1]
        if (mn < lo) lo = mn
        if (mx > hi) hi = mx
      }
      const y0 = mid - hi * amp, y1 = mid - lo * amp
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0))
    }
  }

  drawLabels(ctx) {
    const { w, h } = this
    const span = this.windowSpan()

    // bar numbers
    if (this.gridOrigin != null && this.barLen) {
      ctx.fillStyle = 'rgba(148,163,184,0.55)'
      ctx.font = '10px ui-monospace, monospace'
      const barsVisible = span / this.barLen
      const every = barsVisible > 10 ? 4 : 1
      const b0 = Math.floor((this.viewStart - this.gridOrigin) / this.barLen)
      const b1 = Math.ceil((this.viewEnd - this.gridOrigin) / this.barLen)
      for (let b = b0; b <= b1; b++) {
        if (b % every !== 0) continue
        const t = this.gridOrigin + b * this.barLen
        if (t < this.viewStart || t > this.viewEnd) continue
        const x = this.xForTime(t)
        if (x < 14 || x > w - 34) continue
        ctx.fillText(`bar ${b}`, x + 3, 12)
      }
    }

    // time ruler at the bottom
    const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60]
    const step = steps.find((s) => span / s <= 9) ?? 60
    const t0 = Math.ceil(this.viewStart / step) * step
    ctx.fillStyle = 'rgba(148,163,184,0.6)'
    ctx.font = '10px ui-monospace, monospace'
    ctx.strokeStyle = 'rgba(148,163,184,0.22)'
    for (let t = t0; t <= this.viewEnd; t += step) {
      const x = Math.round(this.xForTime(t)) + 0.5
      ctx.beginPath(); ctx.moveTo(x, h - 14); ctx.lineTo(x, h); ctx.stroke()
      ctx.fillText(timeLabel(t), x + 3, h - 5)
    }
  }

  drawOverlay({ position = 0, loop = null, heads = null } = {}) {
    const ctx = this.overlay.getContext('2d')
    const { dpr, w, h } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const xOf = (t) => this.xForTime(t)

    if (loop?.enabled && loop.end > loop.start) {
      const ax = xOf(loop.start), bx = xOf(loop.end)
      if (bx > 0 && ax < w) {
        const x0 = clamp(ax, 0, w), x1 = clamp(bx, 0, w)
        ctx.fillStyle = LOOP_FILL
        ctx.fillRect(x0, 0, x1 - x0, h)

        const fpx = Math.max(1, (loop.fade / this.windowSpan()) * w)
        const fillX = (a, b) => {
          const s = clamp(a, 0, w), e = clamp(b, 0, w)
          if (e > s) ctx.fillRect(s, 0, e - s, h)
        }
        if (loop.fade > 0) {
          ctx.fillStyle = FADE
          // use the *unclamped* marker positions: a marker outside the view
          // must not paint its fade zone pinned to the edge
          if (loop.mode === 'lead') {
            // pre-roll before the first marker + loop tail before the second
            fillX(ax - fpx, ax)
            fillX(bx - fpx, bx)
          } else if (loop.mode === 'keep') {
            // head fade-in + post-roll after the second marker
            fillX(ax, ax + fpx)
            fillX(bx, bx + fpx)
            if (bx > 0 && bx < w) {
              ctx.strokeStyle = FADE_LINE
              ctx.lineWidth = 1
              ctx.beginPath(); ctx.moveTo(bx + 0.5, 0); ctx.lineTo(bx + 0.5, h); ctx.stroke()
            }
          } else {
            fillX(ax, ax + fpx)
            fillX(bx - fpx, bx)
          }
        }

        if (loop.effectiveEnd && loop.effectiveEnd < loop.end - 1e-3) {
          const xe = xOf(loop.effectiveEnd)
          if (xe > 0 && xe < w) {
            ctx.strokeStyle = 'rgba(248,250,252,0.30)'
            ctx.setLineDash([3, 4])
            ctx.lineWidth = 1
            ctx.beginPath(); ctx.moveTo(xe + 0.5, 0); ctx.lineTo(xe + 0.5, h); ctx.stroke()
            ctx.setLineDash([])
          }
        }

        for (const [x, visible] of [[ax, ax > -10 && ax < w + 10], [bx, bx > -10 && bx < w + 10]]) {
          if (!visible) continue
          const hx = clamp(x, 2, w - 2)
          ctx.strokeStyle = HANDLE
          ctx.lineWidth = 1.5
          ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, h); ctx.stroke()
          ctx.fillStyle = HANDLE
          ctx.beginPath(); ctx.moveTo(hx - 5, 0); ctx.lineTo(hx + 5, 0); ctx.lineTo(hx, 9); ctx.closePath(); ctx.fill()
          ctx.beginPath(); ctx.moveTo(hx - 5, h); ctx.lineTo(hx + 5, h); ctx.lineTo(hx, h - 9); ctx.closePath(); ctx.fill()
        }
      }
    }

    const list = heads?.length ? heads : [{ t: position, kind: 'main' }]

    // every overlapping source: amber bars for the fade tail
    for (const h of list) {
      if (h.kind !== 'tail') continue
      const tx = xOf(h.t)
      const alpha = clamp(h.gain ?? 1, 0, 1)
      if (tx >= -2 && tx <= w + 2) {
        ctx.strokeStyle = '#fbbf24'
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.moveTo(tx, 0); ctx.lineTo(tx, h); ctx.stroke()
        ctx.globalAlpha = alpha
        ctx.fillStyle = '#fbbf24'
        ctx.beginPath(); ctx.moveTo(tx - 4, 0); ctx.lineTo(tx + 4, 0); ctx.lineTo(tx, 7); ctx.closePath(); ctx.fill()
        ctx.globalAlpha = 1
      } else {
        drawEdgeIndicator(ctx, w, h, tx, h.label ?? 'tail', '#fbbf24', alpha)
      }
    }

    // played region + main playhead
    const main = list.find((h) => h.kind === 'main') ?? list[0]
    const x = xOf(main.t)
    if (x >= -2 && x <= w + 2) {
      ctx.fillStyle = 'rgba(125,211,252,0.08)'
      ctx.fillRect(0, 0, clamp(x, 0, w), h)
      ctx.strokeStyle = '#f8fafc'
      ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
      ctx.fillStyle = '#f8fafc'
      ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 8); ctx.closePath(); ctx.fill()
    } else {
      drawEdgeIndicator(ctx, w, h, x, 'main', '#f8fafc')
    }
  }

  drawMinimap(loop = null, position = null) {
    const c = this.mini
    if (!c) return
    const rect = c.getBoundingClientRect()
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (c.width !== Math.floor(rect.width * dpr) || c.height !== Math.floor(rect.height * dpr)) {
      c.width = Math.max(1, Math.floor(rect.width * dpr))
      c.height = Math.max(1, Math.floor(rect.height * dpr))
    }
    const ctx = c.getContext('2d')
    const w = rect.width, h = rect.height
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#0a1120'
    ctx.fillRect(0, 0, w, h)

    const n = this.peaks.length / 2
    if (n) {
      const mid = h / 2, amp = h * 0.44
      ctx.fillStyle = 'rgba(125,211,252,0.55)'
      for (let x = 0; x < w; x++) {
        const a = Math.floor((x / w) * n)
        const b = Math.max(a + 1, Math.floor(((x + 1) / w) * n))
        let lo = 0, hi = 0
        for (let i = a; i < b && i < n; i++) {
          const mn = this.peaks[i * 2], mx = this.peaks[i * 2 + 1]
          if (mn < lo) lo = mn
          if (mx > hi) hi = mx
        }
        ctx.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp))
      }
    }

    const dur = this.duration || 1
    if (loop?.enabled && loop.end > loop.start) {
      ctx.fillStyle = 'rgba(125,211,252,0.12)'
      ctx.fillRect((loop.start / dur) * w, 0, ((loop.end - loop.start) / dur) * w, h)
    }

    const x0 = (this.viewStart / dur) * w
    const x1 = (this.viewEnd / dur) * w
    ctx.fillStyle = 'rgba(2,6,14,0.55)'
    ctx.fillRect(0, 0, x0, h)
    ctx.fillRect(x1, 0, w - x1, h)
    ctx.strokeStyle = 'rgba(248,250,252,0.7)'
    ctx.lineWidth = 1
    ctx.strokeRect(x0 + 0.5, 0.5, Math.max(1, x1 - x0 - 1), h - 1)

    if (position != null) {
      const xp = (position / dur) * w
      ctx.strokeStyle = '#f8fafc'
      ctx.beginPath(); ctx.moveTo(xp, 0); ctx.lineTo(xp, h); ctx.stroke()
    }
  }
}
