/**
 * The account/preset registry.
 *
 * Aurora deliberately separates two things people lump together as "login":
 *
 *  1. Identity on this machine - local profiles, implemented here.
 *  2. A remote service account - only ever through an interface the service
 *     itself publishes for third parties.
 *
 * Several entries below are marked `planned`: the seam exists, the UI states
 * what it needs, and nothing is pretended to work. `unsupported` is used for
 * services where no authorised interface exists at all, with the reason written
 * out so the boundary is visible in the product rather than only in a chat.
 */

export type ProviderId =
  | 'local'
  | 'subsonic'
  | 'lastfm'
  | 'listenbrainz'
  | 'spotify'
  | 'apple'
  | 'netease'

export interface ProviderField {
  key: string
  label: string
  type: 'text' | 'password' | 'url'
  placeholder?: string
}

export interface AuthProvider {
  id: ProviderId
  name: string
  summary: string
  /** What the sign-in flow needs to collect. */
  kind: 'none' | 'password' | 'token' | 'oauth' | 'unavailable'
  status: 'ready' | 'planned' | 'unsupported'
  fields?: ProviderField[]
  /** Shown verbatim in the UI: what this needs, or why it is not offered. */
  note: string
}

export const AUTH_PROVIDERS: AuthProvider[] = [
  {
    id: 'local',
    name: '本地档案',
    summary: '分开不同的曲库、歌单和播放统计',
    kind: 'none',
    status: 'ready',
    note: '不需要联网，也不会上传任何东西。一台电脑上可以建多个档案，比如「我」和「客厅」。'
  },
  {
    id: 'subsonic',
    name: 'Subsonic / Navidrome / Jellyfin',
    summary: '登录你自己的音乐服务器，流式播放整个曲库',
    kind: 'password',
    status: 'planned',
    fields: [
      { key: 'server', label: '服务器地址', type: 'url', placeholder: 'https://music.example.com' },
      { key: 'username', label: '用户名', type: 'text' },
      { key: 'password', label: '密码', type: 'password' }
    ],
    note: '这是「登录账号听自己的音乐」最干净的做法。需要你已经有一个 Navidrome / Subsonic 服务器。'
  },
  {
    id: 'listenbrainz',
    name: 'ListenBrainz',
    summary: '把听歌记录同步到开源的音乐档案',
    kind: 'token',
    status: 'planned',
    fields: [{ key: 'token', label: 'User token', type: 'password' }],
    note: '开源项目，在官网个人设置里直接生成 token，不需要审批。'
  },
  {
    id: 'lastfm',
    name: 'Last.fm',
    summary: 'Scrobble 听歌记录，同步「喜爱的歌曲」',
    kind: 'oauth',
    status: 'planned',
    note: '需要你先在 Last.fm 申请一个免费的 API key（约两分钟，个人开发者即可）。'
  },
  {
    id: 'spotify',
    name: 'Spotify',
    summary: '登录账号，播放你的会员曲库',
    kind: 'oauth',
    status: 'planned',
    note:
      '官方 Web Playback SDK 明确允许第三方播放器播放会员曲库，需要 Spotify Premium，并自己申请一个 ' +
      'developer app 拿 Client ID。这是「登录账号播会员歌曲」的合规做法。'
  },
  {
    id: 'apple',
    name: 'Apple Music',
    summary: '通过 MusicKit 播放订阅曲库',
    kind: 'oauth',
    status: 'planned',
    note: '需要 Apple Developer 账号并申请 MusicKit identifier。'
  },
  {
    id: 'netease',
    name: '网易云音乐 / QQ 音乐',
    summary: '不提供',
    kind: 'unavailable',
    status: 'unsupported',
    note:
      '这两家没有对个人开放的曲库接口，其开放平台只面向硬件、车载、App 内嵌等合作方。' +
      '第三方客户端只能逆向它们的私有接口，这属于未授权访问并违反服务条款，Aurora 不做。' +
      '想用这个功能请使用它们的官方客户端。'
  }
]

export function providerOf(id: ProviderId): AuthProvider {
  return AUTH_PROVIDERS.find((p) => p.id === id) ?? AUTH_PROVIDERS[0]
}
