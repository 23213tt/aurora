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
    name: '网易云音乐',
    summary: '搜索并播放网易云上的歌曲，支持登录自己的账号',
    kind: 'password',
    status: 'ready',
    note:
      '这不是官方客户端，也不存在官方授权：Aurora 接的是第三方逆向出来的私有接口' +
      '（NeteaseCloudMusicApiEnhanced），仅供个人学习自用，风险自负。' +
      '它只能播放你这个账号本来就有权播放的内容——不绕过付费、不破解会员音质、不解锁 VIP 单曲；' +
      '遇到需要会员或受地区限制的歌，界面会如实说明原因，而不是假装能播。' +
      '这类接口随时可能被平台改动而失效，账号也可能被风控波及。' +
      '想稳定听会员曲库，请用官方客户端。QQ 音乐不接入。'
  }
]

export function providerOf(id: ProviderId): AuthProvider {
  return AUTH_PROVIDERS.find((p) => p.id === id) ?? AUTH_PROVIDERS[0]
}
