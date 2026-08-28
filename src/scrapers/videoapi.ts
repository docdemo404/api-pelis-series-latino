/**
 * videoapi.la — LA PRIMERA FUENTE QUE NO SE CRAWLEA.
 *
 * Todas las demás son webs: hay que recorrer su índice, leer su plantilla, adivinar de qué obra
 * habla cada página y demostrarlo. De ahí salen casi todos los destrozos que documenta FUENTES.md.
 *
 * Esta no. videoapi.la es un proveedor de embeds con documentación pública (https://videoapi.la/api)
 * que direcciona POR TMDB ID y **publica su catálogo entero** en cinco listas de texto plano. O sea:
 *
 *   · no hay índice que recorrer     — te dan la lista;
 *   · no hay identidad que demostrar — el id lo pone la fuente, no lo deduce el matcher;
 *   · no hay plantilla que parsear   — la url del embed se construye con el id.
 *
 * El capítulo 1 de FUENTES.md («nada adopta la identidad de otra cosa sin una prueba independiente
 * del título») no es que se cumpla: es que no llega a aplicar. No hay título de por medio en ningún
 * momento. Comprobado con controles — `movie/999999999`, `movie/0` y `tv/1399/99/99` contestan sin
 * embed, así que tampoco acuña ids a ciegas.
 *
 * SE LE HABLA AL PROVEEDOR, NO A SU CLIENTE. A esta fuente se llegó por modocine.com, que es una
 * web que le pinta una portada encima con las listas de TMDB. Modocine no tiene catálogo propio
 * —su portada son ~286 tarjetas que TMDB considera populares hoy— y puede cerrar mañana. El
 * proveedor es lo que hay debajo y lo que aquí se usa. `videoapp.zip` es otra piel del mismo
 * backend y sirve de reserva (ver ORIGENES).
 *
 * MEDIDO EL 2026-08-27, contra el catálogo de ese día:
 *
 *   películas       ellos 7.916 · nosotros 1.033 · compartido 739  → 7.177 nuevas (91 % de lo suyo)
 *   series y anime  ellos 1.800 · nosotros   175 · compartido  86  → 1.714 nuevas (95 %)
 *   capítulos       34.001 de serie + 16.863 de anime, nombrados uno a uno
 *
 * Y entrega vídeo: 23 títulos probados de punta a punta (15 del catálogo + 8 nuevos al azar), 23
 * reproducen. No hizo falta escribir extractor — su reproductor es `vimeos.net`, que ya se extrae
 * (`mereceRepasoDeExtraccion`) y tiene perfil medido en hostPolicy.
 *
 *   npx ts-node --transpile-only scripts/dev/diag_videoapi.ts          ← la cadena entera
 *   npx ts-node --transpile-only scripts/dev/diag_videoapi_solape.ts   ← cuánto es nuevo
 */
import { httpClient } from '../utils/httpClient';

/**
 * DOS PIELES DEL MISMO BACKEND, y la segunda no es adorno.
 *
 * `videoapi.la` es el origen documentado y va primero. `videoapp.zip` sirve exactamente el mismo
 * `/e/…` (comprobado: mismos ids de vimeos para los mismos tmdb) y existe como reserva para el
 * único fallo que este diseño no puede absorber solo — que un dominio caiga o que Cloudflare le
 * cierre la puerta a la IP desde la que corremos.
 *
 * No se prueban los dos en cada llamada: se prueba el primero y solo se baja al segundo si el
 * primero no contesta. Multiplicar por dos las peticiones de una fuente que va a recibir ~10.000
 * es la forma más rápida de que empiece a contestar 429.
 */
export const ORIGENES = ['https://videoapi.la', 'https://videoapp.zip'] as const;

/** Las listas que publica, tal cual las nombra su documentación. */
const LISTAS = {
  peliculas: 'movies',
  series: 'tvshows',
  capitulos: 'episodes',
  anime: 'anime',
  capitulosAnime: 'anime-episodes',
} as const;

/**
 * El User-Agent va explícito y no se hereda el de `httpClient`.
 *
 * Cloudflare está delante de los dos orígenes, y lo que decide si contesta o planta un desafío es
 * la pinta del cliente. Un agente de navegador pasa; el de axios por defecto es una invitación a
 * que te miren con lupa. No es paranoia: es la diferencia entre 200 y 403 en el primer intento.
 */
export const UA_NAVEGADOR =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Qué clase de obra es, en el vocabulario de la fuente. */
export type ClaseVideoapi = 'movie' | 'tv' | 'anime';

/**
 * LA URL DEL EMBED, QUE SE CONSTRUYE Y NO SE DESCUBRE.
 *
 * Esto es lo que hace a esta fuente distinta de todas las demás y conviene entenderlo antes de
 * tocar nada: la url no sale de ninguna página, sale del `tmdb_id` que ya está en la fila. Es
 * derivable, así que NO CADUCA NUNCA y no hay que volver a rastrear nada para recuperarla.
 *
 * Por eso es esta la que se guarda como `embed_url`, y no la de `vimeos.net` que hay detrás: el
 * fichero de vimeos ROTA entre copias espejo (medido — `634492` y `1084736` devolvieron otro id en
 * la segunda llamada) y su token `cf=` dura 6 h. Guardar aquello sería guardar algo que se pudre;
 * guardar esto es guardar una operación aritmética sobre un número que no cambia.
 */
export function embedDeVideoapi(
  clase: ClaseVideoapi,
  tmdbId: number,
  temporada?: number,
  capitulo?: number,
  origen: string = ORIGENES[0]
): string {
  if (clase === 'movie') return `${origen}/e/movie/${tmdbId}`;
  return `${origen}/e/${clase}/${tmdbId}/${temporada ?? 1}/${capitulo ?? 1}`;
}

/** ¿Esta url es de la fuente? Vale para las dos pieles. */
export function esUrlDeVideoapi(url: string): boolean {
  return /(?:videoapi\.la|videoapp\.zip)\/e\//i.test(url || '');
}

/** El `tmdb_id`, la temporada y el capítulo que hay escritos en una url de la fuente. */
export function datosDeLaUrl(
  url: string
): { clase: ClaseVideoapi; tmdbId: number; temporada?: number; capitulo?: number } | null {
  const m = String(url || '').match(/\/e\/(movie|tv|anime|novel|wwe)\/(\d+)(?:\/(\d+)\/(\d+))?/i);
  if (!m) return null;
  const clase = m[1].toLowerCase();
  return {
    clase: (clase === 'movie' || clase === 'anime' ? clase : 'tv') as ClaseVideoapi,
    tmdbId: Number(m[2]),
    temporada: m[3] ? Number(m[3]) : undefined,
    capitulo: m[4] ? Number(m[4]) : undefined,
  };
}

async function bajarLista(fichero: string): Promise<string> {
  let ultimoFallo = '';
  for (const origen of ORIGENES) {
    try {
      const r = await httpClient.get(`${origen}/api/v1/public/wordpress/ids/${fichero}.txt`, {
        // Las listas llegan a 350 KB y no las sirve un CDN de borde: 90 s es el tope que hace
        // falta para que no se corten en un runner con la red cargada.
        timeout: 90000,
        responseType: 'text',
        transformResponse: [(d: unknown) => d],
        headers: { 'User-Agent': UA_NAVEGADOR },
        validateStatus: () => true,
      });
      if (r.status === 200 && typeof r.data === 'string' && r.data.length > 0) return r.data;
      ultimoFallo = `${origen} → HTTP ${r.status}`;
    } catch (e: any) {
      ultimoFallo = `${origen} → ${e?.code || e?.message}`;
    }
  }
  throw new Error(`no se pudo bajar ${fichero}.txt (${ultimoFallo})`);
}

/** Un capítulo, tal y como lo nombra `episodes.txt`: `1855_4x26` → serie 1855, T4 E26. */
export interface CapituloDeVideoapi {
  tmdbId: number;
  temporada: number;
  capitulo: number;
}

function parsearCapitulos(texto: string): CapituloDeVideoapi[] {
  const out: CapituloDeVideoapi[] = [];
  for (const linea of texto.split('\n')) {
    const m = linea.trim().match(/^(\d+)_(\d+)x(\d+)$/);
    if (!m) continue;
    out.push({ tmdbId: Number(m[1]), temporada: Number(m[2]), capitulo: Number(m[3]) });
  }
  return out;
}

function parsearIds(texto: string): number[] {
  const vistos = new Set<number>();
  for (const linea of texto.split('\n')) {
    const n = Number(linea.trim());
    if (Number.isFinite(n) && n > 0) vistos.add(n);
  }
  return [...vistos];
}

export interface CatalogoDeVideoapi {
  peliculas: number[];
  series: number[];
  anime: number[];
  /** Los capítulos QUE EXISTEN, agrupados por serie. La clave es el `tmdb_id`. */
  capitulosPorSerie: Map<number, CapituloDeVideoapi[]>;
}

/**
 * El catálogo entero de la fuente, en cinco peticiones.
 *
 * QUE LOS CAPÍTULOS VENGAN NOMBRADOS UNO A UNO ES LO MÁS VALIOSO DE TODO ESTO, y no se nota a
 * primera vista. FUENTES.md llama «el fallo peor sin dar error» a rellenar un capítulo con los
 * enlaces de la serie: pides el 1 y ves otro, y nadie se entera porque hay vídeo. Aquí no hay que
 * defenderse de eso con comprobaciones — la fuente dice exactamente qué capítulos tiene, y a los
 * que no están en su lista no se les cuelga nada.
 */
export async function listarCatalogo(): Promise<CatalogoDeVideoapi> {
  const [peliculas, series, capitulos, anime, capitulosAnime] = await Promise.all([
    bajarLista(LISTAS.peliculas),
    bajarLista(LISTAS.series),
    bajarLista(LISTAS.capitulos),
    bajarLista(LISTAS.anime),
    bajarLista(LISTAS.capitulosAnime),
  ]);

  const capitulosPorSerie = new Map<number, CapituloDeVideoapi[]>();
  for (const c of [...parsearCapitulos(capitulos), ...parsearCapitulos(capitulosAnime)]) {
    const ya = capitulosPorSerie.get(c.tmdbId);
    if (ya) ya.push(c);
    else capitulosPorSerie.set(c.tmdbId, [c]);
  }

  return {
    peliculas: parsearIds(peliculas),
    series: parsearIds(series),
    anime: parsearIds(anime),
    capitulosPorSerie,
  };
}

/**
 * ¿De qué clase es esta serie para la fuente, `tv` o `anime`?
 *
 * Importa porque la url del embed lleva la clase dentro y las dos listas son disjuntas: pedir un
 * anime por `/e/tv/…` no da un 404 elegante, da una página sin embed. Y como el `type` de nuestro
 * catálogo es `tvseries` para las dos, este dato solo lo tiene la fuente.
 *
 * Se recibe el juego de anime como `Set` y no como el catálogo entero porque esto se llama una vez
 * por serie sobre una lista de 795: con `Array.includes` serían 1.800 × 795 comparaciones por
 * corrida para contestar algo que es una consulta de tabla.
 */
export function claseDeSerie(tmdbId: number, animes: Set<number>): ClaseVideoapi {
  return animes.has(tmdbId) ? 'anime' : 'tv';
}
