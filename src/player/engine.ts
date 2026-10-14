import { sourceFor } from '../library/source'
import type { Track } from '../types'
import { EQ_BANDS, usePlayer } from './store'

const FADE_IN_MS = 220
const FADE_OUT_MS = 150
const SWAP_MS = 380

/**
 * The engine needs to advance the queue on its own (a track ending, or an
 * OS media-key press on the SMTC overlay). Importing the actions module here
 * would close an import cycle, so the actions module plugs itself in instead.
 */
export const engineHooks = {
  next: (fromEnd: boolean): void => void fromEnd,
  prev: (): void => {}
}

class AudioEngine {
  private el: HTMLAudioElement | null = null
  private ctx: AudioContext | null = null
  /**
   * Retained deliberately. A media element gets exactly one source node for its
   * lifetime, and holding the reference guards against any collection of a node
   * the element still points at. Public so the type checker does not read the
   * retention as dead state.
   */
  source: MediaElementAudioSourceNode | null = null
  private preGain: GainNode | null = null
  private bands: BiquadFilterNode[] = []
  private analyser: AnalyserNode | null = null
  private master: GainNode | null = null
  private fade: GainNode | null = null
  // Inferred as Uint8Array<ArrayBuffer>, which is what the analyser API wants.
  private spectrum = new Uint8Array(0)
  private raf = 0
  private loadedPath: string | null = null
  /** Invalidates in-flight fades when the user interrupts one. */
  private fadeToken = 0

  private build(): void {
    if (this.ctx) return

    const el = new Audio()
    // Load-bearing: without CORS approval a media element routed through Web
    // Audio outputs pure silence, so this must be set before any src.
    el.crossOrigin = 'anonymous'
    el.preload = 'auto'
    el.autoplay = false

    const ctx = new AudioContext({ latencyHint: 'playback' })
    const source = ctx.createMediaElementSource(el)

    const preGain = ctx.createGain()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 4096
    // Enough smoothing that the spectrum reads as motion, not as noise.
    analyser.smoothingTimeConstant = 0.8
    const master = ctx.createGain()
    const fade = ctx.createGain()

    const bands = EQ_BANDS.map((freq, i) => {
      const band = ctx.createBiquadFilter()
      band.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking'
      band.frequency.value = freq
      band.Q.value = 0.9
      band.gain.value = 0
      return band
    })

    let node: AudioNode = source
    node.connect(preGain)
    node = preGain
    for (const band of bands) {
      node.connect(band)
      node = band
    }
    node.connect(analyser)
    analyser.connect(master)
    master.connect(fade)
    fade.connect(ctx.destination)

    el.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(el.duration)) usePlayer.getState().setDuration(el.duration)
      usePlayer.getState().setLoading(false)
    })
    el.addEventListener('canplay', () => usePlayer.getState().setLoading(false))
    el.addEventListener('waiting', () => usePlayer.getState().setLoading(true))
    el.addEventListener('error', () => {
      usePlayer.getState().setLoading(false)
      usePlayer.getState().setPlaying(false)
      console.error('[aurora] media error', el.error?.message ?? el.error?.code)
    })
    el.addEventListener('ended', () => {
      this.stopTicker()
      engineHooks.next(true)
    })

    this.el = el
    this.ctx = ctx
    this.source = source
    this.preGain = preGain
    this.analyser = analyser
    this.master = master
    this.fade = fade
    this.bands = bands
    this.spectrum = new Uint8Array(analyser.frequencyBinCount)

    this.applyEq()
    this.applyVolume()
    this.installMediaSession()
  }

  // --- graph control -------------------------------------------------------

  private ramp(to: number, ms: number): void {
    const ctx = this.ctx
    const fade = this.fade
    if (!ctx || !fade) return
    const now = ctx.currentTime
    fade.gain.cancelScheduledValues(now)
    // Anchor at the current value so an interrupted ramp does not jump.
    fade.gain.setValueAtTime(fade.gain.value, now)
    fade.gain.linearRampToValueAtTime(to, now + ms / 1000)
  }

  private applyVolume(): void {
    const { volume, muted } = usePlayer.getState()
    if (this.master) this.master.gain.value = muted ? 0 : volume
  }

  private applyEq(): void {
    const { eqEnabled, eqGains } = usePlayer.getState()
    const target = eqEnabled ? eqGains : EQ_BANDS.map(() => 0)
    this.bands.forEach((band, i) => {
      band.gain.value = target[i] ?? 0
    })
  }

  /**
   * ReplayGain, with peak-aware headroom: a positive gain on an already-loud
   * master would clip, so the boost is capped by the track's own peak.
   */
  private applyReplayGain(track: Track): void {
    if (!this.preGain) return
    let gain = 1
    if (track.gainDb !== null && Number.isFinite(track.gainDb)) {
      gain = Math.pow(10, track.gainDb / 20)
      if (track.peak !== null && track.peak > 0 && gain * track.peak > 1) {
        gain = 1 / track.peak
      }
    }
    this.preGain.gain.value = gain
  }

  // --- transport -----------------------------------------------------------

  async load(track: Track, autoplay: boolean): Promise<void> {
    this.build()
    const ctx = this.ctx
    const el = this.el
    if (!ctx || !el) return

    if (ctx.state === 'suspended') await ctx.resume()

    const store = usePlayer.getState()
    store.setLoading(true)
    // Show the tag duration immediately; the real one lands on loadedmetadata.
    store.setDuration(track.duration || 0)
    store.setPosition(0)

    const isSameFile = this.loadedPath === track.path
    if (!isSameFile) {
      // The source decides how this track is reached; the engine never assumes
      // a file on disk.
      const url = sourceFor(track).streamUrl(track)
      if (!url) {
        console.error('[aurora] this track has no playable source', track.id)
        store.setLoading(false)
        return
      }

      const { crossfadeSec } = store
      const swapping = crossfadeSec > 0 && !el.paused && this.loadedPath !== null

      if (swapping) {
        const token = ++this.fadeToken
        this.ramp(0, SWAP_MS / 2)
        await new Promise((resolve) => window.setTimeout(resolve, SWAP_MS / 2))
        if (token !== this.fadeToken) return
      }

      el.src = url
      el.load()
      this.loadedPath = track.path
    }

    this.applyReplayGain(track)
    this.applyEq()
    this.applyVolume()
    this.updateMediaSession(track)

    if (autoplay) await this.play()
    else store.setLoading(false)
  }

  async play(): Promise<void> {
    this.build()
    const ctx = this.ctx
    const el = this.el
    if (!ctx || !el) return
    if (ctx.state === 'suspended') await ctx.resume()

    this.fadeToken += 1
    try {
      await el.play()
    } catch (error) {
      console.error('[aurora] playback was blocked', error)
      usePlayer.getState().setPlaying(false)
      return
    }
    this.ramp(1, FADE_IN_MS)
    usePlayer.getState().setPlaying(true)
    this.startTicker()
  }

  pause(): void {
    const el = this.el
    if (!el) return
    // Fade first, then actually stop, so pausing does not click.
    const token = ++this.fadeToken
    this.ramp(0, FADE_OUT_MS)
    window.setTimeout(() => {
      if (token !== this.fadeToken) return
      el.pause()
      usePlayer.getState().setPlaying(false)
      this.stopTicker()
    }, FADE_OUT_MS)
  }

  seek(seconds: number): void {
    const el = this.el
    if (!el || !Number.isFinite(seconds)) return
    const limit = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : seconds
    el.currentTime = Math.min(Math.max(0, seconds), Math.max(0, limit - 0.05))
    usePlayer.getState().setPosition(el.currentTime)
  }

  setVolume(): void {
    this.applyVolume()
  }

  setEq(): void {
    this.applyEq()
  }

  getSpectrum(): Uint8Array | null {
    const analyser = this.analyser
    if (!analyser || this.spectrum.length === 0) return null
    analyser.getByteFrequencyData(this.spectrum)
    return this.spectrum
  }

  // --- position reporting --------------------------------------------------

  private startTicker(): void {
    if (this.raf) return
    const tick = () => {
      const el = this.el
      if (!el) return
      usePlayer.getState().setPosition(el.currentTime)
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  private stopTicker(): void {
    if (!this.raf) return
    cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  // --- OS integration ------------------------------------------------------

  private installMediaSession(): void {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession

    const bind = (action: MediaSessionAction) => {
      try {
        ms.setActionHandler(action, (details) => {
          switch (action) {
            case 'play':
              void this.play()
              break
            case 'pause':
              this.pause()
              break
            case 'nexttrack':
              engineHooks.next(false)
              break
            case 'previoustrack':
              engineHooks.prev()
              break
            case 'stop':
              this.pause()
              this.seek(0)
              break
            case 'seekto':
              if (typeof details.seekTime === 'number') this.seek(details.seekTime)
              break
            case 'seekbackward':
              this.seek((this.el?.currentTime ?? 0) - (details.seekOffset ?? 10))
              break
            case 'seekforward':
              this.seek((this.el?.currentTime ?? 0) + (details.seekOffset ?? 10))
              break
          }
        })
      } catch {
        // Not every Chromium build implements every action; ignoring is correct.
      }
    }

    const actions: MediaSessionAction[] = [
      'play',
      'pause',
      'nexttrack',
      'previoustrack',
      'stop',
      'seekto',
      'seekbackward',
      'seekforward'
    ]
    actions.forEach(bind)
  }

  private updateMediaSession(track: Track | null): void {
    if (!('mediaSession' in navigator)) return
    if (!track) {
      navigator.mediaSession.metadata = null
      return
    }
    const artwork = sourceFor(track).artUrl(track)
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork: artwork ? [{ src: artwork, sizes: '512x512' }] : []
    })
  }
}

export const engine = new AudioEngine()
