# 网易云主进程探针（netease-smoke）

> 由 `electron/netease/smoke.cjs` 生成，运行于 2026-10-14T11:25:30.871Z。
> 模式：`client-only`。
> 复现：`npm run build:electron && node electron/netease/smoke.cjs`；
> 冷启动（把 %TEMP% 里的 anonymous_token / xeapi_public_key / aurora_device_id
> 三个文件一起删掉，再让客户端自己从零引导）：`node electron/netease/smoke.cjs --client-only`。
>
> 默认模式下探针先按 `scripts/probe-netease5.cjs` 的顺序在本进程里引导一遍；
> `--client-only` 模式下探针完全不碰引导，`%TEMP%` 里的空 token 文件、deviceId、
> xeapi key 与匿名 MUSIC_A 全部由 `dist-electron/netease/client.js` 自己建立。
> 两种模式驱动的都是**编译产物**（`client.js` 与 `remote-protocol.js`），
> 所以下面的数字来自真正参与构建的主进程代码，而不是另抄的一份逻辑。

**结果：全部通过。**

```json
{
  "when": "2026-10-14T11:25:30.871Z",
  "repo": "D:\\Aurora",
  "mode": "client-only",
  "bootstrap": {
    "skipped": true,
    "note": "client.js performed the whole sequence itself"
  },
  "diagnostics": {
    "ready": true,
    "detail": "",
    "deviceIdLength": 52,
    "keyVersion": "1000000000000",
    "hasAnonymousToken": true,
    "tokenFileBytes": 930,
    "hasSession": false
  },
  "status": {
    "ready": true,
    "loggedIn": false
  },
  "search": {
    "keywords": "周杰伦 晴天",
    "count": 5,
    "songs": [
      {
        "id": 2668397359,
        "name": "晴天 (原唱 周杰伦)",
        "artists": [
          "RyaVocal"
        ],
        "album": "晴天",
        "hasCover": true,
        "duration": 271,
        "fee": 8
      },
      {
        "id": 3440441479,
        "name": "晴天",
        "artists": [
          "Jay"
        ],
        "album": "晴天",
        "hasCover": true,
        "duration": 112,
        "fee": 8
      },
      {
        "id": 2652820720,
        "name": "晴天(深情版)",
        "artists": [
          "Lucky小爱"
        ],
        "album": "晴天(深情版)",
        "hasCover": true,
        "duration": 279,
        "fee": 8
      },
      {
        "id": 2653714443,
        "name": "晴天 (女声版))",
        "artists": [
          "GYBeat"
        ],
        "album": "晴天 (女声版)",
        "hasCover": true,
        "duration": 269,
        "fee": 8
      },
      {
        "id": 1945894789,
        "name": "晴天 (钢琴版) [原唱: 周杰伦]",
        "artists": [
          "纪钧瀚 (Bryan Chi)"
        ],
        "album": "钢琴放松轻听 流行轻音乐 华语经典",
        "hasCover": true,
        "duration": 238,
        "fee": 1
      }
    ]
  },
  "stream": {
    "ok": true,
    "url": "http://m801.music.126.net/20261014195...(261 chars masked)",
    "br": 320000,
    "level": "exhigh",
    "duration": 271,
    "trial": false
  },
  "upstreamRange": {
    "status": 206,
    "contentType": "audio/mpeg",
    "contentRange": "bytes 0-4095/10831725",
    "acceptRanges": null,
    "cors": "*",
    "bytes": 4096
  },
  "proxyRange": {
    "status": 206,
    "contentType": "audio/mpeg",
    "contentRange": "bytes 0-4095/10831725",
    "acceptRanges": "bytes",
    "cors": "*",
    "exposeHeaders": "content-range, content-length, accept-ranges",
    "bytes": 4096
  },
  "refusals": [
    {
      "target": "http://127.0.0.1:1/audio.mp3",
      "status": 403
    },
    {
      "target": "http://10.0.0.1/audio.mp3",
      "status": 403
    },
    {
      "target": "http://172.16.5.4/audio.mp3",
      "status": 403
    },
    {
      "target": "http://192.168.1.1/audio.mp3",
      "status": 403
    },
    {
      "target": "http://169.254.169.254/latest/meta-data/",
      "status": 403
    },
    {
      "target": "http://[::1]/audio.mp3",
      "status": 403
    },
    {
      "target": "http://[fe80::1]/audio.mp3",
      "status": 403
    },
    {
      "target": "file:///C:/Windows/win.ini",
      "status": 400
    },
    {
      "target": "ftp://example.com/audio.mp3",
      "status": 400
    }
  ],
  "lyrics": {
    "hasLrc": true,
    "lrcChars": 1471,
    "hasTranslation": false,
    "translationChars": 0,
    "head": "[00:00.000] 作词 : Chieh-lun Chou\n[00:00.000] 作曲 : Chieh-lun Chou\n[00:00.000]晴天 - 周杰伦 (Jay Chou)\n[00:02.250]词：周杰伦"
  },
  "albumSearch": {
    "id": 382004278,
    "name": "周杰伦“晴天”Emo TrapxPop Type Beat",
    "artist": "何洛林",
    "picUrl": "https://p4.music.126.net/pLqUvkevxM8XqBZt7J0wRQ==/109951173398629815.jpg",
    "year": 2026,
    "songCount": 1
  },
  "songDetail": {
    "id": 2668397359,
    "name": "晴天 (原唱 周杰伦)",
    "artists": [
      {
        "id": 0,
        "name": "RyaVocal"
      }
    ],
    "album": {
      "id": 260499608,
      "name": "晴天",
      "picUrl": "https://p3.music.126.net/-NVLOT5vt9I91LRiZV1TCQ==/109951170413587092.jpg"
    },
    "duration": 271,
    "fee": 8
  },
  "album": {
    "id": 260499608,
    "name": "晴天",
    "artist": "RyaVocal",
    "songs": 1,
    "year": 2025
  },
  "artistTopSongs": {
    "artistId": 6452,
    "artistName": "周杰伦",
    "count": 3,
    "names": [
      "布拉格广场",
      "屋顶",
      "想你就写信 (Live)"
    ]
  },
  "invalidIds": {
    "artistTopSongs": 0,
    "album": null,
    "lyrics": null,
    "playlistTracks": 0,
    "streamReason": "unknown"
  },
  "signedOutLists": {
    "myPlaylists": 0,
    "dailySongs": 0,
    "cloudSongs": 0,
    "likeList": 0
  }
}
```
