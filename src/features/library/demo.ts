import type { Track } from '../../types'
import { coverFor } from './cover'

/**
 * A demo library used for design previews and screenshots.
 *
 * Real artwork and real tags always take precedence; this exists so the
 * interface can be judged with a populated library before anything is scanned.
 */

interface Seed {
  album: string
  albumArtist: string
  year: number
  genre: string
  tracks: string[]
}

const SEEDS: Seed[] = [
  {
    album: '夜行列车',
    albumArtist: '陈默',
    year: 2024,
    genre: '独立民谣',
    tracks: ['站台', '夜行列车', '隧道里的风', '第三种沉默', '到站之前']
  },
  {
    album: 'Slow Tide',
    albumArtist: 'Marisol Vega',
    year: 2023,
    genre: 'Dream Pop',
    tracks: ['Undertow', 'Slow Tide', 'Salt and Glass', 'Harbour Lights']
  },
  {
    album: '城市光尘',
    albumArtist: '河图乐队',
    year: 2025,
    genre: '后摇',
    tracks: ['引子', '城市光尘', '每天同一班地铁', '凌晨四点的便利店', '归零']
  },
  {
    album: 'Paper Lanterns',
    albumArtist: 'Kite & Anchor',
    year: 2022,
    genre: 'Folk',
    tracks: ['Paper Lanterns', 'Riverbend', 'The Long Way Down', 'Winter Field']
  },
  {
    album: '未寄出的信',
    albumArtist: '林砚',
    year: 2024,
    genre: '钢琴',
    tracks: ['第一封', '第二封', '第三封', '第四封']
  },
  {
    album: 'Nordlicht',
    albumArtist: 'Fjord Ensemble',
    year: 2021,
    genre: 'Ambient',
    tracks: ['Polar Night', 'Nordlicht', 'Ice Field', 'Aurora Borealis', 'Return of Light']
  }
]

const CODECS = ['FLAC', 'MP3', 'AAC', 'FLAC', 'MP3'] as const

function buildLibrary(): Track[] {
  const tracks: Track[] = []
  let globalIndex = 0
  // A fixed base time keeps the demo deterministic across reloads.
  const base = Date.UTC(2025, 8, 1) / 1000

  SEEDS.forEach((seed, albumIndex) => {
    seed.tracks.forEach((title, trackIndex) => {
      globalIndex += 1
      const codec = CODECS[(albumIndex + trackIndex) % CODECS.length]
      const lossless = codec === 'FLAC'
      // Duration varies plausibly between roughly 2:40 and 5:10.
      const duration = 160 + ((globalIndex * 37) % 150)
      const id = `demo-${albumIndex}-${trackIndex}`

      tracks.push({
        id,
        path: `C:\\Users\\PC\\Music\\${seed.albumArtist}\\${seed.album}\\${String(trackIndex + 1).padStart(2, '0')} ${title}.${codec.toLowerCase()}`,
        title,
        artist: seed.albumArtist,
        albumArtist: seed.albumArtist,
        album: seed.album,
        genre: seed.genre,
        year: seed.year,
        trackNo: trackIndex + 1,
        discNo: 1,
        duration,
        bitrate: lossless ? 950 + ((globalIndex * 13) % 200) : 320,
        sampleRate: lossless ? 44100 : 44100,
        channels: 2,
        codec,
        lossless,
        size: Math.round(duration * (lossless ? 118000 : 40000)),
        mtimeMs: (base - globalIndex * 86400) * 1000,
        addedAt: base - globalIndex * 3600,
        hasArt: true,
        gainDb: null,
        peak: null
      })
    })
  })

  return tracks
}

export const demoLibrary: Track[] = buildLibrary()

export function demoCovers(): Map<string, string> {
  const map = new Map<string, string>()
  for (const track of demoLibrary) {
    if (!map.has(track.album)) map.set(track.album, coverFor(track.album))
  }
  return map
}

const covers = demoCovers()

/** Placeholder artwork for a demo track, keyed by album. */
export function demoCoverFor(track: Track): string {
  return covers.get(track.album) ?? coverFor(track.album)
}

/**
 * An original lyric written for the demo dataset. Deliberately not a real
 * published song: shipping someone else's lyrics with a demo would be a
 * licensing problem, and this file exists to prove the parser and the stage.
 */
const DEMO_LRC = `[ti:夜行列车]
[ar:陈默]
[al:夜行列车]
[by:Aurora demo]
[offset:0]
[00:01.20]（前奏）
[00:12.40]站台的灯把影子拉长
[00:18.60]我数着第几次回头望
[00:24.90]广播里有听不清的远方
[00:31.20]列车进站 带走一整年的慌
[00:38.00]窗外的黑不是没有颜色
[00:44.30]是所有的城市都睡了
[00:50.60]我把名字写在起雾的玻璃上
[00:57.10]写完就擦掉 像没发生过一样
[01:05.50]夜行列车 载着不肯说出口的话
[01:13.80]一站一站 把昨天留在身后啊
[01:22.10]如果天亮之前我还没想清楚
[01:29.40]就让我再坐过一站吧
[01:38.20]（间奏）
[01:52.60]对面的人靠着窗睡着了
[01:58.90]他的梦里有没有人等他
[02:05.20]我们都把目的地藏在口袋
[02:11.50]谁也不敢先拿出来看
[02:19.90]夜行列车 载着不肯说出口的话
[02:28.20]一站一站 把昨天留在身后啊
[02:36.50]如果天亮之前我还没想清楚
[02:43.80]就让我再坐过一站吧
[02:52.10]再坐过一站
[03:00.40]天边开始有一点灰
[03:06.70]我知道该下车了
[03:13.00]（尾奏）`

const LYRICS_BY_ALBUM: Record<string, string> = {
  夜行列车: DEMO_LRC
}

/** Raw LRC text for a demo track, or null when the album has none. */
export function demoLyricsFor(track: Track): string | null {
  return LYRICS_BY_ALBUM[track.album] ?? null
}

export const demoArt = (track: Track): string => demoCoverFor(track)
