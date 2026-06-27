import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import type { EchoLinkTrackPreview } from '../echoLink/types';
import { parseAudioMetadata } from './metadata';

export type LocalMusicTrack = EchoLinkTrackPreview & {
  fileName: string;
  fileSize: number;
  hasLyrics: boolean;
  lyricsUri: string | null;
  uri: string;
};

export type LocalMusicImportResult = {
  importedCount: number;
  tracks: LocalMusicTrack[];
};

const localMusicDirectory = `${FileSystem.documentDirectory ?? ''}local-music/`;
const audioExtensions = new Set(['aac', 'aiff', 'alac', 'caf', 'flac', 'm4a', 'mp3', 'mp4', 'wav']);

const extensionOf = (name: string): string => {
  const match = /\.([^.]+)$/u.exec(name);
  return match?.[1]?.toLowerCase() ?? '';
};

const stemOf = (fileName: string): string => (
  fileName.replace(/\.[^.]+$/u, '')
);

const fileUriForName = (fileName: string): string => (
  `${localMusicDirectory}${encodeURIComponent(fileName)}`
);

const lyricsFileNameForTrack = (track: Pick<LocalMusicTrack, 'fileName'>): string => (
  `${stemOf(track.fileName)}.lrc`
);

const lyricsUriForTrack = (track: Pick<LocalMusicTrack, 'fileName'>): string => (
  fileUriForName(lyricsFileNameForTrack(track))
);

const titleFromFileName = (fileName: string): string => (
  fileName.replace(/^\d+-/u, '').replace(/\.[^.]+$/u, '').trim() || fileName
);

const sanitizeFileName = (name: string): string => (
  name.replace(/[\\/:*?"<>|#%]/gu, '_').replace(/\s+/gu, ' ').trim() || `track-${Date.now()}`
);

const ensureLocalMusicDirectory = async (): Promise<void> => {
  if (!FileSystem.documentDirectory) {
    throw new Error('无法访问 App 本地文件目录。');
  }
  await FileSystem.makeDirectoryAsync(localMusicDirectory, { intermediates: true }).catch(() => undefined);
};

const uniqueFileName = async (fileName: string): Promise<string> => {
  const extension = extensionOf(fileName);
  const stem = extension ? fileName.slice(0, -(extension.length + 1)) : fileName;
  let candidate = fileName;
  let index = 2;

  while ((await FileSystem.getInfoAsync(fileUriForName(candidate))).exists) {
    candidate = extension ? `${stem} ${index}.${extension}` : `${stem} ${index}`;
    index += 1;
  }

  return candidate;
};

const trackFromFileName = async (fileName: string): Promise<LocalMusicTrack> => {
  const extension = extensionOf(fileName);
  const uri = fileUriForName(fileName);
  const info = await FileSystem.getInfoAsync(uri).catch(() => null);
  const fileSize = info?.exists ? info.size : 0;
  const metadata = await parseAudioMetadata(uri, fileName, fileSize);
  const lyricsUri = lyricsUriForTrack({ fileName });
  const lyricsInfo = await FileSystem.getInfoAsync(lyricsUri).catch(() => null);
  const title = metadata.title ?? titleFromFileName(fileName);
  const artist = metadata.artist ?? '本地音乐';
  const album = metadata.album ?? '';

  return {
    album,
    albumArtist: metadata.albumArtist ?? artist,
    artist,
    artworkUrl: metadata.artworkUrl ?? null,
    bitrate: metadata.bitrate ?? null,
    bitDepth: metadata.bitDepth ?? null,
    canPlayOnPhone: true,
    codec: metadata.codec ?? (extension || null),
    durationMs: metadata.durationMs ?? 0,
    fileName,
    fileSize,
    hasLyrics: Boolean(lyricsInfo?.exists),
    id: `local:${fileName}`,
    lyricsUri: lyricsInfo?.exists ? lyricsUri : null,
    sampleRate: metadata.sampleRate ?? null,
    sourceLabel: 'Local Library',
    title,
    uri,
  };
};

export const scanLocalMusic = async (): Promise<LocalMusicTrack[]> => {
  await ensureLocalMusicDirectory();
  const fileNames = await FileSystem.readDirectoryAsync(localMusicDirectory).catch(() => []);

  return fileNames
    .filter((fileName) => audioExtensions.has(extensionOf(fileName)))
    .sort((a, b) => a.localeCompare(b))
    .reduce<Promise<LocalMusicTrack[]>>(async (promise, fileName) => {
      const tracks = await promise;
      tracks.push(await trackFromFileName(fileName));
      return tracks;
    }, Promise.resolve([]));
};

export const importLocalMusicFiles = async (): Promise<LocalMusicImportResult | null> => {
  await ensureLocalMusicDirectory();
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: true,
    type: 'audio/*',
  });

  if (result.canceled) {
    return null;
  }

  let importedCount = 0;
  for (const asset of result.assets) {
    const extension = extensionOf(asset.name);
    if (!audioExtensions.has(extension)) {
      continue;
    }
    const fileName = await uniqueFileName(sanitizeFileName(asset.name));
    await FileSystem.copyAsync({
      from: asset.uri,
      to: fileUriForName(fileName),
    });
    importedCount += 1;
  }

  return {
    importedCount,
    tracks: await scanLocalMusic(),
  };
};

export const deleteLocalMusicTrack = async (track: LocalMusicTrack): Promise<LocalMusicTrack[]> => {
  await ensureLocalMusicDirectory();
  await FileSystem.deleteAsync(track.uri, { idempotent: true });
  await FileSystem.deleteAsync(lyricsUriForTrack(track), { idempotent: true });
  return scanLocalMusic();
};

export const importLocalLyricFile = async (track: LocalMusicTrack): Promise<LocalMusicTrack[] | null> => {
  await ensureLocalMusicDirectory();
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: false,
    type: '*/*',
  });

  if (result.canceled) {
    return null;
  }

  const asset = result.assets[0];
  if (!asset) {
    return null;
  }

  await FileSystem.copyAsync({
    from: asset.uri,
    to: lyricsUriForTrack(track),
  });
  return scanLocalMusic();
};

export const readLocalLyrics = async (track: LocalMusicTrack): Promise<string | null> => {
  const uri = lyricsUriForTrack(track);
  const info = await FileSystem.getInfoAsync(uri).catch(() => null);
  if (!info?.exists) {
    return null;
  }
  const lyrics = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 });
  return lyrics.trim() || null;
};

export const getLocalMusicStorageUsage = async (): Promise<number> => {
  await ensureLocalMusicDirectory();
  const fileNames = await FileSystem.readDirectoryAsync(localMusicDirectory).catch(() => []);
  const sizes = await Promise.all(fileNames.map(async (fileName) => {
    const info = await FileSystem.getInfoAsync(fileUriForName(fileName)).catch(() => null);
    return info?.exists ? info.size : 0;
  }));
  return sizes.reduce((total, size) => total + size, 0);
};
