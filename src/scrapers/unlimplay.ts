/**
 * UNLIMPLAY — agregador de embeds DIRECCIONADO POR `tmdb_id`.
 *
 * `https://unlimplay.com/f/embed/movie/<tmdb>` y `/f/embed/tv/<tmdb>/<temporada>/<capítulo>`
 * devuelven una página cuyo `finalizePlayer({...})` trae los servidores ya resueltos por idioma:
 * `{ latino: { streamwish: url, filelions: url, … }, subtitulado: {…}, español: {…} }`.
 *
 * La identidad es la de videoapi, no la de lamoviebot: se le pregunta por una obra y contesta por
 * esa o por ninguna (un id inexistente da `{}`), así que su número no es una candidatura que haya
 * que verificar — es el que pusimos nosotros.
 *
 * Lo que se guarda es el EMBED del host (`embedwish.com/e/…`), no nada de UnlimPlay: si la web
 * cae, lo ya importado sigue reproduciendo, porque lo resuelve `extractDirect` al darle al play.
 *
 * Medido el 2026-09-21 (`scripts/dev/diag_unlimplay.ts`): de 25 películas nuestras, 21 con latino
 * y vídeo extraíble; streamwish 49→47, filelions 47→43; todo lo demás, 0.
 */
import { httpClient } from '../utils/httpClient';

export const BASE_UNLIMPLAY = 'https://unlimplay.com';
export const UA_NAVEGADOR =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export const REFERER_UNLIMPLAY = 'https://unlimplay.com/';

/**
 * LOS ÚNICOS HOSTS QUE SE GUARDAN, por lista blanca y no negra: esta fuente trae una docena por
 * título y casi todos son ruido medido. voe sirve el clip de prueba (ver `esVideoDeMuestra`),
 * doodstream/netu/streamtape/filemoon no tienen extractor o piden prueba humana, y `direct` es un
 * m3u8 de vimeos firmado para la IP de quien lo pidió — el mismo fichero que ya da videoapi.
 */
const HOSTS_QUE_ENTREGAN = ['embedwish.com', 'streamwish', 'morencius.com', 'filelions', 'vidhide'];

export interface EmbedUnlimplay {
  link: string;
  host: string;
  /** El nombre que le da UnlimPlay: `streamwish`, `filelions 2`… */
  server: string;
}

export function urlDeEmbed(tipo: 'movie' | 'tv', tmdb: number, temporada?: number, capitulo?: number): string {
  return tipo === 'movie'
    ? `${BASE_UNLIMPLAY}/f/embed/movie/${tmdb}`
    : `${BASE_UNLIMPLAY}/f/embed/tv/${tmdb}/${temporada}/${capitulo}`;
}

/** Los servidores por idioma, `{}` si no tiene la obra, o null si la página no contestó como se espera. */
export async function servidoresPorIdioma(url: string): Promise<Record<string, Record<string, string>> | null> {
  const r = await httpClient.get(url, {
    headers: { 'User-Agent': UA_NAVEGADOR },
    timeout: 40000,
    responseType: 'text',
    transformResponse: [(d: unknown) => d],
    validateStatus: () => true,
  });
  if (r.status === 404) return {};
  if (r.status !== 200) return null;
  const m = String(r.data).match(/finalizePlayer\((\{[\s\S]*?\})\)\s*;?\s*\}?\s*<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** Los embeds EN LATINO que merece la pena intentar, sin repetidos. */
export function embedsLatinos(porIdioma: Record<string, Record<string, string>> | null): EmbedUnlimplay[] {
  const out: EmbedUnlimplay[] = [];
  const vistos = new Set<string>();
  for (const [server, link] of Object.entries(porIdioma?.latino || {})) {
    if (typeof link !== 'string' || !/^https?:\/\//.test(link) || vistos.has(link)) continue;
    let host = '';
    try {
      host = new URL(link).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    if (!HOSTS_QUE_ENTREGAN.some((h) => host.includes(h) || server.toLowerCase().startsWith(h))) continue;
    if (/^(direct|proxy)$/i.test(server)) continue;
    vistos.add(link);
    out.push({ link, host, server });
  }
  return out;
}

export function esUrlDeUnlimplay(url: string): boolean {
  return /unlimplay\.com\/f\/embed\/(?:movie|tv)\/\d+/i.test(url || '');
}

/** El id de fila, con el tipo dentro por lo mismo que `va-tv-…`: un tmdb_id designa una película y una serie distintas. */
export function idDeFicha(tipo: 'movie' | 'tvseries', tmdb: number): string {
  return tipo === 'movie' ? `unl-${tmdb}` : `unl-tv-${tmdb}`;
}
