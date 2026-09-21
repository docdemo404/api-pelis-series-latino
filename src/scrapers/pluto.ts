/**
 * PLUTO TV — PELÍCULAS BAJO DEMANDA, VISTAS DESDE EL MÓVIL.
 *
 * Medido el 2026-09-21 con scripts/dev/diag_pluto.ts desde Chile (mercado LATAM): 1.767
 * películas, 825 identificadas contra TMDB por año + director + duración, 637 que no teníamos, y
 * 30 de 30 reproducen (29 con audio español).
 *
 * POR QUÉ LO HACE EL MÓVIL Y NO UN JOB. Pluto decide el catálogo por la IP que pregunta y mete esa
 * IP dentro del JWT de cada stream. Desde GitHub o Vercel (EE. UU.) se vería otro catálogo, y una
 * url acuñada allí no la abriría el teléfono. Así que el reparto es:
 *
 *   · el MÓVIL pide el catálogo a Pluto y nos manda los datos crudos (id, nombre, año,
 *     directores, duración); después mira el master de los que le pidamos y nos dice qué audios
 *     trae. Nunca manda urls: solo ids de Pluto, que no sirven para nada sin sesión propia.
 *   · el IMPORTADOR (scripts/importarPluto.ts, en GitHub) identifica contra TMDB —que sí llega
 *     desde allí— y publica.
 *   · al REPRODUCIR, el móvil convierte `pluto://movie/<id>` en el master con su propia sesión.
 *
 * Los anuncios van dentro del stream y se quedan: es lo que paga el contenido. Nada de esto pasa
 * por el Worker ni toca claves: el HLS de Pluto es AES-128 con la clave en la propia playlist y
 * media3 la pide solo, igual que su reproductor oficial.
 */
import axios from 'axios';
import { TMDB_API_KEY } from '../services/tmdbService';
import { ServerOption } from '../types';

/** Un id de Pluto: ObjectId de Mongo, 24 hex. Lo único que viaja del móvil que acaba en una url. */
export const ID_PLUTO = /^[0-9a-f]{24}$/;

export const PREFIJO_PLUTO = 'pluto://movie/';

export interface PeliPluto {
  id: string;
  nombre: string;
  anio?: number;
  minutos?: number;
  /** Ya normalizados con [norm]. */
  directores: string[];
}

export const norm = (s: string) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function esServidorPluto(sv: any): boolean {
  return String(sv?.source_id || '').toLowerCase() === 'pluto'
    || String(sv?.direct_stream || '').startsWith(PREFIJO_PLUTO);
}

/**
 * El servidor que se guarda en la ficha.
 *
 * `embed_url` lleva la misma pseudo-url a propósito: hay filtros que tiran los servidores sin
 * embed (ver `catalogService`, «guardados.filter(s => s.embed_url)»). Los sondeos que la verían
 * se saltan `source_id: 'pluto'` —`playbackHealth`— o solo miran `https?://` —verificarPermanentes—.
 *
 * `verified_at` es la última vez que el móvil vio el título en el catálogo de Pluto. Es lo que
 * lo mantiene anunciado: si Pluto lo retira, deja de aparecer y el sello envejece.
 */
export function servidorDePluto(plutoId: string, vistoAt: string): ServerOption {
  const url = PREFIJO_PLUTO + plutoId;
  return {
    id: `srv_pluto_${plutoId}`,
    name: 'Pluto TV [Vídeo directo]',
    quality: '720p',
    language: 'latino',
    status: 'online',
    source_id: 'pluto',
    embed_url: url,
    direct_stream: url,
    direct_kind: 'hls',
    direct_mode: 'public',
    last_checked: vistoAt,
    verified_at: vistoAt,
  } as unknown as ServerOption;
}

const tmdb = (ruta: string, params: Record<string, unknown> = {}) =>
  axios.get(`https://api.themoviedb.org/3${ruta}`, {
    params: { api_key: process.env.TMDB_API_KEY || TMDB_API_KEY, ...params },
    timeout: 12000,
  }).then((r) => r.data);

export type VeredictoPluto =
  | { tipo: 'verificada'; tmdbId: number }
  | { tipo: 'ambigua' | 'sin_director' | 'sin_anio' | 'nada' };

/**
 * NADA SE ADOPTA POR TÍTULO. Pluto no da tmdb_id, así que se exige año ±1 Y un director que
 * coincida, y duración a ±8 min cuando las dos partes la saben (Pluto recorta créditos). Si pasan
 * dos candidatos, es ambigua y no se publica. Ver [[nunca-fusionar-por-titulo]].
 *
 * Sobre el catálogo entero dio 825 verificadas, 7 ambiguas y 928 sin identificar: estricto a
 * propósito. Las 928 no son basura, son las que no se pueden demostrar.
 */
export async function identificarPeliPluto(p: PeliPluto): Promise<VeredictoPluto> {
  if (!p.anio) return { tipo: 'sin_anio' };
  const vistos = new Set<number>();
  for (const language of ['es-MX', 'en-US']) {
    const r = await tmdb('/search/movie', { query: p.nombre, language, include_adult: false });
    for (const c of (r.results || []).slice(0, 6)) {
      const y = Number(String(c.release_date || '').slice(0, 4));
      if (y && Math.abs(y - p.anio) <= 1) vistos.add(Number(c.id));
    }
  }
  if (!vistos.size) return { tipo: 'nada' };
  if (!p.directores.length) return { tipo: 'sin_director' };

  const pasan: number[] = [];
  for (const id of vistos) {
    const d = await tmdb(`/movie/${id}`, { append_to_response: 'credits' });
    const dirs = (d.credits?.crew || []).filter((c: any) => c.job === 'Director').map((c: any) => norm(c.name));
    const director = dirs.some((x: string) => p.directores.includes(x));
    const duracion = !d.runtime || !p.minutos || Math.abs(d.runtime - p.minutos) <= 8;
    if (director && duracion) pasan.push(id);
  }
  if (pasan.length === 1) return { tipo: 'verificada', tmdbId: pasan[0] };
  return { tipo: pasan.length > 1 ? 'ambigua' : 'nada' };
}
