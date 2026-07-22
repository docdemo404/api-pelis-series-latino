import axios from 'axios';
import { USER_AGENT } from '../utils/httpClient';

/**
 * Verificación de salud de reproductores embed (capa de aplicación).
 * Extraído de realScraperService para separar la responsabilidad de
 * "¿este embed sigue vivo?" del scraping de catálogo en sí.
 */

const SOFT_ERROR_PATTERNS = [
  /file is no longer available/i,
  /expired or has been deleted/i,
  /player_blank\.jpg/i,
  /file not found/i,
  /file deleted/i,
  /video (has been|was) (deleted|removed)/i,
  /disabled due to copyright/i,
  /content removed/i,
  /video no disponible/i,
  /archivo (eliminado|no encontrado)/i,
  /file_deleted/i,
  /video_not_found/i,
  /404 not found/i,
  /this video (is|was) deleted/i,
  /media not found/i,
  /can't find the file/i,
  /we're sorry/i,
  /got deleted by the owner/i,
  /removed due a copyright/i,
  /copyright violation/i,
  /file you are looking for/i,
  /too many requests/i
];

/**
 * Verifica el estado real en la capa de aplicación de un iframe embed
 * (detecta Soft Errors HTTP 200 y distingue WAF HTTP 403).
 */
export async function verifyEmbedStatus(
  embedUrl: string,
  referer: string = 'https://tioplus.app'
): Promise<'online' | 'offline'> {
  if (!embedUrl) return 'offline';
  try {
    // 0. Detectar reproductores SPA basados en HASH (#hash_id) ej. upns.pro, rpmstream.live, 4meplayer.pro, strp2p.com
    const hashMatch = embedUrl.match(/https?:\/\/([^\/#]+)\/.*?#([a-zA-Z0-9_-]+)/);
    if (hashMatch) {
      const domain = hashMatch[1];
      const hashId = hashMatch[2];
      const apiUrl = `https://${domain}/api/v1/info?id=${hashId}`;
      try {
        const hashRes = await axios.get(apiUrl, {
          headers: { 'User-Agent': USER_AGENT, 'Referer': embedUrl },
          timeout: 4000,
          validateStatus: () => true
        });
        const dataStr = typeof hashRes.data === 'string' ? hashRes.data : JSON.stringify(hashRes.data || '');
        if (hashRes.status !== 200 || dataStr.length < 3600 || dataStr.includes('error') || dataStr.includes('not found')) {
          return 'offline';
        }
      } catch {
        return 'offline';
      }
    }

    const res = await axios.get(embedUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': referer,
      },
      timeout: 4000,
      validateStatus: () => true
    });

    // WAF / Anti-hotlink protection (ej. VidHide, StreamWish devuelven 403 Forbidden a scrapers automatizados pero funcionan 100% en navegador web)
    if (res.status === 403 || res.status === 401) {
      return 'online';
    }

    if (res.status >= 400) return 'offline';

    const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '');

    // Detectar mensajes de error en capa de aplicación (Soft Errors)
    for (const pattern of SOFT_ERROR_PATTERNS) {
      if (pattern.test(html)) {
        return 'offline';
      }
    }

    // Detectar redirecciones JS de window.location / document.location (ej. listeamed.net)
    const jsLocationMatch = html.match(/window\.location\.(?:replace|href)\s*=\s*['"]([^'"]+)['"]/i) ||
                            html.match(/document\.location\.(?:replace|href)\s*=\s*['"]([^'"]+)['"]/i);
    if (jsLocationMatch) {
      const redirectPath = jsLocationMatch[1];
      const targetUrl = redirectPath.startsWith('http') ? redirectPath : `${new URL(embedUrl).origin}${redirectPath}`;
      try {
        const jsRes = await axios.get(targetUrl, {
          headers: { 'User-Agent': USER_AGENT, 'Referer': embedUrl },
          timeout: 4000,
          validateStatus: () => true
        });

        if (jsRes.status >= 400 || jsRes.status === 429 || jsRes.status === 410) {
          return 'offline';
        }

        const jsHtml = typeof jsRes.data === 'string' ? jsRes.data : '';
        for (const pattern of SOFT_ERROR_PATTERNS) {
          if (pattern.test(jsHtml)) {
            return 'offline';
          }
        }
      } catch {
        return 'offline';
      }
    }

    // Detectar redirección de huella JS de Vudeo (var redirect_link = '...') y seguir la redirección final
    const vudeoMatch = html.match(/var\s+redirect_link\s*=\s*['"]([^'"]+)['"]/i);
    if (vudeoMatch) {
      const targetUrl = vudeoMatch[1] + 'fp=-7';
      try {
        const vudeoRes = await axios.get(targetUrl, {
          headers: { 'User-Agent': USER_AGENT, 'Referer': embedUrl },
          timeout: 4000,
          validateStatus: () => true
        });

        if (vudeoRes.status >= 400 || vudeoRes.status === 410) {
          return 'offline';
        }

        const vudeoHtml = typeof vudeoRes.data === 'string' ? vudeoRes.data : '';
        for (const pattern of SOFT_ERROR_PATTERNS) {
          if (pattern.test(vudeoHtml)) {
            return 'offline';
          }
        }
      } catch {
        return 'offline';
      }
    }

    // Inspeccionar iframe interno de nivel 2 si el reproductor está encapsulado (ej. waaw.to / netu)
    const innerIframeMatch = html.match(/iframe[^>]+src=["']([^"']+)["']/i);
    if (innerIframeMatch) {
      const innerPath = innerIframeMatch[1];
      const innerUrl = innerPath.startsWith('http') ? innerPath : `${new URL(embedUrl).origin}${innerPath}`;
      try {
        const innerRes = await axios.get(innerUrl, {
          headers: { 'User-Agent': USER_AGENT, 'Referer': embedUrl },
          timeout: 3000,
          validateStatus: () => true
        });

        if (innerRes.status >= 400 || innerRes.status === 410) {
          return 'offline';
        }

        const innerHtml = typeof innerRes.data === 'string' ? innerRes.data : '';
        for (const pattern of SOFT_ERROR_PATTERNS) {
          if (pattern.test(innerHtml)) {
            return 'offline';
          }
        }
      } catch {}
    }

    // HTML extremadamente corto sin reproductores
    if (html.length < 250 && !html.includes('jwplayer') && !html.includes('video') && !html.includes('iframe') && !html.includes('source') && !html.includes('script')) {
      return 'offline';
    }

    return 'online';
  } catch {
    if (embedUrl.includes('vidhide') || embedUrl.includes('streamwish') || embedUrl.includes('upns') || embedUrl.includes('waaw')) {
      return 'online';
    }
    return 'offline';
  }
}

/**
 * Extrae el nombre del servidor embed a partir de su URL o label
 */
export function getServerName(url: string, label?: string): string {
  if (label) return label.trim();
  const host = url.toLowerCase();
  if (host.includes('vidhide')) return 'VidHide';
  if (host.includes('streamwish')) return 'Streamwish';
  if (host.includes('filelions')) return 'FileLions';
  if (host.includes('voe')) return 'Voe';
  if (host.includes('doodstream') || host.includes('dood')) return 'DoodStream';
  if (host.includes('upstream')) return 'Upstream';
  if (host.includes('mp4upload')) return 'MP4Upload';
  if (host.includes('upfast') || host.includes('upf')) return 'UPFAST';
  if (host.includes('earnvids')) return 'Earnvids';
  if (host.includes('p2p')) return 'P2P';
  if (host.includes('mixdrop')) return 'MixDrop';
  if (host.includes('lulustream')) return 'LuluStream';
  return 'Servidor Latino';
}
