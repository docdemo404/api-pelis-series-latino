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
  return {
    mp4: j.mp4,
    referer: REFERER_MP4,
    subtitulosEs: filtrarYordenarEsp(j.captions),
    meta: {
      title: j.title || '',
      year: j.year || '',
      imdb: j.imdb || '',
      resolution: j.resolution,
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
