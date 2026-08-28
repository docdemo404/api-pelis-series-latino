/**
 * MOVIEDAYS (moviedays.lat) — la fuente que NO tiene catálogo.
 *
 * Todas las demás fuentes de esta API son webs: se recorre su índice, se lee una ficha, se saca
 * un título y después hay que averiguar a qué obra de TMDB corresponde. De ahí sale el problema
 * que FUENTES.md documenta como origen de casi todos los fallos graves — emparejar por título.
 *
 * Esta no. Moviedays es un MOTOR DE EMBEDS INDEXADO POR TMDB ID: se le pregunta por un id y
 * contesta con los servidores que tiene para esa obra, o con un 404 si no tiene ninguno. No hay
 * índice que recorrer, no hay slug que interpretar y, sobre todo, NO HAY NADA QUE EMPAREJAR: la
 * identidad viene con la respuesta, que es el caso ideal del punto 1 de FUENTES.md. Por eso el
 * descubrimiento de fichas nuevas no vive aquí sino en `scrapeMoviedaysLatest`, que usa TMDB como
 * índice y a esta fuente como oráculo de «¿tienes vídeo de esto?».
 *
 * Contrato medido el 2026-08-21:
 *
 *   api/embed.php?tmdb=<id>&type=pelicula                 → película
 *   api/embed.php?tmdb=<id>&type=serie&se=<N>&ep=<M>      → capítulo
 *   api/seasons.php?tmdb=<id>                             → temporadas y episodios
 *
 * y devuelve, además de `servers[]`, la metadata de TMDB ya resuelta: `tmdb_id`, `title`,
 * `original_title`, `release_year`, `imdb_id`, géneros y duración.
 *
 * NO FABRICA FICHAS FANTASMA, y eso se comprobó a propósito antes de escribir una línea: a un id
 * inexistente contesta `success: false` («No se pudo obtener info de TMDB»), y a un id real del
 * que no tiene vídeo —un corto oscuro, un capítulo que no existe— contesta 404. Nunca inventa un
 * servidor para justificar una respuesta. Es la condición mínima para dejar que una fuente dé de
 * alta títulos: la que no la cumple llena el catálogo de fichas que se anuncian y no reproducen.
 */
import { ServerOption, ContentType } from '../types';
import { USER_AGENT, httpClient } from '../utils/httpClient';
import { inspectEmbed } from './embedHealth';
import { extractDirect, describeDirect, deferredDirectFields } from './directStream';
import { nombreConTipo } from '../services/streamSorter';

export const MOVIEDAYS_BASE = 'https://moviedays.lat';

/**
 * El `Referer` no es cosmético: `api/servers.php` contesta «Origin requerido» sin él, y aunque
 * `embed.php` hoy responda igual, pedir como pide su propia página es lo que evita que un día
 * cualquiera nos empiecen a filtrar por parecer lo que somos.
 */
const CABECERAS = {
  'User-Agent': USER_AGENT,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'es-ES,es;q=0.9',
  Referer: `${MOVIEDAYS_BASE}/`,
  Origin: MOVIEDAYS_BASE,
};

/** Su `embed.php` tarda 2-4 s porque resuelve contra TMDB y contra sus proveedores. */
const TIMEOUT = 20000;

/** Lo que `embed.php` contesta cuando tiene algo. Solo se declara lo que se usa. */
export interface MoviedaysPayload {
  success: boolean;
  tmdb_id: number;
  type: string;
  title: string;
  original_title: string;
  poster: string | null;
  backdrop: string | null;
  imdb_id: string | null;
  overview: string;
  release_year: number | string | null;
  genres?: Array<string | { name: string }>;
  runtime?: number;
  vote_average?: number;
  total_seasons?: number;
  total_episodes?: number;
  season?: number;
  episode?: number;
  total_servers?: number;
  servers?: MoviedaysServer[];
}

export interface MoviedaysServer {
  name?: string;
  quality?: string;
  lang?: string;
  url?: string;
  provider?: string;
}

/**
 * QUÉ PROVEEDORES SE APROVECHAN, y por qué uno de los dos se tira entero.
 *
 * Moviedays agrega dos: `vimeus` (embeds de `vimeos.net`) y `zonaaps`. El segundo NO SE PUEDE
 * SERVIR desde aquí, y no es una sospecha: su cadena es
 *
 *   moviedays.lat/api/serve.php → api/stream.php → zonaaps-player.xyz/embed3.php
 *                               → zonaaps.com/embed-pro.php → 403 Cf-Mitigated: challenge
 *
 * o sea que termina contra el muro de Cloudflare de zonaaps.com, que rechaza a cualquier
 * datacenter — medido contra el dominio entero, incluidos su `wp-json` y su sitemap. Desde Vercel
 * no hay forma de atravesarlo (haría falta un Worker de Cloudflare haciendo de relé, que es
 * precisamente el truco del worker ajeno que se descartó por no depender de un tercero).
 *
 * Así que sus servidores se descartan aquí mismo en vez de publicarse. Es la regla que ya aplican
 * las otras fuentes y que `getStreams` repite a su manera: **publicar un servidor muerto es peor
 * que no publicarlo**, porque el reproductor lo intenta igual y el espectador ve un error.
 *
 * Si algún día se monta el relé en el Worker propio (`worker/`), esto es lo único que hay que
 * tocar: quitar el filtro y darle a `serve.php` la política de host que le corresponda.
 */
const PROVEEDORES_ALCANZABLES = new Set(['vimeus']);

/** Calidad tal como la rotula moviedays → la que entiende `ServerOption`. */
function calidadDeMoviedays(crudo: string | undefined): ServerOption['quality'] {
  const q = String(crudo || '').toLowerCase();
  if (q.includes('4k') || q.includes('2160')) return '4K';
  if (q.includes('720')) return '720p';
  if (q.includes('480') || q.includes('sd')) return '480p';
  // «Full HD» y cualquier cosa que no se reconozca caen aquí. No es inventar: es el valor que
  // ya usan las otras fuentes cuando el sitio no declara nada más preciso.
  return '1080p';
}

function idiomaDeMoviedays(crudo: string | undefined): ServerOption['language'] {
  const l = String(crudo || '').toLowerCase();
  if (l.includes('sub')) return 'subtitulado';
  if (l.includes('cast') || l.includes('españ') || l.includes('espan')) return 'castellano';
  return 'latino';
}

/**
 * La URL canónica de una ficha en esta fuente, que es la que se guarda en `_source_url`.
 *
 * Se guarda una URL REAL y no un identificador inventado (`moviedays://550`) porque todo el
 * catálogo trata `_source_url` como algo que se puede volver a pedir: las reparaciones, el
 * comprobador y `fetchSourceSignals` la usan tal cual. Una que no se pueda abrir sería una mina.
 */
export function moviedaysSourceUrl(
  tmdbId: number,
  type: ContentType,
  season?: number,
  episode?: number
): string {
  const params = new URLSearchParams({
    tmdb: String(tmdbId),
    type: type === 'tvseries' ? 'serie' : 'pelicula',
  });
  if (type === 'tvseries' && season && episode) {
    params.set('se', String(season));
    params.set('ep', String(episode));
  }
  return `${MOVIEDAYS_BASE}/api/embed.php?${params.toString()}`;
}

export function esUrlDeMoviedays(url: string): boolean {
  return /moviedays\.lat\//i.test(String(url || ''));
}

/** Lo que una `_source_url` de esta fuente lleva dentro, o null si no es de aquí. */
export function parseMoviedaysUrl(url: string): {
  tmdbId: number;
  type: ContentType;
  season?: number;
  episode?: number;
} | null {
  if (!esUrlDeMoviedays(url)) return null;
  try {
    const u = new URL(url);
    const tmdbId = Number(u.searchParams.get('tmdb'));
    if (!tmdbId || !Number.isFinite(tmdbId)) return null;
    const crudo = (u.searchParams.get('type') || 'pelicula').toLowerCase();
    // `anime` es una serie para todo lo que hay aguas abajo: TMDB numera películas y series, no
    // animes. Tratarlo como clase propia obligaría a buscar en un catálogo que no existe.
    const type: ContentType = crudo === 'serie' || crudo === 'anime' || crudo === 'tv' ? 'tvseries' : 'movie';
    const season = Number(u.searchParams.get('se')) || undefined;
    const episode = Number(u.searchParams.get('ep')) || undefined;
    return { tmdbId, type, season, episode };
  } catch {
    return null;
  }
}

/**
 * UNA petición a `embed.php`. Devuelve null tanto si la red falla como si moviedays dice que no
 * tiene nada — para quien llama son el mismo caso: de aquí no sale ficha.
 *
 * El 404 NO se trata como error: es su forma de decir «este id existe en TMDB pero no tengo
 * vídeo». Por eso `validateStatus` acepta todo y el veredicto se toma leyendo `success`.
 */
export async function pedirMoviedays(
  tmdbId: number,
  type: ContentType,
  season?: number,
  episode?: number
): Promise<MoviedaysPayload | null> {
  if (!tmdbId || tmdbId <= 0) return null;
  /**
   * A UNA SERIE SIN CAPÍTULO SE LE PREGUNTA POR SU 1x1.
   *
   * `embed.php` contesta 400 a `type=serie` sin `se`/`ep`: no existe una «ficha de serie», solo
   * fichas de capítulo. Pero la respuesta de cualquiera de ellos trae la metadata de la SERIE
   * entera —`original_title`, póster, sinopsis, `total_seasons`— así que el 1x1 sirve de sonda:
   * responde a la vez «¿tienes esta serie?» y «¿cómo se llama?».
   *
   * Se hace aquí y no en cada llamante para que la `_source_url` que se guarda pueda ser la de la
   * serie, sin capítulo. Si llevara el 1x1 dentro, cada reparación futura estaría preguntando por
   * un capítulo concreto en vez de por la obra.
   */
  const se = type === 'tvseries' ? season || 1 : undefined;
  const ep = type === 'tvseries' ? episode || 1 : undefined;
  try {
    const res = await httpClient.get(moviedaysSourceUrl(tmdbId, type, se, ep), {
      headers: CABECERAS,
      timeout: TIMEOUT,
      validateStatus: () => true,
    } as any);
    const data = res.data as any;
    if (!data || typeof data !== 'object' || data.success !== true) return null;
    return data as MoviedaysPayload;
  } catch {
    return null;
  }
}

/** Las temporadas y capítulos que declara moviedays (`seasons.php`). Null si no contesta. */
export async function pedirTemporadasMoviedays(tmdbId: number): Promise<any[] | null> {
  if (!tmdbId || tmdbId <= 0) return null;
  try {
    const res = await httpClient.get(`${MOVIEDAYS_BASE}/api/seasons.php?tmdb=${tmdbId}`, {
      headers: CABECERAS,
      timeout: TIMEOUT,
      validateStatus: () => true,
    } as any);
    const data = res.data as any;
    if (!data || data.success !== true || !Array.isArray(data.seasons)) return null;
    return data.seasons;
  } catch {
    return null;
  }
}

/**
 * Convierte los `servers[]` de moviedays en `ServerOption[]`, resolviendo el vídeo directo.
 *
 * Es el mismo camino que videoapi: inspeccionar el embed y pasarlo por `extractDirect`, que ya
 * sabe desempaquetar el `p,a,c,k,e,d` de `vimeos.net` y sacar el m3u8. Eso no es teoría — se probó
 * con el propio extractor del repo antes de escribir esto, sobre Fight Club, Breaking Bad T1E1 y
 * Stranger Things T4E1, y los tres devolvieron un manifiesto que responde 200.
 *
 * `idPrefijo` separa los servidores de una película (`srv_md_1`) de los de un capítulo
 * (`srv_md_1x3_1`), porque los ids conviven en la misma fila cuando se guarda una serie.
 */
export async function servidoresDeMoviedays(
  payload: MoviedaysPayload | null,
  idPrefijo = 'srv_md'
): Promise<ServerOption[]> {
  const crudos = (payload?.servers || []).filter(
    s => s?.url && PROVEEDORES_ALCANZABLES.has(String(s.provider || '').toLowerCase())
  );
  if (crudos.length === 0) return [];

  const vistos = await Promise.allSettled(
    crudos.map(async s => {
      const embedUrl = String(s.url);
      // El Referer que espera el embed es el de moviedays, que es quien lo publica. Con el de
      // tioplus —el que `inspectEmbed` pone por defecto— se estaría mintiendo sobre el origen.
      const { status, html } = await inspectEmbed(embedUrl, `${MOVIEDAYS_BASE}/`);
      const direct = await extractDirect(embedUrl, html);
      return { crudo: s, embedUrl, status, direct };
    })
  );

  const servers: ServerOption[] = [];
  vistos.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value?.embedUrl) return;
    const { crudo, embedUrl, status, direct } = r.value;
    // Igual que en las otras fuentes: a un embed recién declarado muerto no se le cuelga un vídeo
    // directo, porque publicarlo muerto es peor que no publicarlo.
    const directo =
      status === 'offline'
        ? {}
        : direct
        ? describeDirect(embedUrl, direct)
        : deferredDirectFields(embedUrl);
    servers.push({
      id: `${idPrefijo}_${i + 1}`,
      name: nombreConTipo(crudo.name?.trim() || 'Vimeos', Boolean((directo as any).direct_stream)),
      quality: direct?.quality || calidadDeMoviedays(crudo.quality),
      language: idiomaDeMoviedays(crudo.lang),
      embed_url: embedUrl,
      ...directo,
      status,
      last_checked: new Date().toISOString(),
      source_id: 'moviedays',
    });
  });
  return servers;
}

/**
 * Los servidores SIN resolver: lo que moviedays dice tener, sin bajar a ningún embed.
 *
 * Es lo que usa el crawl para descubrir (ver `scrapeMoviedaysDetail`). Devuelve el servidor con su
 * `embed_url` y su nombre, pero sin `direct_stream` y con estado `checking` — que es la verdad:
 * todavía no se ha mirado. Ponerle `online` sería afirmar algo que no se ha comprobado, y este
 * proyecto ya ha pagado dos veces por dar por bueno un servidor que nadie abrió.
 */
export function sondaDeServidoresMoviedays(payload: MoviedaysPayload | null): ServerOption[] {
  return (payload?.servers || [])
    .filter(s => s?.url && PROVEEDORES_ALCANZABLES.has(String(s.provider || '').toLowerCase()))
    .map((s, i) => ({
      id: `srv_md_${i + 1}`,
      name: String(s.name || 'Vimeos'),
      quality: calidadDeMoviedays(s.quality),
      language: idiomaDeMoviedays(s.lang),
      embed_url: String(s.url),
      status: 'checking' as const,
      last_checked: new Date().toISOString(),
      source_id: 'moviedays',
    }));
}

/**
 * El árbol de temporadas de una serie, con los servidores puestos SOLO en el capítulo al que
 * pertenecen.
 *
 * Esto no es un adorno, es lo que evita una mentira. La ficha de una serie de esta fuente lleva
 * los servidores del capítulo con el que se la sondeó (su 1x1), y hay dos sitios del código
 * —`ensureSeasons` y `enrichMediaItem`— que, cuando una serie llega SIN temporadas, se las
 * reconstruyen desde TMDB pasando `item.servers` como servidores por defecto DE TODOS LOS
 * CAPÍTULOS. O sea que el vídeo del 1x1 acabaría colgado del 3x5, del 4x2 y de los sesenta
 * restantes: el espectador pulsa un capítulo y ve el piloto.
 *
 * Las dos reconstrucciones están guardadas tras un `seasons.length === 0`, así que traer el árbol
 * hecho desde aquí las desactiva a las dos. El resto de capítulos salen con `servers: []`, que es
 * la verdad —todavía no se han resuelto— y es justo lo que el camino de episodios sabe rellenar
 * cuando alguien los abre.
 */
export function temporadasDeMoviedays(
  crudas: any[] | null,
  servidoresDelSondeo: ServerOption[],
  sondeo: { season: number; episode: number }
): any[] {
  if (!Array.isArray(crudas) || crudas.length === 0) return [];
  return crudas
    .map(t => {
      const season = Number(t?.seasonNumber);
      if (!season) return null;
      const episodes = (Array.isArray(t?.episodes) ? t.episodes : [])
        .map((e: any) => {
          const numero = Number(e?.episodeNumber);
          if (!numero) return null;
          const esElSondeado = season === sondeo.season && numero === sondeo.episode;
          return {
            episode_number: numero,
            name: String(e?.name || `Episodio ${numero}`),
            overview: String(e?.overview || ''),
            still_path: e?.still || t?.poster || null,
            air_date: e?.airDate || null,
            servers: esElSondeado ? servidoresDelSondeo : [],
          };
        })
        .filter(Boolean);
      if (episodes.length === 0) return null;
      return {
        season_number: season,
        name: String(t?.name || `Temporada ${season}`),
        episodes_count: Number(t?.episodeCount) || episodes.length,
        poster: t?.poster || null,
        episodes,
      };
    })
    .filter(Boolean) as any[];
}

/**
 * El título de la OBRA, no el del capítulo.
 *
 * En las series `title` viene rotulado «Breaking Bad — T1E1: Piloto», y guardar eso como título de
 * la ficha dejaría el catálogo lleno de series llamadas como su primer capítulo. El resto de
 * campos del payload (`original_title`, póster, sinopsis) ya son de la serie, solo este no.
 */
export function tituloDeMoviedays(payload: MoviedaysPayload): string {
  return String(payload.title || '')
    .replace(/\s*[—–-]\s*T\d{1,3}\s*E\d{1,4}\s*:.*$/i, '')
    .trim();
}

/** El nombre del capítulo que rotula `title`, o '' si esta ficha no es un capítulo. */
export function nombreDelEpisodioMoviedays(payload: MoviedaysPayload): string {
  const m = /\s*[—–-]\s*T\d{1,3}\s*E\d{1,4}\s*:\s*(.+)$/i.exec(String(payload.title || ''));
  return m ? m[1].trim() : '';
}

/** El año que declara `release_year`, en el formato `release_date` que espera `MediaItem`. */
export function fechaDeMoviedays(payload: MoviedaysPayload): string {
  const y = Number(payload.release_year);
  return y && y > 1800 && y < 2200 ? `${y}-01-01` : '';
}

/** Los géneros vienen como strings o como `{ name }` según el endpoint. */
export function generosDeMoviedays(payload: MoviedaysPayload): string[] {
  return (payload.genres || [])
    .map(g => (typeof g === 'string' ? g : g?.name))
    .filter((g): g is string => Boolean(g));
}
