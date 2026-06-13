import type { EchoLinkConnection } from './client';

const normalizeScheme = (value: string | null): EchoLinkConnection['scheme'] =>
  value === 'https' ? 'https' : 'http';

export const parsePairingUri = (input: string): EchoLinkConnection => {
  const raw = input.trim();
  if (!raw) {
    throw new Error('请先粘贴电脑端生成的 echo://pair 链接。');
  }

  const url = new URL(raw);
  if (url.protocol !== 'echo:' || url.hostname !== 'pair') {
    throw new Error('这不是有效的 ECHO Link 配对链接。');
  }

  const host = url.searchParams.get('host')?.trim() ?? '';
  const token = url.searchParams.get('token')?.trim() ?? '';
  const port = Number(url.searchParams.get('port') ?? 26789);
  if (!host || !token) {
    throw new Error('配对链接缺少 host 或 token。');
  }

  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 26789,
    token,
    name: url.searchParams.get('name')?.trim() || 'PC ECHO',
    scheme: normalizeScheme(url.searchParams.get('scheme')),
  };
};
