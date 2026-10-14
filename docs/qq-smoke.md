# QQ 音乐主进程探针（qq-smoke）

> 由 `electron/qq/smoke.cjs` 生成，运行于 2026-10-14T16:13:09.448Z。
> 复现：`npm run build:electron && node electron/qq/smoke.cjs`。
> 探针驱动**编译产物** `dist-electron/qq/client.js` 与
> `dist-electron/remote-protocol.js`，并另起一段直接问上游包要原始 `result` 码，
> 所以下面的数字既来自真正参与构建的代码，也能与 `reasons.ts` 的判定对照。
> 本机**没有 QQ 音乐账号**：所以 320k / FLAC 需要登录这一档无法在真机上验证，
> 探针只记录实测到的部分。

**结果：全部通过。**

```json
{
  "when": "2026-10-14T16:13:09.448Z",
  "repo": "D:\\Aurora",
  "status": {
    "ready": true,
    "loggedIn": false
  },
  "search": {
    "keywords": "告白气球",
    "songs": 10,
    "albums": 10,
    "artists": 1,
    "first": [
      {
        "id": 107192078,
        "songmid": "003OUlho2HcRHC",
        "mediaMid": "003gbY6c0g1L4Q",
        "name": "告白气球",
        "artists": [
          "周杰伦"
        ],
        "album": "周杰伦的床边故事",
        "hasCover": true,
        "duration": 215,
        "fee": 1
      },
      {
        "id": 244115394,
        "songmid": "002t78Qs1Av9Kn",
        "mediaMid": "000deklO0sLspa",
        "name": "告白气球 (Live)",
        "artists": [
          "周杰伦"
        ],
        "album": "周杰伦地表最强世界巡回演唱会",
        "hasCover": true,
        "duration": 264,
        "fee": 1
      },
      {
        "id": 107785182,
        "songmid": "0037GMG74LpROP",
        "mediaMid": "004AD9WG2KSvC0",
        "name": "告白气球",
        "artists": [
          "二珂"
        ],
        "album": "",
        "hasCover": false,
        "duration": 213,
        "fee": 0
      }
    ],
    "albumSample": {
      "id": 1458791,
      "name": "周杰伦的床边故事",
      "artist": "周杰伦",
      "picUrl": "https://y.gtimg.cn/music/photo_new/T002R300x300M000003RMaRI1iFoYd.jpg",
      "year": null,
      "songCount": 0
    },
    "artistSample": {
      "id": 4558,
      "name": "周杰伦",
      "picUrl": "http://y.gtimg.cn/music/photo_new/T001R150x150M0000025NhlN2yWrP4.jpg",
      "albumCount": 43
    }
  },
  "picked": {
    "free": "0037GMG74LpROP",
    "paid": "003OUlho2HcRHC"
  },
  "stream": {
    "ok": true,
    "url": "http://aqqmusic.tc.qq.com/M500004AD9W...(187 chars masked)",
    "quality": "exhigh",
    "level": "standard",
    "br": 128,
    "lossless": false,
    "trial": false
  },
  "upstreamRange": {
    "status": 206,
    "contentType": "audio/mpeg",
    "contentRange": "bytes 0-4095/3413244",
    "acceptRanges": null,
    "cors": "*",
    "bytes": 4096,
    "magic": "49443303"
  },
  "proxyRange": {
    "status": 206,
    "contentType": "audio/mpeg",
    "contentRange": "bytes 0-4095/3413244",
    "acceptRanges": "bytes",
    "cors": "*",
    "bytes": 4096
  },
  "lyrics": {
    "chars": 1209,
    "head": "[ti:告白气球]\n[ar:周二珂]\n[al:   ]\n[by:]"
  },
  "cover": {
    "songmid": "003OUlho2HcRHC",
    "url": "https://y.gtimg.cn/music/photo_new/T002R300x300M000003RMaRI1iFoYd.jpg",
    "proxy": {
      "status": 200,
      "contentType": "image/jpeg",
      "cors": "*",
      "bytes": 66463
    }
  },
  "refusal": {
    "ok": false,
    "reason": "login-required",
    "message": "这首歌需要登录 QQ 音乐账号后才能播放"
  },
  "rawUpstream": {
    "0037GMG74LpROP/128": {
      "requestCode": 0,
      "result": 0,
      "hasPurl": true,
      "filename": "M5000037GMG74LpROP004AD9WG2KSvC0.mp3"
    },
    "0037GMG74LpROP/320": {
      "requestCode": 0,
      "result": 104003,
      "hasPurl": false,
      "filename": "M8000037GMG74LpROP004AD9WG2KSvC0.mp3"
    },
    "0037GMG74LpROP/flac": {
      "requestCode": 0,
      "result": 104003,
      "hasPurl": false,
      "filename": "F0000037GMG74LpROP004AD9WG2KSvC0.flac"
    },
    "003OUlho2HcRHC/128": {
      "requestCode": 0,
      "result": 104003,
      "hasPurl": false,
      "filename": "M500003OUlho2HcRHC003gbY6c0g1L4Q.mp3"
    },
    "003OUlho2HcRHC/320": {
      "requestCode": 0,
      "result": 104003,
      "hasPurl": false,
      "filename": "M800003OUlho2HcRHC003gbY6c0g1L4Q.mp3"
    },
    "003OUlho2HcRHC/flac": {
      "requestCode": 0,
      "result": 104003,
      "hasPurl": false,
      "filename": "F000003OUlho2HcRHC003gbY6c0g1L4Q.flac"
    },
    "numericIdAsSongmid": {
      "result": 101404,
      "hasPurl": false
    }
  }
}
```
