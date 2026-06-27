<p align="center">
  <img src="docs/app-icon.png" width="96" alt="ECHO iPhone app icon" />
</p>

<h1 align="center">ECHO iPhone</h1>

<p align="center">
  一款面向 iPhone 的独立音乐播放器，支持连接 <a href="https://github.com/Moekotori/ECHO">ECHO NEXT</a> EchoLink
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="README.en.md">English</a> · <a href="RELEASE_NOTES.md">Release Notes</a>
</p>

> 这是一个非官方社区项目，不隶属于 ECHO NEXT 官方仓库。

> 如果你有所属权、建议或问题反馈，可以在 [ECHO 官方 QQ 群](https://qm.qq.com/q/OdpngxJU86) 联系 @白雪ユキ。

> 本项目定位为独立音乐播放器。EchoLink 是其中一个连接、控制和串流来源，上游兼容会持续同步。

> 如果ECHO NEXT更新了IOS端 我会在此项目标出

> 这个项目是我的第一个作品 可能做的很烂 可能烂尾 本项目主要是为了证明windows可以全流程制作ios端软件(除了签名和发布)/还有自己使用IOS端的方便 感谢理解<3

## 这是什么

ECHO iPhone 是一个 iPhone 音乐播放器。它可以扫描并播放手机本地音乐，也可以连接 ECHO NEXT 的 EchoLink，浏览电脑曲库、控制电脑播放，或把电脑音乐串流到手机上播放。

0.5.0 开始加入真 DSP：本地播放和串流播放会优先走 iOS 原生音频引擎，EQ 预设、响度归一化、音量和 seek 都作用在真实音频链路上。设置、连接信息、语言、音频 tag、EQ、外源数据开关都会持久化保存。

## 功能亮点

- 独立播放模式：播放页支持本地、控制、串流三种输出，一处切换。
- 本地曲库：支持导入、扫描、收藏、最近播放、本地队列、LRC 歌词导入。
- 曲库切换：曲库页可在 ECHO 曲库和手机本地曲库之间切换，本地曲库支持歌曲、专辑、艺术家、格式、收藏、最近播放视图。
- EchoLink 配对链接连接：支持 `echo://pair?...` 一键填入。
- 手动局域网连接：Host、Port、Token 会保存到本机，不需要每次重新粘贴配对链接。
- 连接页新增 ECHO 连接开关，默认关闭；关闭时不会轮询电脑端，也不会弹出连接错误。
- 连接页新增“连接 ECHO / 流媒体”切换；流媒体入口暂未开放。
- 播放、曲库、连接、设置四页，支持底部玻璃 dock 和左右滑动切换。
- 播放页重构：封面、歌曲信息、tag、进度、播放控制、音量、EQ、播放列表和输出切换集中在一个播放器视图里。
- 高斯玻璃 UI：播放面板、按钮、dock、弹窗和弹层使用 `expo-blur` 统一风格。
- 真 DSP：本地 / 串流播放支持 iOS 原生 DSP、EQ 预设和响度归一化。
- EQ 预设：均衡、低频、人声、清晰、暖声、夜间。
- 音量展开条：展开后显示更长的滑条和当前百分比。
- 播放列表弹窗：播放页内打开，带开合动画。
- 歌词模式：支持本地 LRC、EchoLink `/lyrics`、LRCLIB 和网易云音乐结果，解析 LRC、自动滚动、当前歌词高亮。
- 歌词点击跳转：有时间戳的歌词行可以直接 seek。
- 外源数据：LRCLIB 优先补歌词，网易云音乐补封面和中文曲库歌词；EchoLink 没有封面或封面加载失败时会尝试外源封面。
- 稳定封面加载：新封面加载成功前保留上一张封面，减少默认封面闪动和空白。
- 滑条断触修复：进度条和音量条拖动时锁住页面手势，避免界面上滑抢触摸。
- 播放控制：上一首、播放/暂停、下一首、单曲循环、播放列表预览。
- 曲库搜索：浏览 PC 本地曲库，并从手机点歌到电脑端播放。
- 输出切换：可本地播放、控制电脑播放，也可在支持时串流到 iPhone。
- 音频信息标签：Local、可串流、WASAPI/ASIO、格式、采样率、位深、码率等。
- 设置页：按功能分组展开，支持语言、默认页面、默认曲库、音频 tag、EQ、响度归一化、外源数据、存储管理等设置。
- 本地持久化：连接信息、设置状态、本地收藏、最近播放和队列都会保存到 App 本地数据。

## 当前限制

- ECHO 曲库、电脑控制和电脑串流需要开启 ECHO NEXT 的 EchoLink。
- iPhone 和电脑需要在同一个局域网。
- Windows 防火墙需要允许 ECHO NEXT 通信。
- 手机串流依赖桌面端 stream 接口；DSP 模式会先缓存串流音频再播放。
- 外源数据默认关闭；LRCLIB 和网易云音乐开关可单独开启，需要手机能连接外网。
- 网易云音乐使用非官方公开接口，稳定性取决于上游可用性。
- 封面、歌词和音频 tag 优先使用本地文件或桌面端 EchoLink 返回的数据。
- 本仓库是 Expo / React Native 项目，不是原生 SwiftUI 项目。

## 环境要求

- Node.js 与 npm
- Expo，通过 `npx expo`
- 本地 iOS 构建需要 macOS + Xcode
- Windows 用户可以通过 GitHub Actions 触发 macOS runner 生成未签名 IPA
- 真机安装需要 Sideloadly、AltStore、Xcode 或其他签名安装方式

## 本地运行

```powershell
npm install
npm run start
```

类型检查：

```powershell
npm run typecheck
```

iOS Expo 导出检查：

```powershell
npx expo export --platform ios --output-dir build\export-check
```

## 连接 ECHO NEXT

连接页默认不会自动连接 ECHO。需要使用电脑端功能时，先打开“启用 ECHO 连接”，再使用配对链接或手动输入局域网地址。

```text
echo://pair?host=192.168.1.12&port=26789&token=...
```

手动连接字段：

- Host：电脑局域网 IP，例如 `192.168.2.27`
- Port：通常是 `26789`
- Token：从桌面端 EchoLink 配对界面复制

连接信息会保存在本机 AsyncStorage，下次打开 App 不需要重新粘贴配对链接。关闭 ECHO 连接开关后，App 会保留信息，但不会主动连接或弹窗提醒。

如果连接失败，优先检查：

- iPhone 和电脑是否在同一个 Wi-Fi / LAN。
- ECHO NEXT 是否正在运行，EchoLink 是否开启。
- Windows 防火墙是否允许 ECHO NEXT 在专用网络通信。
- Host 是否填写电脑局域网 IP，而不是 `localhost`、虚拟网卡 IP 或公网 IP。
- iOS 是否允许本地网络权限。

## 设置与外源数据

- 连接信息保存在 `src/storage/connectionStore.ts`。
- 设置项通过 App 本地个人数据保存，包括语言、默认页面、默认曲库、音频 tag、EQ、响度归一化、ECHO 连接开关、LRCLIB 开关和网易云音乐开关。
- 本地音乐状态保存在 `src/storage/localMusicStore.ts`，包括收藏、最近播放和本地队列。
- LRCLIB：优先用于获取歌曲歌词等。
- 网易云音乐：中文曲库补充，主要用于封面，也可作为歌词 fallback。
- 外源数据用于补位：本地 LRC、EchoLink 歌词或已有封面优先；缺失或加载失败时再使用外源结果。

## EchoLink 接口

移动端当前使用：

```text
GET  /echo-link/v1/status
GET  /echo-link/v1/library/tracks?page=1&pageSize=40&q=...
GET  /echo-link/v1/library/albums?page=1&pageSize=40&q=...
GET  /echo-link/v1/library/albums/:albumId/tracks
POST /echo-link/v1/playback/command
POST /echo-link/v1/library/tracks/:trackId/stream
GET  /echo-link/v1/library/tracks/:trackId/lyrics
```

请求头：

```text
Authorization: Bearer <token>
x-echo-link-version: 1
```

## 构建未签名 IPA

iOS 构建仍然依赖 macOS 和 Xcode。Windows 不能直接生成可用 IPA，但可以触发 GitHub Actions。

### GitHub Actions

1. 推送本仓库到 GitHub。
2. 打开 GitHub Actions。
3. 运行 `Build iOS unsigned IPA`。
4. 下载 `ECHO-iPhone-unsigned-ipa` artifact。
5. 使用 Sideloadly、AltStore 或其他方式签名安装。

### 本地 Mac 构建

```bash
bash scripts/build-unsigned-ipa-for-sideloadly.sh
```

输出：

```text
build/ios-unsigned/ECHO-iPhone-unsigned.ipa
```

### Xcode 免费 Apple ID

```bash
bash scripts/build-free-apple-id-with-xcode.sh
```

脚本会打开生成的 Xcode workspace。选择自己的 Apple ID Team，连接 iPhone，然后 Run。

## 资源说明

- `docs/app-icon.png` 是 README 和 Expo 当前共用的应用图标。
- `docs/app-icon.svg` 是同风格的轻量展示版图标。
- `docs/preview.svg` 是 README 顶部 ACG 风格功能预览图。
- `Assets.car` 可以放在仓库根目录，未签名 IPA 脚本会在打包时复制进最终 `.app`。
- 歌曲封面优先使用本地文件或 EchoLink artwork URL；如果没有返回封面或图片加载失败，App 会尝试网易云音乐封面，再保留稳定封面或显示 ECHO 占位。

## 项目结构

```text
App.tsx                         主界面、播放控制、歌词、本地播放、串流和设置
app.json                        Expo iOS 配置
modules/echo-audio-dsp/         iOS 原生 DSP 播放模块
src/components/                 App 内部图标组件
src/echoLink/client.ts          EchoLink HTTP 客户端
src/echoLink/types.ts           移动端 EchoLink 类型
src/echoLink/pairing.ts         配对 URI 解析
src/localMusic/                 本地音乐扫描、导入、元数据和歌词
src/storage/connectionStore.ts  本地连接信息保存
src/storage/localMusicStore.ts  本地音乐状态保存
src/storage/settingsStore.ts    设置持久化
scripts/                        iOS 构建辅助脚本
.github/workflows/              未签名 IPA 工作流
docs/                           图标、预览图和 README 资产
```

## 上传清单

建议上传：

- `.github/workflows/build-ios-unsigned.yml`
- `.gitattributes`
- `.gitignore`
- `app.json`
- `App.tsx`
- `Assets.car`
- `modules/`
- `package.json`
- `package-lock.json`
- `README.md`
- `README.en.md`
- `RELEASE_NOTES.md`
- `tsconfig.json`
- `docs/`
- `scripts/`
- `src/`

不要上传：

- `node_modules/`
- `build/`
- 生成的 `.ipa` 文件

## Release 更新日志

最新更新请看 [RELEASE_NOTES.md](RELEASE_NOTES.md)。
