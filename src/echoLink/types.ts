export type EchoLinkPlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error';

export type EchoLinkDevice = {
  id: string;
  name: string;
};

export type EchoLinkTrackPreview = {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  artworkUrl: string | null;
  durationMs: number;
  sourceLabel: string;
  canPlayOnPhone: boolean;
};

export type EchoLinkAlbumPreview = {
  id: string;
  title: string;
  albumArtist: string;
  artworkUrl: string | null;
  trackCount: number;
  durationMs: number;
  sourceLabel: string;
  year: number | null;
};

export type EchoLinkQueuePreview = {
  currentTrackId: string | null;
  items: EchoLinkTrackPreview[];
};

export type EchoLinkPlayback = {
  state: EchoLinkPlaybackState;
  track: EchoLinkTrackPreview | null;
  positionMs: number;
  durationMs: number;
  volume: number;
  outputMode: string;
  updatedAtEpochMs: number;
  queue?: EchoLinkQueuePreview;
};

export type EchoLinkStatusResponse = {
  device: EchoLinkDevice;
  playback: EchoLinkPlayback;
};

export type EchoLinkLibraryTracksResponse = {
  tracks: EchoLinkTrackPreview[];
  totalCount: number;
};

export type EchoLinkLibraryAlbumsResponse = {
  albums: EchoLinkAlbumPreview[];
  totalCount: number;
};

export type EchoLinkLibraryAlbumTracksResponse = {
  album: EchoLinkAlbumPreview;
  tracks: EchoLinkTrackPreview[];
  totalCount: number;
};

export type EchoLinkStreamResponse = {
  streamUrl: string;
  expiresAtEpochMs: number;
  track: EchoLinkTrackPreview;
};

export type EchoLinkPlaybackCommand =
  | { command: 'playPause' }
  | { command: 'next' }
  | { command: 'previous' }
  | { command: 'stop' }
  | { command: 'seekTo'; positionMs: number }
  | { command: 'setVolume'; volume: number }
  | { command: 'playTrack'; trackId: string; output: 'pc' }
  | { command: 'handoff'; trackId: string; positionMs: number; target: 'pc' }
  | { command: 'queueReplace'; trackIds: string[]; startTrackId?: string; output: 'pc' };
