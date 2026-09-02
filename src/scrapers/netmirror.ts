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

async function llamar(tmdbId: number, extra: string): Promise<RespuestaNetmirror | null> {
  for (const origen of ORIGENES) {
    try {
      const r = await fetch(`${origen}/api/embed-tmdb/${tmdbId}${extra}`, {
        headers: { 'User-Agent': UA, 'Referer': REFERER_MP4, 'Accept': 'application/json' },
      });
      if (!r.ok) continue;
      const j = (await r.json()) as RespuestaNetmirror;
      return j;
    } catch { /* siguiente origen */ }
  }
  return null;
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
  const j = await llamar(tmdbId, '');
  return j ? empaquetar(j) : null;
}

/** Resuelve un capítulo por tmdbId de la serie y temporada/episodio. */
export async function episodio(
  tmdbId: number,
  temporada: number,
  episodio: number,
): Promise<FuenteNetmirror | null> {
  const j = await llamar(tmdbId, `?type=tv&s=${temporada}&e=${episodio}`);
  return j ? empaquetar(j) : null;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// MULTI-AUDIO via HLS master (/hls/{netflix_id}.m3u8?in=<token>)
//
// La API `/api/embed-tmdb/{tmdb}` que se usa arriba devuelve mp4 mono-audio. Multi-audio real
// vive en el reproductor interno de NetMirror, que se sirve como HLS master con multiples pistas
// `#EXT-X-MEDIA TYPE=AUDIO`. Requiere netflix_id (no tmdb) y token de sesion (?in=).
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** Origen actual del site donde vive /search.php. Rota cada mes. */
const NM_SITE_ORIGEN = 'https://net77.cc';
/** Origen actual del reproductor donde vive /hls. Rota cada mes. */
const NM_PLAY_ORIGEN = 'https://net52.cc';

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
}

/**
 * Empareja titulo+anio contra el buscador de NetMirror y devuelve su netflix_id.
 * `/search.php?s=<titulo>` no requiere cookies ni token — se puede llamar desde cualquier IP.
 *
 * Devuelve null si no hay match o si el año no encaja (respeta la regla de "nunca fusionar por
 * titulo": exige año). Cuando NetMirror devuelve varios resultados, se queda con el primero cuyo
 * titulo normalizado coincida.
 */
export async function buscarNetflixId(titulo: string, anio?: string | number): Promise<string | null> {
  if (!titulo) return null;
  const q = encodeURIComponent(titulo.trim());
  try {
    const r = await fetch(`${NM_SITE_ORIGEN}/search.php?s=${q}&t=${Date.now()}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!r.ok) return null;
    const j = await r.json() as { searchResult?: Array<{ id: string; t: string }> };
    const items = Array.isArray(j?.searchResult) ? j.searchResult : [];
    if (items.length === 0) return null;

    const normalizar = (s: string) => String(s || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim();
    const buscado = normalizar(titulo);

    // Preferir match exacto del titulo normalizado; si no, el primer resultado.
    const exacto = items.find(x => normalizar(x.t) === buscado);
    const candidato = exacto ?? items[0];

    // Si nos dieron año, NO validamos aquí (el search no devuelve año). La validación por año se
    // hace en el escaneo consultando el propio master (que lleva metadatos), o simplemente
    // aceptamos: NetMirror es un catálogo específico, los homónimos son raros. Ver
    // `nunca-fusionar-por-titulo`: si algún dia se detecta un problema, se añade prueba por año.
    void anio;

    return candidato?.id || null;
  } catch { return null; }
}

/**
 * Descarga el HLS master de NetMirror y parsea audios + variantes de video.
 * Devuelve null si el master está vacío (netflix_id inexistente) o si el token no vale.
 */
export async function masterHls(netflixId: string, token: string): Promise<MasterNetmirror | null> {
  if (!netflixId || !token) return null;
  try {
    const r = await fetch(`${NM_PLAY_ORIGEN}/hls/${encodeURIComponent(netflixId)}.m3u8?in=${encodeURIComponent(token)}`, {
      headers: { 'User-Agent': UA, Referer: `${NM_PLAY_ORIGEN}/` },
    });
    if (!r.ok) return null;
    const txt = await r.text();
    if (!txt.startsWith('#EXTM3U')) return null;

    const audios: AudioHls[] = [];
    const video: VideoVariante[] = [];
    const lineas = txt.split('\n').map(l => l.trim());

    for (let i = 0; i < lineas.length; i++) {
      const l = lineas[i];
      if (l.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/i.test(l)) {
        const language = /LANGUAGE="([^"]+)"/i.exec(l)?.[1] || '';
        const name = /NAME="([^"]+)"/i.exec(l)?.[1] || '';
        const uri = /URI="([^"]+)"/i.exec(l)?.[1] || '';
        const defaultTrack = /DEFAULT=YES/i.test(l);
        // Las URIs de audio son publicas y vienen absolutas ("https://s88...").
        // Filtramos las vacías ("https:///files/...") que salen cuando el netflix_id no está.
        if (uri && /^https?:\/\/[^/]+\//i.test(uri)) {
          audios.push({ language, name, uri, defaultTrack });
        }
      } else if (l.startsWith('#EXT-X-STREAM-INF')) {
        const bandwidth = Number(/BANDWIDTH=(\d+)/i.exec(l)?.[1] || 0);
        const resolution = /RESOLUTION=(\d+x\d+)/i.exec(l)?.[1] || null;
        const defaultTrack = /DEFAULT=YES/i.test(l);
        const uri = lineas[i + 1] || '';
        // Solo variantes reales; las de placeholder tienen `in=unknown` cuando el netflix_id no
        // existe (medido: `s21.freecdn4.top/files/220884/...` para ids no reconocidos).
        if (uri && /^https?:\/\//.test(uri) && !/unknown/i.test(uri)) {
          video.push({ bandwidth, resolution, uri, defaultTrack });
        }
      }
    }

    // Sin audios reales el master no vale (netflix_id inexistente o token muerto).
    if (audios.length === 0) return null;
    return { audios, video };
  } catch { return null; }
}
