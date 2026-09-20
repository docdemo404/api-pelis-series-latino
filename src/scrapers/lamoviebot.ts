/**
 * lamovie.org, POR LA API DE UN TERCERO — Y POR QUÉ ESO NO NOS ATA A ÉL.
 *
 * `lamoviebot.tvymas.workers.dev` es un Worker ajeno (dev: jjma49 / t.me/GATESCCN) que indexa
 * lamovie.org y lo publica en JSON. Depender de la infraestructura de otro da miedo con razón, así
 * que conviene tener claro QUÉ le compramos exactamente, porque no es lo que parece:
 *
 *   · EL ÍNDICE  — sí, y es lo único frágil. Si el Worker muere, dejamos de enterarnos de títulos
 *                  NUEVOS. No se pierde ni uno de los ya importados.
 *   · LOS ENLACES — no son suyos. Son `goodstream.one/embed-…`, `hlswish.com/e/…`, `voe.sx/e/…`:
 *                  hosts de terceros que seguirán ahí. En cuanto se guardan en nuestra base, el
 *                  Worker SOBRA para reproducir.
 *   · LA RESOLUCIÓN — esa ni se le pide. Su `/streamurl` devuelve urls atadas a la IP del Worker
 *                  (`i=172.64&asn=13335`), o sea que al cliente le darían 403. Se guarda el EMBED
 *                  y lo resuelve nuestro `extractDirect` al reproducir, que es lo que ya hacemos
 *                  con todas las demás.
 *
 * Por eso no se intentó «copiar el Worker»: medido el 2026-09-20, lamovie.org no se deja leer
 * directamente —sitemaps a 500, `/peliculas/` pinta el catálogo con JavaScript y no trae un solo
 * enlace de ficha, y las urls de ficha dan 404 desde nuestra IP—. Importar es lo que nos
 * independiza; reimplementar sería pelearse a ciegas con un sitio que no podemos ni abrir.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 * SU `tmdb_id` ES UNA CANDIDATURA, NO UNA IDENTIDAD. Esto es lo más importante del módulo.
 *
 * videoapi DIRECCIONA por `tmdb_id`: se le pregunta por un número y contesta por esa obra o por
 * ninguna, así que su id es un dato publicado y FUENTES.md §1 ni llega a aplicar. Aquí NO. Este
 * Worker SCRAPEA lamovie.org y después le pega un `tmdb_id` que dedujo su propio matcher. O sea
 * que puede cometer —y comete— el fallo del que salen casi todos los destrozos del catálogo:
 *
 *     ficha «Los Malditos (2025)»  →  dice tmdb 1059010 = «Los malditos» / *I dannati* (2024)
 *     su propio enlace apuntaba a      tmdb  850439    = «Los condenados» / *The Damned* (2025)
 *
 * Emparejó por título en español y se llevó el homónimo del año equivocado, que es exactamente lo
 * que aquí produjo 42 adopciones indebidas en cinco títulos.
 *
 * MEDIDO sobre 119 películas (`diag_lamoviebot_identidad.ts`): acierta el 97 %, falla el 3 %. Los
 * tres fallos eran homónimos DEL MISMO AÑO —el caso que el año no puede separar— y los tres los
 * cazó el título original. De ahí `juzgarIdentidad`: su id se acepta solo si una señal
 * independiente del nombre regional lo respalda.
 *
 *   npx ts-node --transpile-only scripts/dev/diag_lamoviebot_identidad.ts   ← ¿sigue acertando?
 *   npx ts-node --transpile-only scripts/dev/diag_lamoviebot_extrae.ts      ← ¿sus hosts reproducen?
 *   npx ts-node --transpile-only scripts/dev/diag_fuentes_candidatas.ts     ← ¿cuánto aporta?
 */
import { httpClient } from '../utils/httpClient';
import { similarity } from '../services/tmdbService';

export const BASE_LAMOVIEBOT = 'https://lamoviebot.tvymas.workers.dev';

/**
 * Agente de navegador explícito, por lo mismo que en videoapi: hay Cloudflare delante y lo que
 * decide entre 200 y un desafío es la pinta del cliente.
 */
export const UA_NAVEGADOR =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Referer de la web de origen: sus embeds lo piden para no cortar por hotlinking. */
export const REFERER_LAMOVIE = 'https://lamovie.org/';

/** Cómo llama la fuente a cada catálogo. Los tres son listas paginadas con la misma forma. */
export type ClaseLamoviebot = 'peliculas' | 'series' | 'animes';

/** El singular, que es lo que va en la ruta del detalle. */
const SINGULAR: Record<ClaseLamoviebot, string> = {
  peliculas: 'pelicula',
  series: 'serie',
  animes: 'anime',
};

/**
 * HOSTS QUE NO SE GUARDAN, y cada uno por un motivo ya documentado.
 *
 * No es una lista de «hosts malos»: es la lista de los que sabemos que NO entregan vídeo por esta
 * vía, y guardarlos sería llenar las fichas de servidores que fallan al primer clic. FUENTES.md
 * §5.5 explica los dos primeros (muros que quedan fuera a propósito) y la medición del 2026-09-20
 * los dos últimos.
 */
const HOSTS_QUE_NO_ENTREGAN = [
  'filemoon',    // prueba de trabajo (`pow.js`) antes de soltar el vídeo — §5.5
  'waaw',        // exige prueba de interacción humana y firma antifraude — §5.5
  'krakenfiles', // reCAPTCHA — §5.5
  'mega.nz',     // cifrado en cliente, no es un embed reproducible
  'youtube.com', // es el tráiler, no la obra
  'youtu.be',
];

export interface FichaLamoviebot {
  title: string;
  slug: string;
  post_id?: number;
  year?: string;
  original_title?: string;
  release_date?: string;
  tmdb_id?: number;
  imdb_id?: string;
  /** Solo se usa como señal de identidad; la metadata la pone TMDB, nunca la fuente. */
  poster_tmdb?: string;
  temporadas?: TemporadaLamoviebot[];
}

export interface TemporadaLamoviebot {
  season_number: number;
  episodios?: Array<{ episode_number: number; url?: string }>;
}

export interface EmbedLamoviebot {
  /** La url del reproductor de un tercero. Esto es lo que se guarda: no depende del Worker. */
  link: string;
  host: string;
  server?: string;
  language?: string;
  quality?: string;
}

async function pedir(ruta: string, timeout = 45000): Promise<any> {
  const r = await httpClient.get(`${BASE_LAMOVIEBOT}${ruta}`, {
    timeout,
    headers: { 'User-Agent': UA_NAVEGADOR },
    validateStatus: () => true,
  });
  if (r.status !== 200) throw new Error(`lamoviebot ${ruta} → HTTP ${r.status}`);
  return r.data;
}

export interface PaginaLamoviebot {
  pagina: number;
  totalPaginas: number;
  totalFichas: number;
  fichas: FichaLamoviebot[];
}

/**
 * Una página del índice. La fuente reparte el mismo contenido en tres claves distintas según el
 * catálogo (`movies`, `series`, `animes`), así que se leen las tres y se normaliza aquí — que es
 * la clase de detalle que, leído en dos sitios, acaba divergiendo (FUENTES.md §4).
 */
export async function listarPagina(clase: ClaseLamoviebot, pagina = 1): Promise<PaginaLamoviebot> {
  const d = await pedir(`/${clase}?page=${pagina}`);
  const lista = d.movies || d.series || d.animes || [];
  return {
    pagina: Number(d.page) || pagina,
    totalPaginas: Number(d.total_pages) || 1,
    totalFichas: Number(d.total_results) || 0,
    fichas: (Array.isArray(lista) ? lista : []).filter((f: any) => f?.slug && f?.title),
  };
}

/**
 * La url pública de una ficha en la fuente, que es la que se guarda en `source_urls`.
 *
 * Existe para que la clase no se escriba a mano en el importador: allí se ponía `/serie/` para
 * series Y animes, y la página de un anime vive en `/anime/`. El id de fila salía igual —el molde
 * de `candidateIdsForUrl` reconoce las tres—, así que no se habría notado: solo quedaba guardada
 * una url que da 404, justo en el campo que sirve para volver a leer la ficha.
 */
export function urlDeFicha(clase: ClaseLamoviebot, slug: string): string {
  return `${BASE_LAMOVIEBOT}/${SINGULAR[clase]}/${slug}`;
}

/** El detalle de una ficha, con sus embeds y —si es serie— su árbol de temporadas. */
export async function detalle(clase: ClaseLamoviebot, slug: string): Promise<any> {
  return pedir(`/${SINGULAR[clase]}/${encodeURIComponent(slug)}`);
}

/**
 * El detalle de UN CAPÍTULO, que va por su propia ruta y tiene su propia función A PROPÓSITO.
 *
 * El primer intento componía el slug a mano (`detalle(clase, `${slug}/${t}/${e}`)`) y eso no
 * fallaba ruidosamente: `encodeURIComponent` convierte las barras en `%2F`, la fuente contestaba
 * 404 y el importador lo contaba como «este capítulo no tiene vídeo». O sea que una serie entera
 * se quedaba fuera con el mismo mensaje que usa un título sin enlaces, y el recuento final parecía
 * plausible — que es la peor forma de romperse.
 *
 * Y es justo donde está el valor de esta fuente: LAS FICHAS DE SERIE NO LLEVAN EMBEDS, los llevan
 * sus capítulos. Preguntando por el capítulo concreto no hay que defenderse de rellenarlo con los
 * enlaces de la serie —«el fallo peor sin dar error» de FUENTES.md—: lo que contesta esta ruta es
 * de este capítulo, y al que no contesta no se le cuelga nada.
 */
export async function detalleEpisodio(
  clase: ClaseLamoviebot,
  slug: string,
  temporada: number,
  capitulo: number
): Promise<any> {
  return pedir(`/${SINGULAR[clase]}/${encodeURIComponent(slug)}/${temporada}/${capitulo}`);
}

/**
 * LOS EMBEDS QUE MERECE LA PENA GUARDAR.
 *
 * Se descartan aquí y no al reproducir a propósito: un servidor guardado que nunca entrega no es
 * neutro —ocupa el primer puesto de la ficha, el cliente le da a Reproducir y ve un error—, y
 * además ensucia las mediciones de «servidores muertos» con hosts que nunca estuvieron vivos.
 */
export function embedsDe(detalleFicha: any): EmbedLamoviebot[] {
  const crudos: any[] = Object.values(detalleFicha?.embeds || {}).flat() as any[];
  const out: EmbedLamoviebot[] = [];
  const vistos = new Set<string>();
  for (const e of crudos) {
    const link = String(e?.link || '').trim();
    if (!link || vistos.has(link)) continue;
    let host = '';
    try {
      host = new URL(link).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    if (HOSTS_QUE_NO_ENTREGAN.some((h) => host.includes(h))) continue;
    vistos.add(link);
    out.push({
      link,
      host,
      server: e?.server ? String(e.server) : undefined,
      language: e?.language ? String(e.language) : undefined,
      quality: e?.quality ? String(e.quality) : undefined,
    });
  }
  return out;
}

/** El veredicto sobre el `tmdb_id` que propone la fuente. */
export type VeredictoIdentidad = 'confirma-original' | 'confirma-año' | 'CONTRADICE' | 'sin-datos';

/**
 * ¿RESPALDA ALGO INDEPENDIENTE DEL NOMBRE REGIONAL AL `tmdb_id` QUE PROPONE?
 *
 * La escalera es la de `resolveTmdb` y el ORDEN importa: el título original manda sobre el año,
 * porque un año suelto puede tapar un desmentido —el primero de los cinco caminos de FUENTES.md
 * §4 bis, donde un año de diferencia bastó para adoptar el póster y la sinopsis de otra película—.
 *
 * Se compara contra el original Y contra el título traducido del candidato porque TMDB devuelve el
 * original cuando no hay traducción, y esta fuente a veces publica el nombre regional en el campo
 * de original.
 */
export function juzgarIdentidad(
  suyo: { original_title?: string; year?: string; title?: string },
  tmdb: { original_title?: string; title?: string; fecha?: string }
): VeredictoIdentidad {
  const origSuyo = (suyo.original_title || '').trim();
  const origTmdb = (tmdb.original_title || '').trim();
  const anioSuyo = Number(String(suyo.year || '').slice(0, 4));
  const anioTmdb = Number(String(tmdb.fecha || '').slice(0, 4));
  const hayAnios = Number.isFinite(anioSuyo) && Number.isFinite(anioTmdb) && anioSuyo > 0 && anioTmdb > 0;

  if (origSuyo && origTmdb) {
    const s = Math.max(similarity(origSuyo, origTmdb), similarity(origSuyo, tmdb.title || ''));
    if (s >= 0.8) return 'confirma-original';
    // Un original que no se parece a NINGUNO de los nombres del candidato es un desmentido, y a
    // partir de ahí el año ya no puede respaldar por encima de él.
    if (hayAnios && Math.abs(anioSuyo - anioTmdb) > 1) return 'CONTRADICE';
    return s >= 0.5 ? 'confirma-año' : 'CONTRADICE';
  }

  if (hayAnios) return Math.abs(anioSuyo - anioTmdb) <= 1 ? 'confirma-año' : 'CONTRADICE';
  return 'sin-datos';
}

/** ¿Vale este veredicto para adoptar la ficha de TMDB? Solo lo respaldado; `sin-datos` no basta. */
export function respalda(v: VeredictoIdentidad): boolean {
  return v === 'confirma-original' || v === 'confirma-año';
}

/**
 * ¿Es de esta fuente esta url? Vale tanto para la del Worker como para la de lamovie.org, porque
 * la segunda puede aparecer guardada si algún día se importa por otra vía.
 */
export function esUrlDeLamoviebot(url: string): boolean {
  return /(?:lamoviebot\.[a-z0-9.-]+\.workers\.dev|lamovie\.org)\/(?:pelicula|serie|anime)\//i.test(url || '');
}

/**
 * El slug y la clase que hay escritos en una url de la fuente.
 *
 * Hace falta porque el último tramo de la ruta NO SIRVE en las urls de episodio
 * (`/serie/kenan-y-kel-1996/1/1` acaba en «1», un número pelado que chocaría con cualquier slug
 * numérico de otra web), igual que pasa con videoapi. La identidad vive en medio de la ruta.
 */
export function datosDeLaUrl(url: string): { clase: 'pelicula' | 'serie' | 'anime'; slug: string } | null {
  const m = String(url || '').match(/\/(pelicula|serie|anime)\/([^/?#]+)/i);
  if (!m) return null;
  return { clase: m[1].toLowerCase() as any, slug: decodeURIComponent(m[2]) };
}

/**
 * El id de fila. Lleva el tipo dentro por lo mismo que `va-tv-…`: el mismo slug puede designar una
 * película y una serie, y la clave primaria no admite las dos.
 */
export function idDeFicha(tipo: 'movie' | 'tvseries', slug: string): string {
  return tipo === 'movie' ? `lmb-${slug}` : `lmb-tv-${slug}`;
}
