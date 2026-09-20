/**
 * NetMirror — fuente por TMDB id via API pública.
 *
 * No hay scraping. La web publica un endpoint REST que direcciona por tmdbId y devuelve
 * la URL mp4 directamente. Único requisito: cabecera Referer.
 *
 *   GET https://net27.cc/api/embed-tmdb/{tmdbId}                   → película
 *   GET https://net27.cc/api/embed-tmdb/{tmdbId}?type=tv&s=1&e=1   → episodio
 *
 * Respuesta útil (los campos que consumimos):
 *   { ok, tmdbId, title, year, imdb, type, mp4, streams?, mode, noSource? }
 *
 * `mode:"none"` + `noSource:true` significa que NetMirror no tiene ese título.
 * `mode:"proxy"` significa que devolvio una url mp4 valida.
 *
 * El mp4 requiere `Referer: https://videodownloader.site/` — sin el, la CDN
 * (bcdnxw.hakunaymatata.com) contesta 429. Con el, 200 y Content-Length real.
 *
 * Descubierto via Sushan64/NetMirror-Extension#24. El dominio host de la API rota
 * (net27.cc hoy, otro mañana), pero el path y el shape se mantienen.
 */

import { ServerOption } from '../types';

const ORIGENES = ['https://net27.cc'] as const;
const REFERER_MP4 = 'https://videodownloader.site/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface CaptionNetmirror {
  lang: string;   // 'es', 'es-ES', 'es-419', 'en', ...
  name: string;   // 'Español', 'Spanish (Latin America)', 'English', ...
  url: string;    // ruta a proxy interno de netmirror, absoluta cuando se sirve
  source?: string;
}

export interface RespuestaNetmirror {
  ok: boolean;
  tmdbId: number;
  title?: string;
  year?: string;
  imdb?: string;
  type?: 'movie' | 'tv';
  poster?: string;
  mode?: 'proxy' | 'none' | string;
  noSource?: boolean;
  mp4?: string;
  streams?: Array<{ url: string; resolution?: number | string; label?: string; size?: number }>;
  resolution?: string;
  captions?: CaptionNetmirror[];
  error?: string;
}

export interface FuenteNetmirror {
  /** URL mp4 servida por bcdnxw.hakunaymatata.com u similar. */
  mp4: string;
  /** Cabecera Referer que la CDN exige. Sin ella responde 429. */
  referer: string;
  /** Solo las pistas en espanol, ordenadas: latino primero, castellano al final. */
  subtitulosEs: CaptionNetmirror[];
  /** Metadata de la respuesta, util para logs y auditoria. */
  meta: {
    title: string;
    year: string;
    imdb: string;
    resolution?: string;
    otrosStreams: number;
  };
}

const NETMIRROR_ORIGEN_SUBS = 'https://net27.cc';

/**
 * Filtra las captions a solo espanol y las ordena de forma que se reproduzca LATINO
 * por defecto (primera de la lista):
 *   1. explicitas latinas       — es-419, es-MX, es-LA, es-AR, es-CL, es-CO, es-PE, es-VE, es-419
 *   2. `es` a secas             — la API por tmdb hoy solo devuelve esta; suele ser latino
 *   3. explicitas castellanas   — es-ES, es-EU (van al final)
 *
 * Cuando en algun titulo aparezcan las dos variantes (es y es-ES), la ordenacion pone la
 * latina primero automaticamente y el reproductor la elige por defecto.
 */
export function filtrarYordenarEsp(captions: CaptionNetmirror[] | undefined): CaptionNetmirror[] {
  if (!Array.isArray(captions)) return [];
  const es = captions.filter(c => {
    const l = String(c.lang || '').toLowerCase();
    if (l === 'es' || l.startsWith('es-') || l.startsWith('es_')) return true;
    const nombre = String(c.name || '').toLowerCase();
    return nombre.includes('espa') || nombre.includes('span') || nombre.includes('latin');
  });
  const puntuar = (c: CaptionNetmirror): number => {
    const l = String(c.lang || '').toLowerCase();
    const n = String(c.name || '').toLowerCase();
    if (n.includes('latin') || n.includes('latinoam')) return 0;
    if (['es-419', 'es-la', 'es-mx', 'es-ar', 'es-cl', 'es-co', 'es-pe', 'es-ve', 'es_419'].includes(l)) return 0;
    if (['es-es', 'es_es', 'es-eu', 'es_eu'].includes(l) || n.includes('castell') || n.includes('spain') || n.includes('espana')) return 2;
    return 1; // 'es' a secas, u otras variantes sin marcar
  };
  return es
    .map((c, i) => ({ c, p: puntuar(c), i }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map(x => ({
      ...x.c,
      // La API devuelve URL relativa a net27.cc; la absolutizamos para el consumidor.
      url: x.c.url.startsWith('http') ? x.c.url : NETMIRROR_ORIGEN_SUBS + x.c.url,
    }));
}

/**
 * Lo que contesta la API, SEPARANDO «no lo tengo» de «no contesta».
 *
 * Antes las dos cosas salían como `null`, y quien llamaba no podía distinguir un título que
 * NetMirror no tiene de una red caída, un 403 por IP o un timeout. La diferencia importa cuando
 * la respuesta se APUNTA: el importador guarda los «no» dos semanas en `netmirror_cache`, y una
 * corrida desde una IP que NetMirror bloquea escribió 105 «no» falsos en diez minutos (medido el
 * 2026-09-16 desde un runner de GitHub) antes de que nadie lo viera.
 */
export type ConsultaNetmirror =
  | { estado: 'tiene'; fuente: FuenteNetmirror }
  | { estado: 'no' }
  | { estado: 'sin-respuesta'; detalle: string };

async function llamar(tmdbId: number, extra: string): Promise<{ j: RespuestaNetmirror } | { detalle: string }> {
  let detalle = 'sin origenes';
  for (const origen of ORIGENES) {
    try {
      const r = await fetch(`${origen}/api/embed-tmdb/${tmdbId}${extra}`, {
        headers: { 'User-Agent': UA, 'Referer': REFERER_MP4, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) { detalle = `HTTP ${r.status}`; continue; }
      const cuerpo = await r.text();
      try {
        return { j: JSON.parse(cuerpo) as RespuestaNetmirror };
      } catch {
        // Un muro de Cloudflare contesta 200 con HTML: eso no es un «no».
        detalle = `respuesta no JSON (${cuerpo.slice(0, 40).replace(/s+/g, ' ')}…)`;
      }
    } catch (e: any) {
      detalle = e?.name === 'TimeoutError' ? 'timeout' : (e?.message || String(e));
    }
  }
  return { detalle };
}

function clasificar(r: { j: RespuestaNetmirror } | { detalle: string }): ConsultaNetmirror {
  if ('detalle' in r) return { estado: 'sin-respuesta', detalle: r.detalle };
  const fuente = empaquetar(r.j);
  return fuente ? { estado: 'tiene', fuente } : { estado: 'no' };
}

/** Pregunta por una película distinguiendo «no la tiene» de «no contesta». */
export async function consultarPelicula(tmdbId: number): Promise<ConsultaNetmirror> {
  return clasificar(await llamar(tmdbId, ''));
}

function empaquetar(j: RespuestaNetmirror): FuenteNetmirror | null {
  if (!j.ok || !j.mp4 || j.noSource || j.mode === 'none') return null;
  // La API devuelve `mp4` con la calidad por defecto (habitualmente 480p) y `streams` con las
  // demas. Escogemos la MEJOR de streams si supera a la default: sin esto, netmirror siempre se
  // publica en 480p aunque tenga 1080p disponible, y el sorter (que preordena por max_height) lo
  // hunde al fondo. Medido: Oppenheimer default 480p, streams incluye 1080p.
  const alturaMp4 = Number(j.resolution) || 0;
  let mejorUrl = j.mp4;
  let mejorRes = alturaMp4;
  for (const s of j.streams || []) {
    const r = Number(s.resolution) || 0;
    if (r > mejorRes && s.url) { mejorUrl = s.url; mejorRes = r; }
  }
  return {
    mp4: mejorUrl,
    referer: REFERER_MP4,
    subtitulosEs: filtrarYordenarEsp(j.captions),
    meta: {
      title: j.title || '',
      year: j.year || '',
      imdb: j.imdb || '',
      resolution: mejorRes > 0 ? String(mejorRes) : j.resolution,
      otrosStreams: (j.streams || []).length,
    },
  };
}

/** Resuelve una película por tmdbId. Devuelve null si NetMirror no la tiene. */
export async function pelicula(tmdbId: number): Promise<FuenteNetmirror | null> {
  const c = await consultarPelicula(tmdbId);
  return c.estado === 'tiene' ? c.fuente : null;
}

/**
 * EL SERVIDOR QUE SE ANUNCIA para una película que NetMirror tiene.
 *
 * Lo construyen dos sitios y tiene que salir igual de los dos: `serverDeNetmirror` en
 * catalogService, al abrir la ficha, y `scripts/importarNetmirror.ts`, al traer un título que
 * el catálogo no tenía. Antes vivía solo en el primero, y el importador habría tenido que copiar
 * la forma a mano — y una copia se separa en cuanto alguien toca una de las dos.
 *
 * El `direct_stream` apunta a nuestro endpoint con `?mode=redirect`: para el cliente Android
 * (Media3) esto es un 302 al CDN, propaga los headers `Referer` y descarga directo del CDN sin
 * que ningún byte pase por el Worker. Antes el proxy duplicaba latencia y ancho de banda:
 * Spider-Man y Kung Fu Panda 4 tardaban 5-10 s en empezar. Los clientes sin headers pueden pedir
 * la misma URL sin `?mode=redirect` y el endpoint hace proxy.
 *
 * El `?mode=redirect` sobre nuestro endpoint tiene otra ventaja sobre la URL directa del CDN:
 * aquí el 302 se emite en el momento del play (con firma FRESCA), no cuando se cacheó la ficha
 * diez minutos atrás. Así el CDN nunca ve una firma caducada — y por eso el servidor se puede
 * guardar en la base aunque el mp4 de detrás caduque en horas.
 */
export function servidorDePelicula(tmdbId: number, fuente: FuenteNetmirror): ServerOption {
  return servidorVirtualDePelicula(tmdbId, fuente.meta.resolution);
}

/**
 * Construye la URL estable de NetMirror sin consultar su API.
 *
 * El listado de servidores no necesita la URL MP4 firmada: `/netmirror/stream/:tmdbId` la
 * obtiene recién cuando Media3 va a reproducir. Separar esta forma barata evita pagar la llamada
 * a `net27.cc` al abrir cada ficha; la disponibilidad se decide con `netmirror_cache` y el endpoint
 * conserva la resolución en vivo como último paso.
 */
export function servidorVirtualDePelicula(tmdbId: number, resolution?: string): ServerOption {
  const ruta = `/api/v1/netmirror/stream/${tmdbId}`;
  const calidad: ServerOption['quality'] =
    resolution === '1080' ? '1080p' :
    resolution === '720'  ? '720p'  :
    resolution === '4K' || resolution === '2160' ? '4K' : '480p';
  const ahora = new Date().toISOString();
  const altura =
    resolution === '2160' || resolution === '4K' ? 2160 :
    resolution === '1080' ? 1080 :
    resolution === '720'  ? 720  :
    resolution === '360'  ? 360  : 480;
  const rutaRedirect = ruta + '?mode=redirect';
  return {
    id: `nm-${tmdbId}`,
    name: 'NetMirror',
    quality: calidad,
    // Este MP4 lleva la pista original (habitualmente inglés) y subtítulos en español. Solo el
    // master HLS interno es multi-audio; anunciar el MP4 como `latino` hacía que el sorter lo
    // eligiera como si ya trajera doblaje y el usuario terminaba oyendo inglés.
    language: 'subtitulado',
    embed_url: rutaRedirect,
    direct_stream: rutaRedirect,
    direct_kind: 'mp4',
    direct_mode: 'redirect',
    direct_host: 'bcdnxw.hakunaymatata.com',
    // Cabeceras que el CDN exige. Media3 las fija y las propaga al seguir el 302 (comprobado).
    headers: {
      Referer: REFERER_MP4,
      'User-Agent': UA,
    },
    status: 'online',
    last_checked: ahora,
    // Sello reciente: acabamos de resolver el mp4 contra la API oficial. Sin esto,
    // `revisarServidores` intenta comprobar el embed_url y lo puede marcar offline.
    verified_at: ahora,
    max_height: altura,
    // TTFB observado en la CDN: ~300-500 ms. Sin este valor el sorter le asigna infinito y lo
    // hunde por debajo de cualquier server con TTFB medido.
    ttfb_ms: 400,
    source_id: 'netmirror',
    source_name: 'NetMirror',
  } as ServerOption;
}

/** Resuelve un capítulo por tmdbId de la serie y temporada/episodio. */
export async function episodio(
  tmdbId: number,
  temporada: number,
  episodio: number,
): Promise<FuenteNetmirror | null> {
  const c = clasificar(await llamar(tmdbId, `?type=tv&s=${temporada}&e=${episodio}`));
  return c.estado === 'tiene' ? c.fuente : null;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// MULTI-AUDIO via HLS master (NewTV, sin cookie ni token)
//
// La API `/api/embed-tmdb/{tmdb}` que se usa arriba devuelve mp4 mono-audio. Multi-audio real
// vive en el reproductor interno de NetMirror, que se sirve como HLS master con multiples pistas
// `#EXT-X-MEDIA TYPE=AUDIO`. La ruta NewTV actual solo requiere netflix_id (no tmdb); se conserva
// el flujo antiguo con `?in=<token>` exclusivamente como respaldo.
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** Origen actual del site donde vive /search.php. Rota cada mes. */
const NM_SITE_ORIGEN = 'https://net77.cc';
/** Origen actual del reproductor donde vive /hls. Rota cada mes. */
const NM_PLAY_ORIGEN = 'https://net52.cc';

const NEWTV_DISCOVERY = [
  'https://mobiledetects.com',
  'https://mobiledetect.app',
  'https://mobiledetect.art',
  'https://mobiledetect.cc',
] as const;
const NEWTV_HEADERS = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  Pragma: 'no-cache',
  'X-Requested-With': 'NetmirrorNewTV v1.0',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0 /OS.GatuNewTV v1.0',
  Accept: 'application/json, text/plain, */*',
};

let newTvBaseCache: { url: string; hasta: number } | null = null;

/** Resuelve el backend rotativo que publica NetMirror para sus clientes NewTV. */
async function resolverNewTvBase(): Promise<string | null> {
  if (newTvBaseCache && newTvBaseCache.hasta > Date.now()) return newTvBaseCache.url;
  for (const origen of NEWTV_DISCOVERY) {
    try {
      const r = await fetch(`${origen}/checknewtv.php`, {
        headers: NEWTV_HEADERS,
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) continue;
      const j = await r.json() as { token_hash?: string };
      const url = Buffer.from(String(j.token_hash || ''), 'base64').toString('utf8').trim().replace(/\/$/, '');
      if (!/^https:\/\/[^/]+$/i.test(url)) continue;
      newTvBaseCache = { url, hasta: Date.now() + 6 * 60 * 60 * 1000 };
      return url;
    } catch { /* siguiente dominio de descubrimiento */ }
  }
  return null;
}

export interface AudioHls {
  /** ISO 639-2 tal como venga del master (`spa`, `eng`, `und`, ...). */
  language: string;
  /** Nombre bruto del master (`Spanish`, `English`, `Unknown`, ...). Se traduce arriba. */
  name: string;
  /** URL absoluta del m3u8 de esa pista de audio. Publica, sin token. */
  uri: string;
  /** true si el master lo marca DEFAULT=YES. */
  defaultTrack: boolean;
}

export interface VideoVariante {
  /** Bandwidth declarado por el master. */
  bandwidth: number;
  /** Ej. "1920x1080" o null si el master no lo dice. */
  resolution: string | null;
  /** URL absoluta del m3u8 de esta variante (con token). */
  uri: string;
  /** true si el master lo marca DEFAULT=YES. */
  defaultTrack: boolean;
}

export interface MasterNetmirror {
  audios: AudioHls[];
  video: VideoVariante[];
  /** URL exacta del master comprobado; puede ser firmada y efimera. */
  masterUrl: string;
  referer: string;
}

/** Plataformas publicadas por el backend NewTV de NetMirror. `hs` incluye Disney+. */
export type NetmirrorOtt = 'nf' | 'pv' | 'hs';

export function normalizarNetmirrorOtt(valor: unknown): NetmirrorOtt {
  const ott = String(valor || '').trim().toLowerCase();
  return ott === 'pv' || ott === 'hs' ? ott : 'nf';
}

/** La columna histórica se llama `netflix_id`; el prefijo permite guardar cualquier OTT. */
export function codificarIdNetmirror(ott: NetmirrorOtt, id: string): string {
  return `${normalizarNetmirrorOtt(ott)}:${String(id || '').trim()}`;
}

/** Los valores antiguos sin prefijo siguen siendo Netflix. */
export function decodificarIdNetmirror(valor: string | null | undefined): { ott: NetmirrorOtt; id: string } {
  const crudo = String(valor || '').trim();
  const m = /^(nf|pv|hs):(.*)$/i.exec(crudo);
  return m ? { ott: normalizarNetmirrorOtt(m[1]), id: m[2].trim() } : { ott: 'nf', id: crudo };
}

/** Lee un atributo HLS incluso cuando la lista usa valores sin comillas. */
function atributoHls(linea: string, clave: string): string {
  const escapada = clave.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[:,])\\s*${escapada}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^,\\s]*))`, 'i').exec(linea);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

/** HLS permite URI relativas; NetMirror las usa en parte de sus pistas de audio. */
function uriHlsAbsoluta(uri: string, masterUrl: string, permitirUnknown = false): string {
  try {
    const cruda = uri.trim();
    // Placeholder de ID inexistente: `https:///files/<id>/...`. WHATWG lo interpreta como
    // host `files`, convirtiendo una pista rota en un falso positivo aparentemente válido.
    if (/^https?:\/{3,}/i.test(cruda)) return '';
    const u = new URL(cruda, masterUrl);
    const absoluta = u.toString();
    return /^https?:$/i.test(u.protocol)
      && u.hostname.includes('.')
      && (permitirUnknown || !/\bunknown\b/i.test(absoluta))
      ? absoluta
      : '';
  } catch {
    return '';
  }
}

/**
 * Empareja titulo+anio contra el buscador de NetMirror y devuelve su netflix_id.
 * `/search.php?s=<titulo>` no requiere cookies ni token — se puede llamar desde cualquier IP.
 *
 * Devuelve null si no hay match o si el año no encaja (respeta la regla de "nunca fusionar por
 * titulo": exige año). Cuando NetMirror devuelve varios resultados, se queda con el primero cuyo
 * titulo normalizado coincida.
 */
export async function buscarNetmirrorId(
  titulo: string,
  anio?: string | number,
  tituloOriginal?: string,
  tituloIngles?: string,
  ott: NetmirrorOtt = 'nf',
): Promise<string | null> {
  ott = normalizarNetmirrorOtt(ott);
  // NetMirror indexa SIEMPRE en INGLES. TMDB nos da:
  //   - title (traducido al idioma de la region \u2014 aqui, espa\u00f1ol)
  //   - original_title (idioma nativo: puede ser ingles, coreano '\uc624\uc9d5\uc5b4 \uac8c\uc784', ruso, arabe...)
  //   - tituloIngles (traduccion ingles pedida aparte \u2014 el mas fiable)
  //
  // Orden de intento: ingles > original si es latino > title en espa\u00f1ol > romanizacion cruda del
  // original. La primera coincidencia gana. Ejemplo Squid Game: original=\ucf54\ub9ac\uc544, es="El juego del
  // calamar", ingles="Squid Game" -> matchea via ingles con id 81040344.
  const norm = (s: string) => String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  // Otro alfabeto (coreano, japones, chino, ruso, arabe, hebreo, thai, devanagari, hangul):
  // si original_title lo tiene, no sirve buscar por el en NetMirror (indexa alfabeto latino).
  const otroAlfabeto = (s: string) => /[\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff\u0900-\u097f\u0e00-\u0e7f\u3040-\u309f\u30a0-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(s || '');

  const candidatos: string[] = [];
  const push = (s: string | undefined) => {
    const t = (s || '').trim();
    if (!t) return;
    if (candidatos.some(c => norm(c) === norm(t))) return;
    candidatos.push(t);
  };
  push(tituloIngles);
  if (tituloOriginal && !otroAlfabeto(tituloOriginal)) push(tituloOriginal);
  push(titulo);
  // Variantes agresivas: sin subtitulo tras dos puntos, sin sufijo numerico romano/arabigo,
  // sin articulos iniciales espanoles. Cubre "Vengadores: Endgame" -> "Vengadores"; "Rocky II" ->
  // "Rocky"; "Los Vengadores" -> "Vengadores".
  const base = [tituloIngles, tituloOriginal, titulo].filter(Boolean) as string[];
  for (const b of base) {
    const sinSub = b.split(':')[0].trim();
    if (sinSub && sinSub !== b) push(sinSub);
    const sinSufNum = b.replace(/\s+(?:[ivx]+|\d+)\s*$/i, '').trim();
    if (sinSufNum && sinSufNum !== b) push(sinSufNum);
    const sinArt = b.replace(/^(?:el|la|los|las|un|una|the|le|la|les)\s+/i, '').trim();
    if (sinArt && sinArt !== b) push(sinArt);
  }
  if (candidatos.length === 0) return null;

  for (const q of candidatos) {
    // La API NewTV es el buscador oficial del cliente actual y no depende de cookies. Se usa
    // primero; `/search.php` del sitio queda como respaldo mientras convivan ambas versiones.
    try {
      const apiBase = await resolverNewTvBase();
      if (apiBase) {
        const r = await fetch(`${apiBase}/newtv/search.php?s=${encodeURIComponent(q)}`, {
          headers: { ...NEWTV_HEADERS, Ott: ott },
          signal: AbortSignal.timeout(10_000),
        });
        if (r.ok) {
          const j = await r.json() as { searchResult?: Array<{ id: string; t?: string }> };
          const items = Array.isArray(j?.searchResult) ? j.searchResult.filter(x => x?.id && x?.t) as Array<{ id: string; t: string }> : [];
          const buscado = norm(q);
          const exacto = items.find(x => norm(x.t) === buscado);
          if (exacto?.id) { void anio; return exacto.id; }
          const contenido = items.find(x => {
            const t = norm(x.t);
            return t.length >= 5 && buscado.length >= 5 && (t.includes(buscado) || buscado.includes(t));
          });
          if (contenido?.id) { void anio; return contenido.id; }
        }
      }
    } catch { /* respaldo del sitio */ }

    // El buscador del sitio clásico sólo indexa Netflix; pv/hs ya se consultaron por NewTV.
    if (ott !== 'nf') continue;
    try {
      // OJO: sin Referer, NetMirror devuelve `type:1, head:"Top Searches"` con una lista
      // canned que es igual para toda consulta y con `t:""` vacios. Medido en produccion:
      // rescatar Squid Game requiere este header sin excepciones.
      const r = await fetch(`${NM_SITE_ORIGEN}/search.php?s=${encodeURIComponent(q)}&t=${Date.now()}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${NM_SITE_ORIGEN}/home` },
      });
      if (!r.ok) continue;
      const j = await r.json() as { head?: string; type?: number; searchResult?: Array<{ id: string; t: string }> };
      // Descartar la lista "Top Searches" bogus: aparece cuando falta el Referer o similar,
      // trae ids reales pero `t` vacio, distinto para cada usuario y NO refleja la consulta.
      if (j?.head === 'Top Searches' || j?.type === 1) continue;
      const items = Array.isArray(j?.searchResult) ? j.searchResult.filter(x => x && x.t) : [];
      if (items.length === 0) continue;
      const buscado = norm(q);
      // 1) Match exacto normalizado.
      const exacto = items.find(x => norm(x.t) === buscado);
      if (exacto?.id) { void anio; return exacto.id; }
      // 2) Contencion estricta en ambos sentidos (p.ej. "Squid Game" contenido en "Squid Game:
      // The Challenge"). Requiere que el mas corto sea al menos 5 chars para evitar matches
      // basura tipo "The" contenido en cualquier cosa.
      const contenido = items.find(x => {
        const t = norm(x.t);
        return (t.length >= 5 && buscado.length >= 5) && (t.includes(buscado) || buscado.includes(t));
      });
      if (contenido?.id) { void anio; return contenido.id; }
    } catch { /* siguiente candidato */ }
  }
  return null;
}

/**
 * Descarga el HLS master de NetMirror y parsea audios + variantes de video.
 * NewTV es el camino primario. Con `NETMIRROR_USER_TOKEN`, player.php devuelve el master real
 * firmado; sin esa credencial sólo entrega un manifiesto de inventario cuyo vídeo es un señuelo
 * truncado. `token` conserva el flujo antiguo como respaldo.
 */
export async function masterHls(
  netflixId: string,
  token = '',
  ott: NetmirrorOtt = 'nf',
): Promise<MasterNetmirror | null> {
  if (!netflixId) return null;
  ott = normalizarNetmirrorOtt(ott);

  // Inventario público y estable: no reproduce el metraje completo, pero sí enumera exactamente
  // audios/subtítulos/variantes. Es el camino ideal para barridos y además funciona desde runners
  // donde `player.php` está bloqueado. El Android nunca lo usa para reproducir: pide firma+OTP.
  const candidatos: Array<{ masterUrl: string; referer: string }> = [{
    masterUrl: `https://tv.imgcdn.kim/newtv/hls/${ott}/${encodeURIComponent(netflixId)}.m3u8`,
    referer: `${NM_PLAY_ORIGEN}/`,
  }];
  try {
    const apiBase = await resolverNewTvBase();
    if (apiBase) {
      const userToken = String(process.env.NETMIRROR_USER_TOKEN || '').trim();
      const player = await fetch(`${apiBase}/newtv/player.php?id=${encodeURIComponent(netflixId)}`, {
        headers: {
          ...NEWTV_HEADERS,
          Ott: ott,
          ...(userToken ? { Usertoken: userToken } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (player.ok) {
        const j = await player.json() as { status?: string; video_link?: string; referer?: string };
        // Incluso con credencial vencida (`status=otp`) NewTV entrega el master público de
        // inventario. Sirve para auditar idiomas y catálogo; el Android exige `status=ok` y
        // renueva por OTP antes de reproducir el master completo.
        if (/^https?:\/\//i.test(String(j.video_link || ''))) {
          candidatos.push({ masterUrl: String(j.video_link), referer: String(j.referer || apiBase) });
        }
      }
    }
  } catch { /* se prueba el flujo antiguo */ }

  if (token && ott === 'nf') {
    candidatos.push({
      masterUrl: `${NM_PLAY_ORIGEN}/hls/${encodeURIComponent(netflixId)}.m3u8?in=${encodeURIComponent(token)}`,
      referer: `${NM_PLAY_ORIGEN}/`,
    });
  }

  for (const candidato of candidatos) {
    try {
      const { masterUrl, referer } = candidato;
    const r = await fetch(masterUrl, {
        headers: { 'User-Agent': UA, Referer: referer, Origin: referer.replace(/\/$/, '') },
        signal: AbortSignal.timeout(12_000),
    });
      if (!r.ok) continue;
    const txt = await r.text();
      if (!txt.startsWith('#EXTM3U')) continue;

    const audios: AudioHls[] = [];
    const video: VideoVariante[] = [];
    const lineas = txt.split('\n').map(l => l.trim());

    for (let i = 0; i < lineas.length; i++) {
      const l = lineas[i];
      if (l.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/i.test(l)) {
        const language = atributoHls(l, 'LANGUAGE');
        const name = atributoHls(l, 'NAME');
        const uri = uriHlsAbsoluta(atributoHls(l, 'URI'), r.url || masterUrl);
        const defaultTrack = /^yes$/i.test(atributoHls(l, 'DEFAULT'));
        // Las pistas no inglesas pueden llegar como URI relativa; descartarlas hacía que el
        // API expusiera sólo la pista English aunque el master tuviera varias.
        if (uri) {
          audios.push({ language, name, uri, defaultTrack });
        }
      } else if (l.startsWith('#EXT-X-STREAM-INF')) {
        const bandwidth = Number(atributoHls(l, 'BANDWIDTH')) || 0;
        const resolution = atributoHls(l, 'RESOLUTION') || null;
        const defaultTrack = /^yes$/i.test(atributoHls(l, 'DEFAULT'));
        // NewTV usa literalmente `?in=unknown::lc` en variantes válidas; el filtro `unknown`
        // solo detecta placeholders del flujo legacy.
        const uri = uriHlsAbsoluta(
          lineas[i + 1] || '',
          r.url || masterUrl,
          /\/newtv\//i.test(r.url || masterUrl),
        );
        // Solo variantes reales; las de placeholder tienen `in=unknown` cuando el netflix_id no
        // existe (medido: `s21.freecdn4.top/files/220884/...` para ids no reconocidos).
        if (uri) {
          video.push({ bandwidth, resolution, uri, defaultTrack });
        }
      }
    }

    // Sin audios reales el master no vale (netflix_id inexistente o token muerto).
      // “Multipista” significa al menos dos pistas reales. Una sola `und/Unknown` es además la
      // firma exacta del placeholder que NewTV devuelve cuando el ID no existe.
      if (audios.length < 2) continue;
      return { audios, video, masterUrl: r.url || masterUrl, referer };
    } catch { /* siguiente candidato */ }
  }
  return null;
}

/** Alias histórico para los escáneres que recorren exclusivamente Netflix. */
export async function buscarNetflixId(
  titulo: string,
  anio?: string | number,
  tituloOriginal?: string,
  tituloIngles?: string,
): Promise<string | null> {
  return buscarNetmirrorId(titulo, anio, tituloOriginal, tituloIngles, 'nf');
}
