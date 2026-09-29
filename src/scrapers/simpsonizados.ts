/**
 * SIMPSONIZADOS (simpsonizados.me) — LOS SIMPSON EN LATINO, CAPÍTULO A CAPÍTULO.
 *
 * Una web de una sola serie: WordPress con el tema DooPlay, 768 capítulos de las temporadas 1 a 35
 * (completas, contadas contra las oficiales) y la película de 2007. MEDIDO el 2026-09-29 antes de
 * escribir esto:
 *
 *   capítulo   `/cap/los-simpson-<t>x<e>/`   — sin cero delante: `1x1`, no `1x01`
 *   opciones   `admin-ajax.php` con `action=doo_player_ajax` → `{ embed_url }`, sin nonce
 *   servidores videok.pro en 10 de 10 capítulos muestreados (T1 a T35); el segundo es hqq/netu
 *              (señuelo, DECOY_HOSTS) o hlswish. La película solo tiene hqq: no se importa.
 *   videok     XFileSharing: el reproductor hace POST `/dl` (`op=embed`) y la respuesta trae
 *              `sources: [{src: "…/master.m3u8?t=…&s=…&e=43200&i=<ip>"}]`
 *   el HLS     360p–1080p H.264/AAC, audio Español latino (confirmado de oído por el usuario) +
 *              inglés, subtítulos. La firma NO se exige: el master abre sin query, con `s=` alterado,
 *              desde otra IP, sin Referer y sin User-Agent. Los trozos van relativos y sin firma.
 *              Así que lo que se guarda es el master SIN la query: una url permanente, de las que el
 *              barrido de permanentes sabe sellar (`esFicheroDirecto` + `isPubliclyShareable`).
 *   la obra    fotograma del 34x14 (Carl en la bolera) y 21,7 min: el capítulo de verdad, no un
 *              clip de relleno de los que coló voe.sx.
 *
 * La url permanente lleva comas dentro (`,<code>_l,<code>_n,…,.urlset/master.m3u8`): es el
 * `.urlset` de nginx-vod y es UNA sola url. Ver src/utils/urlsPegadas.ts.
 */
import { httpClient, USER_AGENT } from '../utils/httpClient';

export const BASE_SIMPSONIZADOS = 'https://simpsonizados.me';
const VIDEOK = 'https://videok.pro';

export interface CapituloSimpsonizados {
  temporada: number;
  episodio: number;
  pagina: string;
}

const pedirTexto = async (url: string, referer?: string): Promise<string> => {
  const r = await httpClient.get(url, {
    timeout: 20000,
    responseType: 'text',
    headers: { 'User-Agent': USER_AGENT, ...(referer ? { Referer: referer } : {}) },
  });
  return String(r.data || '');
};

/**
 * Todos los capítulos, del sitemap de WordPress (`episodes-sitemap.xml`), sin recorrer la web.
 * El número sale del slug; lo que no tenga forma `<t>x<e>` (la portada `/cap/`) se descarta.
 */
export async function listarCapitulos(): Promise<CapituloSimpsonizados[]> {
  const xml = await pedirTexto(`${BASE_SIMPSONIZADOS}/episodes-sitemap.xml`);
  const vistos = new Set<string>();
  const out: CapituloSimpsonizados[] = [];
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const pagina = m[1].trim();
    const n = pagina.match(/\/cap\/los-simpson-(\d+)x(\d+)\/?$/i);
    if (!n) continue;
    const temporada = Number(n[1]);
    const episodio = Number(n[2]);
    const clave = `${temporada}x${episodio}`;
    if (!temporada || !episodio || vistos.has(clave)) continue;
    vistos.add(clave);
    out.push({ temporada, episodio, pagina });
  }
  return out.sort((a, b) => a.temporada - b.temporada || a.episodio - b.episodio);
}

/**
 * La fecha de estreno que declara la ficha de la serie (`datePublished`, `YYYY-MM-DD`).
 *
 * Es el respaldo de identidad: la web no publica el `tmdb_id`, así que antes de colgar nada de la
 * ficha 456 se compara esta fecha con el `first_air_date` de TMDB. Solo el título no basta.
 */
export async function estrenoDeLaSerie(): Promise<string> {
  const html = await pedirTexto(`${BASE_SIMPSONIZADOS}/serie/los-simpson/`);
  const m = html.match(/"datePublished":"(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

/** Las opciones del reproductor de una página DooPlay: `post`, `nume` y el host que rotula. */
function opcionesDooplay(html: string): Array<{ post: string; nume: string; tipo: string; servidor: string }> {
  const out: Array<{ post: string; nume: string; tipo: string; servidor: string }> = [];
  const re = /data-type=['"](\w+)['"]\s+data-post=['"](\d+)['"]\s+data-nume=['"](\w+)['"][\s\S]*?<span class=['"]server['"]>([^<]*)/g;
  for (const m of html.matchAll(re)) out.push({ tipo: m[1], post: m[2], nume: m[3], servidor: m[4].trim() });
  return out;
}

/**
 * El código de videok de un capítulo, o null si no tiene opción de videok.
 *
 * Se pregunta solo por la opción rotulada videok: las otras son señuelos o embeds que caducan,
 * y cada petición de más a la web es carga para ella sin nada que ganar.
 */
export async function codigoVideok(pagina: string): Promise<string | null> {
  const html = await pedirTexto(pagina);
  const opcion = opcionesDooplay(html).find((o) => /videok/i.test(o.servidor));
  if (!opcion) return null;
  const cuerpo = new URLSearchParams({
    action: 'doo_player_ajax', post: opcion.post, nume: opcion.nume, type: opcion.tipo,
  }).toString();
  const r = await httpClient.post(`${BASE_SIMPSONIZADOS}/wp-admin/admin-ajax.php`, cuerpo, {
    timeout: 20000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: pagina },
  });
  const embed = String((r.data as any)?.embed_url || '');
  const m = embed.match(/videok\.pro\/(?:e\/|embed-)?([a-z0-9]{8,})/i);
  return m ? m[1] : null;
}

/** El master sin la firma: `…/master.m3u8?t=…&s=…&i=<ip>` → `…/master.m3u8`. */
export function sinFirma(url: string): string {
  return url.split('?')[0];
}

/**
 * El master sin las pistas de subtítulos (`lang/<idioma>/<code>_<idioma>`), o null si no tenía.
 *
 * nginx-vod monta el master con TODO lo que lista el `.urlset`, y si falta uno solo de los
 * ficheros devuelve 404 al master entero. Pasa: el 3x10 lista subtítulos spa/cat/eng que no existen
 * y no abre ni firmado —tampoco en la propia web—, pero sus cuatro calidades están enteras. El audio
 * latino va dentro del vídeo, no en `lang/`, así que quitar los subtítulos no quita el doblaje.
 */
export function sinSubtitulos(master: string): string | null {
  const limpio = master.replace(/,lang\/[^,]+/g, '');
  return limpio !== master ? limpio : null;
}

/**
 * El master HLS de un código de videok, YA SIN FIRMA (la firma caduca a las 12 h y lleva la IP de
 * quien lo pidió, pero el CDN no la comprueba — ver la cabecera). Null si no trae fuente.
 */
export async function masterDeVideok(codigo: string, referer = `${BASE_SIMPSONIZADOS}/`): Promise<string | null> {
  const cuerpo = new URLSearchParams({ op: 'embed', file_code: codigo, auto: '1', referer }).toString();
  const r = await httpClient.post(`${VIDEOK}/dl`, cuerpo, {
    timeout: 20000,
    responseType: 'text',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${VIDEOK}/e/${codigo}.html` },
  });
  const m = String(r.data || '').match(/sources\s*:\s*\[\s*\{\s*src\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i);
  return m ? sinFirma(m[1]) : null;
}
