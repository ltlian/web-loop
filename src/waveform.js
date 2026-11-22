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
const LOOP_FILL = 'rgba(148,163,184,0.055)'
const HANDLE_LEFT = '#93c5fd'
const HANDLE_RIGHT = '#fbbf24'
const WAVE_LEFT = '#3b82f6'
const WAVE_RIGHT = '#fbbf24'
const WAVE_BASE = '#7dd3fc'
const FADE_LEFT = 'rgba(59,130,246,0.06)'
const FADE_RIGHT = 'rgba(251,191,36,0.07)'
const EDGE_LEFT = 'rgba(96,165,250,0.55)'
const EDGE_RIGHT = 'rgba(251,191,36,0.55)'
const MIN_SPAN = 0.05

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** Incoming 0 -> 1 over [start-pre, start+post]. */
function inGainAt(u, pre, post, curve) {
  if (pre + post <= 0) return u < 0 ? 0 : 1
  if (u <= -pre) return 0
  if (u >= post) return 1
  const t = (u + pre) / (pre + post)
  return curve === 'linear' ? t : Math.sin((t * Math.PI) / 2)
}

/** Outgoing 1 -> 0 over [end-pre, end+post]. */
function outGainAt(u, pre, post, curve) {
  if (pre + post <= 0) return u < 0 ? 1 : 0
  if (u <= -pre) return 1
  if (u >= post) return 0
  const t = (u + pre) / (pre + post)
  return curve === 'linear' ? 1 - t : Math.cos((t * Math.PI) / 2)
}

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
    this.loop = null
    this.loopSig = ''
    this.shimmer = null
    this.shimmerFill = null
  }

  setBuffer(buffer) {
    this.buffer = buffer
    this.drawWave()
  }

  setTrack(track, barLen, gridOrigin) {
    this.loop = null
    this.loopSig = ''
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

  /**
   * Tell the static waveform about the current envelope. Called from redraw;
   * only redraws when the markers, fades or curve actually changed.
   */
  setLoopEnvelope(loop) {
    const active = loop?.enabled ? loop : null
    const sig = active
      ? [active.start, active.end, active.inPre, active.inPost, active.outPre, active.outPost, active.curve].join('|')
      : 'off'
    if (sig === this.loopSig) return
    this.loopSig = sig
    this.loop = active
    this.drawWave()
  }

  /** Position (0..1 across the canvas) of the analysis highlight, or null. */
  setShimmer(x) {
    this.shimmer = x == null ? null : clamp(x, -0.2, 1.2)
    this.drawWave()
  }

  waveFillStyle(ctx) {
    if (this.shimmerFill) return this.shimmerFill
    const loop = this.loop
    if (!loop || !(loop.end > loop.start)) return WAVE_BASE
    const x0 = this.xForTime(loop.start), x1 = this.xForTime(loop.end)
    if (!(x1 > x0 + 0.5)) return WAVE_BASE
    const g = ctx.createLinearGradient(x0, 0, x1, 0)
    g.addColorStop(0, WAVE_LEFT)
    g.addColorStop(1, WAVE_RIGHT)
    return g
  }

  /** The gain applied to the loop's own waveform at source time t. */
  waveGainAt(t) {
    const loop = this.loop
    if (!loop) return 1
    const { start, end } = loop
    const inPre = loop.inPre ?? 0, inPost = loop.inPost ?? 0
    const outPre = loop.outPre ?? 0, outPost = loop.outPost ?? 0
    const p = t - start, u = t - end
    if (p >= 0 && p < Math.max(inPost, outPost)) return inGainAt(p, inPre, inPost, loop.curve)
    if (u >= -Math.max(inPre, outPre) && u < 0) return outGainAt(u, outPre, outPost, loop.curve)
    return 1
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

    this.drawProjections(ctx)
    this.drawShimmer(ctx)
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
    const span = this.windowSpan()
    const mid = h / 2
    const amp = h * 0.46
    ctx.fillStyle = this.waveFillStyle(ctx)
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
        const gain = this.waveGainAt(this.viewStart + ((x + 0.5) / w) * span)
        if (gain <= 0.001) continue
        const y0 = mid - hi * amp * gain
        const y1 = mid - lo * amp * gain
        ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0))
      }
    } else {
      ctx.strokeStyle = this.waveFillStyle(ctx)
      ctx.lineWidth = 1.25
      ctx.beginPath()
      for (let x = 0; x <= w; x++) {
        const i = Math.min(z - 1, a + Math.floor((x / w) * (z - a)))
        const gain = this.waveGainAt(i / sr)
        const y = mid - ch[i] * amp * gain
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
    ctx.fillStyle = this.waveFillStyle(ctx)
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
      const gain = this.waveGainAt((t0 + t1) / 2)
      if (gain <= 0.001) continue
      const y0 = mid - hi * amp * gain, y1 = mid - lo * amp * gain
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0))
    }
  }

  /**
   * Draw the other range's waveform where it will be heard: the post-roll from
   * beyond the right marker at the loop head, and the pre-roll from before the
   * left marker at the loop tail. Each is shifted by one loop and faded by its
   * outgoing/incoming gain.
   */
  drawProjections(ctx) {
    const loop = this.loop
    if (!loop || !this.buffer) return
    const liveL = loop.end - loop.start
    const outPost = loop.outPost ?? 0
    const inPre = loop.inPre ?? 0
    if (outPost > 0) {
      this.drawProjection(
        ctx,
        loop.start, loop.start + outPost, liveL,
        (t) => outGainAt(t - loop.start, loop.outPre ?? 0, outPost, loop.curve),
        WAVE_RIGHT,
      )
    }
    if (inPre > 0) {
      this.drawProjection(
        ctx,
        loop.end - inPre, loop.end, -liveL,
        (t) => inGainAt(t - loop.end, inPre, loop.inPost ?? 0, loop.curve),
        WAVE_LEFT,
      )
    }
  }

  /**
   * Light the waveform itself: draw the same peaks again with a moving
   * gradient fill under `lighter`, so only the audio is brightened, never the
   * canvas behind it.
   */
  drawShimmer(ctx) {
    if (this.shimmer == null || !this.duration) return
    const { w } = this
    const x = this.shimmer * w
    const half = Math.max(84, w * 0.15)
    const g = ctx.createLinearGradient(x - half, 0, x + half, 0)
    g.addColorStop(0, 'rgba(125,211,252,0)')
    g.addColorStop(0.38, 'rgba(125,211,252,0.24)')
    g.addColorStop(0.5, 'rgba(255,255,255,0.6)')
    g.addColorStop(0.62, 'rgba(125,211,252,0.24)')
    g.addColorStop(1, 'rgba(125,211,252,0)')
    this.shimmerFill = g
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    if (this.buffer) this.drawFromSamples(ctx)
    else this.drawFromPeaks(ctx)
    ctx.restore()
    this.shimmerFill = null
  }

  drawProjection(ctx, outStart, outEnd, srcOffset, gainFn, color) {
    const buf = this.buffer
    if (!buf || !(outEnd > outStart)) return
    const sr = buf.sampleRate
    const ch = buf.getChannelData(0)
    const { w, h } = this
    const mid = h / 2, amp = h * 0.46
    const x0 = Math.max(0, Math.floor(this.xForTime(outStart)))
    const x1 = Math.min(w, Math.ceil(this.xForTime(outEnd)))
    if (x1 <= x0) return
    const secPerPx = this.windowSpan() / w
    ctx.save()
    ctx.globalAlpha = 0.58
    ctx.fillStyle = color
    for (let x = x0; x < x1; x++) {
      const tOut = this.timeForX(x + 0.5)
      const gain = gainFn(tOut)
      if (gain <= 0.001) continue
      const tSrc = tOut + srcOffset
      const s0 = Math.max(0, Math.floor((tSrc - secPerPx / 2) * sr))
      const s1 = Math.min(ch.length, Math.ceil((tSrc + secPerPx / 2) * sr))
      if (s1 <= s0) continue
      let lo = 0, hi = 0
      for (let i = s0; i < s1; i++) {
        const v = ch[i]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      const y0 = mid - hi * amp * gain
      const y1 = mid - lo * amp * gain
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0))
    }
    ctx.restore()
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

    // The region while the loop is off: no handles, just enough of an outline
    // that the toggle has a visible subject.
    if (loop && !loop.enabled && loop.end > loop.start) {
      const x0 = clamp(xOf(loop.start), 0, w)
      const x1 = clamp(xOf(loop.end), 0, w)
      if (x1 > x0) {
        ctx.fillStyle = 'rgba(125,211,252,0.05)'
        ctx.fillRect(x0, 0, x1 - x0, h)
        ctx.save()
        ctx.setLineDash([4, 5])
        ctx.strokeStyle = 'rgba(125,211,252,0.3)'
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(x0 + 0.5, 0); ctx.lineTo(x0 + 0.5, h); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(x1 - 0.5, 0); ctx.lineTo(x1 - 0.5, h); ctx.stroke()
        ctx.restore()
      }
    }

    if (loop?.enabled && loop.end > loop.start) {
      const ax = xOf(loop.start), bx = xOf(loop.end)
      if (bx > 0 && ax < w) {
        const x0 = clamp(ax, 0, w), x1 = clamp(bx, 0, w)
        ctx.fillStyle = LOOP_FILL
        ctx.fillRect(x0, 0, x1 - x0, h)

        const span = this.windowSpan()
        const inPrePx = ((loop.inPre ?? 0) / span) * w
        const inPostPx = ((loop.inPost ?? 0) / span) * w
        const outPrePx = ((loop.outPre ?? 0) / span) * w
        const outPostPx = ((loop.outPost ?? 0) / span) * w
        const leftStart = ax - inPrePx, leftEnd = ax + inPostPx
        const rightStart = bx - outPrePx, rightEnd = bx + outPostPx
        const drawWindow = (a, b, fill, edge) => {
          const s = clamp(a, 0, w), e = clamp(b, 0, w)
          if (e <= s) return
          ctx.fillStyle = fill
          ctx.fillRect(s, 0, e - s, h)
          ctx.strokeStyle = edge
          ctx.lineWidth = 1
          ctx.setLineDash([3, 4])
          ctx.strokeRect(s + 0.5, 2.5, Math.max(1, e - s - 1), h - 5)
          ctx.setLineDash([])
        }
        // unclamped marker positions keep an off-screen marker from painting at the edge
        if (leftEnd > leftStart) drawWindow(leftStart, leftEnd, FADE_LEFT, EDGE_LEFT)
        if (rightEnd > rightStart) drawWindow(rightStart, rightEnd, FADE_RIGHT, EDGE_RIGHT)

        const label = (text, x, y, color) => {
          if (x < 0 || x > w - 24) return
          ctx.font = '9px ui-monospace, monospace'
          ctx.lineWidth = 3
          ctx.strokeStyle = 'rgba(11,18,32,.9)'
          ctx.strokeText(text, x, y)
          ctx.fillStyle = color
          ctx.fillText(text, x, y)
        }
        if (leftEnd > leftStart) label('fade-in', clamp(leftStart, 0, w) + 4, 14, HANDLE_LEFT)
        if (rightEnd > rightStart) label('fade-out', clamp(rightStart, 0, w) + 4, 14, HANDLE_RIGHT)

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

        for (const [x, color, visible] of [[ax, HANDLE_LEFT, ax > -10 && ax < w + 10], [bx, HANDLE_RIGHT, bx > -10 && bx < w + 10]]) {
          if (!visible) continue
          const hx = clamp(x, 2, w - 2)
          ctx.strokeStyle = color
          ctx.lineWidth = 1.5
          ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, h); ctx.stroke()
          ctx.fillStyle = color
          ctx.beginPath(); ctx.moveTo(hx - 5, 0); ctx.lineTo(hx + 5, 0); ctx.lineTo(hx, 9); ctx.closePath(); ctx.fill()
          ctx.beginPath(); ctx.moveTo(hx - 5, h); ctx.lineTo(hx + 5, h); ctx.lineTo(hx, h - 9); ctx.closePath(); ctx.fill()
        }
      }
    }

    const list = heads?.length ? heads : [{ t: position, kind: 'main' }]

    // every overlapping source: amber for the right/post-roll, blue for the left/pre-roll
    for (const h of list) {
      if (h.kind !== 'tail') continue
      const tx = xOf(h.t)
      const color = h.label === 'lead' ? HANDLE_LEFT : HANDLE_RIGHT
      const alpha = clamp(h.gain ?? 1, 0, 1)
      if (tx >= -2 && tx <= w + 2) {
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.moveTo(tx, 0); ctx.lineTo(tx, h); ctx.stroke()
        ctx.globalAlpha = alpha
        ctx.fillStyle = color
        ctx.beginPath(); ctx.moveTo(tx - 4, 0); ctx.lineTo(tx + 4, 0); ctx.lineTo(tx, 7); ctx.closePath(); ctx.fill()
        ctx.globalAlpha = 1
      } else {
        drawEdgeIndicator(ctx, w, h, tx, h.label ?? 'tail', color, alpha)
      }
    }

    // played region + main playhead
    const main = list.find((h) => h.kind === 'main') ?? list[0]
    const x = xOf(main.t)
    if (x >= -2 && x <= w + 2) {
      ctx.fillStyle = 'rgba(148,163,184,0.05)'
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
    if (!c || !this.buffer) return
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

    const dur = this.duration || 1
    if (loop?.enabled && loop.end > loop.start) {
      const g = ctx.createLinearGradient((loop.start / dur) * w, 0, (loop.end / dur) * w, 0)
      g.addColorStop(0, WAVE_LEFT)
      g.addColorStop(1, WAVE_RIGHT)
      ctx.fillStyle = g
    } else {
      ctx.fillStyle = 'rgba(125,211,252,0.55)'
    }
    const n = this.peaks.length / 2
    if (n) {
      const mid = h / 2, amp = h * 0.44
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

    if (loop && loop.end > loop.start) {
      ctx.fillStyle = loop.enabled ? 'rgba(148,163,184,0.08)' : 'rgba(125,211,252,0.10)'
      ctx.fillRect((loop.start / dur) * w, 0, ((loop.end - loop.start) / dur) * w, h)
    }

    const x0 = (this.viewStart / dur) * w
    const x1 = (this.viewEnd / dur) * w
    ctx.fillStyle = 'rgba(2,6,14,0.55)'
    ctx.fillRect(0, 0, x0, h)
    ctx.fillRect(x1, 0, w - x1, h)
    // Vertical lines within the container's corner radius get clipped into
    // stubs, so keep them out of that margin; the masks indicate the window and
    // the main timeline carries the playhead.
    const INSET = 8
    // Interior window edges only: a full outline sits under the rounded corners
    // and reads as a second, broken border.
    if (x1 - x0 < w - 1) {
      ctx.strokeStyle = 'rgba(248,250,252,0.45)'
      ctx.lineWidth = 1
      for (const x of [x0, x1]) {
        const px = Math.round(x) + 0.5
        if (px < INSET || px > w - INSET) continue
        ctx.beginPath()
        ctx.moveTo(px, 0)
        ctx.lineTo(px, h)
        ctx.stroke()
      }
    }

    if (position != null) {
      const xp = (position / dur) * w
      if (xp >= INSET && xp <= w - INSET) {
        ctx.strokeStyle = '#f8fafc'
        ctx.beginPath(); ctx.moveTo(xp, 0); ctx.lineTo(xp, h); ctx.stroke()
      }
    }
  }
}
