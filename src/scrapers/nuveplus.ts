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
import { TMDB_API_KEY } from '../services/tmdbService';
import { ServerOption } from '../types';

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

/**
 * El stream que se entrega: Latino, y dentro 1080p antes que 4K y H264 antes que H265.
 *
 * Al revés que el orden de `resolverNuvePlus` a propósito: aquí no se elige lo mejor que hay, sino
 * lo que abre en cualquier aparato sin cortarse. El 4K HEVC pesa el doble y no todos los móviles
 * lo decodifican; el 1080p H264 sí. Medido el 2026-10-01: «Los Simpson» 1x1 solo trae 1080p H264,
 * y las películas traen 4K y 1080p, los dos HEVC.
 */
export function elegirStream(streams: StreamNuvePlus[]): StreamNuvePlus | null {
  const latinos = streams.filter((s) => s.idioma === 'latino');
  if (!latinos.length) return null;
  const peso = (s: StreamNuvePlus) =>
    (s.calidad === '1080' ? 0 : s.calidad === '720' ? 1 : s.calidad === '4k' ? 2 : 3) * 10 +
    (s.codec === 'h264' ? 0 : s.codec === '' ? 1 : 2);
  return [...latinos].sort((a, b) => peso(a) - peso(b))[0];
}

/** La ruta ESTABLE de esta API que resuelve al pulsar Play (ver src/routes/addons.routes.ts). */
export function rutaNuvePlus(imdbId: string, temporada?: number, capitulo?: number): string {
  return `/api/v1/addon/nuveplus/${imdbId}${temporada && capitulo ? `/${temporada}/${capitulo}` : ''}`;
}

/**
 * El servidor VIRTUAL que se cuelga de la ficha, como el de NetMirror.
 *
 * No se entrega la url de `play`: lleva un token que el addon acuña en cada consulta y no se sabe
 * cuánto vive (a los 90 s seguía valiendo, medido), mientras que las respuestas de esta API se
 * cachean. Se entrega nuestra ruta estable, que la pide fresca y contesta 302. El sello es de ahora
 * porque el addon acaba de contestar con un stream Latino para esta obra.
 */
export function servidorNuvePlus(
  imdbId: string,
  stream: StreamNuvePlus,
  temporada?: number,
  capitulo?: number,
): ServerOption {
  const ruta = rutaNuvePlus(imdbId, temporada, capitulo);
  const alto = stream.calidad === '4k' ? 2160 : stream.calidad === '720' ? 720 : 1080;
  const ahora = new Date().toISOString();
  return {
    id: `nuve-${imdbId}${temporada && capitulo ? `-${temporada}x${capitulo}` : ''}`,
    name: 'Nuve+',
    quality: alto >= 2160 ? '4K' : alto >= 1080 ? '1080p' : '720p',
    language: 'latino',
    status: 'online',
    embed_url: ruta,
    direct_stream: ruta,
    direct_kind: 'mp4',
    direct_mode: 'redirect',
    direct_host: new URL(BASE_NUVEPLUS).hostname,
    last_checked: ahora,
    verified_at: ahora,
    max_height: alto,
    source_id: 'nuveplus',
    source_name: 'Nuve+',
  } as ServerOption;
}

const imdbPorTmdb = new Map<string, string | null>();

/**
 * El IMDB id de una obra de TMDB. Las películas lo traen en la ficha; las series no (TMDB solo lo
 * da en `external_ids`), así que aquí se pide y se recuerda mientras viva la instancia.
 */
export async function imdbDeTmdb(tmdbId: number, tipo: 'movie' | 'tv'): Promise<string | null> {
  if (!(tmdbId > 0)) return null;
  const clave = `${tipo}:${tmdbId}`;
  if (imdbPorTmdb.has(clave)) return imdbPorTmdb.get(clave) ?? null;
  try {
    const r = await httpClient.get(`https://api.themoviedb.org/3/${tipo}/${tmdbId}/external_ids`, {
      params: { api_key: TMDB_API_KEY }, timeout: 4000,
    });
    const id = /^tt\d+$/.test(String(r.data?.imdb_id || '')) ? String(r.data.imdb_id) : null;
    imdbPorTmdb.set(clave, id);
    return id;
  } catch {
    return null; // no se recuerda: un fallo de red no es un «no tiene»
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
