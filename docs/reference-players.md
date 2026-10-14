# 参考软件分析：多平台接入是怎么做的

这份文档记录**读参考软件代码得出的事实**，用于指导 Aurora 的平台层设计。用户明确要求「参考现有的这些音乐播放器，看他们是怎么做的，看他们的文件」，所以这里是先读、再照着做，而不是自己发明结构。

**重要前提：只看结构，不抄代码。** Aurora 是 MIT，Folia 是闭源，Mineradio 是 GPL-3.0。下面记录的是「它们怎么组织」，任何代码都是独立实现。

两个参考软件：

| | Folia | Mineradio |
|---|---|---|
| 语言/形态 | TypeScript，Electron | 网页 + Electron 外壳（`public/js`，另有 264KB 的 `server.js` 作后端） |
| 许可 | 闭源 | GPL-3.0（已停更） |
| 界面截图 | 仓库内有真实快照（`test/ui/app.screenshot.spec.ts-snapshots/`） | **没有**（只有一张暗场启动页），其界面只能引用文档 |
| 接入的平台 | 网易云、酷狗、**QQ 音乐**、波点（bodian） | 网易云、**QQ 音乐**、酷狗、汽水音乐、Spotify |

---

## 一、Folia：`provider` 是一组可选能力

### 目录结构（`src/services/onlineMusic/`）

```
providerRegistry.ts        注册表（3KB）
neteaseProvider.ts   31KB      kugouProvider.ts  75KB
qqProvider.ts        42KB      bodianProvider.ts  7KB
qqTransport.ts       17KB      kugouTransport.ts 22KB
qqNormalize.ts       17KB      bodianNormalize.ts  5KB
neteasePlaybackFailure.ts 10KB bodianErrors.ts     5KB
songAvailability.ts         1KB
```

**每个平台是四个文件**：Provider（实现与能力声明）+ Transport（发请求、cookie、错误码）+ Normalize（上游响应 → 统一形状）+ 失败分类。这个划分是照抄的理由：`normalize` 与失败分类是**纯函数**，可以脱离运行时测试；transport 只管网络；provider 只做组装。

### 注册表契约（`providerRegistry.ts`）

```ts
registerOnlineMusicProvider(provider)      // Map<ProviderId, Provider>
listOnlineMusicProviders() / getOnlineMusicProvider(id)
providerSupports(provider, capability)     // 能力查询
getOnlineMusicProviderForSong(song)        // 按歌曲反查平台
canPlayOnlineMusicSong(song)
```
文件最后四行把 netease / kugou / qq / bodian 全部注册。**UI 只拿 `listProviders()`，不 import 任何具体平台。**

注册表还带一个 `registryVersion` + 订阅机制，因为 mod 会在运行时增删 provider——Aurora 不需要这一层（平台是编译期固定的），但「UI 订阅列表变化」这个形状值得保留。

### provider 契约是一组可选子接口

```ts
interface OnlineMusicProvider {
  id; displayName; shortName?
  capabilities: ProviderCapabilities      // search / playback / lyrics / auth / userLibrary /
                                          // playlists / albums / artists / recommendations /
                                          // mutations / wordByWordLyrics / userCloud …
  normalizeSong(raw): UnifiedSong
  search?; playback?; lyrics?; auth?; library?; catalog?; recommendations?; mutations?
}
```

几点值得照搬：

1. **能力用布尔显式声明**。「某个平台没有每日推荐」是 `recommendations: false`，不是在 UI 里判断它是哪个平台。Aurora 侧栏里硬编码的「每日推荐 / 我喜欢的音乐 / 云盘」应该由平台自己声明。
2. **子接口都是可选的**，所以一个只支持搜索的平台不必实现播放接口。`providerSupports()` 查询前先看能力位。
3. **`normalizeSong` 是必须的**（不带问号）——每个平台都必须把上游响应转成统一形状。这就是把「上游长什么样」隔离在一个纯函数里的地方。

### 歌曲自带来源标识

```ts
getPlaybackSourceRef(song)  // { kind: 'online', providerId } | { kind: 'local', … }
```

所以一首歌知道自己属于哪个平台，UI 不需要猜。**这条直接解决 Aurora 的一条已知限制（歌曲列表里看不出歌来自平台还是本地）。**

### 可用性不是报错（契约注释原文）

```ts
export interface ProviderSongAvailability {
  state: 'playable' | 'unavailable' | 'unknown'
  label?: string
  reason?: 'taken-down' | 'restricted'
}
```
> `state 'unavailable'` 只能搭配 `'taken-down'`；权限 / 付费 / 地区这类限制只能是 `state 'unknown'` + `reason 'restricted'`，交给运行时判定。**运行时失败永不回写这里。**

即区分「**确定下架**」与「**可能因权限播不了、要等真请求**」。`getSongAvailability(song)` 由各平台自己实现（`playback.getAvailability?()`），UI 拿到的只是 `{ state, label }`，不含平台细节。

这条规则对 Aurora 直接适用：QQ 音乐的 VIP 歌（实测 `result=104003`）属于「受限」，**不能硬编码成已下架，也不能当 error**。

### 能力查询（`capability.ts`，全文 16 行）

```ts
type LibraryCapabilityReason = 'empty' | 'loading' | 'unsupported' | 'pending' | 'limit-reached'
type LibraryCapability = { supported; enabled; pending; reason? }
```
注释写着「按钮与命令面板共用同一份结果」。值得学的是：**「这个按钮现在能不能点、为什么不能点」本身是一个结构化查询**，而不是散落在各处的 `disabled={…}`。

---

## 二、Mineradio：一切都经后端，会员状态要穷举探测

### 目录结构

```
server.js               264KB   ← 所有平台调用集中在这个 Node 后端
spotify-api.js           61KB
kugou-api.js             88KB
qishui-api.js           132KB   （汽水音乐）
qq-vip-api.js            27KB   ← 会员权益探测，独立成文件
qishui-auth-v6.js        20KB   qishui-auth-v6/（bdms.js 233KB、sdk-glue.js 92KB、react-dom.js 118KB）
qishui-audio-decryptor/   10KB   decrypt-utils / mp4-box / track-decryptor
desktop/                        local-music-library.js 29KB、full-desktop-mode-runtime.js 89KB
public/js/modules/              01-scene 02-visual 03-beat 04-shelf 05-playback 06-lyrics 07-fx 08-account 10-shell
cuefield/                       音乐结构分析与转场规划（18 个文件，recipe-planner.js 62KB）
```

与 Folia 的对比：Mineradio 的平台客户端**不共享接口**，每个 `*-api.js` 是独立的一大坨，统一性靠 `server.js` 里的路由来收。**这一点不建议学**——Folia 的 provider 契约明显更好维护。

### 但有一件它做得比 Folia 更彻底：会员权益探测

`qq-vip-api.js` 里判断「这个账号是不是 VIP」用了**七组候选键名**：`VIP_TYPE_KEYS`、`SVIP_TYPE_KEYS`、`VIP_FLAG_KEYS`、`SVIP_FLAG_KEYS`、`MEMBERSHIP_STATUS_KEYS`、`MEMBERSHIP_LEVEL_KEYS`、`MEMBERSHIP_EXPIRY_KEYS`，加一组正则 `/vip|member|membership|green|luxury|associator/`，在响应对象里**深度优先探测到 8 层**，并给「过期但仍在宽限期内」留了 `10 分钟`。

它这么做的原因很清楚：**上游返回的字段名与结构会变**。靠单个字段判断会员，接口一改就静默失效。

配套测试也很重：`tests/qq-vip-entitlement.test.js` 26KB、`kugou-vip-hardening.test.js`、`qishui-entitlement-cache.test.js`。

**对 Aurora 的启示**：QQ 音乐的「这首歌你能不能播」不能写成 `pay_play === 1 → 拒绝` 了事。`pay_play` 只是搜索响应里的一个提示，真实权限在换 vkey 那一步才确定（`result=104003`）。要用：
- 搜索结果的 `pay_play` / `size_*` 做**初步提示**（列表里可以先标出来）
- 真正播放时以 vkey 请求的 `result` 为准
- 会员状态**单独探测**（`GetLoginUserInfo`，伪 cookie 回 `req_0.code=1000`），失败时不要缓存成「非会员」——Mineradio 给过期判断留了宽限期，正是这个原因

---

## 三、两者共同的做法（可以放心照搬）

1. **平台是数据，不是代码分支**。两个项目都没有在 UI 里写 `if (platform === 'netease')`。
2. **上游响应必须经过归一化函数**，不能把上游字段名泄漏到界面层。
3. **播放地址是两步**（换 key/vkey → 拼 URL），且 key 有 TTL。
4. **每个平台有自己的失败词汇**（Folia 每个平台一个 `*Failure.ts`）。
5. **二维码/扫码登录是标配**，不是附赠功能。
6. **纯函数部分单独成文件并测试**：normalize、错误分类、URL 构造、权限判断。

## 四、明确不学的部分

| 做法 | 出现在 | 为什么不学 |
|---|---|---|
| `qishui-audio-decryptor/`（解密加密音频） | Mineradio | Aurora 的 README 明确承诺不破解加密音频、不绕过付费。这条是立场，不是技术难度问题 |
| 把全部平台塞进一个 264KB 的 `server.js` | Mineradio | 与 Folia 的 provider 契约相比难以维护；Aurora 采用后者的分文件方式 |
| 平台客户端各写一套、共享零个接口 | Mineradio | 加一个平台要重复实现搜索/归一化/错误分类 |
| 运行时注册 provider + mod 系统 | Folia | Aurora 的平台是编译期固定的，这层抽象没有收益 |

---

## 五、落到 Aurora 的结论

按 Folia 的结构做，按 Mineradio 的教训补两点：

```
src/features/online/
  registry.ts              平台注册表（Map + register/list/get + 能力查询 + 按歌曲反查）
  contract.ts              OnlineMusicProvider / ProviderCapabilities / ProviderSongAvailability
  availability.ts          getSongAvailability(song) 的统一查询
  netease/                 provider + transport + normalize + failure
  qq/                      provider + transport + normalize + failure
electron/qq/               主进程侧：transport / normalize / reasons / session / client / ipc
```

**两条从 Mineradio 学来的硬要求**：

1. **VIP 歌不可播是「受限」而非「已下架」**，且**播放时才最终确定**——搜索阶段的 `pay_play` 只能当提示。
2. **会员状态探测要能容忍上游字段变化**，并且**失败时不能缓存成「非会员」**（否则一次网络抖动会让用户以为自己的会员失效了）。
