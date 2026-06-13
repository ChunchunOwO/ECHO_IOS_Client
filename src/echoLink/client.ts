import type {
  EchoLinkLibraryAlbumTracksResponse,
  EchoLinkLibraryAlbumsResponse,
  EchoLinkLibraryTracksResponse,
  EchoLinkPlaybackCommand,
  EchoLinkStatusResponse,
  EchoLinkStreamResponse,
} from './types';

export type EchoLinkConnection = {
  host: string;
  port: number;
  token: string;
  name: string;
  scheme: 'http' | 'https';
};

export class EchoLinkHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const linkVersion = '1';

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/gu, '');

export type EchoLinkClient = ReturnType<typeof createEchoLinkClient>;

export const createEchoLinkClient = (connection: EchoLinkConnection) => {
  const baseUrl = `${connection.scheme}://${connection.host}:${connection.port}`;

  const requestJson = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${connection.token}`);
    headers.set('x-echo-link-version', linkVersion);
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(`${baseUrl}/${trimSlashes(path)}`, {
      ...init,
      headers,
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) as unknown : null;
    if (!response.ok) {
      const message = typeof body === 'object' && body && 'message' in body
        ? String((body as { message: unknown }).message)
        : response.statusText;
      throw new EchoLinkHttpError(response.status, message);
    }
    return body as T;
  };

  return {
    connection,
    baseUrl,
    getStatus: () => requestJson<EchoLinkStatusResponse>('/echo-link/v1/status'),
    getLibraryTracks: ({ page = 1, pageSize = 40, query = '' }: { page?: number; pageSize?: number; query?: string } = {}) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      if (query.trim()) {
        params.set('q', query.trim());
      }
      return requestJson<EchoLinkLibraryTracksResponse>(`/echo-link/v1/library/tracks?${params.toString()}`);
    },
    getLibraryAlbums: ({ page = 1, pageSize = 40, query = '' }: { page?: number; pageSize?: number; query?: string } = {}) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      if (query.trim()) {
        params.set('q', query.trim());
      }
      return requestJson<EchoLinkLibraryAlbumsResponse>(`/echo-link/v1/library/albums?${params.toString()}`);
    },
    getLibraryAlbumTracks: (albumId: string, { page = 1, pageSize = 80 }: { page?: number; pageSize?: number } = {}) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      return requestJson<EchoLinkLibraryAlbumTracksResponse>(
        `/echo-link/v1/library/albums/${encodeURIComponent(albumId)}/tracks?${params.toString()}`,
      );
    },
    sendPlaybackCommand: (command: EchoLinkPlaybackCommand) =>
      requestJson<EchoLinkStatusResponse>('/echo-link/v1/playback/command', {
        method: 'POST',
        body: JSON.stringify(command),
      }),
    createPhoneStream: (trackId: string) =>
      requestJson<EchoLinkStreamResponse>(`/echo-link/v1/library/tracks/${encodeURIComponent(trackId)}/stream`, {
        method: 'POST',
        body: JSON.stringify({ target: 'phone' }),
      }),
    getLyrics: (trackId: string) =>
      requestJson<{ lyrics: string; sourceLabel: string; kind: string }>(
        `/echo-link/v1/library/tracks/${encodeURIComponent(trackId)}/lyrics`,
      ),
  };
};
