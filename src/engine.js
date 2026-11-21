const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * Web Audio playback with sample-accurate offset, a loop region, and a
 * position clock. One AudioContext, one gain node, one source at a time.
 */
export class AudioEngine {
  constructor() {
    this.ctx = null
    this.gain = null
    this.buffer = null
    this.source = null
    this.playing = false
    this.offset = 0
    this.startedAt = 0
    this.loop = false
    this.loopStart = 0
    this.loopEnd = 0
    this.token = 0
    this.onEnded = null
  }

  async init() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' })
      this.gain = this.ctx.createGain()
      this.gain.connect(this.ctx.destination)
    }
    // Never await resume() here: before a user gesture it stays pending, which
    // would stall decoding. Resume only from an interaction (see resume()).
    return this.ctx
  }

  async resume() {
    await this.init()
    if (this.ctx.state !== 'running') await this.ctx.resume()
  }

  async decode(data) {
    await this.init()
    return this.ctx.decodeAudioData(data)
  }

  setBuffer(buffer) {
    this.stop()
    this.buffer = buffer
    this.offset = 0
    this.loopStart = 0
    this.loopEnd = buffer.duration
    this.playing = false
  }

  get duration() { return this.buffer?.duration ?? 0 }

  play(from = this.offset) {
    if (!this.buffer) return
    this.stop()
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = this.buffer
    if (this.loop) {
      src.loop = true
      src.loopStart = this.loopStart
      src.loopEnd = Math.min(this.loopEnd, this.buffer.duration)
    }
    src.connect(this.gain)
    const start = clamp(from, 0, this.duration - 0.0001)
    const my = ++this.token
    src.onended = () => {
      if (this.token !== my) return
      this.playing = false
      this.offset = this.loop ? this.loopStart : this.duration
      this.onEnded?.()
    }
    this.ctx.resume().catch(() => {})
    src.start(0, start)
    this.source = src
    this.offset = start
    this.startedAt = ctx.currentTime
    this.playing = true
  }

  pause() {
    if (!this.playing) return
    this.offset = this.position()
    this.playing = false
    this.stop()
  }

  stop() {
    if (this.source) {
      this.token++
      try { this.source.onended = null; this.source.stop() } catch {}
      try { this.source.disconnect() } catch {}
      this.source = null
    }
    this.playing = false
  }

  seek(t) {
    const target = clamp(t, 0, this.duration)
    if (this.playing) this.play(target)
    else this.offset = target
  }

  setLoop(enabled) {
    this.loop = enabled
    if (this.playing) this.play(this.position())
  }

  position() {
    if (!this.buffer) return 0
    if (!this.playing) return this.offset
    let p = this.offset + (this.ctx.currentTime - this.startedAt)
    if (this.loop) {
      const a = this.loopStart, b = Math.min(this.loopEnd, this.duration)
      if (b > a) {
        if (p >= b) p = a + ((p - a) % (b - a))
      } else if (p > this.duration) {
        p = this.duration
      }
    } else if (p > this.duration) {
      p = this.duration
    }
    return p
  }
}
