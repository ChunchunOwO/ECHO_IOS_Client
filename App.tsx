import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactElement, type ReactNode } from 'react';
import {
  Alert,
  Animated,
  Easing,
  GestureResponderEvent,
  Image as RNImage,
  KeyboardAvoidingView,
  LayoutChangeEvent,
  LayoutAnimation,
  PanResponder,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { BlurView } from 'expo-blur';
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
import { loadSavedConnection, saveConnection } from './src/storage/connectionStore';

type AppPage = 'control' | 'library' | 'connect';
type PlaybackOutputMode = 'pc' | 'phone';
type PendingPcSeek = {
  positionMs: number;
  requestedAtMs: number;
  trackId: string | null;
};

const appPages: AppPage[] = ['control', 'library', 'connect'];

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
    : [{ id: 'empty', text: '暂无歌词', timeMs: null }];
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
  const khz = sampleRate / 1000;
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

const tagsForTrack = (
  track: EchoLinkTrackPreview | null | undefined,
  options: { includeDuration?: boolean; outputMode?: string | null } = {},
): string[] => {
  const tags = [
    formatOutputTag(options.outputMode),
    formatSourceTag(track?.sourceLabel),
    track ? (track.canPlayOnPhone ? '可串流' : '仅控制') : null,
    formatCodecTag(track?.codec),
    formatQualityTag(track),
    formatBitrateTag(track?.bitrate),
    options.includeDuration && track ? formatTime(track.durationMs) : null,
  ];
  return tags.filter((tag): tag is string => Boolean(tag && tag.trim()));
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
  const [pairingText, setPairingText] = useState('');
  const [status, setStatus] = useState<EchoLinkStatusResponse | null>(null);
  const [statusReceivedAtMs, setStatusReceivedAtMs] = useState(() => Date.now());
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [tracks, setTracks] = useState<EchoLinkTrackPreview[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [playlistOpen, setPlaylistOpen] = useState(false);
  const [repeatOneEnabled, setRepeatOneEnabled] = useState(false);
  const [lyricsVisible, setLyricsVisible] = useState(false);
  const [lyricsText, setLyricsText] = useState('');
  const [lyricsTrackId, setLyricsTrackId] = useState<string | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricsError, setLyricsError] = useState<string | null>(null);
  const [volumeExpanded, setVolumeExpanded] = useState(false);
  const [playbackOutputMode, setPlaybackOutputMode] = useState<PlaybackOutputMode>('pc');
  const [phoneTrack, setPhoneTrack] = useState<EchoLinkTrackPreview | null>(null);
  const [phoneAudioBusy, setPhoneAudioBusy] = useState(false);
  const [phoneAudioError, setPhoneAudioError] = useState<string | null>(null);
  const [phoneVolume, setPhoneVolume] = useState(1);
  const [phoneSeekPreviewMs, setPhoneSeekPreviewMs] = useState<number | null>(null);
  const [progressTrackWidth, setProgressTrackWidth] = useState(0);
  const [volumeTrackWidth, setVolumeTrackWidth] = useState(0);
  const [lyricsViewportHeight, setLyricsViewportHeight] = useState(0);
  const [failedArtworkUrls, setFailedArtworkUrls] = useState<Set<string>>(() => new Set());
  const [loadedArtworkUrls, setLoadedArtworkUrls] = useState<Set<string>>(() => new Set());
  const [stableArtworkUrl, setStableArtworkUrl] = useState<string | null>(null);
  const pageTransition = useRef(new Animated.Value(1)).current;
  const lyricsTransition = useRef(new Animated.Value(0)).current;
  const volumeTransition = useRef(new Animated.Value(0)).current;
  const lyricsScrollRef = useRef<ScrollView | null>(null);
  const lyricLineLayoutsRef = useRef<Record<string, { height: number; y: number }>>({});
  const lastAlertKeyRef = useRef<string | null>(null);
  const statusPollInFlight = useRef(false);
  const sliderInteractionInFlight = useRef(false);
  const latestStatusRef = useRef<EchoLinkStatusResponse | null>(null);
  const pendingPcSeekRef = useRef<PendingPcSeek | null>(null);
  const pcRepeatArmedRef = useRef(true);
  const phoneRepeatArmedRef = useRef(true);

  const client = useMemo(() => (
    connection.host.trim() && connection.token.trim()
      ? createEchoLinkClient(connection)
      : null
  ), [connection]);

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

  const showErrorAlert = useCallback((title: string, message: string) => {
    const key = `${title}:${message}`;
    if (lastAlertKeyRef.current === key) {
      return;
    }
    lastAlertKeyRef.current = key;
    Alert.alert(title, message);
  }, []);

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
      const library = await client.getLibraryTracks({ page: 1, pageSize: 20, query });
      setTracks(library.tracks);
    } catch (libraryLoadError) {
      setLibraryError(`已连接电脑端，但曲库加载失败：${formatRequestError(libraryLoadError)}`);
    } finally {
      setBusy(false);
    }
  }, [applyStatus, client, query]);

  useEffect(() => {
    let mounted = true;
    void loadSavedConnection().then((saved) => {
      if (mounted && saved) {
        setConnection(saved);
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
    pageTransition.setValue(0);
    Animated.timing(pageTransition, {
      duration: 220,
      easing: Easing.out(Easing.cubic),
      toValue: 1,
      useNativeDriver: true,
    }).start();
  }, [page, pageTransition]);

  useEffect(() => {
    Animated.timing(lyricsTransition, {
      duration: 360,
      easing: Easing.out(Easing.cubic),
      toValue: lyricsVisible ? 1 : 0,
      useNativeDriver: true,
    }).start();
    LayoutAnimation.configureNext({
      duration: 360,
      update: {
        type: LayoutAnimation.Types.easeInEaseOut,
      },
    });
  }, [lyricsTransition, lyricsVisible]);

  useEffect(() => {
    Animated.timing(volumeTransition, {
      duration: 260,
      easing: Easing.out(Easing.cubic),
      toValue: volumeExpanded ? 1 : 0,
      useNativeDriver: true,
    }).start();
    LayoutAnimation.configureNext({
      duration: 260,
      update: {
        type: LayoutAnimation.Types.easeInEaseOut,
      },
    });
  }, [volumeExpanded, volumeTransition]);

  useEffect(() => {
    if (error) {
      showErrorAlert('连接异常', error);
    }
  }, [error, showErrorAlert]);

  useEffect(() => {
    if (libraryError) {
      showErrorAlert('曲库加载异常', libraryError);
    }
  }, [libraryError, showErrorAlert]);

  useEffect(() => {
    if (phoneAudioError) {
      showErrorAlert('播放异常', phoneAudioError);
    }
  }, [phoneAudioError, showErrorAlert]);

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
      setConnection(parsed);
      await saveConnection(parsed);
      setPairingText('');
      setError(null);
      switchPage('control');
    } catch (pairingError) {
      Alert.alert('配对失败', pairingError instanceof Error ? pairingError.message : String(pairingError));
    }
  }, [pairingText, switchPage]);

  const saveManualConnection = useCallback(async () => {
    const nextConnection = {
      ...connection,
      host: normalizeEchoLinkHost(connection.host),
      token: normalizeEchoLinkToken(connection.token),
      port: Number(connection.port) || 26789,
      scheme: connection.scheme || 'http',
    };
    setConnection(nextConnection);
    await saveConnection(nextConnection);
    switchPage('control');
    void refresh();
  }, [connection, refresh, switchPage]);

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
    void sendCommand({ command: 'playTrack', trackId: track.id, output: 'pc' });
  }, [sendCommand]);

  const nowPlaying = status?.playback.track;
  const playbackQueue = status?.playback.queue;
  const playlistItems = playbackQueue?.items ?? [];
  const visiblePlaylistItems = playlistItems.slice(0, 8);
  const hiddenPlaylistItemCount = Math.max(0, playlistItems.length - visiblePlaylistItems.length);
  const isPhoneOutput = playbackOutputMode === 'phone';
  const displayTrack = isPhoneOutput ? phoneTrack ?? nowPlaying : nowPlaying;
  const displayArtworkUrl = resolveArtworkUrl(displayTrack?.artworkUrl);
  const echoConnectionBroken = Boolean(error);
  const echoConnectionOnline = Boolean(status && !echoConnectionBroken);
  const connectedLabel = echoConnectionBroken
    ? '连接已断开'
    : status
      ? `已连接 ${status.device.name}`
      : client
        ? '正在连接'
        : '尚未连接';
  const playerConnectionDetail = status?.device.name ?? 'ECHO Link';
  const pcPlaybackPositionMs = status
    ? Math.max(0, Math.min(
      status.playback.durationMs || Number.MAX_SAFE_INTEGER,
      status.playback.positionMs + (status.playback.state === 'playing' ? Math.max(0, clockMs - statusReceivedAtMs) : 0),
    ))
    : 0;
  const phonePlaybackPositionMs = Math.max(0, Math.round(phonePlayerStatus.currentTime * 1000));
  const playbackPositionMs = isPhoneOutput
    ? phoneSeekPreviewMs ?? phonePlaybackPositionMs
    : pcPlaybackPositionMs;
  const playbackDurationMs = isPhoneOutput
    ? Math.max(0, Math.round(phonePlayerStatus.duration * 1000) || displayTrack?.durationMs || 0)
    : status?.playback.durationMs ?? 0;
  const progressRatio = playbackDurationMs
    ? clamp01(playbackPositionMs / playbackDurationMs)
    : 0;
  const outputVolume = isPhoneOutput ? phoneVolume : status?.playback.volume ?? 0;
  const volumePercent = Math.round(outputVolume * 100);
  const isPlaybackActive = isPhoneOutput ? phonePlayerStatus.playing : status?.playback.state === 'playing';
  const playbackTags = tagsForTrack(displayTrack, {
    outputMode: isPhoneOutput ? '串流' : status?.playback.outputMode,
  });
  const lyricLines = useMemo(() => {
    if (lyricsLoading) {
      return [{ id: 'loading', text: '正在载入歌词...', timeMs: null }];
    }
    if (lyricsError) {
      return [{ id: 'error', text: '暂无可用歌词', timeMs: null }];
    }
    return parseLyrics(lyricsText);
  }, [lyricsError, lyricsLoading, lyricsText]);
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
  const isCompactPlayer = windowWidth < 390 || windowHeight < 760;
  const playerCoverSize = isCompactPlayer ? Math.min(windowWidth - 92, 228) : Math.min(windowWidth - 80, 272);
  const playerShellPadding = isCompactPlayer ? 14 : 18;
  const playerShellGap = isCompactPlayer ? 10 : 14;
  const playerTitleSize = isCompactPlayer ? 21 : 24;
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
    const targetY = Math.max(0, layout.y - Math.max(24, lyricsViewportHeight * 0.34));
    lyricsScrollRef.current.scrollTo({ animated: true, y: targetY });
  }, [activeLyricIndex, lyricLines, lyricsVisible, lyricsViewportHeight]);
  const renderOutputSwitch = () => (
    <View style={styles.outputSwitch}>
      <Pressable
        accessibilityLabel="控制电脑播放"
        accessibilityRole="button"
        disabled={!client || phoneAudioBusy}
        onPress={switchToPcPlayback}
        style={[styles.outputSwitchButton, !isPhoneOutput ? styles.outputSwitchButtonActive : null]}
      >
        {renderButtonBlur(!isPhoneOutput ? 12 : 18)}
        <Text style={[styles.outputSwitchText, !isPhoneOutput ? styles.outputSwitchTextActive : null]}>
          控制
        </Text>
      </Pressable>
      <Pressable
        accessibilityLabel="串流到手机播放"
        accessibilityRole="button"
        disabled={!client || phoneAudioBusy}
        onPress={switchToPhonePlayback}
        style={[styles.outputSwitchButton, isPhoneOutput ? styles.outputSwitchButtonActive : null]}
      >
        {renderButtonBlur(isPhoneOutput ? 12 : 18)}
        <Text style={[styles.outputSwitchText, isPhoneOutput ? styles.outputSwitchTextActive : null]}>
          {phoneAudioBusy ? '...' : '串流'}
        </Text>
      </Pressable>
    </View>
  );

  useEffect(() => {
    if (!lyricsVisible || !client || !displayTrack?.id) {
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
        setLyricsText(response.lyrics || '暂无歌词');
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
  }, [client, displayTrack?.id, lyricsError, lyricsText, lyricsTrackId, lyricsVisible]);

  const playTrackOnPhone = useCallback(async (
    track: EchoLinkTrackPreview,
    positionMs = 0,
    pausePcAfterStart = false,
  ) => {
    if (!client) {
      return;
    }
    if (!track.canPlayOnPhone) {
      setPhoneAudioError('这首歌暂时不能直接串流到手机。请换一首本地 MP3/AAC/M4A 等 iOS 友好格式的歌曲。');
      return;
    }

    setPhoneAudioBusy(true);
    setPhoneAudioError(null);
    setPhoneSeekPreviewMs(null);
    try {
      const stream = await client.createPhoneStream(track.id);
      const nextVolume = playbackOutputMode === 'phone'
        ? phoneVolume
        : status?.playback.volume ?? phoneVolume;

      phonePlayer.pause();
      phonePlayer.replace({
        name: `${stream.track.title} - ${stream.track.artist}`,
        uri: stream.streamUrl,
      });
      phonePlayer.volume = nextVolume;
      setPhoneVolume(nextVolume);
      setPhoneTrack(stream.track);
      setPlaybackOutputMode('phone');
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
  }, [applyStatus, client, phonePlayer, phoneVolume, playbackOutputMode, status]);

  const switchToPhonePlayback = useCallback(() => {
    if (isPhoneOutput) {
      return;
    }
    const track = nowPlaying ?? phoneTrack;
    if (!track) {
      setPhoneAudioError('当前没有可播放的歌曲。请先在电脑端播放一首歌。');
      return;
    }
    void playTrackOnPhone(track, nowPlaying?.id === track.id ? pcPlaybackPositionMs : 0, true);
  }, [isPhoneOutput, nowPlaying, pcPlaybackPositionMs, phoneTrack, playTrackOnPhone]);

  const switchToPcPlayback = useCallback(() => {
    if (!isPhoneOutput) {
      return;
    }
    const track = phoneTrack ?? nowPlaying;
    const positionMs = Math.max(0, Math.round(phonePlayerStatus.currentTime * 1000));

    phonePlayer.pause();
    phonePlayer.clearLockScreenControls();
    setPlaybackOutputMode('pc');
    setPhoneSeekPreviewMs(null);
    setPhoneAudioError(null);

    if (client && track) {
      void client.sendPlaybackCommand({
        command: 'handoff',
        positionMs,
        target: 'pc',
        trackId: track.id,
      })
        .then(applyStatus)
        .catch((handoffError) => setError(formatRequestError(handoffError)));
    }
  }, [applyStatus, client, isPhoneOutput, nowPlaying, phonePlayer, phonePlayerStatus.currentTime, phoneTrack]);

  const togglePlayPause = useCallback(() => {
    if (isPhoneOutput) {
      if (!phoneTrack) {
        switchToPhonePlayback();
        return;
      }
      if (phonePlayerStatus.playing) {
        phonePlayer.pause();
      } else {
        phonePlayer.play();
      }
      return;
    }
    void sendCommand({ command: 'playPause' });
  }, [isPhoneOutput, phonePlayer, phonePlayerStatus.playing, phoneTrack, sendCommand, switchToPhonePlayback]);

  const playRelativePhoneQueueTrack = useCallback((direction: -1 | 1) => {
    const currentTrackId = phoneTrack?.id ?? nowPlaying?.id ?? playbackQueue?.currentTrackId;
    const currentIndex = playlistItems.findIndex((item) => item.id === currentTrackId);
    const nextTrack = currentIndex >= 0 ? playlistItems[currentIndex + direction] : null;
    if (!nextTrack) {
      setPhoneAudioError(direction > 0 ? '播放列表里暂时没有下一首。' : '播放列表里暂时没有上一首。');
      return;
    }
    void playTrackOnPhone(nextTrack, 0, false);
  }, [nowPlaying, phoneTrack, playbackQueue?.currentTrackId, playlistItems, playTrackOnPhone]);

  const playPrevious = useCallback(() => {
    if (isPhoneOutput) {
      playRelativePhoneQueueTrack(-1);
      return;
    }
    void sendCommand({ command: 'previous' });
  }, [isPhoneOutput, playRelativePhoneQueueTrack, sendCommand]);

  const playNext = useCallback(() => {
    if (isPhoneOutput) {
      playRelativePhoneQueueTrack(1);
      return;
    }
    void sendCommand({ command: 'next' });
  }, [isPhoneOutput, playRelativePhoneQueueTrack, sendCommand]);

  useEffect(() => {
    if (!repeatOneEnabled || !isPhoneOutput || !phoneTrack) {
      phoneRepeatArmedRef.current = true;
      return;
    }

    const durationSeconds = Number(phonePlayerStatus.duration) || 0;
    const currentSeconds = Number(phonePlayerStatus.currentTime) || 0;
    if (phonePlayerStatus.playing && (!durationSeconds || currentSeconds < Math.max(0, durationSeconds - 1))) {
      phoneRepeatArmedRef.current = true;
    }

    if (!phonePlayerStatus.didJustFinish || !phoneRepeatArmedRef.current) {
      return;
    }

    phoneRepeatArmedRef.current = false;
    void phonePlayer.seekTo(0)
      .catch(() => undefined)
      .finally(() => {
        phonePlayer.play();
      });
  }, [
    isPhoneOutput,
    phonePlayer,
    phonePlayerStatus.currentTime,
    phonePlayerStatus.didJustFinish,
    phonePlayerStatus.duration,
    phonePlayerStatus.playing,
    phoneTrack,
    repeatOneEnabled,
  ]);

  useEffect(() => {
    if (!repeatOneEnabled || isPhoneOutput || !client || !status?.playback.track) {
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
    isPhoneOutput,
    repeatOneEnabled,
    status?.playback.durationMs,
    status?.playback.positionMs,
    status?.playback.state,
    status?.playback.track,
  ]);

  const updateSeekFromGesture = useCallback((event: GestureResponderEvent, commit: boolean) => {
    if ((!status && !isPhoneOutput) || !playbackDurationMs || progressTrackWidth <= 0) {
      return;
    }
    const ratio = ratioFromGesture(event, progressTrackWidth);
    const positionMs = Math.round(playbackDurationMs * ratio);
    if (isPhoneOutput) {
      setPhoneSeekPreviewMs(commit ? null : positionMs);
      if (commit) {
        void phonePlayer.seekTo(positionMs / 1000);
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
  }, [isPhoneOutput, patchPlayback, phonePlayer, playbackDurationMs, progressTrackWidth, sendCommand, status]);

  const seekToLyric = useCallback((line: LyricLine) => {
    if (line.timeMs === null || (!status && !isPhoneOutput)) {
      return;
    }
    if (isPhoneOutput) {
      void phonePlayer.seekTo(line.timeMs / 1000);
      return;
    }
    pendingPcSeekRef.current = {
      positionMs: line.timeMs,
      requestedAtMs: Date.now(),
      trackId: status?.playback.track?.id ?? null,
    };
    patchPlayback({ positionMs: line.timeMs });
    void sendCommand({ command: 'seekTo', positionMs: line.timeMs });
  }, [isPhoneOutput, patchPlayback, phonePlayer, sendCommand, status]);

  const updateVolumeFromGesture = useCallback((event: GestureResponderEvent, commit: boolean) => {
    if ((!status && !isPhoneOutput) || volumeTrackWidth <= 0) {
      return;
    }
    const volume = ratioFromGesture(event, volumeTrackWidth);
    if (isPhoneOutput) {
      phonePlayer.volume = volume;
      setPhoneVolume(volume);
      return;
    }
    sliderInteractionInFlight.current = !commit;
    patchPlayback({ volume });
    if (commit) {
      void sendCommand({ command: 'setVolume', volume });
    }
  }, [isPhoneOutput, patchPlayback, phonePlayer, sendCommand, status, volumeTrackWidth]);

  const handleProgressLayout = useCallback((event: LayoutChangeEvent) => {
    setProgressTrackWidth(event.nativeEvent.layout.width);
  }, []);

  const handleVolumeLayout = useCallback((event: LayoutChangeEvent) => {
    setVolumeTrackWidth(event.nativeEvent.layout.width);
  }, []);

  const pageTitle = page === 'connect'
    ? '连接电脑'
    : page === 'library'
      ? '曲库'
      : '正在播放';
  const pageDescription = page === 'connect'
    ? '用配对链接或局域网地址，让手机与 ECHO NEXT 桌面端建立同一套音乐空间。'
    : page === 'library'
      ? '浏览电脑端本地曲库，把歌曲从 PC 端自然接到手机端体验里。'
      : '同步 PC 端当前播放、曲库与音量，让手机和电脑保持同一段聆听进度。';
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
        translateY: pageTransition.interpolate({
          inputRange: [0, 1],
          outputRange: [10, 0],
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
  const renderArtwork = (variant: 'default' | 'lyrics') => {
    const artworkSize = variant === 'lyrics' ? (isCompactPlayer ? 104 : 120) : playerCoverSize;
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
        onStartShouldSetResponderCapture={() => Boolean((client || isPhoneOutput) && playbackDurationMs)}
        onStartShouldSetResponder={() => Boolean((client || isPhoneOutput) && playbackDurationMs)}
        onMoveShouldSetResponder={() => Boolean((client || isPhoneOutput) && playbackDurationMs)}
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
      onStartShouldSetResponderCapture={() => Boolean(client || isPhoneOutput)}
      onStartShouldSetResponder={() => Boolean(client || isPhoneOutput)}
      onMoveShouldSetResponder={() => Boolean(client || isPhoneOutput)}
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
        accessibilityLabel={volumeExpanded ? '收起音量调节' : '展开音量调节'}
        accessibilityRole="button"
        onPress={() => setVolumeExpanded((current) => !current)}
        style={[styles.volumeMiniButton, volumeExpanded ? styles.volumeMiniButtonActive : null]}
      >
        {renderButtonBlur(20)}
        <Text style={styles.volumeMiniIcon}>VOL</Text>
        <Text style={styles.volumeMiniValue}>{volumePercent}%</Text>
      </Pressable>
      {volumeExpanded ? (
        <Animated.View style={[styles.volumeExpandedPanel, volumeExpandedAnimatedStyle]}>
          {renderVolumeSlider(true)}
        </Animated.View>
      ) : null}
    </View>
  );
  const renderTransportControls = (lyricsMode = false) => (
    <View style={[styles.transportRow, lyricsMode ? styles.lyricsTransportRow : null]}>
      <Pressable
        accessibilityLabel="上一首"
        accessibilityRole="button"
        style={[styles.roundButton, lyricsMode ? styles.roundButtonLyrics : null]}
        onPress={playPrevious}
        disabled={!client && !isPhoneOutput}
      >
        {renderButtonBlur(24)}
        <Text style={[styles.roundButtonText, lyricsMode ? styles.roundButtonTextLyrics : null]}>‹</Text>
      </Pressable>
      <Pressable
        accessibilityLabel={isPlaybackActive ? '暂停播放' : '开始播放'}
        accessibilityRole="button"
        style={[styles.playButton, lyricsMode ? styles.playButtonLyrics : null]}
        onPress={togglePlayPause}
        disabled={!client && !isPhoneOutput}
      >
        {renderButtonBlur(14)}
        <Text style={[
          styles.playButtonText,
          lyricsMode ? styles.playButtonTextLyrics : null,
          isPlaybackActive ? null : styles.playButtonTextPlay,
        ]}>{isPlaybackActive ? 'Ⅱ' : '▶'}</Text>
      </Pressable>
      <Pressable
        accessibilityLabel="下一首"
        accessibilityRole="button"
        style={[styles.roundButton, lyricsMode ? styles.roundButtonLyrics : null]}
        onPress={playNext}
        disabled={!client && !isPhoneOutput}
      >
        {renderButtonBlur(24)}
        <Text style={[styles.roundButtonText, lyricsMode ? styles.roundButtonTextLyrics : null]}>›</Text>
      </Pressable>
    </View>
  );
  const renderSecondaryControls = (compact = false) => (
    <View style={[styles.secondaryControlsRow, compact ? styles.secondaryControlsRowCompact : null]}>
      <Pressable
        accessibilityLabel={repeatOneEnabled ? '关闭单曲循环' : '开启单曲循环'}
        accessibilityRole="button"
        onPress={() => setRepeatOneEnabled((current) => !current)}
        style={[styles.repeatButton, compact ? styles.repeatButtonCompact : null, repeatOneEnabled ? styles.repeatButtonActive : null]}
      >
        {renderButtonBlur(repeatOneEnabled ? 10 : 22)}
        <Text style={[styles.repeatButtonIcon, repeatOneEnabled ? styles.repeatButtonIconActive : null]}>↻</Text>
        {repeatOneEnabled ? (
          <Text style={styles.repeatButtonBadge}>1</Text>
        ) : null}
      </Pressable>
      <Pressable
        accessibilityLabel={lyricsVisible ? '关闭歌词显示' : '打开歌词显示'}
        accessibilityRole="button"
        onPress={() => setLyricsVisible((current) => !current)}
        style={[styles.lyricsButton, compact ? styles.lyricsButtonCompact : null, lyricsVisible ? styles.lyricsButtonActive : null]}
      >
        {renderButtonBlur(lyricsVisible ? 10 : 22)}
        <Text style={[styles.lyricsButtonText, lyricsVisible ? styles.lyricsButtonTextActive : null]}>词</Text>
      </Pressable>
      <Pressable
        accessibilityLabel={playlistOpen ? '关闭播放列表预览' : '打开播放列表预览'}
        accessibilityRole="button"
        onPress={() => setPlaylistOpen((current) => !current)}
        style={[styles.playlistMiniButton, compact ? styles.playlistMiniButtonCompact : null, playlistOpen ? styles.playlistMiniButtonActive : null]}
      >
        {renderButtonBlur(22)}
        <Text style={styles.playlistMiniIcon}>☰</Text>
        <Text style={styles.playlistMiniCount}>{playlistItems.length}</Text>
      </Pressable>
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
            refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void refresh()} tintColor="#18181b" />}
            scrollEnabled={page !== 'control'}
          >
            <Animated.View style={[styles.pageTransition, pageAnimatedStyle]}>
            {page !== 'control' ? (
              <View style={styles.header}>
                <Text style={styles.kicker}>ECHO iPhone</Text>
                <Text style={styles.title}>{pageTitle}</Text>
                <Text style={styles.description}>{pageDescription}</Text>
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
              <>
                <View style={styles.section}>
                  <Text style={styles.cardEyebrow}>Pair</Text>
                  <Text style={styles.cardTitle}>配对连接</Text>
                  <Text style={styles.hint}>
                    在电脑端打开 Connect / Mobile ECHO Link，复制或扫描二维码里的 echo://pair 链接，然后粘贴到这里。
                  </Text>
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
                    accessibilityLabel="使用配对链接连接电脑"
                    accessibilityRole="button"
                    style={styles.primaryButton}
                    onPress={() => void applyPairingText()}
                  >
                    {renderButtonBlur(12)}
                    <Text style={styles.primaryButtonIcon}>↗</Text>
                    <Text style={styles.primaryButtonText}>使用配对链接</Text>
                  </Pressable>
                </View>

                <View style={styles.section}>
                  <Text style={styles.cardEyebrow}>Manual</Text>
                  <Text style={styles.cardTitle}>手动连接</Text>
                  <TextInput
                    value={connection.host}
                    onChangeText={(host) => setConnection((current) => ({ ...current, host }))}
                    placeholder="电脑 IP，例如 192.168.1.12"
                    placeholderTextColor="#a8a29e"
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.input}
                  />
                  <TextInput
                    value={String(connection.port)}
                    onChangeText={(port) => setConnection((current) => ({ ...current, port: Number(port) || 26789 }))}
                    placeholder="端口"
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
                      accessibilityLabel="保存手动连接"
                      accessibilityRole="button"
                      style={styles.secondaryButton}
                      onPress={() => void saveManualConnection()}
                    >
                      {renderButtonBlur(24)}
                      <Text style={styles.secondaryButtonIcon}>✓</Text>
                      <Text style={styles.secondaryButtonText}>保存连接</Text>
                    </Pressable>
                    <Pressable
                      accessibilityLabel="测试电脑连接"
                      accessibilityRole="button"
                      style={styles.secondaryButton}
                      onPress={() => void refresh()}
                      disabled={!client || busy}
                    >
                      {renderButtonBlur(24)}
                      <Text style={styles.secondaryButtonIcon}>↻</Text>
                      <Text style={styles.secondaryButtonText}>{busy ? '刷新中...' : '测试连接'}</Text>
                    </Pressable>
                  </View>
                </View>
              </>
            ) : page === 'library' ? (
              <View style={styles.libraryPage}>
                <View style={styles.librarySearchRow}>
                  <TextInput
                    value={query}
                    onChangeText={setQuery}
                    onSubmitEditing={() => void refresh()}
                    placeholder="搜索歌曲、艺术家或专辑"
                    placeholderTextColor="#9b9690"
                    style={[styles.input, styles.librarySearchInput]}
                  />
                  <Pressable
                    accessibilityLabel="刷新曲库"
                    accessibilityRole="button"
                    disabled={!client || busy}
                    onPress={() => void refresh()}
                    style={styles.libraryRefreshButton}
                  >
                    {renderButtonBlur(24)}
                    <Text style={styles.libraryRefreshIcon}>↻</Text>
                    <Text style={styles.libraryRefreshText}>{busy ? '同步中' : '刷新'}</Text>
                  </Pressable>
                </View>

                <View style={styles.libraryList}>
                  {tracks.length > 0 ? tracks.map((item) => {
                    const itemArtworkUrl = resolveArtworkUrl(item.artworkUrl);
                    const itemArtworkVisible = artworkUrlIsVisible(itemArtworkUrl);
                    return (
                      <Pressable
                        accessibilityLabel={`在电脑端播放 ${item.title}`}
                        accessibilityRole="button"
                        key={item.id}
                        style={styles.trackRow}
                        onPress={() => playTrackOnPc(item)}
                      >
                        <View style={styles.libraryArtwork}>
                          <View style={styles.libraryArtworkFallback}>
                            <Text style={styles.libraryArtworkText}>E</Text>
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
                          <Text style={styles.listMeta} numberOfLines={1}>{item.artist}</Text>
                          <View style={styles.libraryTagRow}>
                            {tagsForTrack(item, { includeDuration: true }).map((tag) => (
                              <Text key={`${item.id}-${tag}`} style={styles.libraryTag}>{tag}</Text>
                            ))}
                          </View>
                        </View>
                        <Text style={styles.playInline}>▷</Text>
                      </Pressable>
                    );
                  }) : (
                    <Text style={styles.hint}>{client ? '暂无曲库结果' : '连接后会显示电脑端曲库'}</Text>
                  )}
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
                  <BlurView intensity={32} pointerEvents="none" style={styles.playerCardBlur} tint="light" />
                  {lyricsVisible ? (
                    <Animated.View style={[styles.lyricsMode, lyricsPanelAnimatedStyle]}>
                      <View style={styles.lyricsTopBar}>
                        {renderArtwork('lyrics')}
                        <View style={styles.lyricsHeroText}>
                          <Text style={[styles.trackTitleLyrics, { fontSize: playerTitleSize }]} numberOfLines={2}>
                            {displayTrack?.title ?? '没有正在播放的歌曲'}
                          </Text>
                          <View style={[styles.playbackTagRow, styles.playbackTagRowLyrics]}>
                            {playbackTags.map((tag) => (
                              <Text key={tag} style={styles.playbackTag}>{tag}</Text>
                            ))}
                          </View>
                        </View>
                        <Pressable
                          accessibilityLabel="关闭歌词显示"
                          accessibilityRole="button"
                          onPress={() => setLyricsVisible(false)}
                          style={styles.lyricsCloseButton}
                        >
                          {renderButtonBlur(18)}
                          <Text style={styles.lyricsCloseText}>×</Text>
                        </Pressable>
                      </View>

                      <View
                        onLayout={(event) => setLyricsViewportHeight(event.nativeEvent.layout.height)}
                        style={styles.lyricsViewport}
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
                        {renderOutputSwitch()}
                        <View style={styles.compactControlRow}>
                          {renderProgressScrubber(true)}
                          {renderExpandableVolume()}
                        </View>
                        {renderTransportControls(true)}
                        {renderSecondaryControls(true)}
                      </View>
                    </Animated.View>
                  ) : (
                    <Animated.View style={[styles.defaultPlayerMode, defaultPlayerAnimatedStyle]}>
                      <View style={styles.playerStatusBar}>
                        <View style={styles.playerStatusLeft}>
                          <Text style={styles.cardEyebrow}>Now Playing</Text>
                          <Text style={styles.playerStatusText} numberOfLines={1}>{connectedLabel}</Text>
                        </View>
                        {renderConnectionChip('inline')}
                      </View>
                      <View style={styles.artworkStage}>
                        <View style={styles.artworkGlow} />
                        {renderArtwork('default')}
                      </View>
                      <View style={styles.trackInfoPanel}>
                        <Text style={[styles.trackTitle, { fontSize: playerTitleSize }]} numberOfLines={2}>{displayTrack?.title ?? '没有正在播放的歌曲'}</Text>
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
                      </View>

                      <View style={styles.playerUtilityGrid}>
                        {renderOutputSwitch()}
                        <View style={styles.volumePanel}>
                        <View style={styles.volumeHeader}>
                          <Text style={styles.cardEyebrow}>VOL</Text>
                          <Text style={styles.volumeValue}>{volumePercent}%</Text>
                        </View>
                        {renderVolumeSlider()}
                        </View>
                      </View>
                    </Animated.View>
                  )}
                </View>
              </>
            )}
            </Animated.View>
          </ScrollView>

          {page === 'control' && playlistOpen ? (
            <View style={styles.playlistOverlay} pointerEvents="box-none">
              <Pressable
                accessibilityLabel="关闭播放列表预览"
                accessibilityRole="button"
                onPress={() => setPlaylistOpen(false)}
                style={styles.playlistBackdrop}
              />
              <View style={styles.playlistPopover}>
                <View style={styles.playlistPopoverHeader}>
                  <View>
                    <Text style={styles.playlistPopoverEyebrow}>Queue</Text>
                    <Text style={styles.playlistPopoverTitle}>播放列表</Text>
                  </View>
                  <Pressable
                    accessibilityLabel="关闭播放列表"
                    accessibilityRole="button"
                    onPress={() => setPlaylistOpen(false)}
                    style={styles.playlistCloseButton}
                  >
                    <Text style={styles.playlistCloseText}>×</Text>
                  </Pressable>
                </View>
                <View style={styles.playlistPopoverList}>
                  {visiblePlaylistItems.length > 0 ? visiblePlaylistItems.map((item, index) => {
                    const isCurrentTrack = item.id === playbackQueue?.currentTrackId || item.id === displayTrack?.id;
                    return (
                      <Pressable
                        accessibilityLabel={`播放列表第 ${index + 1} 首：${item.title}`}
                        accessibilityRole="button"
                        key={`${item.id}-${index}`}
                        onPress={() => {
                          setPlaylistOpen(false);
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
                      </Pressable>
                    );
                  }) : (
                    <Text style={styles.playlistEmpty}>当前播放队列暂无内容。之后这里会承接 PC 与手机互通的播放列表。</Text>
                  )}
                </View>
                {hiddenPlaylistItemCount > 0 ? (
                  <Text style={styles.playlistMore}>还有 {hiddenPlaylistItemCount} 首在队列中</Text>
                ) : null}
              </View>
            </View>
          ) : null}

          <View style={styles.dock}>
            <BlurView intensity={34} pointerEvents="none" style={styles.dockBlur} tint="light" />
            <Pressable
              accessibilityLabel="播放页面"
              accessibilityRole="button"
              style={[styles.dockItem, page === 'control' ? styles.dockItemActive : null]}
              onPress={() => switchPage('control')}
            >
              {page === 'control' ? renderButtonBlur(16) : null}
              <Text style={[styles.dockIcon, page === 'control' ? styles.dockIconActive : null]}>▷</Text>
              <Text style={[styles.dockLabel, page === 'control' ? styles.dockLabelActive : null]}>播放</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="曲库页面"
              accessibilityRole="button"
              style={[styles.dockItem, page === 'library' ? styles.dockItemActive : null]}
              onPress={() => switchPage('library')}
            >
              {page === 'library' ? renderButtonBlur(16) : null}
              <Text style={[styles.dockIcon, page === 'library' ? styles.dockIconActive : null]}>≋</Text>
              <Text style={[styles.dockLabel, page === 'library' ? styles.dockLabelActive : null]}>曲库</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="连接页面"
              accessibilityRole="button"
              style={[styles.dockItem, page === 'connect' ? styles.dockItemActive : null]}
              onPress={() => switchPage('connect')}
            >
              {page === 'connect' ? renderButtonBlur(16) : null}
              <Text style={[styles.dockIcon, page === 'connect' ? styles.dockIconActive : null]}>⌁</Text>
              <Text style={[styles.dockLabel, page === 'connect' ? styles.dockLabelActive : null]}>连接</Text>
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
    backgroundColor: '#f6f6f3',
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
  playerContent: {
    flexGrow: 1,
    justifyContent: 'flex-start',
    paddingBottom: 118,
    paddingTop: 4,
  },
  playerContentLyrics: {
    justifyContent: 'flex-start',
    paddingTop: 4,
  },
  header: {
    gap: 9,
    paddingHorizontal: 2,
    paddingTop: 18,
  },
  kicker: {
    color: '#8b8b86',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.7,
    textTransform: 'uppercase',
  },
  title: {
    color: '#18181b',
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: -0.8,
  },
  description: {
    color: '#666662',
    fontSize: 15,
    lineHeight: 23,
    maxWidth: 330,
  },
  statusPill: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255, 255, 255, 0.62)',
    borderColor: 'rgba(255, 255, 255, 0.78)',
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
    backgroundColor: 'rgba(255, 255, 255, 0.86)',
    borderColor: 'rgba(255, 255, 255, 0.92)',
  },
  statusPillError: {
    backgroundColor: 'rgba(254, 242, 242, 0.86)',
    borderColor: 'rgba(248, 113, 113, 0.34)',
  },
  statusDot: {
    backgroundColor: '#a1a1aa',
    borderRadius: 999,
    height: 7,
    width: 7,
  },
  statusDotOnline: {
    backgroundColor: '#27272a',
  },
  statusDotError: {
    backgroundColor: '#dc2626',
  },
  statusPillText: {
    color: '#706b66',
    fontSize: 12,
    fontWeight: '800',
  },
  statusPillTextOnline: {
    color: '#27272a',
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
    backgroundColor: 'rgba(255, 255, 255, 0.48)',
    borderColor: 'rgba(255, 255, 255, 0.76)',
    borderRadius: 26,
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
    color: '#18181b',
    fontSize: 18,
    fontWeight: '800',
  },
  hint: {
    color: '#706b66',
    fontSize: 13,
    lineHeight: 19,
  },
  input: {
    backgroundColor: 'rgba(255, 255, 255, 0.62)',
    borderColor: 'rgba(39, 39, 42, 0.08)',
    borderRadius: 18,
    borderWidth: 1,
    color: '#18181b',
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
    backgroundColor: '#18181b',
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
  primaryButtonIcon: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '900',
    includeFontPadding: false,
    lineHeight: 18,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '800',
  },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.54)',
    borderColor: 'rgba(255, 255, 255, 0.76)',
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
  secondaryButtonIcon: {
    color: '#27272a',
    fontSize: 15,
    fontWeight: '900',
    includeFontPadding: false,
    lineHeight: 16,
  },
  secondaryButtonText: {
    color: '#27272a',
    fontSize: 14,
    fontWeight: '800',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
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
    backgroundColor: 'rgba(255, 255, 255, 0.64)',
    borderColor: 'rgba(255, 255, 255, 0.8)',
    borderRadius: 32,
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
    gap: 14,
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
    color: '#57534e',
    fontSize: 13,
    fontWeight: '700',
  },
  trackInfoPanel: {
    alignSelf: 'stretch',
    gap: 8,
  },
  playerControlDeck: {
    alignSelf: 'stretch',
    backgroundColor: 'rgba(255, 255, 255, 0.48)',
    borderColor: 'rgba(255, 255, 255, 0.72)',
    borderRadius: 28,
    borderWidth: 1,
    gap: 10,
    padding: 12,
  },
  playerUtilityGrid: {
    alignItems: 'stretch',
    alignSelf: 'stretch',
    gap: 10,
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
  lyricsCloseText: {
    color: '#f8fafc',
    fontSize: 28,
    fontWeight: '500',
    includeFontPadding: false,
    lineHeight: 30,
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
    backgroundColor: '#e8e8e4',
    borderColor: 'rgba(24, 24, 27, 0.08)',
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
    backgroundColor: 'rgba(255, 255, 255, 0.38)',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  artworkFallbackText: {
    color: '#737373',
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: 3,
  },
  artworkFallbackTextLyrics: {
    fontSize: 20,
    letterSpacing: 2,
  },
  artworkGlow: {
    backgroundColor: 'rgba(255, 255, 255, 0.5)',
    borderRadius: 999,
    height: 14,
    opacity: 0.42,
    position: 'absolute',
    top: 0,
    width: '58%',
  },
  playerConnectionChip: {
    backgroundColor: 'rgba(255, 255, 255, 0.74)',
    borderColor: 'rgba(255, 255, 255, 0.86)',
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
    backgroundColor: 'rgba(254, 242, 242, 0.9)',
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
    color: '#27272a',
    flex: 1,
    fontSize: 12,
    fontWeight: '900',
  },
  playerConnectionTextError: {
    color: '#dc2626',
  },
  playerConnectionDetail: {
    color: '#706b66',
    fontSize: 10,
    fontWeight: '700',
  },
  playerConnectionDetailError: {
    color: '#b91c1c',
  },
  trackTitle: {
    color: '#18181b',
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
    color: '#706b66',
    fontSize: 14,
    textAlign: 'center',
  },
  playbackTagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    justifyContent: 'center',
    minHeight: 24,
  },
  playbackTagRowLyrics: {
    justifyContent: 'flex-start',
    minHeight: 0,
  },
  playbackTag: {
    borderColor: 'rgba(24, 24, 27, 0.12)',
    borderRadius: 999,
    borderWidth: 1,
    color: '#3f3f46',
    fontSize: 10,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  outputSwitch: {
    alignSelf: 'stretch',
    backgroundColor: 'rgba(255, 255, 255, 0.56)',
    borderColor: 'rgba(39, 39, 42, 0.08)',
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
    minHeight: 42,
    justifyContent: 'center',
    overflow: 'hidden',
    paddingHorizontal: 10,
    position: 'relative',
  },
  outputSwitchButtonActive: {
    backgroundColor: '#ffffff',
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
  },
  outputSwitchText: {
    color: '#706b66',
    fontSize: 13,
    fontWeight: '800',
  },
  outputSwitchTextActive: {
    color: '#18181b',
  },
  phoneAudioError: {
    alignSelf: 'stretch',
    color: '#9f1239',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  progressTrack: {
    backgroundColor: 'rgba(24, 24, 27, 0.12)',
    borderRadius: 999,
    height: 8,
    overflow: 'hidden',
    width: '100%',
  },
  compactProgressTrack: {
    height: 8,
  },
  sliderTouchArea: {
    justifyContent: 'center',
    minHeight: 42,
    position: 'relative',
    width: '100%',
  },
  compactSliderTouchArea: {
    minHeight: 40,
  },
  progressFill: {
    backgroundColor: '#18181b',
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
    color: '#706b66',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  lyricsControlPanel: {
    alignSelf: 'stretch',
    gap: 12,
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
    minHeight: 278,
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
    gap: 16,
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
    gap: 10,
    justifyContent: 'center',
    width: '100%',
  },
  secondaryControlsRowCompact: {
    gap: 8,
    justifyContent: 'flex-start',
  },
  roundButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.7)',
    borderColor: 'rgba(255, 255, 255, 0.84)',
    borderRadius: 999,
    borderWidth: 1,
    height: 54,
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    width: 54,
  },
  roundButtonLyrics: {
    height: 54,
    width: 54,
  },
  roundButtonText: {
    color: '#27272a',
    fontSize: 34,
    fontWeight: '900',
    includeFontPadding: false,
    lineHeight: 38,
    textAlign: 'center',
  },
  roundButtonTextLyrics: {
    fontSize: 34,
  },
  playButton: {
    alignItems: 'center',
    backgroundColor: '#18181b',
    borderRadius: 999,
    height: 86,
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.2,
    shadowRadius: 24,
    width: 86,
  },
  playButtonLyrics: {
    height: 88,
    width: 88,
  },
  playButtonText: {
    color: '#ffffff',
    fontSize: 30,
    fontWeight: '900',
    includeFontPadding: false,
    lineHeight: 31,
    textAlign: 'center',
  },
  playButtonTextLyrics: {
    fontSize: 31,
  },
  playButtonTextPlay: {
    paddingLeft: 3,
  },
  repeatButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.66)',
    borderColor: 'rgba(255, 255, 255, 0.82)',
    borderRadius: 999,
    borderWidth: 1,
    height: 48,
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
    width: 48,
  },
  repeatButtonCompact: {
    height: 42,
    width: 42,
  },
  repeatButtonActive: {
    backgroundColor: '#18181b',
    borderColor: '#18181b',
  },
  repeatButtonIcon: {
    color: '#27272a',
    fontSize: 21,
    fontWeight: '900',
    includeFontPadding: false,
    lineHeight: 23,
    textAlign: 'center',
  },
  repeatButtonIconActive: {
    color: '#ffffff',
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
    backgroundColor: 'rgba(255, 255, 255, 0.66)',
    borderColor: 'rgba(255, 255, 255, 0.82)',
    borderRadius: 999,
    borderWidth: 1,
    height: 48,
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
    width: 48,
  },
  lyricsButtonCompact: {
    height: 42,
    width: 42,
  },
  lyricsButtonActive: {
    backgroundColor: '#18181b',
    borderColor: '#18181b',
  },
  lyricsButtonText: {
    color: '#27272a',
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
    backgroundColor: 'rgba(255, 255, 255, 0.66)',
    borderColor: 'rgba(255, 255, 255, 0.82)',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 5,
    height: 48,
    justifyContent: 'center',
    overflow: 'hidden',
    minWidth: 62,
    paddingHorizontal: 13,
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
    backgroundColor: '#ffffff',
    borderColor: 'rgba(24, 24, 27, 0.18)',
  },
  playlistMiniIcon: {
    color: '#18181b',
    fontSize: 16,
    fontWeight: '900',
    includeFontPadding: false,
    lineHeight: 19,
  },
  playlistMiniCount: {
    color: '#706b66',
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
    backgroundColor: 'rgba(245, 245, 245, 0.38)',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  playlistPopover: {
    alignSelf: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderColor: 'rgba(39, 39, 42, 0.1)',
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
  playlistPopoverEyebrow: {
    color: '#8a8178',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  playlistPopoverTitle: {
    color: '#18181b',
    fontSize: 19,
    fontWeight: '900',
  },
  playlistCloseButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(244, 244, 245, 0.92)',
    borderRadius: 999,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  playlistCloseText: {
    color: '#3f3f46',
    fontSize: 22,
    fontWeight: '600',
    lineHeight: 24,
  },
  playlistPopoverList: {
    gap: 0,
  },
  playlistItem: {
    alignItems: 'center',
    borderBottomColor: 'rgba(39, 39, 42, 0.07)',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 52,
    paddingVertical: 9,
  },
  playlistItemActive: {
    backgroundColor: 'rgba(24, 24, 27, 0.06)',
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
    color: '#18181b',
  },
  playlistText: {
    flex: 1,
    gap: 2,
  },
  playlistTitle: {
    color: '#18181b',
    fontSize: 14,
    fontWeight: '800',
  },
  playlistTitleActive: {
    color: '#18181b',
  },
  playlistMeta: {
    color: '#706b66',
    fontSize: 12,
  },
  playlistEmpty: {
    color: '#706b66',
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
  volumePanel: {
    gap: 6,
    width: '100%',
  },
  volumeHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  volumeValue: {
    color: '#18181b',
    fontSize: 14,
    fontWeight: '900',
  },
  volumeTrack: {
    backgroundColor: '#e5e5e5',
    borderRadius: 999,
    height: 12,
    overflow: 'hidden',
  },
  compactVolumeTrack: {
    backgroundColor: 'rgba(228, 228, 231, 0.92)',
    height: 7,
  },
  volumeFill: {
    backgroundColor: '#18181b',
    borderRadius: 999,
    height: '100%',
  },
  compactVolumeShell: {
    alignItems: 'flex-end',
    gap: 7,
    minWidth: 92,
  },
  volumeMiniButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.74)',
    borderColor: 'rgba(255, 255, 255, 0.86)',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    height: 40,
    justifyContent: 'center',
    overflow: 'hidden',
    paddingHorizontal: 12,
    position: 'relative',
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.07,
    shadowRadius: 16,
  },
  volumeMiniButtonActive: {
    backgroundColor: '#ffffff',
    borderColor: 'rgba(24, 24, 27, 0.1)',
  },
  volumeMiniIcon: {
    color: '#71717a',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  volumeMiniValue: {
    color: '#18181b',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
  },
  volumeExpandedPanel: {
    backgroundColor: 'rgba(255, 255, 255, 0.78)',
    borderColor: 'rgba(255, 255, 255, 0.88)',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 5,
    width: 112,
  },
  libraryList: {
    gap: 0,
  },
  libraryPage: {
    gap: 12,
  },
  librarySearchRow: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.46)',
    borderColor: 'rgba(255, 255, 255, 0.74)',
    borderRadius: 24,
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
    backgroundColor: 'rgba(255, 255, 255, 0.62)',
    borderColor: 'rgba(255, 255, 255, 0.82)',
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
  libraryRefreshIcon: {
    color: '#27272a',
    fontSize: 15,
    fontWeight: '900',
    includeFontPadding: false,
    lineHeight: 16,
  },
  libraryRefreshText: {
    color: '#27272a',
    fontSize: 14,
    fontWeight: '800',
  },
  trackRow: {
    alignItems: 'center',
    borderBottomColor: 'rgba(39, 39, 42, 0.065)',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 13,
    minHeight: 72,
    paddingHorizontal: 2,
    paddingVertical: 12,
  },
  libraryArtwork: {
    alignItems: 'center',
    backgroundColor: '#eeeeeb',
    borderColor: 'rgba(255, 255, 255, 0.82)',
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
  libraryArtworkText: {
    color: '#71717a',
    fontSize: 16,
    fontWeight: '900',
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
    color: '#18181b',
    fontSize: 15,
    fontWeight: '800',
  },
  listMeta: {
    color: '#706b66',
    fontSize: 12,
  },
  libraryTagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
  },
  libraryTag: {
    borderColor: 'rgba(24, 24, 27, 0.12)',
    borderRadius: 999,
    borderWidth: 1,
    color: '#52525b',
    fontSize: 10,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  playInline: {
    color: '#52525b',
    fontSize: 20,
    fontWeight: '900',
    includeFontPadding: false,
    lineHeight: 22,
  },
  dock: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.42)',
    borderColor: 'rgba(255, 255, 255, 0.88)',
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
  dockItem: {
    alignItems: 'center',
    borderRadius: 26,
    flex: 1,
    gap: 4,
    minHeight: 58,
    justifyContent: 'center',
    overflow: 'hidden',
    paddingVertical: 9,
    position: 'relative',
  },
  dockItemActive: {
    backgroundColor: 'rgba(255, 255, 255, 0.74)',
    borderColor: 'rgba(24, 24, 27, 0.06)',
    borderWidth: 1,
    shadowColor: '#18181b',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 18,
  },
  dockIcon: {
    color: '#77736d',
    fontSize: 20,
    fontWeight: '900',
    includeFontPadding: false,
    lineHeight: 23,
  },
  dockIconActive: {
    color: '#18181b',
  },
  dockLabel: {
    color: '#77736d',
    fontSize: 11,
    fontWeight: '800',
  },
  dockLabelActive: {
    color: '#18181b',
  },
});
