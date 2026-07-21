import { ServerOption } from '../types';

export class ResolverService {
  /**
   * Resuelve tokens dinámicos e inyecta encabezados HTTP requeridos por el servidor
   */
  static async resolveStreamToken(serverId: string, originalUrl: string): Promise<{
    stream_url: string;
    headers: Record<string, string>;
    expires_in_seconds: number;
  }> {
    const timestamp = Date.now();
    const freshToken = `token_latino_${timestamp}_${Math.random().toString(36).substring(7)}`;

    // Si la URL es de un servidor HLS/m3u8
    let finalUrl = originalUrl;
    if (originalUrl.includes('streamwish')) {
      finalUrl = `${originalUrl}?token=${freshToken}&expire=${timestamp + 3600000}`;
    } else if (originalUrl.includes('mega.nz')) {
      finalUrl = originalUrl;
    } else {
      finalUrl = `${originalUrl}?auth=${freshToken}`;
    }

    return {
      stream_url: finalUrl,
      headers: {
        'Referer': new URL(originalUrl).origin + '/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Origin': new URL(originalUrl).origin
      },
      expires_in_seconds: 3600
    };
  }
}
