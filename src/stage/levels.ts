/**
 * Turns raw analyser bytes into the handful of numbers the visual system wants.
 *
 * Two things matter here. Bands are spaced logarithmically, because linearly
 * spaced FFT bins put almost everything the ear cares about into the left third
 * of the display. And the envelope uses separate attack and release constants,
 * the way a hardware VU meter does - instant rise, slow fall - which is what
 * makes motion look like it is following music rather than twitching.
 */

 interface Levels {
  bass: number
  mid: number
  treble: number
  /** Broadband loudness, 0..1. */
  energy: number
  /** Log-spaced normalised bands for curve drawing. */
  bands: Float32Array
  /** True when there is no signal at all (nothing playing). */
  silent: boolean
}

const ATTACK = 0.55
const RELEASE = 0.045

export function createLevelReader(bandCount = 112) {
  const bands = new Float32Array(bandCount)
  const raw = new Float32Array(bandCount)
  let energy = 0
  let bass = 0
  let mid = 0
  let treble = 0
  // 20 Hz .. ~18 kHz across the visible range.
  const minLog = Math.log10(20)
  const maxLog = Math.log10(18000)
  const ratio = (maxLog - minLog) / bandCount
  const nyquist = 22050

  /*
   * Which FFT bins each band averages, resolved once per spectrum length.
   *
   * The band edges are fixed by the band index and the bin width, so they do not
   * change between frames; only the analysis size can, and only when the
   * AnalyserNode is reconfigured. Computing them every frame cost 224 `Math.pow`
   * calls per frame (two per band) for numbers that never move - small next to
   * the canvas work, but free to remove, and the arithmetic is the same
   * expression evaluated once so the bin indices are unchanged.
   */
  const fromBin = new Int32Array(bandCount)
  const toBin = new Int32Array(bandCount)
  let resolvedFor = -1
  const resolveBands = (bins: number) => {
    if (bins === resolvedFor) return
    resolvedFor = bins
    const binHz = nyquist / bins
    for (let i = 0; i < bandCount; i += 1) {
      const low = Math.pow(10, minLog + ratio * i)
      const high = Math.pow(10, minLog + ratio * (i + 1))
      const from = Math.max(0, Math.min(bins - 1, Math.floor(low / binHz)))
      fromBin[i] = from
      toBin[i] = Math.max(from + 1, Math.min(bins, Math.ceil(high / binHz)))
    }
  }

  /** One-pole filter with asymmetric rise/fall. */
  const follow = (current: number, target: number, attackScale = 1) => {
    const coefficient = target > current ? ATTACK * attackScale : RELEASE
    return current + (target - current) * coefficient
  }

  return function read(spectrum: Uint8Array | null): Levels {
    if (!spectrum || spectrum.length === 0) {
      for (let i = 0; i < bandCount; i += 1) bands[i] = follow(bands[i], 0)
      energy = follow(energy, 0)
      bass = follow(bass, 0)
      mid = follow(mid, 0)
      treble = follow(treble, 0)
      return { bass, mid, treble, energy, bands, silent: true }
    }

    const bins = spectrum.length
    resolveBands(bins)

    for (let i = 0; i < bandCount; i += 1) {
      const from = fromBin[i]
      const to = toBin[i]

      let sum = 0
      for (let b = from; b < to; b += 1) sum += spectrum[b]
      const average = sum / (to - from) / 255
      // A mild power curve lifts quiet detail without flattening transients.
      raw[i] = Math.pow(average, 0.78)
    }

    for (let i = 0; i < bandCount; i += 1) bands[i] = follow(bands[i], raw[i])

    const third = Math.floor(bandCount / 3)
    const mean = (from: number, to: number) => {
      let sum = 0
      for (let i = from; i < to; i += 1) sum += bands[i]
      return sum / Math.max(1, to - from)
    }

    bass = follow(bass, Math.min(1, mean(0, third) * 1.5))
    mid = follow(mid, Math.min(1, mean(third, third * 2) * 1.7))
    treble = follow(treble, Math.min(1, mean(third * 2, bandCount) * 2.2))
    energy = follow(energy, Math.min(1, (bass + mid + treble) / 2.4))

    return { bass, mid, treble, energy, bands, silent: false }
  }
}
