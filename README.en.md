<p align="center">
  <img src="docs/app-icon.png" width="96" alt="ECHO iPhone app icon" />
</p>

<h1 align="center">ECHO iPhone</h1>

<p align="center">
  An independent iPhone music player that can connect to <a href="https://github.com/Moekotori/ECHO">ECHO NEXT</a> through EchoLink and also play local music on the phone.
</p>

<p align="center">
  <a href="README.md">中文</a> · <strong>English</strong> · <a href="RELEASE_NOTES.md">Release Notes</a>
</p>

> This is an unofficial community project and is not affiliated with the official ECHO NEXT repository.

> If you have any ownership claims, suggestions, or feedback, you can contact @白雪ユキ in the [official ECHO QQ group](https://qm.qq.com/q/OdpngxJU86).

> This project is positioned as an independent music player. EchoLink is one source for connection, control, and streaming, and upstream compatibility will continue to be synchronized here.

> If ECHO NEXT releases an official iOS client, I will mark it in this project and stop updating this repository.

> This is my first project, so it may be poorly made or even abandoned in the future. The main purpose of this project is to prove that Windows can complete the full workflow of making an iOS app, except signing and publishing, and to make it more convenient for myself to use ECHO on iOS. Thank you for your understanding <3

## What is this?

ECHO iPhone is an iPhone music player. It can scan and play music stored locally on the phone, and it can connect to ECHO NEXT through EchoLink to browse the desktop library, control desktop playback, or stream desktop music to the phone.

Starting from 0.5.0, local and streamed playback can use a native iOS DSP engine. EQ presets, loudness normalization, volume, and seeking are applied to the real audio path. Connection information, language, audio tags, EQ, and external-data settings are persisted locally.

## Features

- Independent playback modes: Local, Control, and Streaming can be switched from the playback page.
- Local library: import, scan, favorites, recently played, local queue, and imported LRC lyrics.
- Library source switch: the Library page can switch between the ECHO library and the phone library. The local library supports songs, albums, artists, formats, favorites, and recently played views.
- EchoLink pairing link connection: supports one-tap filling through `echo://pair?...`.
- Manual LAN connection: Host, Port, and Token are saved locally, so the pairing link does not need to be pasted every time.
- The Connection page now has an ECHO connection switch. It is off by default; when off, the app does not poll the desktop app or show connection-error alerts.
- The Connection page adds a "Connect ECHO / Streaming" switch. The Streaming entry is present but not open yet.
- Four main pages: Playback, Library, Connection, and Settings, with a glass bottom dock and swipe navigation.
- Redesigned playback page: cover art, track information, tags, progress, playback controls, volume, EQ, playlist, and output switching are gathered into one player view.
- Gaussian glass UI: playback panels, buttons, dock, alerts, and popovers use a unified `expo-blur` style.
- Real DSP: local / streamed playback supports native iOS DSP, EQ presets, and loudness normalization.
- EQ presets: Flat, Bass, Vocal, Clarity, Warm, and Late Night.
- Expandable volume control: the expanded slider is longer and shows the current percentage.
- Playlist popover: opens inside the playback page with an enter / exit animation.
- Lyrics mode: supports local LRC, EchoLink `/lyrics`, LRCLIB, and NetEase Cloud Music results, parses LRC, auto-scrolls, and highlights the current lyric line.
- Tap-to-seek lyrics: lyric lines with timestamps can be tapped to seek directly.
- External data: LRCLIB is preferred for lyrics. NetEase Cloud Music supplements cover art and Chinese-library lyrics. If EchoLink does not return cover art or the image fails to load, the app can try an external cover.
- Stable cover loading: keeps the previous cover before the new one is successfully loaded, reducing default-cover flickering and blank states.
- Slider touch interruption fix: page gestures are locked while dragging the progress bar or volume slider to prevent vertical swipes from stealing touch input.
- Playback controls: previous track, play / pause, next track, repeat one, and playlist preview.
- Library search: browse the PC local music library and select songs from the phone to play on the computer.
- Output switching: play locally, control playback on the computer, or stream to the iPhone when supported.
- Audio information tags: Local, streamable, WASAPI / ASIO, format, sample rate, bit depth, bitrate, and more.
- Settings page: grouped expandable sections for language, launch page, default library, audio tags, EQ, loudness normalization, external data, and storage management.
- Local persistence: connection information, settings, local favorites, recently played items, and the local queue are stored in app data.

## Current Limitations

- ECHO library access, desktop control, and desktop streaming require EchoLink to be enabled in ECHO NEXT.
- The iPhone and computer must be on the same LAN.
- Windows Firewall must allow ECHO NEXT communication.
- Mobile streaming depends on the desktop stream interface; DSP mode caches streamed audio before playback.
- External data is off by default. LRCLIB and NetEase Cloud Music can be enabled separately and require internet access on the phone.
- NetEase Cloud Music uses an unofficial public endpoint, so availability depends on the upstream service.
- Cover art, lyrics, and audio tags prefer local files or desktop EchoLink data first.
- This repository is an Expo / React Native project, not a native SwiftUI project.

## Requirements

- Node.js and npm
- Expo, through `npx expo`
- Local iOS builds require macOS + Xcode
- Windows users can trigger a macOS runner through GitHub Actions to generate an unsigned IPA
- Real-device installation requires Sideloadly, AltStore, Xcode, or another signing / installation method

## Local Development

```powershell
npm install
npm run start
```

Type checking:

```powershell
npm run typecheck
```

iOS Expo export check:

```powershell
npx expo export --platform ios --output-dir build\export-check
```

## Connecting to ECHO NEXT

The Connection page does not automatically connect to ECHO by default. Turn on "Enable ECHO connection" first, then use a pairing link or manually enter the LAN address.

```text
echo://pair?host=192.168.1.12&port=26789&token=...
```

Manual connection fields:

- Host: the computer's LAN IP, for example `192.168.2.27`
- Port: usually `26789`
- Token: copied from the EchoLink pairing page in the desktop app

Connection information is stored locally through AsyncStorage. After it is saved, the app does not need the pairing link again. Turning off the ECHO connection switch keeps the saved information but stops connection attempts and connection-error alerts.

If the connection fails, check the following first:

- Whether the iPhone and computer are connected to the same Wi-Fi / LAN.
- Whether ECHO NEXT is running and EchoLink is enabled.
- Whether Windows Firewall allows ECHO NEXT communication on private networks.
- Whether Host is set to the computer's LAN IP instead of `localhost`, a virtual network adapter IP, or a public IP.
- Whether iOS local network permission is allowed.

## Settings and External Data

- Connection information is stored in `src/storage/connectionStore.ts`.
- App settings are stored in local app data, including language, launch page, default library, audio tags, EQ, loudness normalization, the ECHO connection switch, the LRCLIB switch, and the NetEase Cloud Music switch.
- Local music state is stored in `src/storage/localMusicStore.ts`, including favorites, recently played items, and the local queue.
- LRCLIB is preferred for song lyrics and related lyric data.
- NetEase Cloud Music is used mainly for cover art and can also provide Chinese-library lyric fallback.
- External data is a fallback: local LRC, EchoLink lyrics, and existing cover art are used first; external results are used when those are missing or fail to load.

## EchoLink API

The mobile client currently uses:

```text
GET  /echo-link/v1/status
GET  /echo-link/v1/library/tracks?page=1&pageSize=40&q=...
GET  /echo-link/v1/library/albums?page=1&pageSize=40&q=...
GET  /echo-link/v1/library/albums/:albumId/tracks
POST /echo-link/v1/playback/command
POST /echo-link/v1/library/tracks/:trackId/stream
GET  /echo-link/v1/library/tracks/:trackId/lyrics
```

Request headers:

```text
Authorization: Bearer <token>
x-echo-link-version: 1
```

## Building an Unsigned IPA

iOS builds still depend on macOS and Xcode. Windows cannot directly generate a usable IPA, but it can trigger GitHub Actions.

### GitHub Actions

1. Push this repository to GitHub.
2. Open GitHub Actions.
3. Run `Build iOS unsigned IPA`.
4. Download the `ECHO-iPhone-unsigned-ipa` artifact.
5. Sign and install it using Sideloadly, AltStore, or another method.

### Local Mac Build

```bash
bash scripts/build-unsigned-ipa-for-sideloadly.sh
```

Output:

```text
build/ios-unsigned/ECHO-iPhone-unsigned.ipa
```

### Xcode Free Apple ID

```bash
bash scripts/build-free-apple-id-with-xcode.sh
```

The script will open the generated Xcode workspace. Select your own Apple ID Team, connect your iPhone, and then click Run.

## Assets

- `docs/app-icon.png` is the current app icon shared by the README and Expo.
- `docs/app-icon.svg` is a lightweight display version of the same style.
- `docs/preview.svg` is the ACG-style feature preview image at the top of the README.
- `Assets.car` can be placed in the repository root. The unsigned IPA script will copy it into the final `.app` during packaging.
- Song cover art prefers local files or EchoLink artwork URLs. If no cover is returned or the image fails to load, the app can try a NetEase Cloud Music cover before keeping the stable cover or showing the ECHO placeholder.

## Project Structure

```text
App.tsx                         Main UI, playback controls, lyrics, local playback, streaming, and settings
app.json                        Expo iOS configuration
modules/echo-audio-dsp/         Native iOS DSP playback module
src/components/                 Internal app icon components
src/echoLink/client.ts          EchoLink HTTP client
src/echoLink/types.ts           Mobile EchoLink types
src/echoLink/pairing.ts         Pairing URI parser
src/localMusic/                 Local music scanning, import, metadata, and lyrics
src/storage/connectionStore.ts  Local connection information storage
src/storage/localMusicStore.ts  Local music state storage
src/storage/settingsStore.ts    Settings persistence
scripts/                        iOS build helper scripts
.github/workflows/              Unsigned IPA workflow
docs/                           Icons, preview images, and README assets
```

## Upload Checklist

Recommended files to upload:

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

Do not upload:

- `node_modules/`
- `build/`
- Generated `.ipa` files

## Release Notes

For the latest updates, see [RELEASE_NOTES.md](RELEASE_NOTES.md).
