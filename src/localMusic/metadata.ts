import * as FileSystem from 'expo-file-system/legacy';

export type ParsedAudioMetadata = {
  album?: string | null;
  albumArtist?: string | null;
  artist?: string | null;
  artworkUrl?: string | null;
  bitrate?: number | null;
  bitDepth?: number | null;
  codec?: string | null;
  durationMs?: number | null;
  sampleRate?: number | null;
  title?: string | null;
};

const maxMetadataBytes = 1024 * 1024;
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const base64Lookup = new Map(base64Alphabet.split('').map((char, index) => [char, index]));

const byte = (bytes: Uint8Array, offset: number): number => bytes[offset] ?? 0;

const ascii = (bytes: Uint8Array, offset: number, length: number): string => {
  let output = '';
  for (let index = 0; index < length && offset + index < bytes.length; index += 1) {
    output += String.fromCharCode(byte(bytes, offset + index));
  }
  return output;
};

const readU16LE = (bytes: Uint8Array, offset: number): number => (
  byte(bytes, offset) | (byte(bytes, offset + 1) << 8)
);

const readU32LE = (bytes: Uint8Array, offset: number): number => (
  byte(bytes, offset) | (byte(bytes, offset + 1) << 8) | (byte(bytes, offset + 2) << 16) | (byte(bytes, offset + 3) << 24)
) >>> 0;

const readU24BE = (bytes: Uint8Array, offset: number): number => (
  (byte(bytes, offset) << 16) | (byte(bytes, offset + 1) << 8) | byte(bytes, offset + 2)
);

const readU32BE = (bytes: Uint8Array, offset: number): number => (
  ((byte(bytes, offset) << 24) | (byte(bytes, offset + 1) << 16) | (byte(bytes, offset + 2) << 8) | byte(bytes, offset + 3)) >>> 0
);

const readSynchsafe = (bytes: Uint8Array, offset: number): number => (
  (byte(bytes, offset) << 21) | (byte(bytes, offset + 1) << 14) | (byte(bytes, offset + 2) << 7) | byte(bytes, offset + 3)
);

const cleanText = (value: string): string | null => {
  const cleaned = value.replace(/\0/gu, '').trim();
  return cleaned || null;
};

const decodeLatin1 = (bytes: Uint8Array): string => {
  let output = '';
  for (const value of bytes) {
    output += String.fromCharCode(value);
  }
  return output;
};

const decodeUtf8 = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return decodeLatin1(bytes);
  }
};

const decodeUtf16 = (bytes: Uint8Array, defaultBigEndian = false): string => {
  let offset = 0;
  let bigEndian = defaultBigEndian;
  if (bytes.length >= 2 && byte(bytes, 0) === 0xfe && byte(bytes, 1) === 0xff) {
    bigEndian = true;
    offset = 2;
  } else if (bytes.length >= 2 && byte(bytes, 0) === 0xff && byte(bytes, 1) === 0xfe) {
    bigEndian = false;
    offset = 2;
  }

  const units: number[] = [];
  for (let index = offset; index + 1 < bytes.length; index += 2) {
    units.push(bigEndian ? (byte(bytes, index) << 8) | byte(bytes, index + 1) : byte(bytes, index) | (byte(bytes, index + 1) << 8));
  }
  return String.fromCharCode(...units);
};

const decodeId3Text = (bytes: Uint8Array): string | null => {
  const encoding = byte(bytes, 0);
  const payload = bytes.subarray(1);
  if (encoding === 1) {
    return cleanText(decodeUtf16(payload));
  }
  if (encoding === 2) {
    return cleanText(decodeUtf16(payload, true));
  }
  if (encoding === 3) {
    return cleanText(decodeUtf8(payload));
  }
  return cleanText(decodeLatin1(payload));
};

const base64ToBytes = (base64: string): Uint8Array => {
  const output: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of base64.replace(/\s/gu, '')) {
    if (char === '=') {
      break;
    }
    const value = base64Lookup.get(char);
    if (value === undefined) {
      continue;
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
    }
  }

  return Uint8Array.from(output);
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = byte(bytes, index);
    const second = index + 1 < bytes.length ? byte(bytes, index + 1) : 0;
    const third = index + 2 < bytes.length ? byte(bytes, index + 2) : 0;
    const value = (first << 16) | (second << 8) | third;
    output += base64Alphabet[(value >> 18) & 0x3f] ?? '';
    output += base64Alphabet[(value >> 12) & 0x3f] ?? '';
    output += index + 1 < bytes.length ? base64Alphabet[(value >> 6) & 0x3f] ?? '' : '=';
    output += index + 2 < bytes.length ? base64Alphabet[value & 0x3f] ?? '' : '=';
  }
  return output;
};

const dataUrl = (mime: string, bytes: Uint8Array): string | null => (
  bytes.length > 0 ? `data:${mime || 'image/jpeg'};base64,${bytesToBase64(bytes)}` : null
);

const readHeadBytes = async (uri: string, fileSize: number): Promise<Uint8Array> => {
  const length = Math.min(Math.max(fileSize, 0), maxMetadataBytes);
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
    length,
    position: 0,
  });
  return base64ToBytes(base64);
};

const mpeg1Layer3Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const mpeg2Layer3Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

const mp3SampleRates: Record<string, number[]> = {
  '1': [44100, 48000, 32000],
  '2': [22050, 24000, 16000],
  '2.5': [11025, 12000, 8000],
};

const parseMp3FrameInfo = (bytes: Uint8Array, offset: number, fileSize: number): ParsedAudioMetadata => {
  for (let index = offset; index + 4 < bytes.length; index += 1) {
    if (byte(bytes, index) !== 0xff || (byte(bytes, index + 1) & 0xe0) !== 0xe0) {
      continue;
    }
    const versionBits = (byte(bytes, index + 1) >> 3) & 0x03;
    const layerBits = (byte(bytes, index + 1) >> 1) & 0x03;
    const bitrateIndex = (byte(bytes, index + 2) >> 4) & 0x0f;
    const sampleRateIndex = (byte(bytes, index + 2) >> 2) & 0x03;
    const version = versionBits === 3 ? '1' : versionBits === 2 ? '2' : versionBits === 0 ? '2.5' : null;
    if (!version || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
      continue;
    }
    const bitrate = (version === '1' ? mpeg1Layer3Bitrates[bitrateIndex] : mpeg2Layer3Bitrates[bitrateIndex]) ?? null;
    const sampleRate = mp3SampleRates[version]?.[sampleRateIndex] ?? null;
    return {
      bitrate: bitrate ? bitrate * 1000 : null,
      durationMs: bitrate ? Math.round((fileSize * 8 / (bitrate * 1000)) * 1000) : null,
      sampleRate,
    };
  }
  return {};
};

const parseId3Apic = (frame: Uint8Array): string | null => {
  const encoding = byte(frame, 0);
  let offset = 1;
  const mimeEnd = frame.indexOf(0, offset);
  if (mimeEnd < 0) {
    return null;
  }
  const mime = decodeLatin1(frame.subarray(offset, mimeEnd));
  offset = mimeEnd + 2;
  if (encoding === 1 || encoding === 2) {
    while (offset + 1 < frame.length && !(byte(frame, offset) === 0 && byte(frame, offset + 1) === 0)) {
      offset += 2;
    }
    offset += 2;
  } else {
    while (offset < frame.length && byte(frame, offset) !== 0) {
      offset += 1;
    }
    offset += 1;
  }
  return dataUrl(mime, frame.subarray(offset));
};

const parseMp3 = (bytes: Uint8Array, fileSize: number): ParsedAudioMetadata => {
  const metadata: ParsedAudioMetadata = { codec: 'MP3' };
  let audioOffset = 0;

  if (ascii(bytes, 0, 3) === 'ID3' && bytes.length >= 10) {
    const version = byte(bytes, 3);
    const tagSize = readSynchsafe(bytes, 6);
    let offset = 10;
    audioOffset = Math.min(bytes.length, 10 + tagSize);

    while (offset + 10 <= audioOffset) {
      const frameId = ascii(bytes, offset, 4);
      const frameSize = version === 4 ? readSynchsafe(bytes, offset + 4) : readU32BE(bytes, offset + 4);
      const frameStart = offset + 10;
      const frameEnd = Math.min(frameStart + frameSize, bytes.length);
      if (!frameId.trim() || frameSize <= 0 || frameEnd <= frameStart) {
        break;
      }
      const frame = bytes.subarray(frameStart, frameEnd);
      if (frameId === 'TIT2') {
        metadata.title = decodeId3Text(frame);
      } else if (frameId === 'TPE1') {
        metadata.artist = decodeId3Text(frame);
      } else if (frameId === 'TALB') {
        metadata.album = decodeId3Text(frame);
      } else if (frameId === 'TPE2') {
        metadata.albumArtist = decodeId3Text(frame);
      } else if (frameId === 'TLEN') {
        const duration = Number(decodeId3Text(frame));
        metadata.durationMs = Number.isFinite(duration) && duration > 0 ? Math.round(duration) : metadata.durationMs;
      } else if (frameId === 'APIC' && !metadata.artworkUrl) {
        metadata.artworkUrl = parseId3Apic(frame);
      }
      offset = frameEnd;
    }
  }

  const frameInfo = parseMp3FrameInfo(bytes, audioOffset, fileSize);
  return { ...frameInfo, ...metadata, durationMs: metadata.durationMs ?? frameInfo.durationMs };
};

const parseFlac = (bytes: Uint8Array): ParsedAudioMetadata => {
  const metadata: ParsedAudioMetadata = { codec: 'FLAC' };
  if (ascii(bytes, 0, 4) !== 'fLaC') {
    return metadata;
  }

  let offset = 4;
  let last = false;
  while (!last && offset + 4 <= bytes.length) {
    const header = byte(bytes, offset);
    last = Boolean(header & 0x80);
    const type = header & 0x7f;
    const length = readU24BE(bytes, offset + 1);
    const start = offset + 4;
    const end = Math.min(start + length, bytes.length);
    const block = bytes.subarray(start, end);

    if (type === 0 && block.length >= 34) {
      const sampleRate = (byte(block, 10) << 12) | (byte(block, 11) << 4) | (byte(block, 12) >> 4);
      const bitDepth = (((byte(block, 12) & 0x01) << 4) | (byte(block, 13) >> 4)) + 1;
      const totalSamples = ((byte(block, 13) & 0x0f) * 2 ** 32) + readU32BE(block, 14);
      metadata.sampleRate = sampleRate || null;
      metadata.bitDepth = bitDepth || null;
      metadata.durationMs = sampleRate && totalSamples ? Math.round((totalSamples / sampleRate) * 1000) : null;
    } else if (type === 4 && block.length >= 8) {
      let commentOffset = 0;
      const vendorLength = readU32LE(block, commentOffset);
      commentOffset += 4 + vendorLength;
      const count = readU32LE(block, commentOffset);
      commentOffset += 4;
      for (let index = 0; index < count && commentOffset + 4 <= block.length; index += 1) {
        const commentLength = readU32LE(block, commentOffset);
        commentOffset += 4;
        const comment = decodeUtf8(block.subarray(commentOffset, commentOffset + commentLength));
        commentOffset += commentLength;
        const separator = comment.indexOf('=');
        if (separator <= 0) {
          continue;
        }
        const key = comment.slice(0, separator).toUpperCase();
        const value = cleanText(comment.slice(separator + 1));
        if (key === 'TITLE') {
          metadata.title = value;
        } else if (key === 'ARTIST') {
          metadata.artist = value;
        } else if (key === 'ALBUM') {
          metadata.album = value;
        } else if (key === 'ALBUMARTIST' || key === 'ALBUM ARTIST') {
          metadata.albumArtist = value;
        }
      }
    } else if (type === 6 && block.length >= 32 && !metadata.artworkUrl) {
      let pictureOffset = 4;
      const mimeLength = readU32BE(block, pictureOffset);
      pictureOffset += 4;
      const mime = decodeLatin1(block.subarray(pictureOffset, pictureOffset + mimeLength));
      pictureOffset += mimeLength;
      const descriptionLength = readU32BE(block, pictureOffset);
      pictureOffset += 4 + descriptionLength + 16;
      const dataLength = readU32BE(block, pictureOffset);
      pictureOffset += 4;
      metadata.artworkUrl = dataUrl(mime, block.subarray(pictureOffset, pictureOffset + dataLength));
    }

    offset = start + length;
  }

  return metadata;
};

const parseWav = (bytes: Uint8Array): ParsedAudioMetadata => {
  const metadata: ParsedAudioMetadata = { codec: 'WAV' };
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    return metadata;
  }

  let offset = 12;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const chunkId = ascii(bytes, offset, 4);
    const chunkSize = readU32LE(bytes, offset + 4);
    const start = offset + 8;
    if (chunkId === 'fmt ' && start + 16 <= bytes.length) {
      metadata.sampleRate = readU32LE(bytes, start + 4);
      metadata.bitrate = readU32LE(bytes, start + 8) * 8;
      metadata.bitDepth = readU16LE(bytes, start + 14);
    } else if (chunkId === 'data') {
      dataSize = chunkSize;
    }
    offset = start + chunkSize + (chunkSize % 2);
  }
  if (metadata.bitrate && dataSize) {
    metadata.durationMs = Math.round((dataSize * 8 / metadata.bitrate) * 1000);
  }
  return metadata;
};

type Mp4Box = {
  end: number;
  payload: number;
  type: string;
};

const readMp4Boxes = (bytes: Uint8Array, start: number, end: number): Mp4Box[] => {
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset + 8 <= end && offset + 8 <= bytes.length) {
    const size = readU32BE(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const boxEnd = size === 0 ? end : offset + size;
    if (size < 8 || boxEnd > end || boxEnd > bytes.length) {
      break;
    }
    boxes.push({ end: boxEnd, payload: offset + 8, type });
    offset = boxEnd;
  }
  return boxes;
};

const parseMp4DataBox = (bytes: Uint8Array, item: Mp4Box): Uint8Array | null => {
  const dataBox = readMp4Boxes(bytes, item.payload, item.end).find((box) => box.type === 'data');
  return dataBox && dataBox.payload + 8 <= dataBox.end ? bytes.subarray(dataBox.payload + 8, dataBox.end) : null;
};

const parseM4a = (bytes: Uint8Array, extension: string): ParsedAudioMetadata => {
  const metadata: ParsedAudioMetadata = { codec: extension === 'alac' ? 'ALAC' : 'AAC' };

  const walk = (start: number, end: number): void => {
    for (const box of readMp4Boxes(bytes, start, end)) {
      if (box.type === 'mvhd' && box.payload + 20 <= box.end) {
        const version = byte(bytes, box.payload);
        const timescaleOffset = version === 1 ? box.payload + 20 : box.payload + 12;
        const durationOffset = version === 1 ? box.payload + 24 : box.payload + 16;
        const timescale = readU32BE(bytes, timescaleOffset);
        const duration = version === 1
          ? readU32BE(bytes, durationOffset + 4)
          : readU32BE(bytes, durationOffset);
        metadata.durationMs = timescale ? Math.round((duration / timescale) * 1000) : metadata.durationMs;
      } else if (box.type === 'stsd' && box.payload + 16 <= box.end) {
        const entryStart = box.payload + 8;
        const codec = ascii(bytes, entryStart + 4, 4);
        metadata.codec = codec === 'alac' ? 'ALAC' : codec === 'mp4a' ? 'AAC' : metadata.codec;
        const sampleSize = readU16BE(bytes, entryStart + 26);
        const sampleRate = readU32BE(bytes, entryStart + 32) >> 16;
        metadata.bitDepth = sampleSize || metadata.bitDepth;
        metadata.sampleRate = sampleRate || metadata.sampleRate;
      } else if (box.type === 'meta') {
        walk(box.payload + 4, box.end);
      } else if (box.type === 'ilst') {
        for (const item of readMp4Boxes(bytes, box.payload, box.end)) {
          const data = parseMp4DataBox(bytes, item);
          if (!data) {
            continue;
          }
          const copyright = String.fromCharCode(0xa9);
          const text = cleanText(decodeUtf8(data));
          if (item.type === `${copyright}nam`) {
            metadata.title = text;
          } else if (item.type === `${copyright}ART`) {
            metadata.artist = text;
          } else if (item.type === `${copyright}alb`) {
            metadata.album = text;
          } else if (item.type === 'aART') {
            metadata.albumArtist = text;
          } else if (item.type === 'covr' && !metadata.artworkUrl) {
            const isPng = byte(data, 0) === 0x89 && ascii(data, 1, 3) === 'PNG';
            metadata.artworkUrl = dataUrl(isPng ? 'image/png' : 'image/jpeg', data);
          }
        }
      } else if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta'].includes(box.type)) {
        walk(box.payload, box.end);
      }
    }
  };

  walk(0, bytes.length);
  return metadata;
};

const readU16BE = (bytes: Uint8Array, offset: number): number => (
  (byte(bytes, offset) << 8) | byte(bytes, offset + 1)
);

const extensionOf = (fileName: string): string => {
  const match = /\.([^.]+)$/u.exec(fileName);
  return match?.[1]?.toLowerCase() ?? '';
};

export const parseAudioMetadata = async (
  uri: string,
  fileName: string,
  fileSize: number,
): Promise<ParsedAudioMetadata> => {
  try {
    const extension = extensionOf(fileName);
    const bytes = await readHeadBytes(uri, fileSize);
    if (extension === 'mp3' || ascii(bytes, 0, 3) === 'ID3') {
      return parseMp3(bytes, fileSize);
    }
    if (extension === 'flac' || ascii(bytes, 0, 4) === 'fLaC') {
      return parseFlac(bytes);
    }
    if (extension === 'wav') {
      return parseWav(bytes);
    }
    if (['aac', 'alac', 'm4a', 'mp4'].includes(extension)) {
      return parseM4a(bytes, extension);
    }
    return { codec: extension ? extension.toUpperCase() : null };
  } catch {
    const extension = extensionOf(fileName);
    return { codec: extension ? extension.toUpperCase() : null };
  }
};
