import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactElement, type ReactNode } from 'react';
import {
  Alert,
  Animated,
  Easing,
  GestureResponderEvent,
  Image as RNImage,
  KeyboardAvoidingView,
  LayoutChangeEvent,
  PanResponder,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  type StyleProp,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { BlurView } from 'expo-blur';
import * as FileSystem from 'expo-file-system/legacy';
import { echoAudioDsp, type EchoAudioDspStatus } from 'echo-audio-dsp';
import {
  createEchoLinkClient,
  EchoLinkHttpError,
  EchoLinkNetworkError,
  normalizeEchoLinkHost,
  normalizeEchoLinkToken,
  type EchoLinkConnection,
} from './src/echoLink/client';
import type { EchoLinkStatusResponse, EchoLinkTrackPreview } from './src/echoLink/types';
import { parsePairingUri } from './src/echoLink/pairing';
import {
  deleteLocalMusicTrack,
  getLocalMusicStorageUsage,
  importLocalLyricFile,
  importLocalMusicFiles,
  readLocalLyrics,
  scanLocalMusic,
  type LocalMusicTrack,
} from './src/localMusic/library';
import { loadSavedConnection, saveConnection } from './src/storage/connectionStore';
import { loadSavedLocalMusicState, saveLocalMusicState } from './src/storage/localMusicStore';
import { loadSavedSettings, saveSettings, type SavedSettings } from './src/storage/settingsStore';
import { SuperconIcon } from './src/components/SuperconIcon';

type AppPage = 'control' | 'library' | 'connect' | 'settings';
type ConnectPanelMode = 'echo' | 'streaming';
type PlaybackOutputMode = 'local' | 'pc' | 'phone';
type LibraryFilter = 'all' | 'streamable' | 'local';
type LibrarySource = 'echo' | 'local';
type LocalLibraryView = 'albums' | 'artists' | 'favorites' | 'formats' | 'recent' | 'songs';
type SettingsSectionKey = 'audioTags' | 'externalData' | 'interface' | 'library' | 'playback' | 'storage';
type EqPreset = 'bass' | 'clarity' | 'flat' | 'lateNight' | 'vocal' | 'warm';
type AppLanguage = 'zh' | 'en';
type AudioTagKey = 'output' | 'source' | 'streamability' | 'quality' | 'bitrate' | 'duration';
type AudioTagVisibility = Record<AudioTagKey, boolean>;
type PendingPcSeek = {
  positionMs: number;
  requestedAtMs: number;
  trackId: string | null;
};
type ExternalTrackMetadata = {
  albumArt: string | null;
  error: string | null;
  lyrics: string | null;
  sourceTitle: string | null;
  status: 'error' | 'loading' | 'ready';
};
type ExternalMetadataSource = 'lrclib' | 'netease';
type MotionKey = boolean | number | string | null | undefined;
type AnimatedButtonContentProps = {
  children: ReactNode;
  motionKey: MotionKey;
  style?: StyleProp<ViewStyle>;
};

const AnimatedButtonContent = ({ children, motionKey, style }: AnimatedButtonContentProps): ReactElement => {
  const transition = useRef(new Animated.Value(1)).current;
  const latestChildrenRef = useRef<ReactNode>(children);
  const lastMotionKeyRef = useRef<MotionKey>(motionKey);
  const [previousChildren, setPreviousChildren] = useState<ReactNode | null>(null);

  useEffect(() => {
    if (!Object.is(lastMotionKeyRef.current, motionKey)) {
      setPreviousChildren(latestChildrenRef.current);
      lastMotionKeyRef.current = motionKey;
      transition.setValue(0);
      Animated.timing(transition, {
        duration: 180,
        easing: Easing.out(Easing.cubic),
        toValue: 1,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) {
          setPreviousChildren(null);
        }
      });
    }
    latestChildrenRef.current = children;
  }, [children, motionKey, transition]);

  return (
    <View style={styles.buttonMotionShell}>
      {previousChildren ? (
        <Animated.View
          pointerEvents="none"
          style={[
            style,
            styles.buttonMotionExitLayer,
            {
              opacity: transition.interpolate({
                inputRange: [0, 1],
                outputRange: [1, 0],
              }),
              transform: [
                {
                  scale: transition.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, 0.96],
                  }),
                },
              ],
            },
          ]}
        >
          {previousChildren}
        </Animated.View>
      ) : null}
      <Animated.View
        style={[
          style,
          {
            opacity: transition,
            transform: [
              {
                scale: transition.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.88, 1],
                }),
              },
            ],
          },
        ]}
      >
        {children}
      </Animated.View>
    </View>
  );
};

const SettingsReveal = ({ children, motionKey }: { children: ReactNode; motionKey: MotionKey }): ReactElement => {
  const transition = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    transition.setValue(0);
    Animated.timing(transition, {
      duration: 220,
      easing: Easing.out(Easing.cubic),
      toValue: 1,
      useNativeDriver: true,
    }).start();
  }, [motionKey, transition]);

  return (
    <Animated.View
      style={[
        styles.settingsReveal,
        {
          opacity: transition,
          transform: [
            {
              translateY: transition.interpolate({
                inputRange: [0, 1],
                outputRange: [8, 0],
              }),
            },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
};

const appPages: AppPage[] = ['control', 'library', 'connect', 'settings'];
const defaultAudioTagVisibility: AudioTagVisibility = {
  bitrate: true,
  duration: true,
  output: true,
  quality: true,
  source: true,
  streamability: true,
};
const audioTagOptions: Array<{
  descriptionEn: string;
  descriptionZh: string;
  key: AudioTagKey;
  labelEn: string;
  labelZh: string;
}> = [
  { key: 'output', labelZh: '输出模式', labelEn: 'Output', descriptionZh: 'WASAPI / ASIO / 串流', descriptionEn: 'WASAPI / ASIO / Stream' },
  { key: 'source', labelZh: '来源', labelEn: 'Source', descriptionZh: 'Local / Remote', descriptionEn: 'Local / Remote' },
  { key: 'streamability', labelZh: '串流能力', labelEn: 'Streamable', descriptionZh: '可串流 / 仅控制', descriptionEn: 'Streamable / Control only' },
  { key: 'quality', labelZh: '格式音质', labelEn: 'Quality', descriptionZh: 'FLAC 48kHz/24bit', descriptionEn: 'FLAC 48kHz/24bit' },
  { key: 'bitrate', labelZh: '码率', labelEn: 'Bitrate', descriptionZh: '921kbps', descriptionEn: '921kbps' },
  { key: 'duration', labelZh: '时长', labelEn: 'Duration', descriptionZh: '曲库列表显示', descriptionEn: 'Shown in library rows' },
];
const localLibraryViewOptions: LocalLibraryView[] = [
  'songs',
  'albums',
  'artists',
  'formats',
  'favorites',
  'recent',
];
const eqPresetOptions: Array<{
  descriptionEn: string;
  descriptionZh: string;
  gains: [number, number, number, number, number];
  key: EqPreset;
  labelEn: string;
  labelZh: string;
}> = [
  { key: 'flat', labelZh: '均衡', labelEn: 'Flat', descriptionZh: '不强调任何频段', descriptionEn: 'Neutral response', gains: [0, 0, 0, 0, 0] },
  { key: 'bass', labelZh: '低频', labelEn: 'Bass', descriptionZh: '增强低频和律动感', descriptionEn: 'More low-end weight', gains: [5, 3, 0, -1, 0] },
  { key: 'vocal', labelZh: '人声', labelEn: 'Vocal', descriptionZh: '突出人声和中频', descriptionEn: 'Forward vocal range', gains: [-1, 0, 4, 2, 0] },
  { key: 'clarity', labelZh: '清晰', labelEn: 'Clarity', descriptionZh: '增强细节和空气感', descriptionEn: 'More detail and air', gains: [-2, -1, 1, 3, 4] },
  { key: 'warm', labelZh: '暖声', labelEn: 'Warm', descriptionZh: '柔和高频，增加厚度', descriptionEn: 'Softer treble, fuller body', gains: [2, 3, 1, -1, -2] },
  { key: 'lateNight', labelZh: '夜间', labelEn: 'Late Night', descriptionZh: '轻压动态，适合小音量', descriptionEn: 'Gentler late-night balance', gains: [-3, -1, 2, 1, -2] },
];
const defaultEqOption = eqPresetOptions[0]!;

const defaultSettings: SavedSettings = {
  appLanguage: 'zh',
  audioTagVisibility: defaultAudioTagVisibility,
  autoOpenLyricsForLocalTracks: true,
  autoQueueImportedLocalTracks: false,
  confirmBeforeDeletingLocalTracks: true,
  defaultLibrarySource: 'echo',
  defaultLocalLibraryView: 'songs',
  defaultPage: 'control',
  echoConnectionEnabled: false,
  eqPreset: 'flat',
  lrclibExternalDataEnabled: false,
  neteaseExternalDataEnabled: false,
  loudnessNormalizationEnabled: false,
  showArtworkGlow: true,
};

type LyricLine = {
  id: string;
  text: string;
  timeMs: number | null;
};

const formatTime = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const formatStorageSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)}KB`;
  }
  return `${bytes}B`;
};

const parseLyrics = (lyrics: string): LyricLine[] => {
  const lines = lyrics
    .split(/\r?\n/u)
    .map((line, index) => {
      const matches = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/gu)];
      const text = line.replace(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/gu, '').trim();
      if (!text) {
        return [];
      }
      if (matches.length === 0) {
        return [{ id: `plain-${index}`, text, timeMs: null }];
      }
      return matches.map((match, matchIndex) => {
        const minutes = Number(match[1]);
        const seconds = Number(match[2]);
        const fraction = match[3] ?? '0';
        const fractionMs = Number(fraction.padEnd(3, '0').slice(0, 3));
        return {
          id: `${minutes}-${seconds}-${fraction}-${index}-${matchIndex}`,
          text,
          timeMs: (minutes * 60 + seconds) * 1000 + fractionMs,
        };
      });
    })
    .flat()
    .sort((a, b) => (a.timeMs ?? Number.MAX_SAFE_INTEGER) - (b.timeMs ?? Number.MAX_SAFE_INTEGER));

  return lines.length > 0
    ? lines
    : [];
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const ratioFromGesture = (event: GestureResponderEvent, width: number): number => (
  width > 0 ? clamp01(event.nativeEvent.locationX / width) : 0
);

const formatSourceTag = (sourceLabel: string | null | undefined): string | null => {
  const value = sourceLabel?.trim();
  if (!value) {
    return null;
  }
  if (/local/iu.test(value)) {
    return 'Local';
  }
  if (/remote/iu.test(value)) {
    return 'Remote';
  }
  if (/stream/iu.test(value)) {
    return 'Streaming';
  }
  return value;
};

const formatOutputTag = (outputMode: string | null | undefined): string | null => {
  const value = outputMode?.trim();
  if (!value) {
    return null;
  }
  if (/asio/iu.test(value)) {
    return 'ASIO';
  }
  if (/wasapi|shared|exclusive/iu.test(value)) {
    return 'WASAPI';
  }
  if (/system/iu.test(value)) {
    return 'System';
  }
  return value;
};

const formatCodecTag = (codec: string | null | undefined): string | null => {
  const value = codec?.trim();
  return value ? value.toUpperCase() : null;
};

const formatSampleRateTag = (sampleRate: number | null | undefined): string | null => {
  if (!Number.isFinite(sampleRate) || !sampleRate || sampleRate <= 0) {
    return null;
  }
  const khz = sampleRate >= 1000 ? sampleRate / 1000 : sampleRate;
  return `${Number.isInteger(khz) ? khz.toFixed(0) : khz.toFixed(1)}kHz`;
};

const formatBitDepthTag = (bitDepth: number | null | undefined): string | null => {
  if (!Number.isFinite(bitDepth) || !bitDepth || bitDepth <= 0) {
    return null;
  }
  return `${Math.round(bitDepth)}bit`;
};

const formatBitrateTag = (bitrate: number | null | undefined): string | null => {
  if (!Number.isFinite(bitrate) || !bitrate || bitrate <= 0) {
    return null;
  }
  const kbps = bitrate >= 1000 ? bitrate / 1000 : bitrate;
  return `${Math.round(kbps)}kbps`;
};

const formatQualityTag = (track: EchoLinkTrackPreview | null | undefined): string | null => {
  const sampleRate = formatSampleRateTag(track?.sampleRate);
  const bitDepth = formatBitDepthTag(track?.bitDepth);
  if (sampleRate && bitDepth) {
    return `${sampleRate}/${bitDepth}`;
  }
  return sampleRate ?? bitDepth;
};

const formatAudioQualityTag = (track: EchoLinkTrackPreview | null | undefined): string | null => {
  const codec = formatCodecTag(track?.codec);
  const quality = formatQualityTag(track);
  if (codec && quality) {
    return `${codec} ${quality}`;
  }
  return codec ?? quality;
};

const tagsForTrack = (
  track: EchoLinkTrackPreview | null | undefined,
  options: {
    includeDuration?: boolean;
    outputMode?: string | null;
    visibleAudioTags?: AudioTagVisibility;
  } = {},
): string[] => {
  const visibleTags = options.visibleAudioTags ?? defaultAudioTagVisibility;
  const tags = [
    visibleTags.output ? formatOutputTag(options.outputMode) : null,
    visibleTags.source ? formatSourceTag(track?.sourceLabel) : null,
    visibleTags.streamability && track ? (track.canPlayOnPhone ? '可串流' : '仅控制') : null,
    visibleTags.quality ? formatAudioQualityTag(track) : null,
    visibleTags.bitrate ? formatBitrateTag(track?.bitrate) : null,
    visibleTags.duration && options.includeDuration && track ? formatTime(track.durationMs) : null,
  ];
  return tags.filter((tag): tag is string => Boolean(tag && tag.trim()));
};

const normalizeExternalLookupValue = (value: string | null | undefined): string => (
  (value ?? '')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
);

const externalMetadataKeyForTrack = (track: EchoLinkTrackPreview | null | undefined): string | null => {
  const title = normalizeExternalLookupValue(track?.title);
  if (!title) {
    return null;
  }
  return `${title}::${normalizeExternalLookupValue(track?.artist)}`;
};

const fetchJson = async <T,>(url: string, headers: Record<string, string> = {}): Promise<T> => {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json,text/plain,*/*',
      'User-Agent': 'ECHO-iPhone/0.5.0',
      ...headers,
    },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
};

type LrclibSearchItem = {
  artistName?: string;
  name?: string;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
  trackName?: string;
};

const lookupLrclibMetadata = async (track: EchoLinkTrackPreview): Promise<Partial<ExternalTrackMetadata> | null> => {
  const params = new URLSearchParams({
    artist_name: track.artist ?? '',
    track_name: track.title ?? '',
  });
  const results = await fetchJson<LrclibSearchItem[]>(`https://lrclib.net/api/search?${params.toString()}`);
  const match = results.find((item) => item.syncedLyrics || item.plainLyrics);
  if (!match) {
    return null;
  }
  return {
    lyrics: match.syncedLyrics ?? match.plainLyrics ?? null,
    sourceTitle: match.trackName ?? match.name ?? null,
  };
};

type NeteaseSearchResponse = {
  result?: {
    songs?: NeteaseSearchSong[];
  };
};
type NeteaseSearchSong = {
  artists?: Array<{ name?: string }>;
  id?: number;
  name?: string;
};

type NeteaseDetailResponse = {
  songs?: Array<{
    album?: {
      picUrl?: string;
    };
    name?: string;
  }>;
};

type NeteaseLyricResponse = {
  lrc?: {
    lyric?: string;
  };
};
type NeteaseMediaResponse = {
  lyric?: string;
};

const scoreNeteaseSong = (track: EchoLinkTrackPreview, song: NeteaseSearchSong): number => {
  const trackTitle = normalizeExternalLookupValue(track.title);
  const trackArtist = normalizeExternalLookupValue(track.artist);
  const songTitle = normalizeExternalLookupValue(song.name);
  const songArtists = normalizeExternalLookupValue(song.artists?.map((artist) => artist.name).filter(Boolean).join(' '));
  let score = 0;

  if (songTitle === trackTitle) {
    score += 20;
  } else if (songTitle.includes(trackTitle)) {
    score += 12;
  } else if (trackTitle.includes(songTitle)) {
    score += 8;
  }

  if (trackArtist) {
    if (songArtists === trackArtist) {
      score += 12;
    } else if (songArtists.includes(trackArtist) || trackArtist.includes(songArtists)) {
      score += 8;
    }
  }

  return score;
};

const lookupNeteaseMetadata = async (
  track: EchoLinkTrackPreview,
  options: { includeLyrics?: boolean } = {},
): Promise<Partial<ExternalTrackMetadata> | null> => {
  const query = [track.title, track.artist].filter(Boolean).join(' ');
  if (!query.trim()) {
    return null;
  }

  const searchParams = new URLSearchParams({
    limit: '8',
    offset: '0',
    s: query,
    total: 'false',
    type: '1',
  });
  const neteaseHeaders = { Referer: 'https://music.163.com/' };
  const search = await fetchJson<NeteaseSearchResponse>(`https://music.163.com/api/search/get/web?${searchParams.toString()}`, neteaseHeaders);
  const song = (search.result?.songs ?? [])
    .filter((item) => item.id)
    .sort((a, b) => scoreNeteaseSong(track, b) - scoreNeteaseSong(track, a))[0];
  if (!song?.id) {
    return null;
  }

  const includeLyrics = options.includeLyrics ?? true;
  const [detailResult, lyricResult, mediaResult] = await Promise.allSettled([
    fetchJson<NeteaseDetailResponse>(`https://music.163.com/api/song/detail/?id=${song.id}&ids=${encodeURIComponent(`[${song.id}]`)}`, neteaseHeaders),
    includeLyrics
      ? fetchJson<NeteaseLyricResponse>(`https://music.163.com/api/song/lyric?id=${song.id}&lv=1&kv=1&tv=-1`, neteaseHeaders)
      : Promise.resolve<NeteaseLyricResponse>({}),
    includeLyrics
      ? fetchJson<NeteaseMediaResponse>(`https://music.163.com/api/song/media?id=${song.id}`, neteaseHeaders)
      : Promise.resolve<NeteaseMediaResponse>({}),
  ]);
  const detail = detailResult.status === 'fulfilled' ? detailResult.value : null;
  const lyric = lyricResult.status === 'fulfilled' ? lyricResult.value : null;
  const media = mediaResult.status === 'fulfilled' ? mediaResult.value : null;
  const lyrics = lyric?.lrc?.lyric?.trim() || media?.lyric?.trim() || null;

  return {
    albumArt: detail?.songs?.[0]?.album?.picUrl ?? null,
    lyrics,
    sourceTitle: song.name ?? detail?.songs?.[0]?.name ?? null,
  };
};

const lookupExternalTrackMetadata = async (
  track: EchoLinkTrackPreview,
  sources: Record<ExternalMetadataSource, boolean>,
  options: { includeNeteaseLyrics?: boolean } = {},
): Promise<ExternalTrackMetadata> => {
  const lookups: Array<Promise<{ source: ExternalMetadataSource; value: Partial<ExternalTrackMetadata> | null }>> = [];
  if (sources.lrclib) {
    lookups.push(lookupLrclibMetadata(track).then((value) => ({ source: 'lrclib', value })));
  }
  if (sources.netease) {
    lookups.push(lookupNeteaseMetadata(track, {
      includeLyrics: options.includeNeteaseLyrics ?? true,
    }).then((value) => ({ source: 'netease', value })));
  }

  const results = await Promise.allSettled(lookups);
  const values = results
    .filter((result): result is PromiseFulfilledResult<{ source: ExternalMetadataSource; value: Partial<ExternalTrackMetadata> | null }> => result.status === 'fulfilled')
    .map((result) => result.value)
    .filter((result) => result.value);
  const lrclib = values.find((result) => result.source === 'lrclib')?.value;
  const netease = values.find((result) => result.source === 'netease')?.value;
  // Lyrics prefer LRCLIB; NetEase supplements cover art and lyric fallback.
  const lyrics = lrclib?.lyrics ?? netease?.lyrics ?? null;
  const albumArt = netease?.albumArt ?? null;

  if (!lyrics && !albumArt) {
    return {
      albumArt: null,
      error: 'No external metadata found.',
      lyrics: null,
      sourceTitle: null,
      status: 'error',
    };
  }

  return {
    albumArt,
    error: null,
    lyrics,
    sourceTitle: lrclib?.sourceTitle ?? netease?.sourceTitle ?? null,
    status: 'ready',
  };
};

const initialConnection: EchoLinkConnection = {
  host: '',
  port: 26789,
  token: '',
  name: 'PC ECHO',
  scheme: 'http',
};

const formatRequestError = (error: unknown): string => {
  if (error instanceof EchoLinkNetworkError) {
    return error.message;
  }
  if (error instanceof EchoLinkHttpError) {
    if (error.statusCode === 401) {
      return '认证失败：Token 不匹配。请在电脑端重新生成配对链接，或重新输入最新 token。';
    }
    if (error.statusCode === 403) {
      return '电脑端拒绝了请求：请确认手机和电脑在同一个局域网，且没有走蜂窝网络、访客 Wi-Fi、VPN 或热点隔离。';
    }
    return `${error.statusCode} ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
};

const formatPhoneAudioError = (error: unknown): string => {
  if (error instanceof EchoLinkHttpError && (error.statusCode === 409 || error.statusCode === 415)) {
    return '这首歌暂时不能在手机播放。请先用本地 MP3/AAC/M4A 等 iOS 友好的音频文件测试。';
  }
  return formatRequestError(error);
};

const dspStreamCacheDirectory = `${FileSystem.cacheDirectory ?? ''}echo-dsp-streams/`;

const extensionForDspCache = (track: EchoLinkTrackPreview): string => {
  const codec = track.codec?.trim().toLowerCase();
  if (codec === 'mp3' || codec === 'flac' || codec === 'wav' || codec === 'aac') {
    return codec;
  }
  if (codec === 'alac' || codec === 'm4a' || codec === 'mp4') {
    return 'm4a';
  }
  return 'm4a';
};

const safeCacheToken = (value: string): string => (
  value.replace(/[^a-z0-9._-]/giu, '_').slice(0, 72) || `track-${Date.now()}`
);

const downloadStreamForDsp = async (streamUrl: string, track: EchoLinkTrackPreview): Promise<string> => {
  if (!FileSystem.cacheDirectory) {
    throw new Error('无法访问临时音频缓存目录。');
  }
  await FileSystem.makeDirectoryAsync(dspStreamCacheDirectory, { intermediates: true }).catch(() => undefined);
  const extension = extensionForDspCache(track);
  const uri = `${dspStreamCacheDirectory}${safeCacheToken(track.id)}-${Date.now()}.${extension}`;
  const result = await FileSystem.downloadAsync(streamUrl, uri);
  return result.uri;
};

type ErrorBoundaryState = {
  error: Error | null;
};

class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('ECHO iPhone startup error', error, errorInfo.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.errorBox}>
            <Text style={styles.errorTitle}>应用启动失败</Text>
            <Text style={styles.errorText}>{this.state.error.message}</Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }
}

function EchoLinkApp(): ReactElement {
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const phonePlayer = useAudioPlayer(null, {
    keepAudioSessionActive: true,
    preferredForwardBufferDuration: 12,
    updateInterval: 250,
  });
  const phonePlayerStatus = useAudioPlayerStatus(phonePlayer);
  const [page, setPage] = useState<AppPage>('control');
  const [pageSlideDirection, setPageSlideDirection] = useState(1);
  const [connection, setConnection] = useState<EchoLinkConnection>(initialConnection);
  const [connectPanelMode, setConnectPanelMode] = useState<ConnectPanelMode>('echo');
  const [pairingText, setPairingText] = useState('');
  const [status, setStatus] = useState<EchoLinkStatusResponse | null>(null);
  const [statusReceivedAtMs, setStatusReceivedAtMs] = useState(() => Date.now());
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [tracks, setTracks] = useState<EchoLinkTrackPreview[]>([]);
  const [localTracks, setLocalTracks] = useState<LocalMusicTrack[]>([]);
  const [localStorageBytes, setLocalStorageBytes] = useState(0);
  const [query, setQuery] = useState('');
  const queryRef = useRef(query);
  queryRef.current = query;
  const prevQueryRef = useRef(query);
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>('all');
  const [librarySource, setLibrarySource] = useState<LibrarySource>('echo');
  const [localLibraryView, setLocalLibraryView] = useState<LocalLibraryView>('songs');
  const [favoriteLocalTrackIds, setFavoriteLocalTrackIds] = useState<string[]>([]);
  const [recentLocalTrackIds, setRecentLocalTrackIds] = useState<string[]>([]);
  const [localQueueTrackIds, setLocalQueueTrackIds] = useState<string[]>([]);
  const [localMusicStateLoaded, setLocalMusicStateLoaded] = useState(false);
  const [appLanguage, setAppLanguage] = useState<AppLanguage>('zh');
  const [audioTagVisibility, setAudioTagVisibility] = useState<AudioTagVisibility>(defaultAudioTagVisibility);
  const [defaultPage, setDefaultPage] = useState<AppPage>(defaultSettings.defaultPage);
  const [defaultLibrarySource, setDefaultLibrarySource] = useState<LibrarySource>(defaultSettings.defaultLibrarySource);
  const [defaultLocalLibraryView, setDefaultLocalLibraryView] = useState<LocalLibraryView>(defaultSettings.defaultLocalLibraryView);
  const [echoConnectionEnabled, setEchoConnectionEnabled] = useState(defaultSettings.echoConnectionEnabled);
  const [autoOpenLyricsForLocalTracks, setAutoOpenLyricsForLocalTracks] = useState(defaultSettings.autoOpenLyricsForLocalTracks);
  const [autoQueueImportedLocalTracks, setAutoQueueImportedLocalTracks] = useState(defaultSettings.autoQueueImportedLocalTracks);
  const [confirmBeforeDeletingLocalTracks, setConfirmBeforeDeletingLocalTracks] = useState(defaultSettings.confirmBeforeDeletingLocalTracks);
  const [eqPreset, setEqPreset] = useState<EqPreset>(defaultSettings.eqPreset);
  const [eqPanelOpen, setEqPanelOpen] = useState(false);
  const [lrclibExternalDataEnabled, setLrclibExternalDataEnabled] = useState(defaultSettings.lrclibExternalDataEnabled);
  const [neteaseExternalDataEnabled, setNeteaseExternalDataEnabled] = useState(defaultSettings.neteaseExternalDataEnabled);
  const [loudnessNormalizationEnabled, setLoudnessNormalizationEnabled] = useState(defaultSettings.loudnessNormalizationEnabled);
  const [showArtworkGlow, setShowArtworkGlow] = useState(defaultSettings.showArtworkGlow);
  const [openSettingsSection, setOpenSettingsSection] = useState<SettingsSectionKey>('interface');
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [localLibraryBusy, setLocalLibraryBusy] = useState(false);
  const [localLibraryError, setLocalLibraryError] = useState<string | null>(null);
  const [playlistOpen, setPlaylistOpen] = useState(false);
  const [playlistVisible, setPlaylistVisible] = useState(false);
  const [repeatOneEnabled, setRepeatOneEnabled] = useState(false);
  const [lyricsVisible, setLyricsVisible] = useState(false);
  const [lyricsText, setLyricsText] = useState('');
  const [lyricsTrackId, setLyricsTrackId] = useState<string | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricsError, setLyricsError] = useState<string | null>(null);
  const [volumeExpanded, setVolumeExpanded] = useState(false);
  const [playbackOutputMode, setPlaybackOutputMode] = useState<PlaybackOutputMode>('pc');
  const [localTrack, setLocalTrack] = useState<LocalMusicTrack | null>(null);
  const [phoneTrack, setPhoneTrack] = useState<EchoLinkTrackPreview | null>(null);
  const [phoneAudioBusy, setPhoneAudioBusy] = useState(false);
  const [phoneAudioError, setPhoneAudioError] = useState<string | null>(null);
  const [dspStatus, setDspStatus] = useState<EchoAudioDspStatus>({
    currentTime: 0,
    didJustFinish: false,
    duration: 0,
    playing: false,
    volume: 1,
  });
  const [externalMetadataByKey, setExternalMetadataByKey] = useState<Record<string, ExternalTrackMetadata>>({});
  const [phoneVolume, setPhoneVolume] = useState(1);
  const [phoneSeekPreviewMs, setPhoneSeekPreviewMs] = useState<number | null>(null);
  const [progressTrackWidth, setProgressTrackWidth] = useState(0);
  const [volumeTrackWidth, setVolumeTrackWidth] = useState(0);
  const [dockWidth, setDockWidth] = useState(0);
  const [failedArtworkUrls, setFailedArtworkUrls] = useState<Set<string>>(() => new Set());
  const [loadedArtworkUrls, setLoadedArtworkUrls] = useState<Set<string>>(() => new Set());
  const [stableArtworkUrl, setStableArtworkUrl] = useState<string | null>(null);
  const pageTransition = useRef(new Animated.Value(1)).current;
  const dockIndexTransition = useRef(new Animated.Value(appPages.indexOf('control'))).current;
  const lyricsTransition = useRef(new Animated.Value(0)).current;
  const playlistTransition = useRef(new Animated.Value(0)).current;
  const volumeTransition = useRef(new Animated.Value(0)).current;
  const lyricsScrollRef = useRef<ScrollView | null>(null);
  const lyricLineLayoutsRef = useRef<Record<string, { height: number; y: number }>>({});
  const shownAlertKeysRef = useRef<Set<string>>(new Set()).current;
  const statusPollInFlight = useRef(false);
  const sliderInteractionInFlight = useRef(false);
  const latestStatusRef = useRef<EchoLinkStatusResponse | null>(null);
  const pendingPcSeekRef = useRef<PendingPcSeek | null>(null);
  const pcRepeatArmedRef = useRef(true);
  const phoneRepeatArmedRef = useRef(true);
  const externalMetadataLookupKeysRef = useRef<Set<string>>(new Set());

  const client = useMemo(() => (
    echoConnectionEnabled && connection.host.trim() && connection.token.trim()
      ? createEchoLinkClient(connection)
      : null
  ), [connection, echoConnectionEnabled]);

  const markArtworkUrlFailed = useCallback((url: string | null | undefined) => {
    if (!url) {
      return;
    }
    setFailedArtworkUrls((current) => {
      if (current.has(url)) {
        return current;
      }
      const next = new Set(current);
      next.add(url);
      return next;
    });
  }, []);

  const markArtworkUrlLoaded = useCallback((url: string | null | undefined) => {
    if (!url) {
      return;
    }
    setStableArtworkUrl(url);
    setLoadedArtworkUrls((current) => {
      if (current.has(url)) {
        return current;
      }
      const next = new Set(current);
      next.add(url);
      return next;
    });
  }, []);

  const artworkUrlIsVisible = useCallback((url: string | null | undefined): url is string => (
    Boolean(url && !failedArtworkUrls.has(url))
  ), [failedArtworkUrls]);

  const artworkUrlHasLoaded = useCallback((url: string | null | undefined): boolean => (
    Boolean(url && loadedArtworkUrls.has(url))
  ), [loadedArtworkUrls]);

  const resolveArtworkUrl = useCallback((url: string | null | undefined): string | null => {
    const value = url?.trim();
    if (!value) {
      return null;
    }
    try {
      return new URL(value, client?.baseUrl).toString();
    } catch {
      return value;
    }
  }, [client?.baseUrl]);

  const showErrorAlert = useCallback((title: string, message: string, alertKey = `${title}:${message}`) => {
    if (shownAlertKeysRef.has(alertKey)) {
      return;
    }
    shownAlertKeysRef.add(alertKey);
    Alert.alert(title, message);
  }, [shownAlertKeysRef]);

  const languageIsEnglish = appLanguage === 'en';
  const text = useMemo(() => (languageIsEnglish ? {
    addToQueue: 'Queue',
    all: 'All',
    albums: 'Albums',
    artists: 'Artists',
    audioTags: 'Audio Tags',
    audioTagsDescription: 'Choose which audio tags stay visible.',
    autoLyrics: 'Auto-open local lyrics',
    autoLyricsDescription: 'Open the lyrics view when a local track has an imported LRC file.',
    autoQueueImports: 'Queue imported music',
    autoQueueImportsDescription: 'Newly imported tracks are appended to the local playback queue.',
    chooseCategory: 'Choose A Category',
    clear: 'Clear',
    clearLocalQueue: 'Clear Local Queue',
    clearLocalQueueDescription: 'Remove all tracks from the local playback queue.',
    clearRecent: 'Clear Recent',
    clearRecentDescription: 'Clear local recently played history.',
    closeEqPanel: 'Close EQ panel',
    closeLyrics: 'Close lyrics',
    closePlaylist: 'Close playlist',
    closePlaylistPreview: 'Close queue preview',
    closeRepeatOne: 'Disable repeat one',
    collapseVolume: 'Collapse volume control',
    confirmDeleteLocalTrackMessagePrefix: 'Delete',
    confirmDeleteLocalTrackMessageSuffix: 'from the local library on this phone?',
    confirmDelete: 'Confirm before deleting',
    confirmDeleteDescription: 'Ask before removing local audio files from the phone.',
    connect: 'Connect',
    connectEcho: 'Connect ECHO',
    connectPage: 'Connection page',
    connectWithPairingA11y: 'Connect with pairing link',
    connectedPrefix: 'Connected',
    connectingLabel: 'Connecting',
    control: 'Control',
    controlComputerPlayback: 'Control computer playback',
    controllingMode: 'Controlling Mode',
    defaultLibrarySource: 'Default library source',
    defaultLibrarySourceHint: 'Choose whether the library page starts with ECHO or local songs.',
    defaultLocalView: 'Default local view',
    defaultLocalViewHint: 'Choose the default grouping for local music.',
    defaultPage: 'Launch page',
    defaultPageHint: 'Choose which page opens first next time.',
    deleteAction: 'Del',
    deleteLocalTrackA11y: 'Delete local track',
    deleteLocalTrackTitle: 'Delete local track',
    echoConnection: 'ECHO Connection',
    echoConnectionDescription: 'When off, ECHO iPhone will not connect, poll, or show connection alerts.',
    echoConnectionEnabled: 'Enable ECHO connection',
    echoNotConnected: 'ECHO Not Connected',
    echoOff: 'ECHO Off',
    echoLibrary: 'ECHO',
    emptyEchoLibrary: client ? 'No matching tracks' : 'Connect to show the desktop library',
    emptyLocalLibrary: localTracks.length > 0 ? 'No matching local tracks' : 'Tap “Import Music” to choose audio files',
    eq: 'EQ',
    eqDescription: 'Preset is saved for local / streaming playback. Native DSP will use it when the audio engine is connected.',
    eqUnavailable: 'EQ is for Local and Streaming modes.',
    expandVolume: 'Expand volume control',
    externalData: 'External Data',
    externalDataDescription: 'Use online sources only when local / ECHO artwork or lyrics are missing.',
    formats: 'Formats',
    favorites: 'Favorites',
    filterA11y: 'Filter',
    glow: 'Artwork glow',
    glowDescription: 'Show a soft glow behind the player artwork.',
    host: 'Host',
    importLyrics: 'LRC',
    importLyricsA11y: 'Import lyrics',
    importLocalMusicA11y: 'Import local music',
    importNoFilesMessage: 'Please choose MP3, AAC, M4A, FLAC, ALAC, WAV, or other audio files.',
    importNoFilesTitle: 'No music imported',
    importMusic: 'Import Music',
    interface: 'Interface',
    interfaceDescription: 'Language and launch behavior.',
    language: 'Language',
    languageHint: 'Changes the app language and keeps it saved on this phone.',
    library: 'Library',
    libraryPage: 'Library page',
    librarySettingsDescription: 'Local and desktop library defaults.',
    lyricsLoadingText: 'Loading lyrics...',
    lyricsUnavailable: 'No available lyrics',
    localLibrary: 'Local',
    localLibraryErrorTitle: 'Local library error',
    localPlay: 'Local Play',
    localPlayback: 'Local',
    localPlaybackA11y: 'Local playback',
    localMode: 'Local Mode',
    lrclibSource: 'LRCLIB',
    lrclibSourceHint: 'Can fetch song lyrics and related lyric data.\nRequires the phone to reach the internet.',
    loudness: 'Loudness normalization',
    loudnessDescription: 'Uses the native DSP dynamics processor to keep perceived volume steadier. Off by default.',
    loudnessEnabled: 'Loudness normalization enabled',
    manual: 'Manual',
    manualHostPlaceholder: 'Computer IP, for example 192.168.1.12',
    moreInQueueSuffix: 'more in queue',
    moveDown: 'Move down',
    moveUp: 'Move up',
    neteaseSource: 'NetEase Cloud Music',
    neteaseSourceHint: 'Chinese library supplement.\nRequires the phone to reach the internet.',
    nextPlay: 'Next',
    nextTrack: 'Next track',
    noLyrics: 'No lyrics',
    noTrack: 'No Track Playing',
    nowPlaying: 'Now Playing',
    openEqPanel: 'Open EQ panel',
    openLyrics: 'Open lyrics',
    openPlaylistPreview: 'Open queue preview',
    openRepeatOne: 'Enable repeat one',
    pairLink: 'Pair Link',
    pairingFailedTitle: 'Pairing failed',
    pausePlayback: 'Pause playback',
    pcLocal: 'PC Local',
    playback: 'Playback',
    playbackPage: 'Playback page',
    playbackSettingsDescription: 'Playback page behavior.',
    playFirstLocalMusicA11y: 'Play first local track',
    playLocalTrackA11y: 'Play local track',
    playlistItemPrefix: 'Queue item',
    playNextA11y: 'Play next',
    playlist: 'Queue',
    portPlaceholder: 'Port',
    previousTrack: 'Previous track',
    queue: 'Queue',
    queueEmpty: 'The current queue is empty.',
    recent: 'Recent',
    removeFromQueue: 'Remove from queue',
    resetTags: 'Reset tags',
    resetTagsDescription: 'Restore the default visible audio tags.',
    rescanMetadata: 'Rescan metadata',
    rescanMetadataDescription: 'Scan local files again and refresh metadata.',
    save: 'Save',
    saveManualConnectionA11y: 'Save manual connection',
    scan: 'Scan',
    scanning: 'Scanning',
    searchPlaceholder: 'Search tracks, artists, or albums',
    settings: 'Settings',
    settingsCenter: 'Settings Center',
    settingsDescription: 'Open a category, then tune only the settings under it.',
    settingsPage: 'Settings page',
    songs: 'Songs',
    startPlayback: 'Start playback',
    storage: 'Storage',
    storageDescription: 'Local files, queue, and cleanup.',
    storageUsed: 'Local storage used',
    stream: 'Stream',
    streamToPhonePlayback: 'Stream to phone playback',
    streamingComingSoon: 'Streaming is in progress and not available yet.',
    streamingMode: 'Streaming Mode',
    streamingReserved: 'This page is reserved for future streaming integrations.',
    streamingServices: 'Streaming',
    streamable: 'Streamable',
    switchLibraryPrefix: 'Switch to',
    switchLibrarySuffix: 'library',
    sync: 'Sync',
    syncing: 'Syncing',
    test: 'Test',
    testComputerConnectionA11y: 'Test computer connection',
    testing: 'Testing',
    alertCancel: 'Cancel',
    connectionErrorTitle: 'Connection error',
    deleteConfirmAction: 'Delete',
    libraryErrorTitle: 'Library error',
    localMusicMissingMessage: 'Import music in the local library first.',
    localMusicMissingTitle: 'No local music',
    localNextMissing: 'There is no next track in the local library.',
    localPreviousMissing: 'There is no previous track in the local library.',
    noPlayableTrackMessage: 'No playable track right now. Play a song on the desktop first.',
    phoneAudioErrorTitle: 'Playback error',
    previousPhoneQueueMissing: 'There is no previous track in the queue.',
    nextPhoneQueueMissing: 'There is no next track in the queue.',
    streamUnsupportedMessage: 'This track cannot stream directly to the phone yet. Try a local MP3/AAC/M4A or another iOS-friendly file.',
  } : {
    addToQueue: '队列',
    all: '全部',
    albums: '专辑',
    artists: '艺术家',
    audioTags: '音频标签',
    audioTagsDescription: '选择播放页和曲库里展示哪些音频 tag。',
    autoLyrics: '自动打开本地歌词',
    autoLyricsDescription: '本地歌曲已有 LRC 时，播放后自动进入歌词页。',
    autoQueueImports: '导入后加入队列',
    autoQueueImportsDescription: '新导入的歌曲会自动追加到本地播放列表。',
    chooseCategory: '选择一个分类',
    clear: '清空',
    clearLocalQueue: '清空本地队列',
    clearLocalQueueDescription: '清空本地播放列表里的所有歌曲。',
    clearRecent: '清空最近播放',
    clearRecentDescription: '清空本地最近播放记录。',
    closeEqPanel: '关闭 EQ 面板',
    closeLyrics: '关闭歌词显示',
    closePlaylist: '关闭播放列表',
    closePlaylistPreview: '关闭播放列表预览',
    closeRepeatOne: '关闭单曲循环',
    collapseVolume: '收起音量调节',
    confirmDeleteLocalTrackMessagePrefix: '从手机本地曲库删除',
    confirmDeleteLocalTrackMessageSuffix: '？',
    confirmDelete: '删除前确认',
    confirmDeleteDescription: '从手机本地曲库删除音频文件前弹出确认。',
    connect: '连接',
    connectEcho: '连接 ECHO',
    connectPage: '连接页面',
    connectWithPairingA11y: '使用配对链接连接电脑',
    connectedPrefix: '已连接',
    connectingLabel: '正在连接',
    control: '控制',
    controlComputerPlayback: '控制电脑播放',
    controllingMode: 'Controlling Mode',
    defaultLibrarySource: '默认曲库源',
    defaultLibrarySourceHint: '选择曲库页默认显示 ECHO 曲库还是手机本地曲库。',
    defaultLocalView: '默认本地视图',
    defaultLocalViewHint: '选择本地曲库默认按歌曲、专辑、艺术家或格式展示。',
    defaultPage: '启动页面',
    defaultPageHint: '选择下次打开 App 时默认进入哪个页面。',
    deleteAction: '删',
    deleteLocalTrackA11y: '删除本地歌曲',
    deleteLocalTrackTitle: '删除本地歌曲',
    echoConnection: 'ECHO 连接',
    echoConnectionDescription: '关闭后不会自动连接、轮询 ECHO，也不会弹出连接异常提醒。',
    echoConnectionEnabled: '启用 ECHO 连接',
    echoNotConnected: 'ECHO未连接',
    echoOff: 'ECHO 已关闭',
    echoLibrary: 'ECHO',
    emptyEchoLibrary: client ? '没有匹配的歌曲' : '连接后会显示电脑端曲库',
    emptyLocalLibrary: localTracks.length > 0 ? '没有匹配的本地歌曲' : '点“导入音乐”选择音频文件',
    eq: 'EQ',
    eqDescription: '预设会随本地/串流播放保存；接入原生 DSP 音频引擎后会直接生效。',
    eqUnavailable: 'EQ 仅用于本地和串流模式。',
    expandVolume: '展开音量调节',
    externalData: '外源数据',
    externalDataDescription: '本地 / 串流 / 控制模式都会在缺少封面或歌词时按歌曲名与艺术家检索。',
    formats: '格式',
    favorites: '收藏',
    filterA11y: '筛选',
    glow: '封面光晕',
    glowDescription: '在播放页封面后显示一层柔和光晕。',
    host: '主机',
    importLyrics: '词',
    importLyricsA11y: '导入歌词',
    importLocalMusicA11y: '导入本地音乐',
    importNoFilesMessage: '请选择 MP3、AAC、M4A、FLAC、ALAC、WAV 等音频文件。',
    importNoFilesTitle: '没有导入音乐',
    importMusic: '导入音乐',
    interface: '界面',
    interfaceDescription: '语言、启动页和界面显示。',
    language: '语言',
    languageHint: '切换 App 界面语言，并保存在本机个人数据里。',
    library: '曲库',
    libraryPage: '曲库页面',
    librarySettingsDescription: '本地/电脑曲库的默认入口和视图。',
    lyricsLoadingText: '正在载入歌词...',
    lyricsUnavailable: '暂无可用歌词',
    localLibrary: '本地',
    localLibraryErrorTitle: '本地曲库异常',
    localPlay: '本地播放',
    localPlayback: '本地',
    localPlaybackA11y: '本地播放',
    localMode: 'Local Mode',
    lrclibSource: 'LRCLIB',
    lrclibSourceHint: '可获取歌曲歌词等\n需要保证手机能连接到外网才可获取',
    loudness: '响度归一化',
    loudnessDescription: '使用原生 DSP 动态处理器，让本地和串流歌曲的感知音量更稳定，默认关闭。',
    loudnessEnabled: '响度归一化已开启',
    manual: '手动输入',
    manualHostPlaceholder: '电脑 IP，例如 192.168.1.12',
    moreInQueueSuffix: '首在队列中',
    moveDown: '下移',
    moveUp: '上移',
    neteaseSource: '网易云音乐',
    neteaseSourceHint: '中文曲库补充\n需要保证手机能连接到外网才可获取',
    nextPlay: '下',
    nextTrack: '下一首',
    noLyrics: '暂无歌词',
    noTrack: '没有正在播放的歌曲',
    nowPlaying: '正在播放',
    openEqPanel: '打开 EQ 面板',
    openLyrics: '打开歌词显示',
    openPlaylistPreview: '打开播放列表预览',
    openRepeatOne: '开启单曲循环',
    pairLink: '配对链接',
    pairingFailedTitle: '配对失败',
    pausePlayback: '暂停播放',
    pcLocal: 'PC 本地',
    playback: '播放',
    playbackPage: '播放页面',
    playbackSettingsDescription: '播放页和播放动作相关设置。',
    playFirstLocalMusicA11y: '播放第一首本地音乐',
    playLocalTrackA11y: '本地播放',
    playlistItemPrefix: '播放列表第',
    playNextA11y: '下一首播放',
    playlist: '播放列表',
    portPlaceholder: '端口',
    previousTrack: '上一首',
    queue: '队列',
    queueEmpty: '当前播放队列暂无内容。',
    recent: '最近',
    removeFromQueue: '从队列移除',
    resetTags: '重置标签',
    resetTagsDescription: '恢复默认显示的音频 tag。',
    rescanMetadata: '重扫元数据',
    rescanMetadataDescription: '重新扫描本地文件并刷新元数据。',
    save: '保存',
    saveManualConnectionA11y: '保存手动连接',
    scan: '扫描',
    scanning: '扫描中',
    searchPlaceholder: '搜索歌曲、艺术家或专辑',
    settings: '设置',
    settingsCenter: '设置中心',
    settingsDescription: '按类型展开设置，只调整当前需要的那一组。',
    settingsPage: '设置页面',
    songs: '歌曲',
    startPlayback: '开始播放',
    storage: '存储',
    storageDescription: '本地文件、播放队列和清理设置。',
    storageUsed: '本地占用',
    stream: '串流',
    streamToPhonePlayback: '串流到手机播放',
    streamingComingSoon: '正在制作，暂未开放。',
    streamingMode: 'Streaming Mode',
    streamingReserved: '这里会预留给后续流媒体服务接入。',
    streamingServices: '流媒体',
    streamable: '可串流',
    switchLibraryPrefix: '切换到',
    switchLibrarySuffix: '曲库',
    sync: '刷新',
    syncing: '同步中',
    test: '测试',
    testComputerConnectionA11y: '测试电脑连接',
    testing: '测试中',
    alertCancel: '取消',
    connectionErrorTitle: '连接异常',
    deleteConfirmAction: '删除',
    libraryErrorTitle: '曲库加载异常',
    localMusicMissingMessage: '请先在本地曲库导入音乐。',
    localMusicMissingTitle: '没有本地音乐',
    localNextMissing: '本地曲库里暂时没有下一首。',
    localPreviousMissing: '本地曲库里暂时没有上一首。',
    noPlayableTrackMessage: '当前没有可播放的歌曲。请先在电脑端播放一首歌。',
    phoneAudioErrorTitle: '播放异常',
    previousPhoneQueueMissing: '播放列表里暂时没有上一首。',
    nextPhoneQueueMissing: '播放列表里暂时没有下一首。',
    streamUnsupportedMessage: '这首歌暂时不能直接串流到手机。请换一首本地 MP3/AAC/M4A 等 iOS 友好格式的歌曲。',
  }), [client, languageIsEnglish, localTracks.length]);

  const switchPage = useCallback((nextPage: AppPage) => {
    if (nextPage === page) {
      return;
    }
    const currentIndex = appPages.indexOf(page);
    const nextIndex = appPages.indexOf(nextPage);
    setPageSlideDirection(nextIndex >= currentIndex ? 1 : -1);
    setPlaylistOpen(false);
    setPage(nextPage);
  }, [page]);

  const pagePanResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) => (
      !sliderInteractionInFlight.current
      && Math.abs(gestureState.dx) > 46
      && Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.65
    ),
    onPanResponderRelease: (_, gestureState) => {
      if (Math.abs(gestureState.dx) < 70) {
        return;
      }
      const currentIndex = appPages.indexOf(page);
      const nextIndex = gestureState.dx < 0
        ? Math.min(appPages.length - 1, currentIndex + 1)
        : Math.max(0, currentIndex - 1);
      const nextPage = appPages[nextIndex];
      if (nextPage) {
        switchPage(nextPage);
      }
    },
  }), [page, switchPage]);

  const applyStatus = useCallback((nextStatus: EchoLinkStatusResponse, options: { force?: boolean } = {}) => {
    const pendingSeek = pendingPcSeekRef.current;
    if (pendingSeek && !options.force) {
      const nextTrackId = nextStatus.playback.track?.id ?? null;
      const pendingAgeMs = Date.now() - pendingSeek.requestedAtMs;
      const expectedPositionMs = pendingSeek.positionMs + (
        nextStatus.playback.state === 'playing' ? Math.max(0, pendingAgeMs) : 0
      );
      const closeEnough = Math.abs(nextStatus.playback.positionMs - expectedPositionMs) < 1200;

      if (nextTrackId === pendingSeek.trackId && !closeEnough && pendingAgeMs < 3500) {
        return;
      }
      pendingPcSeekRef.current = null;
    }
    latestStatusRef.current = nextStatus;
    setStatus(nextStatus);
    setStatusReceivedAtMs(Date.now());
  }, []);

  const patchPlayback = useCallback((patch: Partial<EchoLinkStatusResponse['playback']>) => {
    const now = Date.now();
    setStatus((current) => {
      if (!current) {
        return current;
      }
      const nextStatus = {
        ...current,
        playback: {
          ...current.playback,
          ...patch,
          updatedAtEpochMs: now,
        },
      };
      latestStatusRef.current = nextStatus;
      return nextStatus;
    });
    setClockMs(now);
    setStatusReceivedAtMs(now);
  }, []);

  const beginSliderInteraction = useCallback(() => {
    sliderInteractionInFlight.current = true;
  }, []);

  const endSliderInteraction = useCallback(() => {
    sliderInteractionInFlight.current = false;
  }, []);

  const refresh = useCallback(async () => {
    if (!client) {
      return;
    }
    setBusy(true);
    setError(null);
    setLibraryError(null);
    try {
      const nextStatus = await client.getStatus();
      applyStatus(nextStatus);
    } catch (refreshError) {
      setError(formatRequestError(refreshError));
      setBusy(false);
      return;
    }

    try {
      const library = await client.getLibraryTracks({ page: 1, pageSize: 20, query: queryRef.current });
      setTracks(library.tracks);
    } catch (libraryLoadError) {
      setLibraryError(`已连接电脑端，但曲库加载失败：${formatRequestError(libraryLoadError)}`);
    } finally {
      setBusy(false);
    }
  }, [applyStatus, client]);

  const refreshLocalLibrary = useCallback(async () => {
    setLocalLibraryBusy(true);
    setLocalLibraryError(null);
    try {
      setLocalTracks(await scanLocalMusic());
      setLocalStorageBytes(await getLocalMusicStorageUsage());
    } catch (scanError) {
      setLocalLibraryError(formatRequestError(scanError));
    } finally {
      setLocalLibraryBusy(false);
    }
  }, []);

  const refreshFromPull = useCallback(async () => {
    setPullRefreshing(true);
    try {
      if (page === 'library' && librarySource === 'local') {
        await refreshLocalLibrary();
      } else {
        await refresh();
      }
    } finally {
      setPullRefreshing(false);
    }
  }, [librarySource, page, refresh, refreshLocalLibrary]);

  useEffect(() => {
    let mounted = true;
    void Promise.all([loadSavedConnection(), loadSavedSettings(), loadSavedLocalMusicState()]).then(([savedConn, savedSettings, savedLocalMusic]) => {
      if (!mounted) {
        return;
      }
      if (savedConn) {
        setConnection(savedConn);
      }
      if (savedSettings.appLanguage) {
        setAppLanguage(savedSettings.appLanguage);
      }
      if (savedSettings.audioTagVisibility) {
        setAudioTagVisibility((current) => ({ ...current, ...savedSettings.audioTagVisibility }));
      }
      if (savedSettings.defaultPage) {
        setDefaultPage(savedSettings.defaultPage);
        setPage(savedSettings.defaultPage);
      }
      if (savedSettings.defaultLibrarySource) {
        setDefaultLibrarySource(savedSettings.defaultLibrarySource);
        setLibrarySource(savedSettings.defaultLibrarySource);
      }
      if (savedSettings.defaultLocalLibraryView) {
        setDefaultLocalLibraryView(savedSettings.defaultLocalLibraryView);
        setLocalLibraryView(savedSettings.defaultLocalLibraryView);
      }
      if (typeof savedSettings.autoOpenLyricsForLocalTracks === 'boolean') {
        setAutoOpenLyricsForLocalTracks(savedSettings.autoOpenLyricsForLocalTracks);
      }
      if (typeof savedSettings.autoQueueImportedLocalTracks === 'boolean') {
        setAutoQueueImportedLocalTracks(savedSettings.autoQueueImportedLocalTracks);
      }
      if (typeof savedSettings.confirmBeforeDeletingLocalTracks === 'boolean') {
        setConfirmBeforeDeletingLocalTracks(savedSettings.confirmBeforeDeletingLocalTracks);
      }
      if (typeof savedSettings.echoConnectionEnabled === 'boolean') {
        setEchoConnectionEnabled(savedSettings.echoConnectionEnabled);
      }
      if (savedSettings.eqPreset) {
        setEqPreset(savedSettings.eqPreset);
      }
      if (typeof savedSettings.lrclibExternalDataEnabled === 'boolean') {
        setLrclibExternalDataEnabled(savedSettings.lrclibExternalDataEnabled);
      }
      if (typeof savedSettings.neteaseExternalDataEnabled === 'boolean') {
        setNeteaseExternalDataEnabled(savedSettings.neteaseExternalDataEnabled);
      }
      if (typeof savedSettings.loudnessNormalizationEnabled === 'boolean') {
        setLoudnessNormalizationEnabled(savedSettings.loudnessNormalizationEnabled);
      }
      if (typeof savedSettings.showArtworkGlow === 'boolean') {
        setShowArtworkGlow(savedSettings.showArtworkGlow);
      }
      setSettingsLoaded(true);
      setFavoriteLocalTrackIds(savedLocalMusic.favoriteTrackIds);
      setLocalQueueTrackIds(savedLocalMusic.queueTrackIds);
      setRecentLocalTrackIds(savedLocalMusic.recentTrackIds);
      setLocalMusicStateLoaded(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    void Promise.all([scanLocalMusic(), getLocalMusicStorageUsage()])
      .then(([nextTracks, nextStorageBytes]) => {
        if (mounted) {
          setLocalTracks(nextTracks);
          setLocalStorageBytes(nextStorageBytes);
        }
      })
      .catch((scanError) => {
        if (mounted) {
          setLocalLibraryError(formatRequestError(scanError));
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (client) {
      void refresh();
    }
  }, [client, refresh]);

  useEffect(() => {
    if (echoConnectionEnabled) {
      return;
    }
    setBusy(false);
    setError(null);
    setLibraryError(null);
    setStatus(null);
  }, [echoConnectionEnabled]);

  useEffect(() => {
    if (librarySource !== 'echo' || !client || prevQueryRef.current === query) {
      prevQueryRef.current = query;
      return;
    }
    prevQueryRef.current = query;
    const timer = setTimeout(async () => {
      try {
        const lib = await client.getLibraryTracks({ page: 1, pageSize: 20, query });
        setTracks(lib.tracks);
      } catch (searchError) {
        setLibraryError(`已连接电脑端，但曲库加载失败：${formatRequestError(searchError)}`);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [client, librarySource, query]);

  useEffect(() => {
    if (!settingsLoaded) {
      return;
    }
    void saveSettings({
      appLanguage,
      audioTagVisibility,
      autoOpenLyricsForLocalTracks,
      autoQueueImportedLocalTracks,
      confirmBeforeDeletingLocalTracks,
      defaultLibrarySource,
      defaultLocalLibraryView,
      defaultPage,
      echoConnectionEnabled,
      eqPreset,
      lrclibExternalDataEnabled,
      loudnessNormalizationEnabled,
      neteaseExternalDataEnabled,
      showArtworkGlow,
    });
  }, [
    appLanguage,
    audioTagVisibility,
    autoOpenLyricsForLocalTracks,
    autoQueueImportedLocalTracks,
    confirmBeforeDeletingLocalTracks,
    defaultLibrarySource,
    defaultLocalLibraryView,
    defaultPage,
    echoConnectionEnabled,
    eqPreset,
    lrclibExternalDataEnabled,
    loudnessNormalizationEnabled,
    neteaseExternalDataEnabled,
    settingsLoaded,
    showArtworkGlow,
  ]);

  useEffect(() => {
    if (!localMusicStateLoaded) {
      return;
    }
    void saveLocalMusicState({
      favoriteTrackIds: favoriteLocalTrackIds,
      queueTrackIds: localQueueTrackIds,
      recentTrackIds: recentLocalTrackIds,
    });
  }, [favoriteLocalTrackIds, localMusicStateLoaded, localQueueTrackIds, recentLocalTrackIds]);

  useEffect(() => {
    const validIds = new Set(localTracks.map((track) => track.id));
    setFavoriteLocalTrackIds((current) => current.filter((id) => validIds.has(id)));
    setLocalQueueTrackIds((current) => current.filter((id) => validIds.has(id)));
    setRecentLocalTrackIds((current) => current.filter((id) => validIds.has(id)));
  }, [localTracks]);

  useEffect(() => {
    pageTransition.setValue(0);
    Animated.timing(pageTransition, {
      duration: 220,
      easing: Easing.out(Easing.cubic),
      toValue: 1,
      useNativeDriver: true,
    }).start();
  }, [page, pageTransition]);

  useEffect(() => {
    Animated.timing(dockIndexTransition, {
      duration: 260,
      easing: Easing.out(Easing.cubic),
      toValue: appPages.indexOf(page),
      useNativeDriver: true,
    }).start();
  }, [dockIndexTransition, page]);

  useEffect(() => {
    Animated.timing(lyricsTransition, {
      duration: 360,
      easing: Easing.out(Easing.cubic),
      toValue: lyricsVisible ? 1 : 0,
      useNativeDriver: true,
    }).start();
  }, [lyricsTransition, lyricsVisible]);

  useEffect(() => {
    if (playlistOpen) {
      setPlaylistVisible(true);
      Animated.timing(playlistTransition, {
        duration: 240,
        easing: Easing.out(Easing.cubic),
        toValue: 1,
        useNativeDriver: true,
      }).start();
      return;
    }

    Animated.timing(playlistTransition, {
      duration: 190,
      easing: Easing.out(Easing.cubic),
      toValue: 0,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) {
        setPlaylistVisible(false);
      }
    });
  }, [playlistOpen, playlistTransition]);

  useEffect(() => {
    Animated.timing(volumeTransition, {
      duration: 260,
      easing: Easing.out(Easing.cubic),
      toValue: volumeExpanded ? 1 : 0,
      useNativeDriver: true,
    }).start();
  }, [volumeExpanded, volumeTransition]);

  useEffect(() => {
    if (echoConnectionEnabled && error) {
      showErrorAlert(text.connectionErrorTitle, error, 'connection-error');
    }
  }, [echoConnectionEnabled, error, showErrorAlert, text.connectionErrorTitle]);

  useEffect(() => {
    if (echoConnectionEnabled && libraryError) {
      showErrorAlert(text.libraryErrorTitle, libraryError, 'library-error');
    }
  }, [echoConnectionEnabled, libraryError, showErrorAlert, text.libraryErrorTitle]);

  useEffect(() => {
    if (localLibraryError) {
      showErrorAlert(text.localLibraryErrorTitle, localLibraryError, 'local-library-error');
    }
  }, [localLibraryError, showErrorAlert, text.localLibraryErrorTitle]);

  useEffect(() => {
    if (phoneAudioError) {
      showErrorAlert(text.phoneAudioErrorTitle, phoneAudioError, 'phone-audio-error');
    }
  }, [phoneAudioError, showErrorAlert, text.phoneAudioErrorTitle]);

  useEffect(() => {
    const interval = setInterval(() => {
      setClockMs(Date.now());
    }, 500);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    void setAudioModeAsync({
      interruptionMode: 'doNotMix',
      playsInSilentMode: true,
      shouldPlayInBackground: true,
    }).catch((audioModeError) => {
      setPhoneAudioError(formatRequestError(audioModeError));
    });
  }, []);

  useEffect(() => {
    if (!client) {
      return undefined;
    }

    let cancelled = false;
    const pollStatus = async () => {
      if (statusPollInFlight.current) {
        return;
      }
      statusPollInFlight.current = true;
      try {
        const nextStatus = await client.getStatus();
        if (!cancelled && !sliderInteractionInFlight.current) {
          applyStatus(nextStatus);
          setError(null);
        }
      } catch (pollError) {
        if (!cancelled) {
          setError(formatRequestError(pollError));
        }
      } finally {
        statusPollInFlight.current = false;
      }
    };

    void pollStatus();
    const interval = setInterval(() => {
      void pollStatus();
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [applyStatus, client]);

  const applyPairingText = useCallback(async () => {
    try {
      const parsed = parsePairingUri(pairingText);
      parsed.host = normalizeEchoLinkHost(parsed.host);
      setEchoConnectionEnabled(true);
      setConnection(parsed);
      await saveConnection(parsed);
      setPairingText('');
      setError(null);
      switchPage('control');
    } catch (pairingError) {
      Alert.alert(text.pairingFailedTitle, pairingError instanceof Error ? pairingError.message : String(pairingError));
    }
  }, [pairingText, switchPage, text.pairingFailedTitle]);

  const saveManualConnection = useCallback(async () => {
    const nextConnection = {
      ...connection,
      host: normalizeEchoLinkHost(connection.host),
      token: normalizeEchoLinkToken(connection.token),
      port: Number(connection.port) || 26789,
      scheme: connection.scheme || 'http',
    };
    setEchoConnectionEnabled(true);
    setConnection(nextConnection);
    await saveConnection(nextConnection);
    switchPage('control');
  }, [connection, switchPage]);

  const importLocalLibrary = useCallback(async () => {
    setLocalLibraryBusy(true);
    setLocalLibraryError(null);
    try {
      const previousIds = new Set(localTracks.map((track) => track.id));
      const result = await importLocalMusicFiles();
      if (!result) {
        return;
      }
      setLocalTracks(result.tracks);
      setLocalStorageBytes(await getLocalMusicStorageUsage());
      setLibrarySource('local');
      if (autoQueueImportedLocalTracks) {
        const importedIds = result.tracks
          .map((track) => track.id)
          .filter((id) => !previousIds.has(id));
        if (importedIds.length > 0) {
          setLocalQueueTrackIds((current) => [...current, ...importedIds.filter((id) => !current.includes(id))]);
        }
      }
      if (result.importedCount === 0) {
        showErrorAlert(text.importNoFilesTitle, text.importNoFilesMessage);
      }
    } catch (importError) {
      setLocalLibraryError(formatRequestError(importError));
    } finally {
      setLocalLibraryBusy(false);
    }
  }, [autoQueueImportedLocalTracks, localTracks, showErrorAlert, text.importNoFilesMessage, text.importNoFilesTitle]);

  const markLocalTrackPlayed = useCallback((trackId: string) => {
    setRecentLocalTrackIds((current) => [trackId, ...current.filter((id) => id !== trackId)].slice(0, 50));
  }, []);

  const toggleLocalFavorite = useCallback((track: LocalMusicTrack) => {
    setFavoriteLocalTrackIds((current) => (
      current.includes(track.id)
        ? current.filter((id) => id !== track.id)
        : [track.id, ...current]
    ));
  }, []);

  const addLocalTrackToQueue = useCallback((track: LocalMusicTrack) => {
    setLocalQueueTrackIds((current) => [...current.filter((id) => id !== track.id), track.id]);
    setLibrarySource('local');
  }, []);

  const playLocalTrackNext = useCallback((track: LocalMusicTrack) => {
    setLocalQueueTrackIds((current) => {
      const currentId = localTrack?.id;
      const currentIndex = currentId ? current.indexOf(currentId) : -1;
      const insertIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
      const next = current.filter((id) => id !== track.id);
      next.splice(insertIndex, 0, track.id);
      return next;
    });
    setLibrarySource('local');
  }, [localTrack?.id]);

  const moveLocalQueueTrack = useCallback((track: LocalMusicTrack, direction: -1 | 1) => {
    setLocalQueueTrackIds((current) => {
      const index = current.indexOf(track.id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= current.length) {
        return current;
      }
      const next = [...current];
      const [id] = next.splice(index, 1);
      if (!id) {
        return current;
      }
      next.splice(targetIndex, 0, id);
      return next;
    });
  }, []);

  const performDeleteLocalTrack = useCallback(async (track: LocalMusicTrack) => {
    setLocalLibraryBusy(true);
    try {
      const nextTracks = await deleteLocalMusicTrack(track);
      setLocalTracks(nextTracks);
      setLocalStorageBytes(await getLocalMusicStorageUsage());
      setFavoriteLocalTrackIds((current) => current.filter((id) => id !== track.id));
      setLocalQueueTrackIds((current) => current.filter((id) => id !== track.id));
      setRecentLocalTrackIds((current) => current.filter((id) => id !== track.id));
      if (localTrack?.id === track.id) {
        phonePlayer.pause();
        phonePlayer.clearLockScreenControls();
        setLocalTrack(null);
        setPhoneSeekPreviewMs(null);
      }
    } catch (deleteError) {
      setLocalLibraryError(formatRequestError(deleteError));
    } finally {
      setLocalLibraryBusy(false);
    }
  }, [localTrack?.id, phonePlayer]);

  const deleteLocalTrack = useCallback((track: LocalMusicTrack) => {
    if (!confirmBeforeDeletingLocalTracks) {
      void performDeleteLocalTrack(track);
      return;
    }
    Alert.alert(text.deleteLocalTrackTitle, `${text.confirmDeleteLocalTrackMessagePrefix}「${track.title}」${text.confirmDeleteLocalTrackMessageSuffix}`, [
      { style: 'cancel', text: text.alertCancel },
      {
        style: 'destructive',
        text: text.deleteConfirmAction,
        onPress: () => void performDeleteLocalTrack(track),
      },
    ]);
  }, [
    confirmBeforeDeletingLocalTracks,
    performDeleteLocalTrack,
    text.alertCancel,
    text.confirmDeleteLocalTrackMessagePrefix,
    text.confirmDeleteLocalTrackMessageSuffix,
    text.deleteConfirmAction,
    text.deleteLocalTrackTitle,
  ]);

  const importLyricsForLocalTrack = useCallback(async (track: LocalMusicTrack) => {
    setLocalLibraryBusy(true);
    setLocalLibraryError(null);
    try {
      const nextTracks = await importLocalLyricFile(track);
      if (!nextTracks) {
        return;
      }
      setLocalTracks(nextTracks);
      setLocalStorageBytes(await getLocalMusicStorageUsage());
      setLyricsTrackId(null);
      setLyricsText('');
      setLyricsError(null);
    } catch (lyricsImportError) {
      setLocalLibraryError(formatRequestError(lyricsImportError));
    } finally {
      setLocalLibraryBusy(false);
    }
  }, []);

  const sendCommand = useCallback(async (command: Parameters<NonNullable<typeof client>['sendPlaybackCommand']>[0]) => {
    if (!client) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      applyStatus(await client.sendPlaybackCommand(command));
    } catch (commandError) {
      setError(formatRequestError(commandError));
    } finally {
      setBusy(false);
    }
  }, [applyStatus, client]);

  const playTrackOnPc = useCallback((track: EchoLinkTrackPreview) => {
    phonePlayer.pause();
    phonePlayer.clearLockScreenControls();
    if (echoAudioDsp.isAvailable) {
      void echoAudioDsp.stop().catch(() => undefined);
    }
    setPhoneSeekPreviewMs(null);
    setPlaybackOutputMode('pc');
    void sendCommand({ command: 'playTrack', trackId: track.id, output: 'pc' });
  }, [phonePlayer, sendCommand]);

  const nowPlaying = status?.playback.track;
  const playbackQueue = status?.playback.queue;
  const isLocalOutput = playbackOutputMode === 'local';
  const isPhoneOutput = playbackOutputMode === 'phone';
  const isDeviceOutput = isLocalOutput || isPhoneOutput;
  const useDspPlayback = echoAudioDsp.isAvailable && isDeviceOutput;
  const currentEqOption = useMemo(() => (
    eqPresetOptions.find((option) => option.key === eqPreset) ?? defaultEqOption
  ), [eqPreset]);
  const localTrackById = useMemo(() => new Map(localTracks.map((track) => [track.id, track])), [localTracks]);
  const localQueueTracks = useMemo(() => (
    localQueueTrackIds
      .map((id) => localTrackById.get(id))
      .filter((track): track is LocalMusicTrack => Boolean(track))
  ), [localQueueTrackIds, localTrackById]);
  const localPlaybackItems = localQueueTracks.length > 0 ? localQueueTracks : localTracks;
  const playlistItems: EchoLinkTrackPreview[] = isLocalOutput ? localPlaybackItems : playbackQueue?.items ?? [];
  const visiblePlaylistItems = playlistItems.slice(0, 8);
  const hiddenPlaylistItemCount = Math.max(0, playlistItems.length - visiblePlaylistItems.length);
  const displayTrack = isLocalOutput ? localTrack : isPhoneOutput ? phoneTrack ?? nowPlaying : nowPlaying;
  const deviceTrack = isLocalOutput ? localTrack : isPhoneOutput ? phoneTrack : null;
  const externalMetadataKey = externalMetadataKeyForTrack(displayTrack);
  const currentExternalMetadata = externalMetadataKey ? externalMetadataByKey[externalMetadataKey] : undefined;
  const nativeArtworkUrl = resolveArtworkUrl(displayTrack?.artworkUrl);
  const nativeArtworkVisible = artworkUrlIsVisible(nativeArtworkUrl);
  const externalArtworkUrl = resolveArtworkUrl(currentExternalMetadata?.albumArt);
  const displayArtworkUrl = nativeArtworkVisible ? nativeArtworkUrl : externalArtworkUrl;
  const shouldFetchExternalArtwork = Boolean(displayTrack && externalMetadataKey && !nativeArtworkVisible);
  const echoConnectionBroken = echoConnectionEnabled && Boolean(error);
  const echoConnectionOnline = echoConnectionEnabled && Boolean(status && !echoConnectionBroken);
  const connectedLabel = !echoConnectionEnabled
    ? text.echoOff
    : echoConnectionBroken
    ? text.echoNotConnected
    : status
      ? `${text.connectedPrefix} ${status.device.name}`
      : client
        ? text.connectingLabel
        : text.echoNotConnected;
  const playerConnectionDetail = status?.device.name ?? 'ECHO Link';
  const pcPlaybackPositionMs = status
    ? Math.max(0, Math.min(
      status.playback.durationMs || Number.MAX_SAFE_INTEGER,
      status.playback.positionMs + (status.playback.state === 'playing' ? Math.max(0, clockMs - statusReceivedAtMs) : 0),
    ))
    : 0;
  const phonePlaybackPositionMs = useDspPlayback
    ? Math.max(0, Math.round(dspStatus.currentTime * 1000))
    : Math.max(0, Math.round(phonePlayerStatus.currentTime * 1000));
  const playbackPositionMs = isDeviceOutput
    ? phoneSeekPreviewMs ?? phonePlaybackPositionMs
    : pcPlaybackPositionMs;
  const playbackDurationMs = isDeviceOutput
    ? Math.max(0, Math.round((useDspPlayback ? dspStatus.duration : phonePlayerStatus.duration) * 1000) || displayTrack?.durationMs || 0)
    : status?.playback.durationMs ?? 0;
  const progressRatio = playbackDurationMs
    ? clamp01(playbackPositionMs / playbackDurationMs)
    : 0;
  const outputVolume = isDeviceOutput ? phoneVolume : status?.playback.volume ?? 0;
  const volumePercent = Math.round(outputVolume * 100);
  const isPlaybackActive = isDeviceOutput
    ? (useDspPlayback ? dspStatus.playing : phonePlayerStatus.playing)
    : status?.playback.state === 'playing';
  const playbackTags = tagsForTrack(displayTrack, {
    outputMode: isLocalOutput ? '本地' : isPhoneOutput ? '串流' : status?.playback.outputMode,
    visibleAudioTags: audioTagVisibility,
  });

  useEffect(() => {
    const shouldLookupLrclib = lrclibExternalDataEnabled;
    const shouldLookupNetease = neteaseExternalDataEnabled || shouldFetchExternalArtwork;
    if ((!shouldLookupLrclib && !shouldLookupNetease) || !displayTrack || !externalMetadataKey) {
      return undefined;
    }
    const lookupKey = `${externalMetadataKey}::lrclib:${shouldLookupLrclib ? '1' : '0'}::netease:${shouldLookupNetease ? '1' : '0'}`;
    if (externalMetadataLookupKeysRef.current.has(lookupKey)) {
      return undefined;
    }
    externalMetadataLookupKeysRef.current.add(lookupKey);

    setExternalMetadataByKey((current) => ({
      ...current,
      [externalMetadataKey]: {
        albumArt: current[externalMetadataKey]?.albumArt ?? null,
        error: null,
        lyrics: current[externalMetadataKey]?.lyrics ?? null,
        sourceTitle: current[externalMetadataKey]?.sourceTitle ?? null,
        status: 'loading',
      },
    }));

    const lookupTrack = displayTrack;
    void lookupExternalTrackMetadata(lookupTrack, {
      lrclib: shouldLookupLrclib,
      netease: shouldLookupNetease,
    }, {
      includeNeteaseLyrics: neteaseExternalDataEnabled,
    })
      .then((metadata) => {
        setExternalMetadataByKey((current) => {
          const existing = current[externalMetadataKey];
          const albumArt = metadata.albumArt ?? existing?.albumArt ?? null;
          const lyrics = metadata.lyrics ?? existing?.lyrics ?? null;
          const sourceTitle = metadata.sourceTitle ?? existing?.sourceTitle ?? null;
          const hasMetadata = Boolean(albumArt || lyrics);
          return {
            ...current,
            [externalMetadataKey]: {
              albumArt,
              error: hasMetadata ? null : metadata.error,
              lyrics,
              sourceTitle,
              status: hasMetadata ? 'ready' : metadata.status,
            },
          };
        });
      })
      .catch((externalError) => {
        setExternalMetadataByKey((current) => {
          const existing = current[externalMetadataKey];
          const hasMetadata = Boolean(existing?.albumArt || existing?.lyrics);
          return {
            ...current,
            [externalMetadataKey]: {
              albumArt: existing?.albumArt ?? null,
              error: hasMetadata ? null : formatRequestError(externalError),
              lyrics: existing?.lyrics ?? null,
              sourceTitle: existing?.sourceTitle ?? null,
              status: hasMetadata ? 'ready' : 'error',
            },
          };
        });
      });
    return undefined;
  }, [
    displayTrack,
    externalMetadataKey,
    lrclibExternalDataEnabled,
    neteaseExternalDataEnabled,
    shouldFetchExternalArtwork,
  ]);

  useEffect(() => {
    externalMetadataLookupKeysRef.current.clear();
    setExternalMetadataByKey({});
  }, [lrclibExternalDataEnabled, neteaseExternalDataEnabled]);

  useEffect(() => {
    if (!echoAudioDsp.isAvailable) {
      return;
    }
    void echoAudioDsp.setEq(currentEqOption.gains).catch((dspError) => {
      setPhoneAudioError(formatPhoneAudioError(dspError));
    });
  }, [currentEqOption]);

  useEffect(() => {
    if (!echoAudioDsp.isAvailable) {
      return;
    }
    void echoAudioDsp.setLoudness(loudnessNormalizationEnabled).catch((dspError) => {
      setPhoneAudioError(formatPhoneAudioError(dspError));
    });
  }, [loudnessNormalizationEnabled]);

  useEffect(() => {
    if (!useDspPlayback) {
      return undefined;
    }

    let cancelled = false;
    const pollDspStatus = async () => {
      try {
        const nextStatus = await echoAudioDsp.getStatus();
        if (!cancelled) {
          setDspStatus(nextStatus);
          setPhoneVolume(nextStatus.volume);
        }
      } catch (dspError) {
        if (!cancelled) {
          setPhoneAudioError(formatPhoneAudioError(dspError));
        }
      }
    };

    void pollDspStatus();
    const interval = setInterval(() => {
      void pollDspStatus();
    }, 250);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [useDspPlayback]);

  const visibleTracks = useMemo(() => tracks.filter((track) => {
    if (libraryFilter === 'streamable') {
      return track.canPlayOnPhone;
    }
    if (libraryFilter === 'local') {
      return formatSourceTag(track.sourceLabel) === 'Local';
    }
    return true;
  }), [libraryFilter, tracks]);
  const favoriteLocalTrackIdSet = useMemo(() => new Set(favoriteLocalTrackIds), [favoriteLocalTrackIds]);
  const recentLocalTrackIdSet = useMemo(() => new Set(recentLocalTrackIds), [recentLocalTrackIds]);
  const queryFilteredLocalTracks = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return localTracks;
    }
    return localTracks.filter((track) => (
      track.title.toLowerCase().includes(normalizedQuery)
      || track.artist.toLowerCase().includes(normalizedQuery)
      || track.album.toLowerCase().includes(normalizedQuery)
      || track.fileName.toLowerCase().includes(normalizedQuery)
    ));
  }, [localTracks, query]);
  const visibleLocalTracks = useMemo(() => {
    if (localLibraryView === 'favorites') {
      return queryFilteredLocalTracks.filter((track) => favoriteLocalTrackIdSet.has(track.id));
    }
    if (localLibraryView === 'recent') {
      return recentLocalTrackIds
        .map((id) => queryFilteredLocalTracks.find((track) => track.id === id))
        .filter((track): track is LocalMusicTrack => Boolean(track));
    }
    if (localLibraryView === 'albums') {
      return [...queryFilteredLocalTracks].sort((a, b) => (
        (a.album || '未归类专辑').localeCompare(b.album || '未归类专辑') || a.title.localeCompare(b.title)
      ));
    }
    if (localLibraryView === 'artists') {
      return [...queryFilteredLocalTracks].sort((a, b) => (
        (a.artist || '未知艺术家').localeCompare(b.artist || '未知艺术家') || a.title.localeCompare(b.title)
      ));
    }
    if (localLibraryView === 'formats') {
      return [...queryFilteredLocalTracks].sort((a, b) => (
        (formatAudioQualityTag(a) || 'Unknown').localeCompare(formatAudioQualityTag(b) || 'Unknown') || a.title.localeCompare(b.title)
      ));
    }
    return queryFilteredLocalTracks;
  }, [favoriteLocalTrackIdSet, localLibraryView, queryFilteredLocalTracks, recentLocalTrackIds]);
  const streamableTrackCount = useMemo(() => (
    tracks.filter((track) => track.canPlayOnPhone).length
  ), [tracks]);
  const pcLocalTrackCount = useMemo(() => (
    tracks.filter((track) => formatSourceTag(track.sourceLabel) === 'Local').length
  ), [tracks]);
  const activeLibraryTracks: EchoLinkTrackPreview[] = librarySource === 'local' ? visibleLocalTracks : visibleTracks;
  const activeLibraryTotal = librarySource === 'local' ? localTracks.length : tracks.length;
  const localGroupLabel = useCallback((track: LocalMusicTrack): string | null => {
    if (localLibraryView === 'albums') {
      return track.album || '未归类专辑';
    }
    if (localLibraryView === 'artists') {
      return track.artist || '未知艺术家';
    }
    if (localLibraryView === 'formats') {
      return formatAudioQualityTag(track) || 'Unknown';
    }
    return null;
  }, [localLibraryView]);
  const visibleAudioTagCount = audioTagOptions.filter((option) => audioTagVisibility[option.key]).length;
  const lyricLines = useMemo(() => {
    if (lyricsLoading) {
      return [{ id: 'loading', text: text.lyricsLoadingText, timeMs: null }];
    }
    if (lyricsError) {
      return [{ id: 'error', text: text.lyricsUnavailable, timeMs: null }];
    }
    const parsedLyrics = parseLyrics(lyricsText);
    return parsedLyrics.length > 0 ? parsedLyrics : [{ id: 'empty', text: text.noLyrics, timeMs: null }];
  }, [lyricsError, lyricsLoading, lyricsText, text.lyricsLoadingText, text.lyricsUnavailable, text.noLyrics]);
  const activeLyricIndex = useMemo(() => {
    let activeIndex = 0;
    lyricLines.forEach((line, index) => {
      if (line.timeMs !== null && line.timeMs <= playbackPositionMs + 250) {
        activeIndex = index;
      }
    });
    return activeIndex;
  }, [lyricLines, playbackPositionMs]);
  const defaultPlayerAnimatedStyle = {
    opacity: lyricsTransition.interpolate({
      inputRange: [0, 1],
      outputRange: [1, 0.22],
    }),
    transform: [
      {
        scale: lyricsTransition.interpolate({
          inputRange: [0, 1],
          outputRange: [1, 0.96],
        }),
      },
      {
        translateY: lyricsTransition.interpolate({
          inputRange: [0, 1],
          outputRange: [0, -8],
        }),
      },
    ],
  };
  const lyricsPanelAnimatedStyle = {
    opacity: lyricsTransition,
    transform: [
      {
        translateY: lyricsTransition.interpolate({
          inputRange: [0, 1],
          outputRange: [16, 0],
        }),
      },
      {
        scale: lyricsTransition.interpolate({
          inputRange: [0, 1],
          outputRange: [0.985, 1],
        }),
      },
    ],
  };
  const volumeExpandedAnimatedStyle = {
    opacity: volumeTransition,
    transform: [
      {
        scaleX: volumeTransition.interpolate({
          inputRange: [0, 1],
          outputRange: [0.74, 1],
        }),
      },
    ],
  };
  const playlistBackdropAnimatedStyle = {
    opacity: playlistTransition.interpolate({
      inputRange: [0, 1],
      outputRange: [0, 1],
    }),
  };
  const playlistPopoverAnimatedStyle = {
    opacity: playlistTransition,
    transform: [
      {
        translateY: playlistTransition.interpolate({
          inputRange: [0, 1],
          outputRange: [22, 0],
        }),
      },
      {
        scale: playlistTransition.interpolate({
          inputRange: [0, 1],
          outputRange: [0.96, 1],
        }),
      },
    ],
  };
  const isCompactPlayer = windowWidth < 390 || windowHeight < 820;
  const lyricsViewportTargetHeight = Math.max(200, Math.round(windowHeight * 0.42));
  const playerCoverSize = isCompactPlayer ? Math.min(windowWidth - 118, 184) : Math.min(windowWidth - 96, 236);
  const playerShellPadding = isCompactPlayer ? 12 : 16;
  const playerShellGap = isCompactPlayer ? 9 : 12;
  const playerTitleSize = isCompactPlayer ? 20 : 23;
  const renderButtonBlur = (intensity = 22) => (
    <BlurView
      intensity={intensity}
      pointerEvents="none"
      style={styles.glassButtonBlur}
      tint="light"
    />
  );
  useEffect(() => {
    if (!displayArtworkUrl) {
      setStableArtworkUrl(null);
    }
  }, [displayArtworkUrl]);

  useEffect(() => {
    if (!lyricsVisible || !lyricsScrollRef.current || lyricLineLayoutsRef.current == null) {
      return;
    }
    const activeLine = lyricLines[activeLyricIndex];
    if (!activeLine?.id) {
      return;
    }
    const layout = lyricLineLayoutsRef.current[activeLine.id];
    if (!layout) {
      return;
    }
    const targetY = Math.max(0, layout.y - Math.max(24, lyricsViewportTargetHeight * 0.34));
    lyricsScrollRef.current.scrollTo({ animated: true, y: targetY });
  }, [activeLyricIndex, lyricLines, lyricsVisible, lyricsViewportTargetHeight]);
  const renderOutputSwitch = () => (
    <View style={styles.outputSwitch}>
      <Pressable
        accessibilityLabel={text.localPlaybackA11y}
        accessibilityRole="button"
        disabled={phoneAudioBusy || localLibraryBusy}
        onPress={switchToLocalPlayback}
        style={[styles.outputSwitchButton, isLocalOutput ? styles.outputSwitchButtonActive : null]}
      >
        {renderButtonBlur(isLocalOutput ? 12 : 18)}
        <AnimatedButtonContent motionKey={`local-${isLocalOutput}-${localLibraryBusy}`} style={styles.buttonMotionCenter}>
          <Text style={[styles.outputSwitchText, isLocalOutput ? styles.outputSwitchTextActive : null]}>
            {text.localPlayback}
          </Text>
        </AnimatedButtonContent>
      </Pressable>
      <Pressable
        accessibilityLabel={text.controlComputerPlayback}
        accessibilityRole="button"
        disabled={!client || phoneAudioBusy}
        onPress={switchToPcPlayback}
        style={[styles.outputSwitchButton, playbackOutputMode === 'pc' ? styles.outputSwitchButtonActive : null]}
      >
        {renderButtonBlur(playbackOutputMode === 'pc' ? 12 : 18)}
        <AnimatedButtonContent motionKey={`pc-${playbackOutputMode}`} style={styles.buttonMotionCenter}>
          <Text style={[styles.outputSwitchText, playbackOutputMode === 'pc' ? styles.outputSwitchTextActive : null]}>
            {text.control}
          </Text>
        </AnimatedButtonContent>
      </Pressable>
      <Pressable
        accessibilityLabel={text.streamToPhonePlayback}
        accessibilityRole="button"
        disabled={!client || phoneAudioBusy}
        onPress={switchToPhonePlayback}
        style={[styles.outputSwitchButton, isPhoneOutput ? styles.outputSwitchButtonActive : null]}
      >
        {renderButtonBlur(isPhoneOutput ? 12 : 18)}
        <AnimatedButtonContent motionKey={`phone-${isPhoneOutput}-${phoneAudioBusy}`} style={styles.buttonMotionCenter}>
          <Text style={[styles.outputSwitchText, isPhoneOutput ? styles.outputSwitchTextActive : null]}>
            {phoneAudioBusy ? '...' : text.stream}
          </Text>
        </AnimatedButtonContent>
      </Pressable>
    </View>
  );

  useEffect(() => {
    if (!lyricsVisible || !isLocalOutput || !localTrack?.id) {
      return;
    }
    if (lyricsTrackId === localTrack.id && (lyricsText || lyricsError)) {
      return;
    }

    let cancelled = false;
    setLyricsLoading(true);
    setLyricsError(null);
    void readLocalLyrics(localTrack)
      .then((lyrics) => {
        if (cancelled) {
          return;
        }
        setLyricsText(lyrics || text.noLyrics);
        setLyricsTrackId(localTrack.id);
      })
      .catch((lyricsLoadError) => {
        if (cancelled) {
          return;
        }
        setLyricsText('');
        setLyricsTrackId(localTrack.id);
        setLyricsError(formatRequestError(lyricsLoadError));
      })
      .finally(() => {
        if (!cancelled) {
          setLyricsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isLocalOutput, localTrack, lyricsError, lyricsText, lyricsTrackId, lyricsVisible, text.noLyrics]);

  useEffect(() => {
    if (!lyricsVisible || isLocalOutput || !client || !displayTrack?.id) {
      return;
    }
    if (lyricsTrackId === displayTrack.id && (lyricsText || lyricsError)) {
      return;
    }

    let cancelled = false;
    setLyricsLoading(true);
    setLyricsError(null);
    void client.getLyrics(displayTrack.id)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setLyricsText(response.lyrics || text.noLyrics);
        setLyricsTrackId(displayTrack.id);
      })
      .catch((lyricsLoadError) => {
        if (cancelled) {
          return;
        }
        setLyricsText('');
        setLyricsTrackId(displayTrack.id);
        setLyricsError(formatRequestError(lyricsLoadError));
      })
      .finally(() => {
        if (!cancelled) {
          setLyricsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [client, displayTrack?.id, isLocalOutput, lyricsError, lyricsText, lyricsTrackId, lyricsVisible, text.noLyrics]);

  useEffect(() => {
    if (
      !lyricsVisible
      || !displayTrack?.id
      || lyricsLoading
      || lyricsTrackId !== displayTrack.id
      || currentExternalMetadata?.status !== 'ready'
      || !currentExternalMetadata.lyrics
    ) {
      return;
    }
    if (lyricsText && lyricsText !== text.noLyrics && !lyricsError) {
      return;
    }
    setLyricsText(currentExternalMetadata.lyrics);
    setLyricsError(null);
    setLyricsLoading(false);
  }, [
    currentExternalMetadata?.lyrics,
    currentExternalMetadata?.status,
    displayTrack?.id,
    lyricsError,
    lyricsLoading,
    lyricsText,
    lyricsTrackId,
    lyricsVisible,
    text.noLyrics,
  ]);

  const playTrackOnLocal = useCallback(async (track: LocalMusicTrack, positionMs = 0) => {
    setPhoneAudioError(null);
    setPhoneSeekPreviewMs(null);
    setLocalTrack(track);
    markLocalTrackPlayed(track.id);
    setPlaybackOutputMode('local');
    if (autoOpenLyricsForLocalTracks && track.hasLyrics) {
      setLyricsVisible(true);
    }
    try {
      phonePlayer.pause();
      phonePlayer.clearLockScreenControls();
      if (echoAudioDsp.isAvailable) {
        await echoAudioDsp.playFile(track.uri, {
          gains: currentEqOption.gains,
          loudnessEnabled: loudnessNormalizationEnabled,
          positionMs,
          volume: phoneVolume,
        });
        setDspStatus(await echoAudioDsp.getStatus());
        return;
      }

      phonePlayer.replace({
        name: track.title,
        uri: track.uri,
      });
      phonePlayer.volume = phoneVolume;
      phonePlayer.setActiveForLockScreen(true, {
        albumTitle: track.album,
        artist: track.artist,
        artworkUrl: track.artworkUrl ?? undefined,
        title: track.title,
      }, {
        showSeekBackward: true,
        showSeekForward: true,
      });
      if (positionMs > 0) {
        await phonePlayer.seekTo(positionMs / 1000).catch(() => undefined);
      }
      phonePlayer.play();
    } catch (localPlaybackError) {
      setPhoneAudioError(formatPhoneAudioError(localPlaybackError));
    }
  }, [autoOpenLyricsForLocalTracks, currentEqOption, loudnessNormalizationEnabled, markLocalTrackPlayed, phonePlayer, phoneVolume]);

  const switchToLocalPlayback = useCallback(() => {
    if (isLocalOutput) {
      return;
    }
    const track = localTrack ?? localTracks[0];
    if (!track) {
      setLibrarySource('local');
      switchPage('library');
      showErrorAlert(text.localMusicMissingTitle, text.localMusicMissingMessage);
      return;
    }
    void playTrackOnLocal(track, 0);
  }, [isLocalOutput, localTrack, localTracks, playTrackOnLocal, showErrorAlert, switchPage, text.localMusicMissingMessage, text.localMusicMissingTitle]);

  const playTrackOnPhone = useCallback(async (
    track: EchoLinkTrackPreview,
    positionMs = 0,
    pausePcAfterStart = false,
  ) => {
    if (!client) {
      return;
    }
    if (!track.canPlayOnPhone) {
      setPhoneAudioError(text.streamUnsupportedMessage);
      return;
    }

    setPhoneAudioBusy(true);
    setPhoneAudioError(null);
    setPhoneSeekPreviewMs(null);
    try {
      const stream = await client.createPhoneStream(track.id);
      const nextVolume = isDeviceOutput
        ? phoneVolume
        : status?.playback.volume ?? phoneVolume;

      phonePlayer.pause();
      setPhoneVolume(nextVolume);
      setPhoneTrack(stream.track);
      setPlaybackOutputMode('phone');

      if (echoAudioDsp.isAvailable) {
        phonePlayer.clearLockScreenControls();
        const cachedStreamUri = await downloadStreamForDsp(stream.streamUrl, stream.track);
        await echoAudioDsp.playFile(cachedStreamUri, {
          gains: currentEqOption.gains,
          loudnessEnabled: loudnessNormalizationEnabled,
          positionMs,
          volume: nextVolume,
        });
        setDspStatus(await echoAudioDsp.getStatus());
      } else {
        phonePlayer.replace({
          name: `${stream.track.title} - ${stream.track.artist}`,
          uri: stream.streamUrl,
        });
        phonePlayer.volume = nextVolume;
        phonePlayer.setActiveForLockScreen(true, {
          albumTitle: stream.track.album,
          artist: stream.track.artist,
          artworkUrl: stream.track.artworkUrl ?? undefined,
          title: stream.track.title,
        }, {
          showSeekBackward: true,
          showSeekForward: true,
        });
        if (positionMs > 0) {
          await phonePlayer.seekTo(positionMs / 1000).catch(() => undefined);
        }
        phonePlayer.play();
      }

      if (pausePcAfterStart && (status?.playback.state === 'playing' || status?.playback.state === 'loading')) {
        void client.sendPlaybackCommand({ command: 'playPause' })
          .then(applyStatus)
          .catch((handoffError) => setPhoneAudioError(formatPhoneAudioError(handoffError)));
      }
    } catch (phoneError) {
      setPhoneAudioError(formatPhoneAudioError(phoneError));
    } finally {
      setPhoneAudioBusy(false);
    }
  }, [applyStatus, client, currentEqOption, isDeviceOutput, loudnessNormalizationEnabled, phonePlayer, phoneVolume, status, text.streamUnsupportedMessage]);

  const switchToPhonePlayback = useCallback(() => {
    if (isPhoneOutput) {
      return;
    }
    const track = nowPlaying ?? phoneTrack;
    if (!track) {
      setPhoneAudioError(text.noPlayableTrackMessage);
      return;
    }
    void playTrackOnPhone(track, nowPlaying?.id === track.id ? pcPlaybackPositionMs : 0, true);
  }, [isPhoneOutput, nowPlaying, pcPlaybackPositionMs, phoneTrack, playTrackOnPhone, text.noPlayableTrackMessage]);

  const switchToPcPlayback = useCallback(() => {
    if (playbackOutputMode === 'pc') {
      return;
    }
    const track = phoneTrack ?? nowPlaying;
    const positionMs = Math.max(0, Math.round((echoAudioDsp.isAvailable ? dspStatus.currentTime : phonePlayerStatus.currentTime) * 1000));

    phonePlayer.pause();
    phonePlayer.clearLockScreenControls();
    if (echoAudioDsp.isAvailable) {
      void echoAudioDsp.stop().catch(() => undefined);
    }
    setPlaybackOutputMode('pc');
    setPhoneSeekPreviewMs(null);
    setPhoneAudioError(null);

    if (isPhoneOutput && client && track) {
      void client.sendPlaybackCommand({
        command: 'handoff',
        positionMs,
        target: 'pc',
        trackId: track.id,
      })
        .then(applyStatus)
        .catch((handoffError) => setError(formatRequestError(handoffError)));
    }
  }, [applyStatus, client, dspStatus.currentTime, isPhoneOutput, nowPlaying, phonePlayer, phonePlayerStatus.currentTime, phoneTrack, playbackOutputMode]);

  const togglePlayPause = useCallback(() => {
    if (isDeviceOutput) {
      if (isLocalOutput && !localTrack) {
        switchToLocalPlayback();
        return;
      }
      if (isPhoneOutput && !phoneTrack) {
        switchToPhonePlayback();
        return;
      }
      if (echoAudioDsp.isAvailable) {
        void (dspStatus.playing ? echoAudioDsp.pause() : echoAudioDsp.resume())
          .then(() => echoAudioDsp.getStatus())
          .then(setDspStatus)
          .catch((dspError) => setPhoneAudioError(formatPhoneAudioError(dspError)));
      } else if (phonePlayerStatus.playing) {
        phonePlayer.pause();
      } else {
        phonePlayer.play();
      }
      return;
    }
    void sendCommand({ command: 'playPause' });
  }, [
    isDeviceOutput,
    isLocalOutput,
    isPhoneOutput,
    localTrack,
    dspStatus.playing,
    phonePlayer,
    phonePlayerStatus.playing,
    phoneTrack,
    sendCommand,
    switchToLocalPlayback,
    switchToPhonePlayback,
  ]);

  const playRelativePhoneQueueTrack = useCallback((direction: -1 | 1) => {
    const currentTrackId = phoneTrack?.id ?? nowPlaying?.id ?? playbackQueue?.currentTrackId;
    const currentIndex = playlistItems.findIndex((item) => item.id === currentTrackId);
    const nextTrack = currentIndex >= 0 ? playlistItems[currentIndex + direction] : null;
    if (!nextTrack) {
      setPhoneAudioError(direction > 0 ? text.nextPhoneQueueMissing : text.previousPhoneQueueMissing);
      return;
    }
    void playTrackOnPhone(nextTrack, 0, false);
  }, [nowPlaying, phoneTrack, playbackQueue?.currentTrackId, playlistItems, playTrackOnPhone, text.nextPhoneQueueMissing, text.previousPhoneQueueMissing]);

  const playRelativeLocalTrack = useCallback((direction: -1 | 1) => {
    const currentIndex = localPlaybackItems.findIndex((item) => item.id === localTrack?.id);
    const nextTrack = currentIndex >= 0 ? localPlaybackItems[currentIndex + direction] : localPlaybackItems[0];
    if (!nextTrack) {
      setPhoneAudioError(direction > 0 ? text.localNextMissing : text.localPreviousMissing);
      return;
    }
    void playTrackOnLocal(nextTrack, 0);
  }, [localPlaybackItems, localTrack?.id, playTrackOnLocal, text.localNextMissing, text.localPreviousMissing]);

  const playPrevious = useCallback(() => {
    if (isLocalOutput) {
      playRelativeLocalTrack(-1);
      return;
    }
    if (isPhoneOutput) {
      playRelativePhoneQueueTrack(-1);
      return;
    }
    void sendCommand({ command: 'previous' });
  }, [isLocalOutput, isPhoneOutput, playRelativeLocalTrack, playRelativePhoneQueueTrack, sendCommand]);

  const playNext = useCallback(() => {
    if (isLocalOutput) {
      playRelativeLocalTrack(1);
      return;
    }
    if (isPhoneOutput) {
      playRelativePhoneQueueTrack(1);
      return;
    }
    void sendCommand({ command: 'next' });
  }, [isLocalOutput, isPhoneOutput, playRelativeLocalTrack, playRelativePhoneQueueTrack, sendCommand]);

  useEffect(() => {
    if (!repeatOneEnabled || !isDeviceOutput || !deviceTrack) {
      phoneRepeatArmedRef.current = true;
      return;
    }

    const durationSeconds = Number(useDspPlayback ? dspStatus.duration : phonePlayerStatus.duration) || 0;
    const currentSeconds = Number(useDspPlayback ? dspStatus.currentTime : phonePlayerStatus.currentTime) || 0;
    const devicePlaying = useDspPlayback ? dspStatus.playing : phonePlayerStatus.playing;
    const didJustFinish = useDspPlayback ? dspStatus.didJustFinish : phonePlayerStatus.didJustFinish;
    if (devicePlaying && (!durationSeconds || currentSeconds < Math.max(0, durationSeconds - 1))) {
      phoneRepeatArmedRef.current = true;
    }

    if (!didJustFinish || !phoneRepeatArmedRef.current) {
      return;
    }

    phoneRepeatArmedRef.current = false;
    if (useDspPlayback) {
      void echoAudioDsp.seekTo(0)
        .then(() => echoAudioDsp.resume())
        .then(() => echoAudioDsp.getStatus())
        .then(setDspStatus)
        .catch((dspError) => setPhoneAudioError(formatPhoneAudioError(dspError)));
      return;
    }
    void phonePlayer.seekTo(0)
      .catch(() => undefined)
      .finally(() => {
        phonePlayer.play();
      });
  }, [
    deviceTrack,
    dspStatus.currentTime,
    dspStatus.didJustFinish,
    dspStatus.duration,
    dspStatus.playing,
    isDeviceOutput,
    phonePlayer,
    phonePlayerStatus.currentTime,
    phonePlayerStatus.didJustFinish,
    phonePlayerStatus.duration,
    phonePlayerStatus.playing,
    repeatOneEnabled,
    useDspPlayback,
  ]);

  useEffect(() => {
    if (!repeatOneEnabled || isDeviceOutput || !client || !status?.playback.track) {
      pcRepeatArmedRef.current = true;
      return;
    }

    const { durationMs, positionMs, state, track } = status.playback;
    const hasDuration = durationMs > 0;
    const nearEnd = hasDuration && positionMs >= Math.max(0, durationMs - 1500);
    if (state === 'playing' || state === 'loading' || (hasDuration && positionMs < Math.max(0, durationMs - 2500))) {
      pcRepeatArmedRef.current = true;
    }

    if (state !== 'stopped' || !nearEnd || !pcRepeatArmedRef.current) {
      return;
    }

    pcRepeatArmedRef.current = false;
    void client.sendPlaybackCommand({ command: 'playTrack', trackId: track.id, output: 'pc' })
      .then(applyStatus)
      .catch((repeatError) => setError(formatRequestError(repeatError)));
  }, [
    applyStatus,
    client,
    isDeviceOutput,
    repeatOneEnabled,
    status?.playback.durationMs,
    status?.playback.positionMs,
    status?.playback.state,
    status?.playback.track,
  ]);

  const updateSeekFromGesture = useCallback((event: GestureResponderEvent, commit: boolean) => {
    if ((!status && !isDeviceOutput) || !playbackDurationMs || progressTrackWidth <= 0) {
      return;
    }
    const ratio = ratioFromGesture(event, progressTrackWidth);
    const positionMs = Math.round(playbackDurationMs * ratio);
    if (isDeviceOutput) {
      setPhoneSeekPreviewMs(commit ? null : positionMs);
      if (commit) {
        if (useDspPlayback) {
          void echoAudioDsp.seekTo(positionMs / 1000)
            .then(() => echoAudioDsp.getStatus())
            .then(setDspStatus)
            .catch((dspError) => setPhoneAudioError(formatPhoneAudioError(dspError)));
        } else {
          void phonePlayer.seekTo(positionMs / 1000);
        }
      }
      return;
    }
    sliderInteractionInFlight.current = true;
    patchPlayback({ positionMs });
    if (commit) {
      pendingPcSeekRef.current = {
        positionMs,
        requestedAtMs: Date.now(),
        trackId: status?.playback.track?.id ?? null,
      };
      void sendCommand({ command: 'seekTo', positionMs }).finally(() => {
        sliderInteractionInFlight.current = false;
      });
    }
  }, [isDeviceOutput, patchPlayback, phonePlayer, playbackDurationMs, progressTrackWidth, sendCommand, status, useDspPlayback]);

  const seekToLyric = useCallback((line: LyricLine) => {
    if (line.timeMs === null || (!status && !isDeviceOutput)) {
      return;
    }
    if (isDeviceOutput) {
      if (useDspPlayback) {
        void echoAudioDsp.seekTo(line.timeMs / 1000)
          .then(() => echoAudioDsp.getStatus())
          .then(setDspStatus)
          .catch((dspError) => setPhoneAudioError(formatPhoneAudioError(dspError)));
      } else {
        void phonePlayer.seekTo(line.timeMs / 1000);
      }
      return;
    }
    pendingPcSeekRef.current = {
      positionMs: line.timeMs,
      requestedAtMs: Date.now(),
      trackId: status?.playback.track?.id ?? null,
    };
    patchPlayback({ positionMs: line.timeMs });
    void sendCommand({ command: 'seekTo', positionMs: line.timeMs });
  }, [isDeviceOutput, patchPlayback, phonePlayer, sendCommand, status, useDspPlayback]);

  const updateVolumeFromGesture = useCallback((event: GestureResponderEvent, commit: boolean) => {
    if ((!status && !isDeviceOutput) || volumeTrackWidth <= 0) {
      return;
    }
    const volume = ratioFromGesture(event, volumeTrackWidth);
    if (isDeviceOutput) {
      setPhoneVolume(volume);
      if (useDspPlayback) {
        void echoAudioDsp.setVolume(volume)
          .then(() => echoAudioDsp.getStatus())
          .then(setDspStatus)
          .catch((dspError) => setPhoneAudioError(formatPhoneAudioError(dspError)));
      } else {
        phonePlayer.volume = volume;
      }
      return;
    }
    sliderInteractionInFlight.current = !commit;
    patchPlayback({ volume });
    if (commit) {
      void sendCommand({ command: 'setVolume', volume });
    }
  }, [isDeviceOutput, patchPlayback, phonePlayer, sendCommand, status, useDspPlayback, volumeTrackWidth]);

  const handleProgressLayout = useCallback((event: LayoutChangeEvent) => {
    setProgressTrackWidth(event.nativeEvent.layout.width);
  }, []);

  const handleVolumeLayout = useCallback((event: LayoutChangeEvent) => {
    setVolumeTrackWidth(event.nativeEvent.layout.width);
  }, []);

  const handleDockLayout = useCallback((event: LayoutChangeEvent) => {
    setDockWidth(event.nativeEvent.layout.width);
  }, []);

  const toggleAudioTagVisibility = useCallback((key: AudioTagKey) => {
    setAudioTagVisibility((current) => ({
      ...current,
      [key]: !current[key],
    }));
  }, []);

  const pageTitle = page === 'connect'
    ? text.connect
    : page === 'library'
      ? text.library
      : page === 'settings'
        ? text.settings
        : text.playback;
  const playbackModeLabel = isLocalOutput
    ? text.localMode
    : isPhoneOutput
      ? text.streamingMode
      : text.controllingMode;
  const pageAnimatedStyle = {
    opacity: pageTransition,
    transform: [
      {
        translateX: pageTransition.interpolate({
          inputRange: [0, 1],
          outputRange: [24 * pageSlideDirection, 0],
        }),
      },
      {
        scale: pageTransition.interpolate({
          inputRange: [0, 1],
          outputRange: [0.985, 1],
        }),
      },
    ],
  };
  const dockOuterPadding = 8;
  const dockGap = 8;
  const dockItemWidth = dockWidth > 0
    ? Math.max(0, (dockWidth - dockOuterPadding * 2 - dockGap * (appPages.length - 1)) / appPages.length)
    : 0;
  const dockIndicatorStep = dockItemWidth + dockGap;
  const dockIndicatorAnimatedStyle = {
    opacity: dockWidth > 0 ? 1 : 0,
    transform: [
      {
        translateX: dockIndexTransition.interpolate({
          inputRange: [0, appPages.length - 1],
          outputRange: [0, dockIndicatorStep * (appPages.length - 1)],
        }),
      },
    ],
    width: dockItemWidth,
  };
  const pageSettingOptions: Array<[AppPage, string]> = [
    ['control', text.playback],
    ['library', text.library],
    ['connect', text.connect],
    ['settings', text.settings],
  ];
  const connectPanelOptions: Array<[ConnectPanelMode, string]> = [
    ['echo', text.connectEcho],
    ['streaming', text.streamingServices],
  ];
  const librarySourceSettingOptions: Array<[LibrarySource, string]> = [
    ['echo', text.echoLibrary],
    ['local', text.localLibrary],
  ];
  const labelForLocalLibraryView = useCallback((view: LocalLibraryView) => {
    const labels: Record<LocalLibraryView, string> = {
      albums: text.albums,
      artists: text.artists,
      favorites: text.favorites,
      formats: text.formats,
      recent: text.recent,
      songs: text.songs,
    };
    return labels[view];
  }, [text.albums, text.artists, text.favorites, text.formats, text.recent, text.songs]);
  const settingsSections = useMemo<Array<{
    description: string;
    key: SettingsSectionKey;
    summary: string;
    title: string;
  }>>(() => [
    {
      description: text.interfaceDescription,
      key: 'interface',
      summary: `${appLanguage === 'en' ? 'English' : '中文'} · ${pageSettingOptions.find(([value]) => value === defaultPage)?.[1] ?? text.playback}`,
      title: text.interface,
    },
    {
      description: text.playbackSettingsDescription,
      key: 'playback',
      summary: `${languageIsEnglish ? currentEqOption.labelEn : currentEqOption.labelZh} · ${loudnessNormalizationEnabled ? text.loudness : 'DSP'}`,
      title: text.playback,
    },
    {
      description: text.externalDataDescription,
      key: 'externalData',
      summary: [
        lrclibExternalDataEnabled ? 'LRCLIB' : null,
        neteaseExternalDataEnabled ? (languageIsEnglish ? 'NetEase' : '网易云') : null,
      ].filter(Boolean).join(' · ') || (languageIsEnglish ? 'Off' : '关闭'),
      title: text.externalData,
    },
    {
      description: text.librarySettingsDescription,
      key: 'library',
      summary: `${defaultLibrarySource === 'local' ? text.localLibrary : text.echoLibrary} · ${labelForLocalLibraryView(defaultLocalLibraryView)}`,
      title: text.library,
    },
    {
      description: text.audioTagsDescription,
      key: 'audioTags',
      summary: languageIsEnglish ? `${visibleAudioTagCount} visible` : `已显示 ${visibleAudioTagCount} 项`,
      title: text.audioTags,
    },
    {
      description: text.storageDescription,
      key: 'storage',
      summary: formatStorageSize(localStorageBytes),
      title: text.storage,
    },
  ], [
    appLanguage,
    autoOpenLyricsForLocalTracks,
    currentEqOption,
    defaultLibrarySource,
    defaultLocalLibraryView,
    defaultPage,
    labelForLocalLibraryView,
    languageIsEnglish,
    localStorageBytes,
    loudnessNormalizationEnabled,
    lrclibExternalDataEnabled,
    neteaseExternalDataEnabled,
    pageSettingOptions,
    showArtworkGlow,
    text,
    visibleAudioTagCount,
  ]);
  const toggleSettingsSection = useCallback((section: SettingsSectionKey) => {
    setOpenSettingsSection((current) => (current === section ? 'interface' : section));
  }, []);
  const renderSegmentOptions = <T extends string,>(
    options: Array<[T, string]>,
    currentValue: T,
    onChange: (value: T) => void,
  ) => (
    <View style={styles.segmentRow}>
      {options.map(([value, label]) => (
        <Pressable
          accessibilityLabel={label}
          accessibilityRole="button"
          key={value}
          onPress={() => onChange(value)}
          style={[styles.segmentButton, currentValue === value ? styles.segmentButtonActive : null]}
        >
          {renderButtonBlur(currentValue === value ? 10 : 20)}
          <AnimatedButtonContent motionKey={currentValue === value} style={styles.buttonMotionCenter}>
            <Text style={[styles.segmentButtonText, currentValue === value ? styles.segmentButtonTextActive : null]}>{label}</Text>
          </AnimatedButtonContent>
        </Pressable>
      ))}
    </View>
  );
  const renderSettingSwitch = (
    title: string,
    description: string,
    enabled: boolean,
    onChange: (enabled: boolean) => void,
  ) => (
    <Pressable
      accessibilityLabel={title}
      accessibilityRole="switch"
      accessibilityState={{ checked: enabled }}
      onPress={() => onChange(!enabled)}
      style={styles.settingRow}
    >
      <View style={styles.settingText}>
        <Text style={styles.settingTitle}>{title}</Text>
        <Text style={styles.settingDescription}>{description}</Text>
      </View>
      <View style={[styles.switchTrack, enabled ? styles.switchTrackActive : null]}>
        <View style={[styles.switchThumb, enabled ? styles.switchThumbActive : null]} />
      </View>
    </Pressable>
  );
  const renderSettingAction = (
    title: string,
    description: string,
    onPress: () => void,
    disabled = false,
  ) => (
    <Pressable
      accessibilityLabel={title}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.settingRow, disabled ? styles.settingRowDisabled : null]}
    >
      <View style={styles.settingText}>
        <Text style={styles.settingTitle}>{title}</Text>
        <Text style={styles.settingDescription}>{description}</Text>
      </View>
      <SuperconIcon glyph="view-forward" size={18} color="rgba(248, 250, 252, 0.64)" />
    </Pressable>
  );
  const renderSettingsBody = (section: SettingsSectionKey) => {
    if (section === 'interface') {
      return (
        <View style={styles.settingsList}>
          <View style={styles.settingGroupBlock}>
            <Text style={styles.settingGroupTitle}>{text.language}</Text>
            {renderSegmentOptions<AppLanguage>([
              ['zh', '中文'],
              ['en', 'English'],
            ], appLanguage, setAppLanguage)}
            <Text style={styles.settingDescription}>
              {text.languageHint}
            </Text>
          </View>
          <View style={styles.settingGroupBlock}>
            <Text style={styles.settingGroupTitle}>{text.defaultPage}</Text>
            {renderSegmentOptions<AppPage>(pageSettingOptions, defaultPage, setDefaultPage)}
            <Text style={styles.settingDescription}>
              {text.defaultPageHint}
            </Text>
          </View>
        </View>
      );
    }

    if (section === 'playback') {
      return (
        <View style={styles.settingsList}>
          <View style={styles.settingGroupBlock}>
            <Text style={styles.settingGroupTitle}>{text.eq}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.eqPresetRow}>
              {eqPresetOptions.map((option) => {
                const active = option.key === eqPreset;
                const label = languageIsEnglish ? option.labelEn : option.labelZh;
                return (
                  <Pressable
                    accessibilityLabel={`${text.eq} ${label}`}
                    accessibilityRole="button"
                    key={option.key}
                    onPress={() => setEqPreset(option.key)}
                    style={[styles.eqPresetButton, active ? styles.eqPresetButtonActive : null]}
                  >
                    {renderButtonBlur(active ? 10 : 20)}
                    <Text style={[styles.eqPresetText, active ? styles.eqPresetTextActive : null]}>{label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <Text style={styles.settingDescription}>{text.eqDescription}</Text>
          </View>
          {renderSettingSwitch(text.loudness, text.loudnessDescription, loudnessNormalizationEnabled, setLoudnessNormalizationEnabled)}
          {renderSettingSwitch(text.autoLyrics, text.autoLyricsDescription, autoOpenLyricsForLocalTracks, setAutoOpenLyricsForLocalTracks)}
          {renderSettingSwitch(text.glow, text.glowDescription, showArtworkGlow, setShowArtworkGlow)}
        </View>
      );
    }

    if (section === 'library') {
      return (
        <View style={styles.settingsList}>
          <View style={styles.settingGroupBlock}>
            <Text style={styles.settingGroupTitle}>{text.defaultLibrarySource}</Text>
            {renderSegmentOptions<LibrarySource>(librarySourceSettingOptions, defaultLibrarySource, (value) => {
              setDefaultLibrarySource(value);
              setLibrarySource(value);
            })}
            <Text style={styles.settingDescription}>
              {text.defaultLibrarySourceHint}
            </Text>
          </View>
          <View style={styles.settingGroupBlock}>
            <Text style={styles.settingGroupTitle}>{text.defaultLocalView}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.localViewRow}>
              {localLibraryViewOptions.map((value) => {
                const label = labelForLocalLibraryView(value);
                return (
                  <Pressable
                    accessibilityLabel={label}
                    accessibilityRole="button"
                    key={value}
                    onPress={() => {
                      setDefaultLocalLibraryView(value);
                      setLocalLibraryView(value);
                    }}
                    style={[styles.localViewChip, defaultLocalLibraryView === value ? styles.localViewChipActive : null]}
                  >
                    {renderButtonBlur(defaultLocalLibraryView === value ? 10 : 20)}
                    <Text style={[styles.libraryFilterText, defaultLocalLibraryView === value ? styles.libraryFilterTextActive : null]}>{label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <Text style={styles.settingDescription}>
              {text.defaultLocalViewHint}
            </Text>
          </View>
          {renderSettingSwitch(text.autoQueueImports, text.autoQueueImportsDescription, autoQueueImportedLocalTracks, setAutoQueueImportedLocalTracks)}
        </View>
      );
    }

    if (section === 'externalData') {
      return (
        <View style={styles.settingsList}>
          {renderSettingSwitch(text.lrclibSource, text.lrclibSourceHint, lrclibExternalDataEnabled, setLrclibExternalDataEnabled)}
          {renderSettingSwitch(text.neteaseSource, text.neteaseSourceHint, neteaseExternalDataEnabled, setNeteaseExternalDataEnabled)}
          <Text style={styles.settingDescription}>{text.externalDataDescription}</Text>
        </View>
      );
    }

    if (section === 'audioTags') {
      return (
        <View style={styles.settingsList}>
          {audioTagOptions.map((option) => {
            const enabled = audioTagVisibility[option.key];
            return (
              <View key={option.key}>
                {renderSettingSwitch(
                  languageIsEnglish ? option.labelEn : option.labelZh,
                  languageIsEnglish ? option.descriptionEn : option.descriptionZh,
                  enabled,
                  () => toggleAudioTagVisibility(option.key),
                )}
              </View>
            );
          })}
          {renderSettingAction(text.resetTags, text.resetTagsDescription, () => setAudioTagVisibility(defaultAudioTagVisibility))}
        </View>
      );
    }

    return (
      <View style={styles.settingsList}>
        <View style={styles.settingRow}>
          <View style={styles.settingText}>
            <Text style={styles.settingTitle}>{text.storageUsed}</Text>
            <Text style={styles.settingDescription}>{formatStorageSize(localStorageBytes)}</Text>
          </View>
        </View>
        {renderSettingSwitch(text.confirmDelete, text.confirmDeleteDescription, confirmBeforeDeletingLocalTracks, setConfirmBeforeDeletingLocalTracks)}
        {renderSettingAction(text.rescanMetadata, text.rescanMetadataDescription, () => void refreshLocalLibrary(), localLibraryBusy)}
        {renderSettingAction(text.clearLocalQueue, text.clearLocalQueueDescription, () => setLocalQueueTrackIds([]), localQueueTrackIds.length === 0)}
        {renderSettingAction(text.clearRecent, text.clearRecentDescription, () => setRecentLocalTrackIds([]), recentLocalTrackIds.length === 0)}
      </View>
    );
  };
  const renderArtwork = (variant: 'default' | 'lyrics') => {
    const artworkSize = variant === 'lyrics' ? (isCompactPlayer ? 88 : 104) : playerCoverSize;
    return (
    <View
      style={[
        styles.artworkShell,
        { borderRadius: variant === 'lyrics' ? 24 : 34, height: artworkSize, width: artworkSize },
      ]}
    >
      <View style={styles.artworkFallback}>
        <Text style={[styles.artworkFallbackText, variant === 'lyrics' ? styles.artworkFallbackTextLyrics : null]}>
          ECHO
        </Text>
      </View>
      {stableArtworkUrl ? (
        <RNImage
          fadeDuration={0}
          onError={() => markArtworkUrlFailed(stableArtworkUrl)}
          onLoad={() => markArtworkUrlLoaded(stableArtworkUrl)}
          resizeMode="cover"
          source={{ uri: stableArtworkUrl }}
          style={[
            styles.artworkImage,
            artworkUrlHasLoaded(stableArtworkUrl) ? null : styles.artworkImageHidden,
          ]}
        />
      ) : null}
      {artworkUrlIsVisible(displayArtworkUrl) && displayArtworkUrl !== stableArtworkUrl ? (
        <RNImage
          fadeDuration={0}
          onError={() => markArtworkUrlFailed(displayArtworkUrl)}
          onLoad={() => markArtworkUrlLoaded(displayArtworkUrl)}
          resizeMode="cover"
          source={{ uri: displayArtworkUrl }}
          style={[styles.artworkImage, styles.artworkImageHidden]}
        />
      ) : null}
    </View>
    );
  };
  const renderConnectionChip = (variant: 'floating' | 'inline') => (
    <View style={[
      styles.playerConnectionChip,
      variant === 'inline' ? styles.playerConnectionChipInline : null,
      echoConnectionBroken ? styles.playerConnectionChipError : null,
    ]}>
      <Text style={[
        styles.playerConnectionKicker,
        echoConnectionBroken ? styles.playerConnectionKickerError : null,
      ]}>ECHO</Text>
      <View style={styles.playerConnectionStatusRow}>
        <View style={[
          styles.statusDot,
          echoConnectionOnline ? styles.statusDotOnline : null,
          echoConnectionBroken ? styles.statusDotError : null,
        ]} />
        <Text style={[
          styles.playerConnectionText,
          echoConnectionBroken ? styles.playerConnectionTextError : null,
        ]}>{connectedLabel}</Text>
      </View>
      <Text style={[
        styles.playerConnectionDetail,
        echoConnectionBroken ? styles.playerConnectionDetailError : null,
      ]} numberOfLines={1}>{playerConnectionDetail}</Text>
    </View>
  );
  const renderProgressScrubber = (compact = false) => (
    <View style={compact ? styles.compactProgressShell : null}>
      <View
        style={[styles.sliderTouchArea, compact ? styles.compactSliderTouchArea : null]}
        onLayout={handleProgressLayout}
        onStartShouldSetResponderCapture={() => Boolean((client || isDeviceOutput) && playbackDurationMs)}
        onStartShouldSetResponder={() => Boolean((client || isDeviceOutput) && playbackDurationMs)}
        onMoveShouldSetResponder={() => Boolean((client || isDeviceOutput) && playbackDurationMs)}
        onResponderGrant={(event) => {
          beginSliderInteraction();
          updateSeekFromGesture(event, false);
        }}
        onResponderMove={(event) => {
          beginSliderInteraction();
          updateSeekFromGesture(event, false);
        }}
        onResponderRelease={(event) => {
          updateSeekFromGesture(event, true);
          endSliderInteraction();
        }}
        onResponderTerminationRequest={() => false}
        onResponderTerminate={(event) => {
          updateSeekFromGesture(event, true);
          endSliderInteraction();
        }}
      >
        <View style={[styles.progressTrack, compact ? styles.compactProgressTrack : null]}>
          <View style={[styles.progressFill, { width: `${progressRatio * 100}%` }]} />
        </View>
      </View>
      <View style={compact ? styles.compactTimeRow : styles.timeRow}>
        <Text style={styles.progressText}>{displayTrack ? formatTime(playbackPositionMs) : '0:00'}</Text>
        <Text style={styles.progressText}>{displayTrack ? formatTime(playbackDurationMs) : '0:00'}</Text>
      </View>
    </View>
  );
  const renderVolumeSlider = (compact = false) => (
    <View
      style={[styles.sliderTouchArea, compact ? styles.compactSliderTouchArea : null]}
      onLayout={handleVolumeLayout}
      onStartShouldSetResponderCapture={() => Boolean(client || isDeviceOutput)}
      onStartShouldSetResponder={() => Boolean(client || isDeviceOutput)}
      onMoveShouldSetResponder={() => Boolean(client || isDeviceOutput)}
      onResponderGrant={(event) => {
        beginSliderInteraction();
        updateVolumeFromGesture(event, false);
      }}
      onResponderMove={(event) => {
        beginSliderInteraction();
        updateVolumeFromGesture(event, false);
      }}
      onResponderRelease={(event) => {
        updateVolumeFromGesture(event, true);
        endSliderInteraction();
      }}
      onResponderTerminationRequest={() => false}
      onResponderTerminate={(event) => {
        updateVolumeFromGesture(event, true);
        endSliderInteraction();
      }}
    >
      <View style={[styles.volumeTrack, compact ? styles.compactVolumeTrack : null]}>
        <View style={[styles.volumeFill, { width: `${volumePercent}%` }]} />
      </View>
    </View>
  );
  const renderExpandableVolume = () => (
    <View style={styles.compactVolumeShell}>
      <Pressable
        accessibilityLabel={volumeExpanded ? text.collapseVolume : text.expandVolume}
        accessibilityRole="button"
        onPress={() => setVolumeExpanded((current) => !current)}
        style={[styles.volumeMiniButton, volumeExpanded ? styles.volumeMiniButtonActive : null]}
      >
        {renderButtonBlur(20)}
        <AnimatedButtonContent motionKey={volumeExpanded} style={styles.buttonMotionRow}>
          <SuperconIcon glyph="headphones" size={13} color="rgba(248, 250, 252, 0.58)" />
          <Text style={styles.volumeMiniValue}>{volumePercent}%</Text>
        </AnimatedButtonContent>
      </Pressable>
      {volumeExpanded ? (
        <Animated.View style={[styles.volumeExpandedPanel, volumeExpandedAnimatedStyle]}>
          <View style={styles.volumeExpandedSlider}>
            {renderVolumeSlider(true)}
          </View>
          <Text style={styles.volumeExpandedValue}>{volumePercent}%</Text>
        </Animated.View>
      ) : null}
    </View>
  );
  const renderEqPresetButton = (option: (typeof eqPresetOptions)[number]) => {
    const active = option.key === eqPreset;
    const label = languageIsEnglish ? option.labelEn : option.labelZh;
    return (
      <Pressable
        accessibilityLabel={`${text.eq} ${label}`}
        accessibilityRole="button"
        key={option.key}
        onPress={() => setEqPreset(option.key)}
        style={[styles.eqPresetButton, active ? styles.eqPresetButtonActive : null]}
      >
        {renderButtonBlur(active ? 10 : 20)}
        <Text style={[styles.eqPresetText, active ? styles.eqPresetTextActive : null]}>{label}</Text>
      </Pressable>
    );
  };
  const renderEqPanel = () => (
    eqPanelOpen ? (
      <Animated.View style={[styles.eqPanel, volumeExpandedAnimatedStyle]}>
        <View style={styles.eqPanelHeader}>
          <View>
            <Text style={styles.eqPanelTitle}>{text.eq}</Text>
            <Text style={styles.eqPanelDescription} numberOfLines={2}>
              {isDeviceOutput
                ? (languageIsEnglish ? currentEqOption?.descriptionEn : currentEqOption?.descriptionZh)
                : text.eqUnavailable}
            </Text>
          </View>
          <Text style={styles.eqPanelBadge}>{languageIsEnglish ? currentEqOption?.labelEn : currentEqOption?.labelZh}</Text>
        </View>
        <View style={styles.eqCurveRow}>
          {currentEqOption?.gains.map((gain, index) => (
            <View key={`${eqPreset}-${index}`} style={styles.eqBand}>
              <View style={styles.eqBandRail}>
                <View
                  style={[
                    styles.eqBandFill,
                    {
                      height: `${Math.max(10, Math.min(100, 50 + gain * 8))}%`,
                    },
                  ]}
                />
              </View>
            </View>
          ))}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.eqPresetRow}>
          {eqPresetOptions.map(renderEqPresetButton)}
        </ScrollView>
        {loudnessNormalizationEnabled ? (
          <Text style={styles.eqHint}>{text.loudnessEnabled}</Text>
        ) : null}
      </Animated.View>
    ) : null
  );
  const renderTransportControls = (lyricsMode = false) => (
    <View style={[styles.transportRow, lyricsMode ? styles.lyricsTransportRow : null]}>
      <Pressable
        accessibilityLabel={text.previousTrack}
        accessibilityRole="button"
        style={[styles.roundButton, lyricsMode ? styles.roundButtonLyrics : null]}
        onPress={playPrevious}
        disabled={!client && !isDeviceOutput}
      >
        {renderButtonBlur(24)}
        <SuperconIcon glyph="view-back" size={lyricsMode ? 31 : 25} color="#f8fafc" />
      </Pressable>
      <Pressable
        accessibilityLabel={isPlaybackActive ? text.pausePlayback : text.startPlayback}
        accessibilityRole="button"
        style={[styles.playButton, lyricsMode ? styles.playButtonLyrics : null]}
        onPress={togglePlayPause}
        disabled={!client && !isDeviceOutput}
      >
        {renderButtonBlur(14)}
        <AnimatedButtonContent motionKey={`${lyricsMode}-${isPlaybackActive}`} style={styles.buttonMotionCenter}>
          <SuperconIcon
            glyph={isPlaybackActive ? 'pause-circle' : 'play-circle'}
            size={lyricsMode ? 48 : 44}
            color="#101014"
          />
        </AnimatedButtonContent>
      </Pressable>
      <Pressable
        accessibilityLabel={text.nextTrack}
        accessibilityRole="button"
        style={[styles.roundButton, lyricsMode ? styles.roundButtonLyrics : null]}
        onPress={playNext}
        disabled={!client && !isDeviceOutput}
      >
        {renderButtonBlur(24)}
        <SuperconIcon glyph="view-forward" size={lyricsMode ? 31 : 25} color="#f8fafc" />
      </Pressable>
    </View>
  );
  const renderLyricsHeader = () => (
    <View style={styles.lyricsTopBar}>
      {renderArtwork('lyrics')}
      <View style={styles.lyricsHeroText}>
        <Text style={[styles.trackTitleLyrics, { fontSize: playerTitleSize }]} numberOfLines={2}>
          {displayTrack?.title ?? text.noTrack}
        </Text>
        <Text style={[
          styles.lyricsConnectionText,
          echoConnectionBroken ? styles.lyricsConnectionTextError : null,
        ]} numberOfLines={1}>
          {connectedLabel}
        </Text>
        <View style={[styles.playbackTagRow, styles.playbackTagRowLyrics]}>
          {playbackTags.map((tag) => (
            <Text key={tag} style={[styles.playbackTag, styles.playbackTagDark]}>{tag}</Text>
          ))}
        </View>
      </View>
      <Pressable
        accessibilityLabel={text.closeLyrics}
        accessibilityRole="button"
        onPress={() => setLyricsVisible(false)}
        style={styles.lyricsCloseButton}
      >
        {renderButtonBlur(18)}
        <SuperconIcon glyph="view-close" size={22} color="#f8fafc" />
      </Pressable>
    </View>
  );
  const renderSecondaryControls = (compact = false) => (
    <View style={[styles.secondaryControlsRow, compact ? styles.secondaryControlsRowCompact : null]}>
      <Pressable
        accessibilityLabel={repeatOneEnabled ? text.closeRepeatOne : text.openRepeatOne}
        accessibilityRole="button"
        onPress={() => setRepeatOneEnabled((current) => !current)}
        style={[styles.repeatButton, compact ? styles.repeatButtonCompact : null, repeatOneEnabled ? styles.repeatButtonActive : null]}
      >
        {renderButtonBlur(repeatOneEnabled ? 10 : 22)}
        <AnimatedButtonContent motionKey={`${compact}-${repeatOneEnabled}`} style={styles.buttonMotionCenter}>
          <SuperconIcon
            glyph="view-reload"
            size={compact ? 18 : 21}
            color={repeatOneEnabled ? '#ffffff' : '#f8fafc'}
          />
        </AnimatedButtonContent>
        {repeatOneEnabled ? (
          <Text style={styles.repeatButtonBadge}>1</Text>
        ) : null}
      </Pressable>
      <Pressable
        accessibilityLabel={lyricsVisible ? text.closeLyrics : text.openLyrics}
        accessibilityRole="button"
        onPress={() => setLyricsVisible((current) => !current)}
        style={[styles.lyricsButton, compact ? styles.lyricsButtonCompact : null, lyricsVisible ? styles.lyricsButtonActive : null]}
      >
        {renderButtonBlur(lyricsVisible ? 10 : 22)}
        <AnimatedButtonContent motionKey={`${compact}-${lyricsVisible}`} style={styles.buttonMotionCenter}>
          <Text style={[styles.lyricsButtonText, lyricsVisible ? styles.lyricsButtonTextActive : null]}>词</Text>
        </AnimatedButtonContent>
      </Pressable>
      <Pressable
        accessibilityLabel={playlistOpen ? text.closePlaylistPreview : text.openPlaylistPreview}
        accessibilityRole="button"
        onPress={() => setPlaylistOpen((current) => !current)}
        style={[styles.playlistMiniButton, compact ? styles.playlistMiniButtonCompact : null, playlistOpen ? styles.playlistMiniButtonActive : null]}
      >
        {renderButtonBlur(22)}
        <AnimatedButtonContent motionKey={`${compact}-${playlistOpen}`} style={styles.buttonMotionRow}>
          <SuperconIcon glyph="list" size={16} color="#f8fafc" />
          <Text style={styles.playlistMiniCount}>{playlistItems.length}</Text>
        </AnimatedButtonContent>
      </Pressable>
      <Pressable
        accessibilityLabel={eqPanelOpen ? text.closeEqPanel : text.openEqPanel}
        accessibilityRole="button"
        onPress={() => setEqPanelOpen((current) => !current)}
        style={[styles.lyricsButton, compact ? styles.lyricsButtonCompact : null, eqPanelOpen ? styles.lyricsButtonActive : null]}
      >
        {renderButtonBlur(eqPanelOpen ? 10 : 22)}
        <AnimatedButtonContent motionKey={`${compact}-${eqPanelOpen}`} style={styles.buttonMotionCenter}>
          <Text style={[styles.lyricsButtonText, eqPanelOpen ? styles.lyricsButtonTextActive : null]}>EQ</Text>
        </AnimatedButtonContent>
      </Pressable>
      {compact ? null : renderExpandableVolume()}
    </View>
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}>
        <View style={styles.pageShell} {...pagePanResponder.panHandlers}>
          <ScrollView
            contentContainerStyle={[
              styles.content,
              page === 'control' ? styles.playerContent : null,
              page === 'control' && lyricsVisible ? styles.playerContentLyrics : null,
            ]}
            alwaysBounceVertical={page !== 'control'}
            automaticallyAdjustKeyboardInsets={false}
            bounces={page !== 'control'}
            keyboardShouldPersistTaps="handled"
            refreshControl={page === 'control' ? undefined : <RefreshControl refreshing={pullRefreshing} onRefresh={() => void refreshFromPull()} tintColor="#18181b" />}
            scrollEnabled={page !== 'control' || lyricsVisible || volumeExpanded}
          >
            <Animated.View style={[styles.pageTransition, pageAnimatedStyle]}>
            {page !== 'control' ? (
              <View style={styles.header}>
                <Text style={styles.title}>{pageTitle}</Text>
                {page === 'connect' ? (
                  <View style={styles.connectHeaderSwitch}>
                    {renderSegmentOptions<ConnectPanelMode>(connectPanelOptions, connectPanelMode, (value) => {
                      setConnectPanelMode(value);
                      if (value === 'streaming') {
                        showErrorAlert(text.streamingServices, text.streamingComingSoon, 'streaming-coming-soon');
                      }
                    })}
                  </View>
                ) : page === 'settings' ? (
                  <Text style={styles.description}>{text.settingsDescription}</Text>
                ) : null}
                <View style={[
                  styles.statusPill,
                  echoConnectionOnline ? styles.statusPillOnline : null,
                  echoConnectionBroken ? styles.statusPillError : null,
                ]}>
                  <View style={[
                    styles.statusDot,
                    echoConnectionOnline ? styles.statusDotOnline : null,
                    echoConnectionBroken ? styles.statusDotError : null,
                  ]} />
                  <Text style={[
                    styles.statusPillText,
                    echoConnectionOnline ? styles.statusPillTextOnline : null,
                    echoConnectionBroken ? styles.statusPillTextError : null,
                  ]}>{connectedLabel}</Text>
                </View>
              </View>
            ) : null}

            {page === 'connect' ? (
              <View style={styles.connectPage}>
                {connectPanelMode === 'streaming' ? (
                  <View style={styles.connectPanel}>
                    <Text style={styles.cardEyebrow}>{text.streamingServices}</Text>
                    <Text style={styles.cardTitle}>{text.streamingComingSoon}</Text>
                    <Text style={styles.hint}>{text.streamingReserved}</Text>
                  </View>
                ) : (
                  <>
                    <View style={styles.connectPanel}>
                      <Text style={styles.cardEyebrow}>EchoLink</Text>
                      <Text style={styles.cardTitle}>{text.echoConnection}</Text>
                      {renderSettingSwitch(text.echoConnectionEnabled, text.echoConnectionDescription, echoConnectionEnabled, setEchoConnectionEnabled)}
                    </View>

                    <View style={styles.connectHero}>
                      <BlurView intensity={28} pointerEvents="none" style={styles.playerCardBlur} tint="dark" />
                      <Text style={styles.connectHeroKicker}>EchoLink</Text>
                      <Text style={styles.connectHeroTitle}>{connectedLabel}</Text>
                      <View style={styles.connectMetricRow}>
                        <View style={styles.connectMetric}>
                          <Text style={styles.connectMetricValue} numberOfLines={1}>{connection.host || '--'}</Text>
                          <Text style={styles.connectMetricLabel}>{text.host}</Text>
                        </View>
                        <View style={styles.connectMetric}>
                          <Text style={styles.connectMetricValue}>{tracks.length}</Text>
                          <Text style={styles.connectMetricLabel}>{text.library}</Text>
                        </View>
                        <View style={styles.connectMetric}>
                          <Text style={styles.connectMetricValue}>{streamableTrackCount}</Text>
                          <Text style={styles.connectMetricLabel}>{text.streamable}</Text>
                        </View>
                      </View>
                    </View>

                    <View style={styles.connectPanel}>
                      <Text style={styles.cardEyebrow}>{text.pairLink}</Text>
                      <Text style={styles.cardTitle}>{text.pairLink}</Text>
                      <TextInput
                        value={pairingText}
                        onChangeText={setPairingText}
                        placeholder="echo://pair?host=192.168.1.12&port=26789&token=..."
                        placeholderTextColor="#a8a29e"
                        autoCapitalize="none"
                        autoCorrect={false}
                        multiline
                        style={[styles.input, styles.pairingInput]}
                      />
                      <Pressable
                        accessibilityLabel={text.connectWithPairingA11y}
                        accessibilityRole="button"
                        style={styles.primaryButton}
                        onPress={() => void applyPairingText()}
                      >
                        {renderButtonBlur(12)}
                        <SuperconIcon glyph="external" size={16} color="#08110b" />
                        <Text style={styles.primaryButtonText}>{text.connect}</Text>
                      </Pressable>
                    </View>

                    <View style={styles.connectPanel}>
                      <Text style={styles.cardEyebrow}>{text.manual}</Text>
                      <Text style={styles.cardTitle}>{text.manual}</Text>
                      <TextInput
                        value={connection.host}
                        onChangeText={(host) => setConnection((current) => ({ ...current, host }))}
                        placeholder={text.manualHostPlaceholder}
                        placeholderTextColor="#a8a29e"
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={styles.input}
                      />
                      <TextInput
                        value={String(connection.port)}
                        onChangeText={(port) => setConnection((current) => ({ ...current, port: Number(port) || 26789 }))}
                        placeholder={text.portPlaceholder}
                        placeholderTextColor="#a8a29e"
                        keyboardType="number-pad"
                        style={styles.input}
                      />
                      <TextInput
                        value={connection.token}
                        onChangeText={(token) => setConnection((current) => ({ ...current, token }))}
                        placeholder="Token"
                        placeholderTextColor="#a8a29e"
                        autoCapitalize="none"
                        autoCorrect={false}
                        secureTextEntry
                        style={styles.input}
                      />
                      <View style={styles.buttonRow}>
                        <Pressable
                          accessibilityLabel={text.saveManualConnectionA11y}
                          accessibilityRole="button"
                          style={styles.secondaryButton}
                          onPress={() => void saveManualConnection()}
                        >
                          {renderButtonBlur(24)}
                          <SuperconIcon glyph="checkmark" size={15} color="#f8fafc" />
                          <Text style={styles.secondaryButtonText}>{text.save}</Text>
                        </Pressable>
                        <Pressable
                          accessibilityLabel={text.testComputerConnectionA11y}
                          accessibilityRole="button"
                          style={styles.secondaryButton}
                          onPress={() => void refresh()}
                          disabled={!client || busy}
                        >
                          {renderButtonBlur(24)}
                          <AnimatedButtonContent motionKey={`test-${busy}`} style={styles.buttonMotionRow}>
                            <SuperconIcon glyph="view-reload" size={15} color="#f8fafc" />
                            <Text style={styles.secondaryButtonText}>{busy ? text.testing : text.test}</Text>
                          </AnimatedButtonContent>
                        </Pressable>
                      </View>
                    </View>
                  </>
                )}
              </View>
            ) : page === 'library' ? (
              <View style={styles.libraryPage}>
                <View style={styles.libraryHero}>
                  <Text style={styles.connectHeroKicker}>Library</Text>
                  <Text style={styles.libraryHeroTitle}>{activeLibraryTotal} 首</Text>
                </View>
                <View style={styles.libraryFilterRow}>
                  {([
                    ['echo', `${text.echoLibrary} ${tracks.length}`],
                    ['local', `${text.localLibrary} ${localTracks.length}`],
                  ] as const).map(([value, label]) => (
                    <Pressable
                      accessibilityLabel={`${text.switchLibraryPrefix}${label}${text.switchLibrarySuffix}`}
                      accessibilityRole="button"
                      key={value}
                      onPress={() => setLibrarySource(value)}
                      style={[styles.libraryFilterChip, librarySource === value ? styles.libraryFilterChipActive : null]}
                    >
                      {renderButtonBlur(librarySource === value ? 10 : 20)}
                      <AnimatedButtonContent motionKey={librarySource === value} style={styles.buttonMotionCenter}>
                        <Text style={[styles.libraryFilterText, librarySource === value ? styles.libraryFilterTextActive : null]}>{label}</Text>
                      </AnimatedButtonContent>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.librarySearchRow}>
                  <TextInput
                    value={query}
                    onChangeText={setQuery}
                    onSubmitEditing={() => {
                      if (librarySource === 'echo') {
                        void refresh();
                      }
                    }}
                    placeholder={text.searchPlaceholder}
                    placeholderTextColor="#9b9690"
                    style={[styles.input, styles.librarySearchInput]}
                  />
                  <Pressable
                    accessibilityLabel={librarySource === 'local' ? text.scan : text.sync}
                    accessibilityRole="button"
                    disabled={librarySource === 'local' ? localLibraryBusy : (!client || busy)}
                    onPress={() => {
                      if (librarySource === 'local') {
                        void refreshLocalLibrary();
                        return;
                      }
                      void refresh();
                    }}
                    style={styles.libraryRefreshButton}
                  >
                    {renderButtonBlur(24)}
                    <AnimatedButtonContent motionKey={`library-refresh-${librarySource}-${busy}-${localLibraryBusy}`} style={styles.buttonMotionRow}>
                      <SuperconIcon glyph="view-reload" size={15} color="#f8fafc" />
                      <Text style={styles.libraryRefreshText}>
                        {librarySource === 'local'
                          ? (localLibraryBusy ? text.scanning : text.scan)
                          : (busy ? text.syncing : text.sync)}
                      </Text>
                    </AnimatedButtonContent>
                  </Pressable>
                </View>
                {librarySource === 'local' ? (
                  <>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.localViewRow}>
                      {localLibraryViewOptions.map((value) => {
                        const label = labelForLocalLibraryView(value);
                        return (
                        <Pressable
                          accessibilityLabel={`${text.localLibrary} ${label}`}
                          accessibilityRole="button"
                          key={value}
                          onPress={() => setLocalLibraryView(value)}
                          style={[styles.localViewChip, localLibraryView === value ? styles.localViewChipActive : null]}
                        >
                          {renderButtonBlur(localLibraryView === value ? 10 : 20)}
                          <Text style={[styles.libraryFilterText, localLibraryView === value ? styles.libraryFilterTextActive : null]}>{label}</Text>
                        </Pressable>
                      );
                      })}
                    </ScrollView>
                    <View style={styles.buttonRow}>
                      <Pressable
                        accessibilityLabel={text.importLocalMusicA11y}
                        accessibilityRole="button"
                        disabled={localLibraryBusy}
                        onPress={() => void importLocalLibrary()}
                        style={styles.secondaryButton}
                      >
                        {renderButtonBlur(24)}
                        <AnimatedButtonContent motionKey={`import-${localLibraryBusy}`} style={styles.buttonMotionRow}>
                          <SuperconIcon glyph="external" size={15} color="#f8fafc" />
                          <Text style={styles.secondaryButtonText}>{localLibraryBusy ? '...' : text.importMusic}</Text>
                        </AnimatedButtonContent>
                      </Pressable>
                      <Pressable
                        accessibilityLabel={text.playFirstLocalMusicA11y}
                        accessibilityRole="button"
                        disabled={localTracks.length === 0}
                        onPress={switchToLocalPlayback}
                        style={styles.secondaryButton}
                      >
                        {renderButtonBlur(24)}
                        <SuperconIcon glyph="play-circle" size={16} color="#f8fafc" />
                      <Text style={styles.secondaryButtonText}>{text.localPlay}</Text>
                      </Pressable>
                    </View>
                  </>
                ) : (
                  <View style={styles.libraryFilterRow}>
                    {([
                      ['all', `${text.all} ${tracks.length}`],
                      ['streamable', `${text.streamable} ${streamableTrackCount}`],
                      ['local', `${text.pcLocal} ${pcLocalTrackCount}`],
                    ] as const).map(([value, label]) => (
                      <Pressable
                        accessibilityLabel={`${text.filterA11y}${label}`}
                        accessibilityRole="button"
                        key={value}
                        onPress={() => setLibraryFilter(value)}
                        style={[styles.libraryFilterChip, libraryFilter === value ? styles.libraryFilterChipActive : null]}
                      >
                        {renderButtonBlur(libraryFilter === value ? 10 : 20)}
                        <AnimatedButtonContent motionKey={libraryFilter === value} style={styles.buttonMotionCenter}>
                          <Text style={[styles.libraryFilterText, libraryFilter === value ? styles.libraryFilterTextActive : null]}>{label}</Text>
                        </AnimatedButtonContent>
                      </Pressable>
                    ))}
                  </View>
                )}

                <View style={styles.libraryList}>
                  {activeLibraryTracks.length > 0 ? activeLibraryTracks.map((item, index) => {
                    const localItem = item as LocalMusicTrack;
                    const previousLocalItem = activeLibraryTracks[index - 1] as LocalMusicTrack | undefined;
                    const groupLabel = librarySource === 'local' ? localGroupLabel(localItem) : null;
                    const previousGroupLabel = librarySource === 'local' && previousLocalItem ? localGroupLabel(previousLocalItem) : null;
                    const showGroupHeader = Boolean(groupLabel && groupLabel !== previousGroupLabel);
                    const isFavorite = librarySource === 'local' && favoriteLocalTrackIdSet.has(item.id);
                    const itemArtworkUrl = resolveArtworkUrl(item.artworkUrl);
                    const itemArtworkVisible = artworkUrlIsVisible(itemArtworkUrl);
                    return (
                      <View key={item.id} style={styles.trackRowShell}>
                        {showGroupHeader ? (
                          <Text style={styles.localGroupHeader}>{groupLabel}</Text>
                        ) : null}
                        <Pressable
                          accessibilityLabel={`${librarySource === 'local' ? text.playLocalTrackA11y : isPhoneOutput && item.canPlayOnPhone ? text.streamToPhonePlayback : text.controlComputerPlayback} ${item.title}`}
                          accessibilityRole="button"
                          style={styles.trackRow}
                          onPress={() => {
                            if (librarySource === 'local') {
                              void playTrackOnLocal(localItem, 0);
                              return;
                            }
                            if (isPhoneOutput && item.canPlayOnPhone) {
                              void playTrackOnPhone(item, 0, false);
                              return;
                            }
                            playTrackOnPc(item);
                          }}
                        >
                          <View style={styles.libraryArtwork}>
                            <View style={styles.libraryArtworkFallback}>
                              <SuperconIcon glyph="waveform" size={20} color="rgba(248, 250, 252, 0.36)" />
                            </View>
                            {itemArtworkVisible ? (
                              <RNImage
                                fadeDuration={0}
                                onError={() => markArtworkUrlFailed(itemArtworkUrl)}
                                onLoad={() => markArtworkUrlLoaded(itemArtworkUrl)}
                                resizeMode="cover"
                                source={{ uri: itemArtworkUrl }}
                                style={[
                                  styles.libraryArtworkImage,
                                  artworkUrlHasLoaded(itemArtworkUrl) ? null : styles.artworkImageHidden,
                                ]}
                              />
                            ) : null}
                          </View>
                          <View style={styles.trackText}>
                            <Text style={styles.listTitle} numberOfLines={1}>{item.title}</Text>
                            <Text style={styles.listMeta} numberOfLines={1}>{item.artist}{librarySource === 'local' && localItem.hasLyrics ? ' · LRC' : ''}</Text>
                            <View style={styles.libraryTagRow}>
                              {tagsForTrack(item, { includeDuration: true, visibleAudioTags: audioTagVisibility }).map((tag) => (
                                <Text key={`${item.id}-${tag}`} style={styles.libraryTag}>{tag}</Text>
                              ))}
                            </View>
                          </View>
                          {librarySource === 'local' ? (
                            <View style={styles.localTrackActions}>
                              <Pressable
                                accessibilityLabel={isFavorite ? '取消收藏' : '收藏歌曲'}
                                accessibilityRole="button"
                                onPress={(event) => {
                                  event.stopPropagation();
                                  toggleLocalFavorite(localItem);
                                }}
                                style={[styles.localTrackActionButton, isFavorite ? styles.localTrackActionButtonActive : null]}
                              >
                                <Text style={[styles.localTrackActionText, isFavorite ? styles.localTrackActionTextActive : null]}>♥</Text>
                              </Pressable>
                              <Pressable
                                accessibilityLabel={text.addToQueue}
                                accessibilityRole="button"
                                onPress={(event) => {
                                  event.stopPropagation();
                                  addLocalTrackToQueue(localItem);
                                }}
                                style={styles.localTrackActionButton}
                              >
                              <Text style={styles.localTrackActionText}>＋</Text>
                              </Pressable>
                              <Pressable
                                accessibilityLabel={text.playNextA11y}
                                accessibilityRole="button"
                                onPress={(event) => {
                                  event.stopPropagation();
                                  playLocalTrackNext(localItem);
                                }}
                                style={styles.localTrackActionButton}
                              >
                                <Text style={styles.localTrackActionText}>{text.nextPlay}</Text>
                              </Pressable>
                              <Pressable
                                accessibilityLabel={text.importLyricsA11y}
                                accessibilityRole="button"
                                onPress={(event) => {
                                  event.stopPropagation();
                                  void importLyricsForLocalTrack(localItem);
                                }}
                                style={styles.localTrackActionButton}
                              >
                                <Text style={styles.localTrackActionText}>{text.importLyrics}</Text>
                              </Pressable>
                              <Pressable
                                accessibilityLabel={text.deleteLocalTrackA11y}
                                accessibilityRole="button"
                                onPress={(event) => {
                                  event.stopPropagation();
                                  deleteLocalTrack(localItem);
                                }}
                                style={styles.localTrackActionButton}
                              >
                                <Text style={styles.localTrackActionText}>{text.deleteAction}</Text>
                              </Pressable>
                            </View>
                          ) : (
                            <SuperconIcon glyph="play-circle" size={22} color="#22c55e" />
                          )}
                        </Pressable>
                      </View>
                    );
                  }) : (
                    <Text style={styles.hint}>
                      {librarySource === 'local'
                        ? text.emptyLocalLibrary
                        : text.emptyEchoLibrary}
                    </Text>
                  )}
                </View>
              </View>
            ) : page === 'settings' ? (
              <View style={styles.settingsPage}>
                <View style={styles.settingsPanel}>
                  <Text style={styles.cardEyebrow}>{text.settingsCenter}</Text>
                  <Text style={styles.cardTitle}>{text.chooseCategory}</Text>
                  <Text style={styles.hint}>{text.settingsDescription}</Text>
                </View>

                <View style={styles.settingsSectionList}>
                  {settingsSections.map((section) => {
                    const expanded = openSettingsSection === section.key;
                    return (
                      <View key={section.key} style={[styles.settingsSectionCard, expanded ? styles.settingsSectionCardOpen : null]}>
                        <Pressable
                          accessibilityLabel={section.title}
                          accessibilityRole="button"
                          onPress={() => toggleSettingsSection(section.key)}
                          style={styles.settingsSectionHeader}
                        >
                          <View style={styles.settingText}>
                            <Text style={styles.settingTitle}>{section.title}</Text>
                            <Text style={styles.settingDescription}>{section.description}</Text>
                          </View>
                          <View style={styles.settingsSectionMeta}>
                            <Text style={styles.settingsSectionSummary} numberOfLines={1}>{section.summary}</Text>
                            <AnimatedButtonContent motionKey={expanded} style={styles.buttonMotionCenter}>
                              <Text style={styles.settingsChevron}>{expanded ? '−' : '+'}</Text>
                            </AnimatedButtonContent>
                          </View>
                        </Pressable>
                        {expanded ? (
                          <SettingsReveal motionKey={section.key}>
                            {renderSettingsBody(section.key)}
                          </SettingsReveal>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              </View>
            ) : (
              <>
                <View
                  style={[
                    styles.playerCard,
                    { gap: playerShellGap, padding: playerShellPadding },
                    lyricsVisible ? styles.playerCardLyrics : null,
                  ]}
                >
                  <BlurView intensity={32} pointerEvents="none" style={styles.playerCardBlur} tint="dark" />
                  {lyricsVisible ? (
                    <Animated.View style={[styles.lyricsMode, lyricsPanelAnimatedStyle]}>
                      {renderLyricsHeader()}

                      <View
                        style={[styles.lyricsViewport, { height: lyricsViewportTargetHeight }]}
                      >
                        <ScrollView
                          contentContainerStyle={styles.lyricsScrollContent}
                          ref={lyricsScrollRef}
                          showsVerticalScrollIndicator={false}
                        >
                          {lyricLines.map((line, index) => {
                            const isActive = index === activeLyricIndex;
                            const distance = Math.abs(index - activeLyricIndex);
                            return (
                              <Pressable
                                accessibilityLabel={line.timeMs === null ? line.text : `跳转到 ${formatTime(line.timeMs)}：${line.text}`}
                                accessibilityRole={line.timeMs === null ? undefined : 'button'}
                                disabled={line.timeMs === null}
                                key={line.id}
                                onLayout={(event) => {
                                  lyricLineLayoutsRef.current[line.id] = event.nativeEvent.layout;
                                }}
                                onPress={() => seekToLyric(line)}
                                style={styles.lyricLineButton}
                              >
                                <Text
                                  numberOfLines={2}
                                  style={[
                                    styles.lyricLineText,
                                    distance === 1 ? styles.lyricLineTextNear : null,
                                    distance > 1 ? styles.lyricLineTextFar : null,
                                    isActive ? styles.lyricLineTextActive : null,
                                  ]}
                                >
                                  {line.text}
                                </Text>
                                {line.timeMs !== null && !isActive ? (
                                  <Text style={styles.lyricTimestamp}>{formatTime(line.timeMs)}</Text>
                                ) : null}
                              </Pressable>
                            );
                          })}
                        </ScrollView>
                      </View>

                      <View style={styles.lyricsControlPanel}>
                        <View style={styles.compactControlRow}>
                          {renderProgressScrubber(true)}
                          {renderExpandableVolume()}
                        </View>
                        {renderTransportControls(true)}
                        {renderSecondaryControls(true)}
                        {renderEqPanel()}
                      </View>
                    </Animated.View>
                  ) : (
                    <Animated.View style={[styles.defaultPlayerMode, defaultPlayerAnimatedStyle]}>
                      <View style={styles.playerStatusBar}>
                        <View style={styles.playerStatusLeft}>
                          <Text style={styles.cardEyebrow}>{text.nowPlaying}</Text>
                          <Text style={styles.playerStatusText} numberOfLines={1}>{playbackModeLabel}</Text>
                        </View>
                        {renderConnectionChip('inline')}
                      </View>
                      <View style={styles.artworkStage}>
                        {showArtworkGlow ? <View style={styles.artworkGlow} /> : null}
                        {renderArtwork('default')}
                      </View>
                      <View style={styles.trackInfoPanel}>
                        <Text style={[styles.trackTitle, { fontSize: playerTitleSize }]} numberOfLines={2}>{displayTrack?.title ?? text.noTrack}</Text>
                        <View style={styles.playbackTagRow}>
                          {playbackTags.map((tag) => (
                            <Text key={tag} style={styles.playbackTag}>{tag}</Text>
                          ))}
                        </View>
                      </View>
                      <View style={styles.playerControlDeck}>
                        {renderProgressScrubber()}
                        {renderTransportControls()}
                        {renderSecondaryControls()}
                        {renderEqPanel()}
                      </View>

                      {renderOutputSwitch()}
                    </Animated.View>
                  )}
                </View>
              </>
            )}
            </Animated.View>
          </ScrollView>

          {page === 'control' && playlistVisible ? (
            <View style={styles.playlistOverlay} pointerEvents="box-none">
              <Animated.View style={[styles.playlistBackdrop, playlistBackdropAnimatedStyle]}>
                <Pressable
                  accessibilityLabel={text.closePlaylistPreview}
                  accessibilityRole="button"
                  onPress={() => setPlaylistOpen(false)}
                  style={styles.playlistBackdropPressable}
                />
              </Animated.View>
              <Animated.View style={[styles.playlistPopover, playlistPopoverAnimatedStyle]}>
                <View style={styles.playlistPopoverHeader}>
                  <View>
                    <Text style={styles.playlistPopoverEyebrow}>{text.queue}</Text>
                    <Text style={styles.playlistPopoverTitle}>{text.playlist}</Text>
                  </View>
                  <View style={styles.playlistHeaderActions}>
                    {isLocalOutput && localQueueTrackIds.length > 0 ? (
                      <Pressable
                        accessibilityLabel={text.clearLocalQueue}
                        accessibilityRole="button"
                        onPress={() => setLocalQueueTrackIds([])}
                        style={styles.playlistSmallButton}
                      >
                        <Text style={styles.playlistSmallButtonText}>{text.clear}</Text>
                      </Pressable>
                    ) : null}
                    <Pressable
                      accessibilityLabel={text.closePlaylist}
                      accessibilityRole="button"
                      onPress={() => setPlaylistOpen(false)}
                      style={styles.playlistCloseButton}
                    >
                      <SuperconIcon glyph="view-close-small" size={19} color="#f8fafc" />
                    </Pressable>
                  </View>
                </View>
                <View style={styles.playlistPopoverList}>
                  {visiblePlaylistItems.length > 0 ? visiblePlaylistItems.map((item, index) => {
                    const isCurrentTrack = item.id === playbackQueue?.currentTrackId || item.id === displayTrack?.id;
                    const localItem = item as LocalMusicTrack;
                    return (
                      <Pressable
                        accessibilityLabel={`${text.playlistItemPrefix} ${index + 1}: ${item.title}`}
                        accessibilityRole="button"
                        key={`${item.id}-${index}`}
                        onPress={() => {
                          setPlaylistOpen(false);
                          if (isLocalOutput) {
                            void playTrackOnLocal(item as LocalMusicTrack, 0);
                            return;
                          }
                          if (isPhoneOutput) {
                            void playTrackOnPhone(item, 0, false);
                            return;
                          }
                          playTrackOnPc(item);
                        }}
                        style={[styles.playlistItem, isCurrentTrack ? styles.playlistItemActive : null]}
                      >
                        <Text style={[styles.playlistIndex, isCurrentTrack ? styles.playlistIndexActive : null]}>
                          {String(index + 1).padStart(2, '0')}
                        </Text>
                        <View style={styles.playlistText}>
                          <Text style={[styles.playlistTitle, isCurrentTrack ? styles.playlistTitleActive : null]} numberOfLines={1}>
                            {item.title}
                          </Text>
                          <Text style={styles.playlistMeta} numberOfLines={1}>
                            {item.artist} · {item.album || item.sourceLabel}
                          </Text>
                        </View>
                        {isLocalOutput && localQueueTrackIds.length > 0 ? (
                          <View style={styles.localQueueControls}>
                            <Pressable
                              accessibilityLabel={text.moveUp}
                              accessibilityRole="button"
                              disabled={index === 0}
                              onPress={(event) => {
                                event.stopPropagation();
                                moveLocalQueueTrack(localItem, -1);
                              }}
                              style={styles.localQueueButton}
                            >
                              <Text style={styles.localQueueButtonText}>↑</Text>
                            </Pressable>
                            <Pressable
                              accessibilityLabel={text.moveDown}
                              accessibilityRole="button"
                              disabled={index >= playlistItems.length - 1}
                              onPress={(event) => {
                                event.stopPropagation();
                                moveLocalQueueTrack(localItem, 1);
                              }}
                              style={styles.localQueueButton}
                            >
                              <Text style={styles.localQueueButtonText}>↓</Text>
                            </Pressable>
                            <Pressable
                              accessibilityLabel={text.removeFromQueue}
                              accessibilityRole="button"
                              onPress={(event) => {
                                event.stopPropagation();
                                setLocalQueueTrackIds((current) => current.filter((id) => id !== item.id));
                              }}
                              style={styles.localQueueButton}
                            >
                              <Text style={styles.localQueueButtonText}>×</Text>
                            </Pressable>
                          </View>
                        ) : null}
                      </Pressable>
                    );
                  }) : (
                    <Text style={styles.playlistEmpty}>{text.queueEmpty}</Text>
                  )}
                </View>
                {hiddenPlaylistItemCount > 0 ? (
                  <Text style={styles.playlistMore}>
                    {languageIsEnglish ? `${hiddenPlaylistItemCount} ${text.moreInQueueSuffix}` : `还有 ${hiddenPlaylistItemCount} ${text.moreInQueueSuffix}`}
                  </Text>
                ) : null}
              </Animated.View>
            </View>
          ) : null}

          <View style={styles.dock} onLayout={handleDockLayout}>
            <BlurView intensity={34} pointerEvents="none" style={styles.dockBlur} tint="dark" />
            <Animated.View pointerEvents="none" style={[styles.dockActiveIndicator, dockIndicatorAnimatedStyle]}>
              {renderButtonBlur(16)}
            </Animated.View>
            <Pressable
              accessibilityLabel={text.playbackPage}
              accessibilityRole="button"
              style={styles.dockItem}
              onPress={() => switchPage('control')}
            >
              <AnimatedButtonContent motionKey={page === 'control'} style={styles.dockItemContent}>
                <SuperconIcon
                  glyph="headphones"
                  size={20}
                  color={page === 'control' ? '#f8fafc' : 'rgba(248, 250, 252, 0.5)'}
                />
                <Text style={[styles.dockLabel, page === 'control' ? styles.dockLabelActive : null]}>{text.playback}</Text>
              </AnimatedButtonContent>
            </Pressable>
            <Pressable
              accessibilityLabel={text.libraryPage}
              accessibilityRole="button"
              style={styles.dockItem}
              onPress={() => switchPage('library')}
            >
              <AnimatedButtonContent motionKey={page === 'library'} style={styles.dockItemContent}>
                <SuperconIcon
                  glyph="list"
                  size={20}
                  color={page === 'library' ? '#f8fafc' : 'rgba(248, 250, 252, 0.5)'}
                />
                <Text style={[styles.dockLabel, page === 'library' ? styles.dockLabelActive : null]}>{text.library}</Text>
              </AnimatedButtonContent>
            </Pressable>
            <Pressable
              accessibilityLabel={text.connectPage}
              accessibilityRole="button"
              style={styles.dockItem}
              onPress={() => switchPage('connect')}
            >
              <AnimatedButtonContent motionKey={page === 'connect'} style={styles.dockItemContent}>
                <SuperconIcon
                  glyph="link"
                  size={20}
                  color={page === 'connect' ? '#f8fafc' : 'rgba(248, 250, 252, 0.5)'}
                />
                <Text style={[styles.dockLabel, page === 'connect' ? styles.dockLabelActive : null]}>{text.connect}</Text>
              </AnimatedButtonContent>
            </Pressable>
            <Pressable
              accessibilityLabel={text.settingsPage}
              accessibilityRole="button"
              style={styles.dockItem}
              onPress={() => switchPage('settings')}
            >
              <AnimatedButtonContent motionKey={page === 'settings'} style={styles.dockItemContent}>
                <SuperconIcon
                  glyph="settings"
                  size={20}
                  color={page === 'settings' ? '#f8fafc' : 'rgba(248, 250, 252, 0.5)'}
                />
                <Text style={[styles.dockLabel, page === 'settings' ? styles.dockLabelActive : null]}>{text.settings}</Text>
              </AnimatedButtonContent>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default function App(): ReactElement {
  return (
    <AppErrorBoundary>
      <EchoLinkApp />
    </AppErrorBoundary>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#101014',
  },
  root: {
    flex: 1,
  },
  pageShell: {
    flex: 1,
  },
  content: {
    gap: 18,
    padding: 18,
    paddingBottom: 144,
  },
  pageTransition: {
    gap: 18,
    width: '100%',
  },
  glassButtonBlur: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  buttonMotionCenter: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonMotionExitLayer: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  buttonMotionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
  },
  buttonMotionShell: {
    position: 'relative',
  },
  playerContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingBottom: 94,
    paddingTop: 30,
  },
  playerContentLyrics: {
    justifyContent: 'center',
    paddingBottom: 96,
    paddingTop: 24,
  },
  header: {
    gap: 9,
    paddingHorizontal: 2,
    paddingTop: 18,
  },
  connectHeaderSwitch: {
    maxWidth: 360,
    width: '100%',
  },
  kicker: {
    color: '#8b8b86',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.7,
    textTransform: 'uppercase',
  },
  title: {
    color: '#f8fafc',
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: -0.8,
  },
  description: {
    color: 'rgba(248, 250, 252, 0.62)',
    fontSize: 15,
    lineHeight: 23,
    maxWidth: 330,
  },
  statusPill: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 13,
    paddingVertical: 7,
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.06,
    shadowRadius: 18,
  },
  statusPillOnline: {
    backgroundColor: 'rgba(34, 197, 94, 0.16)',
    borderColor: 'rgba(34, 197, 94, 0.28)',
  },
  statusPillError: {
    backgroundColor: 'rgba(127, 29, 29, 0.28)',
    borderColor: 'rgba(248, 113, 113, 0.34)',
  },
  statusDot: {
    backgroundColor: '#a1a1aa',
    borderRadius: 999,
    height: 7,
    width: 7,
  },
  statusDotOnline: {
    backgroundColor: '#22c55e',
  },
  statusDotError: {
    backgroundColor: '#dc2626',
  },
  statusPillText: {
    color: 'rgba(248, 250, 252, 0.58)',
    fontSize: 12,
    fontWeight: '800',
  },
  statusPillTextOnline: {
    color: '#bbf7d0',
  },
  statusPillTextError: {
    color: '#dc2626',
  },
  card: {
    backgroundColor: 'rgba(255, 255, 255, 0.72)',
    borderColor: 'rgba(39, 39, 42, 0.08)',
    borderRadius: 24,
    borderWidth: 1,
    gap: 12,
    padding: 16,
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.07,
    shadowRadius: 24,
  },
  section: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 28,
    borderWidth: 1,
    gap: 12,
    padding: 16,
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.055,
    shadowRadius: 28,
  },
  cardEyebrow: {
    color: '#8a8178',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  cardTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '800',
  },
  hint: {
    color: 'rgba(248, 250, 252, 0.58)',
    fontSize: 13,
    lineHeight: 19,
  },
  input: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderColor: 'rgba(255, 255, 255, 0.14)',
    borderRadius: 18,
    borderWidth: 1,
    color: '#f8fafc',
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.035,
    shadowRadius: 14,
  },
  pairingInput: {
    minHeight: 84,
    textAlignVertical: 'top',
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#22c55e',
    borderRadius: 18,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 48,
    overflow: 'hidden',
    paddingHorizontal: 16,
    paddingVertical: 13,
    position: 'relative',
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.16,
    shadowRadius: 22,
  },
  primaryButtonText: {
    color: '#08110b',
    fontSize: 15,
    fontWeight: '800',
  },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderColor: 'rgba(255, 255, 255, 0.14)',
    borderRadius: 18,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    minHeight: 46,
    overflow: 'hidden',
    paddingHorizontal: 12,
    paddingVertical: 12,
    position: 'relative',
  },
  secondaryButtonText: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '800',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  connectPage: {
    gap: 14,
  },
  connectHero: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.14)',
    borderRadius: 32,
    borderWidth: 1,
    gap: 8,
    overflow: 'hidden',
    padding: 18,
  },
  connectHeroKicker: {
    color: 'rgba(248, 250, 252, 0.58)',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.3,
    textTransform: 'uppercase',
  },
  connectHeroTitle: {
    color: '#f8fafc',
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: -0.7,
  },
  connectHeroText: {
    color: 'rgba(248, 250, 252, 0.64)',
    fontSize: 13,
    lineHeight: 20,
  },
  connectMetricRow: {
    flexDirection: 'row',
    gap: 8,
    paddingTop: 8,
  },
  connectMetric: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 18,
    borderWidth: 1,
    flex: 1,
    gap: 3,
    minHeight: 58,
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  connectMetricValue: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '900',
    minWidth: 0,
  },
  connectMetricLabel: {
    color: 'rgba(248, 250, 252, 0.5)',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  connectPanel: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 28,
    borderWidth: 1,
    gap: 12,
    padding: 16,
  },
  errorBox: {
    backgroundColor: '#fff1f2',
    borderColor: '#fecdd3',
    borderRadius: 18,
    borderWidth: 1,
    gap: 4,
    padding: 14,
  },
  errorTitle: {
    color: '#be123c',
    fontWeight: '800',
  },
  errorText: {
    color: '#be123c',
    fontSize: 13,
    lineHeight: 18,
  },
  warningBox: {
    backgroundColor: '#fffbeb',
    borderColor: '#fde68a',
    borderRadius: 18,
    borderWidth: 1,
    gap: 4,
    padding: 14,
  },
  warningTitle: {
    color: '#a16207',
    fontWeight: '800',
  },
  warningText: {
    color: '#92400e',
    fontSize: 13,
    lineHeight: 18,
  },
  playerCard: {
    alignItems: 'stretch',
    alignSelf: 'stretch',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 28,
    borderWidth: 1,
    gap: 14,
    overflow: 'hidden',
    paddingHorizontal: 16,
    paddingVertical: 16,
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.09,
    shadowRadius: 34,
  },
  playerCardLyrics: {
    backgroundColor: 'rgba(24, 24, 27, 0.9)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  defaultPlayerMode: {
    alignItems: 'stretch',
    gap: 10,
    width: '100%',
  },
  lyricsMode: {
    alignSelf: 'stretch',
    gap: 14,
  },
  lyricsTopBar: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  playerCardBlur: {
    ...StyleSheet.absoluteFill,
  },
  playerStatusBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    width: '100%',
  },
  playerStatusLeft: {
    flex: 1,
    gap: 4,
  },
  playerStatusText: {
    color: 'rgba(248, 250, 252, 0.58)',
    fontSize: 13,
    fontWeight: '700',
  },
  trackInfoPanel: {
    alignSelf: 'stretch',
    gap: 8,
  },
  playerControlDeck: {
    alignSelf: 'stretch',
    backgroundColor: 'rgba(255, 255, 255, 0.07)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 24,
    borderWidth: 1,
    gap: 8,
    padding: 10,
  },
  lyricsHeroText: {
    flex: 1,
    gap: 8,
    minWidth: 0,
  },
  lyricsCloseButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderColor: 'rgba(255, 255, 255, 0.16)',
    borderRadius: 999,
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
    width: 42,
  },
  artworkStage: {
    alignItems: 'center',
    alignSelf: 'stretch',
    justifyContent: 'center',
    minHeight: 0,
    position: 'relative',
  },
  artworkShell: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: '#232329',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 32,
    borderWidth: 1,
    height: 252,
    justifyContent: 'center',
    overflow: 'hidden',
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.14,
    shadowRadius: 32,
    width: 252,
  },
  artworkImage: {
    bottom: 0,
    height: '100%',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    width: '100%',
  },
  artworkImageHidden: {
    opacity: 0,
  },
  artworkFallback: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  artworkFallbackText: {
    color: 'rgba(248, 250, 252, 0.32)',
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: 3,
  },
  artworkFallbackTextLyrics: {
    fontSize: 20,
    letterSpacing: 2,
  },
  artworkGlow: {
    backgroundColor: 'rgba(34, 197, 94, 0.52)',
    borderRadius: 999,
    height: 14,
    opacity: 0.42,
    position: 'absolute',
    top: 0,
    width: '58%',
  },
  playerConnectionChip: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 18,
    borderWidth: 1,
    gap: 4,
    paddingHorizontal: 11,
    paddingVertical: 9,
    position: 'absolute',
    right: 0,
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.08,
    shadowRadius: 20,
    top: 12,
    width: 112,
  },
  playerConnectionChipInline: {
    alignSelf: 'auto',
    minWidth: 118,
    position: 'relative',
    right: undefined,
    top: undefined,
    width: 118,
  },
  playerConnectionChipError: {
    backgroundColor: 'rgba(127, 29, 29, 0.28)',
    borderColor: 'rgba(248, 113, 113, 0.32)',
  },
  playerConnectionKicker: {
    color: '#8b8b86',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.1,
  },
  playerConnectionKickerError: {
    color: '#ef4444',
  },
  playerConnectionStatusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  playerConnectionText: {
    color: '#f8fafc',
    flex: 1,
    fontSize: 12,
    fontWeight: '900',
  },
  playerConnectionTextError: {
    color: '#dc2626',
  },
  playerConnectionDetail: {
    color: 'rgba(248, 250, 252, 0.52)',
    fontSize: 10,
    fontWeight: '700',
  },
  playerConnectionDetailError: {
    color: '#b91c1c',
  },
  trackTitle: {
    color: '#f8fafc',
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: -0.35,
    textAlign: 'left',
  },
  trackTitleLyrics: {
    color: '#f8fafc',
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: -0.45,
    lineHeight: 30,
  },
  trackMeta: {
    color: 'rgba(248, 250, 252, 0.58)',
    fontSize: 14,
    textAlign: 'center',
  },
  playbackTagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    justifyContent: 'center',
    minHeight: 22,
  },
  playbackTagRowLyrics: {
    justifyContent: 'flex-start',
    minHeight: 0,
  },
  playbackTag: {
    borderColor: 'rgba(255, 255, 255, 0.14)',
    borderRadius: 999,
    borderWidth: 1,
    color: 'rgba(248, 250, 252, 0.72)',
    fontSize: 9,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  playbackTagDark: {
    borderColor: 'rgba(255, 255, 255, 0.16)',
    color: 'rgba(248, 250, 252, 0.76)',
  },
  lyricsConnectionText: {
    color: 'rgba(248, 250, 252, 0.62)',
    fontSize: 12,
    fontWeight: '800',
  },
  lyricsConnectionTextError: {
    color: '#fca5a5',
  },
  outputSwitch: {
    alignSelf: 'stretch',
    backgroundColor: 'rgba(255, 255, 255, 0.07)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 24,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 4,
    padding: 4,
  },
  outputSwitchLyrics: {
    alignSelf: 'stretch',
  },
  outputSwitchButton: {
    alignItems: 'center',
    borderRadius: 20,
    flex: 1,
    minHeight: 38,
    justifyContent: 'center',
    overflow: 'hidden',
    paddingHorizontal: 10,
    position: 'relative',
  },
  outputSwitchButtonActive: {
    backgroundColor: 'rgba(34, 197, 94, 0.18)',
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
  },
  outputSwitchText: {
    color: 'rgba(248, 250, 252, 0.58)',
    fontSize: 13,
    fontWeight: '800',
  },
  outputSwitchTextActive: {
    color: '#bbf7d0',
  },
  phoneAudioError: {
    alignSelf: 'stretch',
    color: '#9f1239',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  progressTrack: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 999,
    height: 7,
    overflow: 'hidden',
    width: '100%',
  },
  compactProgressTrack: {
    height: 8,
  },
  sliderTouchArea: {
    justifyContent: 'center',
    minHeight: 36,
    position: 'relative',
    width: '100%',
  },
  compactSliderTouchArea: {
    minHeight: 36,
  },
  progressFill: {
    backgroundColor: '#22c55e',
    borderRadius: 999,
    height: '100%',
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
  },
  compactProgressShell: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  compactTimeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
  },
  progressText: {
    color: 'rgba(248, 250, 252, 0.52)',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  lyricsControlPanel: {
    alignSelf: 'stretch',
    gap: 10,
    paddingTop: 2,
  },
  compactControlRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: 48,
  },
  lyricsViewport: {
    backgroundColor: 'rgba(255, 255, 255, 0.07)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 28,
    borderWidth: 1,
    overflow: 'hidden',
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.2,
    shadowRadius: 28,
  },
  lyricsScrollContent: {
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 22,
  },
  lyricLineButton: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  lyricLineText: {
    color: 'rgba(248, 250, 252, 0.36)',
    fontSize: 19,
    fontWeight: '700',
    letterSpacing: -0.2,
    lineHeight: 28,
  },
  lyricLineTextNear: {
    color: 'rgba(248, 250, 252, 0.58)',
  },
  lyricLineTextFar: {
    color: 'rgba(203, 213, 225, 0.28)',
  },
  lyricLineTextActive: {
    color: '#ffffff',
    fontSize: 25,
    lineHeight: 34,
    textShadowColor: 'rgba(255, 255, 255, 0.28)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },
  lyricTimestamp: {
    color: 'rgba(203, 213, 225, 0.58)',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
    marginTop: 2,
  },
  transportRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 18,
    justifyContent: 'center',
    width: '100%',
  },
  lyricsTransportRow: {
    gap: 16,
    paddingTop: 0,
  },
  secondaryControlsRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
    width: '100%',
  },
  secondaryControlsRowCompact: {
    gap: 8,
    justifyContent: 'flex-start',
  },
  roundButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.09)',
    borderColor: 'rgba(255, 255, 255, 0.13)',
    borderRadius: 999,
    borderWidth: 1,
    height: 50,
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    width: 50,
  },
  roundButtonLyrics: {
    height: 54,
    width: 54,
  },
  playButton: {
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderRadius: 999,
    height: 78,
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.2,
    shadowRadius: 24,
    width: 78,
  },
  playButtonLyrics: {
    height: 82,
    width: 82,
  },
  repeatButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.09)',
    borderColor: 'rgba(255, 255, 255, 0.13)',
    borderRadius: 999,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
    width: 44,
  },
  repeatButtonCompact: {
    height: 42,
    width: 42,
  },
  repeatButtonActive: {
    backgroundColor: 'rgba(34, 197, 94, 0.2)',
    borderColor: 'rgba(34, 197, 94, 0.42)',
  },
  repeatButtonBadge: {
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '900',
    includeFontPadding: false,
    lineHeight: 10,
    position: 'absolute',
    right: 10,
    textAlign: 'center',
    top: 11,
  },
  lyricsButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.09)',
    borderColor: 'rgba(255, 255, 255, 0.13)',
    borderRadius: 999,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
    width: 44,
  },
  lyricsButtonCompact: {
    height: 42,
    width: 42,
  },
  lyricsButtonActive: {
    backgroundColor: 'rgba(34, 197, 94, 0.2)',
    borderColor: 'rgba(34, 197, 94, 0.42)',
  },
  lyricsButtonText: {
    color: '#f8fafc',
    fontSize: 17,
    fontWeight: '900',
    includeFontPadding: false,
    lineHeight: 20,
    textAlign: 'center',
  },
  lyricsButtonTextActive: {
    color: '#ffffff',
  },
  playlistMiniButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.09)',
    borderColor: 'rgba(255, 255, 255, 0.13)',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 5,
    height: 44,
    justifyContent: 'center',
    overflow: 'hidden',
    minWidth: 58,
    paddingHorizontal: 11,
    position: 'relative',
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.06,
    shadowRadius: 16,
  },
  playlistMiniButtonCompact: {
    height: 42,
    minWidth: 54,
    paddingHorizontal: 11,
  },
  playlistMiniButtonActive: {
    backgroundColor: 'rgba(34, 197, 94, 0.2)',
    borderColor: 'rgba(34, 197, 94, 0.42)',
  },
  playlistMiniCount: {
    color: 'rgba(248, 250, 252, 0.58)',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
  },
  playlistOverlay: {
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    paddingBottom: 116,
    paddingHorizontal: 22,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 20,
  },
  playlistBackdrop: {
    backgroundColor: 'rgba(0, 0, 0, 0.48)',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  playlistBackdropPressable: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  playlistPopover: {
    alignSelf: 'center',
    backgroundColor: 'rgba(24, 24, 27, 0.94)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 24,
    borderWidth: 1,
    maxHeight: 380,
    padding: 16,
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 22 },
    shadowOpacity: 0.14,
    shadowRadius: 36,
    width: '100%',
  },
  playlistPopoverHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  playlistHeaderActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  playlistPopoverEyebrow: {
    color: '#8a8178',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  playlistPopoverTitle: {
    color: '#f8fafc',
    fontSize: 19,
    fontWeight: '900',
  },
  playlistCloseButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 999,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  playlistSmallButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 999,
    borderWidth: 1,
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  playlistSmallButtonText: {
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '900',
  },
  playlistPopoverList: {
    gap: 0,
  },
  playlistItem: {
    alignItems: 'center',
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 52,
    paddingVertical: 9,
  },
  playlistItemActive: {
    backgroundColor: 'rgba(34, 197, 94, 0.14)',
    borderRadius: 14,
    borderBottomWidth: 0,
    paddingHorizontal: 10,
  },
  playlistIndex: {
    color: '#9b9690',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
    width: 24,
  },
  playlistIndexActive: {
    color: '#bbf7d0',
  },
  playlistText: {
    flex: 1,
    gap: 2,
  },
  localQueueControls: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
  },
  localQueueButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 999,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  localQueueButtonText: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '900',
    includeFontPadding: false,
  },
  playlistTitle: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '800',
  },
  playlistTitleActive: {
    color: '#bbf7d0',
  },
  playlistMeta: {
    color: 'rgba(248, 250, 252, 0.54)',
    fontSize: 12,
  },
  playlistEmpty: {
    color: 'rgba(248, 250, 252, 0.58)',
    fontSize: 13,
    lineHeight: 19,
    paddingVertical: 10,
  },
  playlistMore: {
    color: '#8a8178',
    fontSize: 12,
    fontWeight: '700',
    paddingTop: 8,
    textAlign: 'center',
  },
  playerDivider: {
    backgroundColor: 'rgba(39, 39, 42, 0.08)',
    height: 1,
    marginTop: 4,
    width: '100%',
  },
  volumeTrack: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 999,
    height: 12,
    overflow: 'hidden',
  },
  compactVolumeTrack: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    height: 7,
  },
  volumeFill: {
    backgroundColor: '#22c55e',
    borderRadius: 999,
    height: '100%',
  },
  compactVolumeShell: {
    alignItems: 'flex-end',
    gap: 7,
    minWidth: 84,
    position: 'relative',
    zIndex: 12,
  },
  volumeMiniButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.09)',
    borderColor: 'rgba(255, 255, 255, 0.13)',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    height: 44,
    justifyContent: 'center',
    overflow: 'hidden',
    paddingHorizontal: 10,
    position: 'relative',
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.07,
    shadowRadius: 16,
  },
  volumeMiniButtonActive: {
    backgroundColor: 'rgba(34, 197, 94, 0.18)',
    borderColor: 'rgba(34, 197, 94, 0.38)',
  },
  volumeMiniValue: {
    color: '#f8fafc',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
  },
  volumeExpandedPanel: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.09)',
    borderColor: 'rgba(255, 255, 255, 0.13)',
    borderRadius: 999,
    borderWidth: 1,
    bottom: 52,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    position: 'absolute',
    right: 0,
    width: 184,
    zIndex: 14,
  },
  volumeExpandedSlider: {
    flex: 1,
    minWidth: 110,
  },
  volumeExpandedValue: {
    color: '#f8fafc',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
    minWidth: 34,
    textAlign: 'right',
  },
  eqPanel: {
    alignSelf: 'stretch',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 22,
    borderWidth: 1,
    gap: 10,
    overflow: 'hidden',
    padding: 12,
  },
  eqPanelHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  eqPanelTitle: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '900',
  },
  eqPanelDescription: {
    color: 'rgba(248, 250, 252, 0.54)',
    fontSize: 12,
    lineHeight: 17,
    maxWidth: 220,
  },
  eqPanelBadge: {
    borderColor: 'rgba(34, 197, 94, 0.36)',
    borderRadius: 999,
    borderWidth: 1,
    color: '#bbf7d0',
    fontSize: 11,
    fontWeight: '900',
    overflow: 'hidden',
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  eqCurveRow: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 8,
    height: 54,
    justifyContent: 'center',
  },
  eqBand: {
    alignItems: 'center',
    flex: 1,
    maxWidth: 34,
  },
  eqBandRail: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 999,
    height: 54,
    justifyContent: 'flex-end',
    overflow: 'hidden',
    width: 9,
  },
  eqBandFill: {
    backgroundColor: '#22c55e',
    borderRadius: 999,
    width: '100%',
  },
  eqPresetRow: {
    gap: 8,
    paddingRight: 2,
  },
  eqPresetButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 34,
    overflow: 'hidden',
    paddingHorizontal: 12,
    position: 'relative',
  },
  eqPresetButtonActive: {
    backgroundColor: 'rgba(34, 197, 94, 0.22)',
    borderColor: 'rgba(34, 197, 94, 0.42)',
  },
  eqPresetText: {
    color: 'rgba(248, 250, 252, 0.58)',
    fontSize: 12,
    fontWeight: '900',
  },
  eqPresetTextActive: {
    color: '#f8fafc',
  },
  eqHint: {
    color: '#bbf7d0',
    fontSize: 11,
    fontWeight: '800',
  },
  libraryList: {
    gap: 10,
  },
  libraryPage: {
    gap: 14,
  },
  settingsPage: {
    gap: 14,
  },
  settingsReveal: {
    paddingTop: 4,
  },
  settingsPanel: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 28,
    borderWidth: 1,
    gap: 12,
    padding: 16,
  },
  settingsSectionList: {
    gap: 10,
  },
  settingsSectionCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.07)',
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 24,
    borderWidth: 1,
    gap: 10,
    overflow: 'hidden',
    padding: 12,
  },
  settingsSectionCardOpen: {
    backgroundColor: 'rgba(255, 255, 255, 0.09)',
    borderColor: 'rgba(34, 197, 94, 0.22)',
  },
  settingsSectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: 58,
  },
  settingsSectionMeta: {
    alignItems: 'flex-end',
    gap: 7,
    maxWidth: 122,
  },
  settingsSectionSummary: {
    color: 'rgba(248, 250, 252, 0.52)',
    fontSize: 11,
    fontWeight: '800',
  },
  settingsChevron: {
    color: '#bbf7d0',
    fontSize: 22,
    fontWeight: '900',
    includeFontPadding: false,
    lineHeight: 24,
  },
  segmentRow: {
    flexDirection: 'row',
    gap: 8,
  },
  segmentButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 999,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 42,
    overflow: 'hidden',
    position: 'relative',
  },
  segmentButtonActive: {
    backgroundColor: 'rgba(34, 197, 94, 0.22)',
    borderColor: 'rgba(34, 197, 94, 0.42)',
  },
  segmentButtonText: {
    color: 'rgba(248, 250, 252, 0.58)',
    fontSize: 13,
    fontWeight: '900',
  },
  segmentButtonTextActive: {
    color: '#f8fafc',
  },
  settingsList: {
    gap: 8,
  },
  settingGroupBlock: {
    gap: 8,
  },
  settingGroupTitle: {
    color: 'rgba(248, 250, 252, 0.58)',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  settingRow: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 20,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 62,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  settingRowDisabled: {
    opacity: 0.46,
  },
  settingText: {
    flex: 1,
    gap: 3,
    minWidth: 0,
  },
  settingTitle: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '900',
  },
  settingDescription: {
    color: 'rgba(248, 250, 252, 0.56)',
    fontSize: 12,
    lineHeight: 17,
  },
  switchTrack: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
    borderRadius: 999,
    height: 30,
    justifyContent: 'center',
    paddingHorizontal: 3,
    width: 52,
  },
  switchTrackActive: {
    backgroundColor: 'rgba(34, 197, 94, 0.86)',
  },
  switchThumb: {
    alignSelf: 'flex-start',
    backgroundColor: '#f8fafc',
    borderRadius: 999,
    height: 24,
    width: 24,
  },
  switchThumbActive: {
    alignSelf: 'flex-end',
    backgroundColor: '#08110b',
  },
  libraryHero: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 32,
    borderWidth: 1,
    gap: 7,
    padding: 18,
  },
  libraryHeroTitle: {
    color: '#f8fafc',
    fontSize: 30,
    fontWeight: '900',
    letterSpacing: -0.8,
  },
  librarySearchRow: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 26,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    padding: 6,
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.05,
    shadowRadius: 24,
  },
  librarySearchInput: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    flex: 1,
    shadowOpacity: 0,
  },
  libraryRefreshButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderColor: 'rgba(255, 255, 255, 0.16)',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minHeight: 46,
    overflow: 'hidden',
    paddingHorizontal: 15,
    position: 'relative',
  },
  libraryRefreshText: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '800',
  },
  libraryFilterRow: {
    flexDirection: 'row',
    gap: 8,
  },
  libraryFilterChip: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 999,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 38,
    overflow: 'hidden',
    position: 'relative',
  },
  libraryFilterChipActive: {
    backgroundColor: 'rgba(34, 197, 94, 0.22)',
    borderColor: 'rgba(34, 197, 94, 0.42)',
  },
  libraryFilterText: {
    color: 'rgba(248, 250, 252, 0.58)',
    fontSize: 12,
    fontWeight: '900',
  },
  libraryFilterTextActive: {
    color: '#f8fafc',
  },
  localViewRow: {
    gap: 8,
    paddingRight: 2,
  },
  localViewChip: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 36,
    minWidth: 62,
    overflow: 'hidden',
    paddingHorizontal: 13,
    position: 'relative',
  },
  localViewChipActive: {
    backgroundColor: 'rgba(34, 197, 94, 0.22)',
    borderColor: 'rgba(34, 197, 94, 0.42)',
  },
  trackRowShell: {
    gap: 7,
  },
  localGroupHeader: {
    color: 'rgba(248, 250, 252, 0.48)',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.8,
    paddingHorizontal: 4,
    textTransform: 'uppercase',
  },
  trackRow: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.07)',
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 22,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 13,
    minHeight: 72,
    paddingHorizontal: 10,
    paddingVertical: 12,
  },
  libraryArtwork: {
    alignItems: 'center',
    backgroundColor: '#232329',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 14,
    borderWidth: 1,
    height: 46,
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
    width: 46,
  },
  libraryArtworkImage: {
    bottom: 0,
    height: '100%',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    width: '100%',
  },
  libraryArtworkFallback: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  trackBadge: {
    alignItems: 'center',
    backgroundColor: '#e5e5e5',
    borderRadius: 999,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  trackBadgeText: {
    color: '#52525b',
    fontSize: 16,
    fontWeight: '900',
  },
  trackText: {
    flex: 1,
    gap: 3,
  },
  listTitle: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '800',
  },
  listMeta: {
    color: 'rgba(248, 250, 252, 0.58)',
    fontSize: 12,
  },
  libraryTagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
  },
  libraryTag: {
    borderColor: 'rgba(255, 255, 255, 0.14)',
    borderRadius: 999,
    borderWidth: 1,
    color: 'rgba(248, 250, 252, 0.68)',
    fontSize: 10,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  localTrackActions: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    justifyContent: 'flex-end',
    maxWidth: 76,
  },
  localTrackActionButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.09)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 999,
    borderWidth: 1,
    height: 29,
    justifyContent: 'center',
    width: 29,
  },
  localTrackActionButtonActive: {
    backgroundColor: 'rgba(34, 197, 94, 0.22)',
    borderColor: 'rgba(34, 197, 94, 0.42)',
  },
  localTrackActionText: {
    color: 'rgba(248, 250, 252, 0.7)',
    fontSize: 12,
    fontWeight: '900',
    includeFontPadding: false,
  },
  localTrackActionTextActive: {
    color: '#bbf7d0',
  },
  dock: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(16, 16, 20, 0.72)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 36,
    borderWidth: 1,
    bottom: 14,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    left: 16,
    overflow: 'hidden',
    padding: 8,
    position: 'absolute',
    right: 16,
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.14,
    shadowRadius: 28,
  },
  dockBlur: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  dockActiveIndicator: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderColor: 'rgba(255, 255, 255, 0.14)',
    borderRadius: 26,
    borderWidth: 1,
    bottom: 8,
    left: 8,
    overflow: 'hidden',
    position: 'absolute',
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 18,
    top: 8,
  },
  dockItem: {
    alignItems: 'center',
    borderColor: 'transparent',
    borderRadius: 26,
    borderWidth: 1,
    flex: 1,
    gap: 3,
    minHeight: 54,
    justifyContent: 'center',
    overflow: 'hidden',
    paddingVertical: 9,
    position: 'relative',
    zIndex: 1,
  },
  dockItemContent: {
    alignItems: 'center',
    gap: 3,
    justifyContent: 'center',
  },
  dockLabel: {
    color: 'rgba(248, 250, 252, 0.5)',
    fontSize: 10,
    fontWeight: '800',
  },
  dockLabelActive: {
    color: '#f8fafc',
  },
});
