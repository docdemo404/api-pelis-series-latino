/**
 * NUVE+ — buena fuente Latino. Addon de Stremio que resuelve por IMDB id a una URL de `play` que hace
 * 302 a su CDN (apollobox): MKV directo, con Range, en 1080p H264/H265 y 4K H265 HDR10, audio Latino.
 * `notWebReady:false` → listo para Media3.
 *
 * Se resuelve EN VIVO al reproducir: la URL de `play` es efímera (token `intent` que rota cada vez),
 * así que no se guarda; se pide fresca en cada reproducción. El token de la ruta de instalación puede
 * caducar (hay login por API para renovarlo); por eso la base es configurable por entorno.
 *
 * No se puede acceder a apollobox por fuera del addon (sus URLs son firmadas y efímeras), así que la
 * durabilidad real de un título se consigue INGIRIÉNDOLO a R2/B2 con el subidor, no dependiendo de aquí.
 */
import { httpClient } from '../utils/httpClient';

export const BASE_NUVEPLUS =
  process.env.NUVEPLUS_BASE ||
  'https://plus.nuvehub.app/LPT3zVBpxBXw5ucWVHb0Ouo8D0Am3e4Ik8oA6g3YPUD_QP9VFfrLp9GHImEi4H5g';

export interface StreamNuvePlus {
  url: string;
  titulo: string;
  idioma: 'latino' | 'ingles' | 'otro';
  calidad: string; // '4k' | '1080' | '720' | ''
  codec: string;   // 'h265' | 'h264' | ''
}

function idiomaDe(t: string): StreamNuvePlus['idioma'] {
  const s = t.toLowerCase();
  // El addon marca los audios con banderas/códigos: 🇲🇽 ES = Latino, 🇺🇸 EN = inglés.
  if (s.includes('🇲🇽') || /\bes\b/.test(s) || s.includes('latino')) return 'latino';
  if (s.includes('🇺🇸') || /\ben\b/.test(s) || s.includes('ingl')) return 'ingles';
  return 'otro';
}

function calidadDe(t: string): string {
  const s = t.toLowerCase();
  if (s.includes('4k') || s.includes('2160')) return '4k';
  if (s.includes('1080')) return '1080';
  if (s.includes('720')) return '720';
  return '';
}

function codecDe(t: string): string {
  const s = t.toLowerCase();
  if (s.includes('h265') || s.includes('hevc')) return 'h265';
  if (s.includes('h264') || s.includes('avc')) return 'h264';
  return '';
}

/** Id de Stremio: película = ttID; serie = ttID:temporada:capitulo. */
export function idDeStremio(imdbId: string, temporada?: number, capitulo?: number): string {
  return temporada && capitulo ? `${imdbId}:${temporada}:${capitulo}` : imdbId;
}

/**
 * Resuelve los streams de un título por su IMDB id. Devuelve las URLs de `play` (frescas), con el
 * Latino y la mayor calidad primero. La URL hace 302 al CDN al reproducir.
 */
export async function resolverNuvePlus(
  imdbId: string,
  tipo: 'movie' | 'series',
  temporada?: number,
  capitulo?: number,
): Promise<StreamNuvePlus[]> {
  if (!/^tt\d+$/.test(imdbId)) return [];
  const id = idDeStremio(imdbId, temporada, capitulo);
  const url = `${BASE_NUVEPLUS}/stream/${tipo}/${encodeURIComponent(id)}.json`;
  try {
    const r = await httpClient.get(url, { timeout: 15000, validateStatus: () => true });
    if (r.status !== 200) return [];
    const streams: any[] = Array.isArray(r.data?.streams) ? r.data.streams : [];
    const out: StreamNuvePlus[] = [];
    for (const s of streams) {
      const u = String(s?.url || '');
      if (!u || !/^https?:\/\//i.test(u)) continue;
      const titulo = String(s?.title || '').replace(/\s+/g, ' ').trim();
      out.push({ url: u, titulo, idioma: idiomaDe(titulo), calidad: calidadDe(titulo), codec: codecDe(titulo) });
    }
    // Latino primero; dentro, 4k > 1080 > 720; a igualdad, HEVC (pesa menos) antes.
    const peso = (s: StreamNuvePlus) =>
      (s.idioma === 'latino' ? 0 : s.idioma === 'otro' ? 1 : 2) * 100 +
      (s.calidad === '4k' ? 0 : s.calidad === '1080' ? 1 : s.calidad === '720' ? 2 : 3) * 10 +
      (s.codec === 'h265' ? 0 : 1);
    return out.sort((a, b) => peso(a) - peso(b));
  } catch {
    return [];
  }
}

export function esUrlDeNuvePlus(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h.includes('nuvehub') || h.includes('apollobox');
  } catch {
    return false;
  }
}
