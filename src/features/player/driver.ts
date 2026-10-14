import type { Track } from '../../types'
import { isNative } from '../../bridge'
import {
  engine,
  engineHooks,
  HIDDEN_POSITION_MS,
  isWindowVisible,
  onWindowVisibility
} from './engine'
import { usePlayer } from './store'

/**
 * The playback seam.
 *
 * The player core talks to this interface, never to the Web Audio graph
 * directly. Two reasons: the browser preview can drive the whole UI with
 * synthetic audio (which is the only way to iterate on the visual system
 * without launching Electron), and a future backend - native audio, or a
 * streaming provider - can replace the engine without touching transport logic.
 */
export interface AudioDriver {
  load(track: Track, autoplay: boolean): Promise<void>
  play(): Promise<void>
  pause(): void
  seek(seconds: number): void
  setVolume(): void
  setEq(): void
  /** Analyser magnitudes, or null when there is no signal. */
  getSpectrum(): Uint8Array | null
}

/** Real playback. */
const webAudioDriver: AudioDriver = {
  load: (track, autoplay) => engine.load(track, autoplay),
  play: () => engine.play(),
  pause: () => engine.pause(),
  seek: (seconds) => engine.seek(seconds),
  setVolume: () => engine.setVolume(),
  setEq: () => engine.setEq(),
  getSpectrum: () => engine.getSpectrum()
}

/**
 * Silent driver used only in the browser preview.
 *
 * It owns a clock so the lyric stage advances and a synthetic spectrum so the
 * ribbons and motes have something musical to follow. It reports its state into
 * the same store the real engine writes to, so nothing downstream can tell the
 * difference.
 */
function createSyntheticDriver(): AudioDriver {
  const store = usePlayer
  /**
   * The harness opens mid-track rather than at 0:00, so a screenshot or a first
   * look shows a highlighted lyric line instead of the pre-roll state.
   */
  const START_AT = 52
  let position = 0
  let duration = 0
  let playing = false
  let frame = 0
  let hiddenTimer = 0
  let unbindVisibility: (() => void) | null = null
  let last = performance.now()

  const bands = 256
  const spectrum = new Uint8Array(bands)
  const phases = Float32Array.from({ length: bands }, (_, i) => (i * 0.7) % (Math.PI * 2))

  /** Advances the synthetic clock by the real elapsed time. */
  const advance = () => {
    const now = performance.now()
    const dt = Math.min(0.25, (now - last) / 1000)
    last = now
    if (!playing) return

    position += dt
    if (duration > 0 && position >= duration) {
      position = 0
      // Same path the real engine takes when a track runs out.
      engineHooks.next(true)
    }
    store.getState().setPosition(position)
  }

  /*
   * The same visibility policy the real engine applies, so the preview exercises
   * it too: animation frames while the window is on screen, a 250 ms timer while
   * it is not. Time is still measured, not counted, so the playhead never drifts
   * - only how often it is published changes.
   */
  const armClock = () => {
    disarmClock()
    if (!playing) return
    if (isWindowVisible()) {
      const tick = () => {
        advance()
        frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
      return
    }
    hiddenTimer = window.setInterval(advance, HIDDEN_POSITION_MS)
  }

  const disarmClock = () => {
    if (frame) {
      cancelAnimationFrame(frame)
      frame = 0
    }
    if (hiddenTimer) {
      window.clearInterval(hiddenTimer)
      hiddenTimer = 0
    }
  }

  const startClock = () => {
    if (!unbindVisibility) unbindVisibility = onWindowVisibility(armClock)
    last = performance.now()
    armClock()
  }

  const stopClock = () => {
    disarmClock()
  }

  const sample = () => {
    if (!playing) {
      // Decay so a paused stage reads as calm rather than as frozen noise.
      for (let i = 0; i < bands; i += 1) spectrum[i] = Math.max(0, spectrum[i] - 7)
      return
    }
    const t = performance.now() / 1000
    // A slow "song" envelope plus a sweeping formant: enough structure that the
    // visualiser looks like it is following music rather than twitching.
    const envelope = (0.6 + 0.4 * Math.sin(t * 0.62)) * (0.75 + 0.25 * Math.sin(t * 0.23))
    const sweep = (Math.sin(t * 0.11) + 1) / 2
    for (let i = 0; i < bands; i += 1) {
      const norm = i / bands
      const falloff = Math.pow(1 - norm, 1.35)
      const formant = Math.exp(-Math.pow((norm - (0.12 + sweep * 0.5)) * 5.2, 2))
      const ripple =
        0.5 + 0.5 * Math.sin(t * 2.1 + phases[i]) * Math.sin(t * 0.53 + phases[i] * 1.7)
      // A floor keeps the ribbons moving through quiet passages: the visual
      // system should never look switched off while music is playing.
      const value = (falloff * 0.5 + formant * 0.8) * ripple * envelope * 1.5 + 0.07
      spectrum[i] = Math.max(0, Math.min(255, Math.round(value * 255)))
    }
  }

  return {
    async load(track, autoplay) {
      position = Math.min(START_AT, Math.max(0, track.duration - 30))
      duration = track.duration
      store.getState().setDuration(track.duration)
      store.getState().setPosition(position)
      if (autoplay) await this.play()
      else {
        playing = false
        stopClock()
        store.getState().setPlaying(false)
      }
    },
    async play() {
      playing = true
      last = performance.now()
      store.getState().setPlaying(true)
      startClock()
    },
    pause() {
      playing = false
      stopClock()
      store.getState().setPlaying(false)
    },
    seek(seconds) {
      position = Math.max(0, Math.min(seconds, duration || seconds))
      store.getState().setPosition(position)
    },
    setVolume() {},
    setEq() {},
    getSpectrum() {
      sample()
      return spectrum
    }
  }
}

export const driver: AudioDriver = isNative ? webAudioDriver : createSyntheticDriver()
