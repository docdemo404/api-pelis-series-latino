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
 * ── Y CUIDADO CON CÓMO SE COMPRUEBA, QUE AQUÍ SE FALLÓ UNA VEZ ───────────────────────────────
 *
 * El primer intento comparó el `original_title` que publica la fuente contra el de TMDB y dio un
 * 97 % de acierto. **Ese número no valía nada.** Medido después: el `original_title` del Worker
 * coincide con el de TMDB en 24 de 24 fichas, tanto en el listado como en el detalle, porque lo
 * RELLENA DESDE TMDB al emparejar. La comprobación le estaba preguntando a TMDB si estaba de
 * acuerdo consigo mismo. Lo mismo vale para `release_date`, y sus imágenes están en su propio CDN,
 * así que tampoco hay hash de `image.tmdb.org` con el que confirmar.
 *
 * Lo que SÍ es independiente son sus propios embeds: incrusta un reproductor de `videoapp.zip`,
 * que direcciona por TMDB id, y ese número lo puso OTRO matcher. Medido sobre 30 fichas: 29 traen
 * ese segundo voto (97 %), 28 coinciden y 1 discrepa. Ver `juzgarIdentidad`.
 *
 * La lección, que vale para la próxima fuente: **antes de fiarte de una señal, comprueba que no
 * venga del mismo sitio que lo que quieres verificar.** Una guarda circular es peor que ninguna,
 * porque tranquiliza.
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
  /**
   * `voe.sx` NO es que falle: es que MIENTE, y por eso encabeza la lista.
   *
   * Nos devuelve un clip de prueba de diez segundos (Big Buck Bunny) haciéndose pasar por la obra,
   * en **83 de 83** extracciones medidas el 2026-09-20. Como es un mp4 real y sano, pasó la
   * verificación entera —resolver, manifiesto, segmento— y 79 fichas se anunciaron con un conejo
   * dentro. Lo cazó el usuario, no el código.
   *
   * Hay guarda genérica en `esVideoDeMuestra` (directStream) para que ningún host vuelva a colar
   * material de demostración. Esto es la segunda cerradura: ni se guarda el embed.
   */
  'voe.sx',
  /**
   * `lamovie.org` COMO «reproductor» ES UN ESTANTE VACÍO, no un extractor que nos falte.
   *
   * Cuando una ficha suya no tiene ningún host de terceros, publica como embed
   * `https://lamovie.org/embed.html?v=1` — **la misma url para todas**, una página estática de
   * 2,5 KB titulada «Contenido no disponible». No hay vídeo detrás ni lo hubo.
   *
   * Importa saberlo porque explica el rendimiento real de la fuente: de las 415 fichas que
   * quedaban en cola el 2026-09-20, la inmensa mayoría son de esta clase. No se recuperan
   * escribiendo código.
   */
  'lamovie.org/embed',
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
export type VeredictoIdentidad =
  | 'confirma-segundo-voto'
  | 'confirma-original'
  | 'confirma-año'
  | 'CONTRADICE'
  | 'sin-datos';

/**
 * El título y el año que lleva escritos el SLUG, que es lo único de esta fuente que no viene de
 * TMDB: `amor-y-compasion-2015` → «amor y compasion», 2015.
 */
export function datosDelSlug(slug: string): { titulo: string; anio: number } {
  const m = String(slug || '').match(/^(.*?)-((?:19|20)\d{2})$/);
  if (!m) return { titulo: String(slug || '').replace(/-/g, ' ').trim(), anio: 0 };
  return { titulo: m[1].replace(/-/g, ' ').trim(), anio: Number(m[2]) };
}

/**
 * ¿RESPALDA ALGO INDEPENDIENTE AL `tmdb_id` QUE PROPONE ESTA FUENTE?
 *
 * ── LA TRAMPA QUE HAY QUE ENTENDER ANTES DE TOCAR ESTO ───────────────────────────────────────
 *
 * La primera versión comparaba el `original_title` que publica la fuente contra el de TMDB, que es
 * la escalera de `resolveTmdb` y parecía lo obvio. **Y era circular.** Medido sobre 24 fichas:
 *
 *     detalle.original_title === TMDB.original_title  →  24/24
 *     listado.original_title === TMDB.original_title  →  24/24
 *
 * O sea que el Worker RELLENA ese campo DESDE TMDB después de emparejar. Comparar su
 * `original_title` con el de TMDB es preguntarle a TMDB si TMDB está de acuerdo consigo mismo:
 * contesta que sí siempre, y el 97 % de acierto que salió de ahí no medía la identidad — medía la
 * copia. Una guarda circular es peor que ninguna, porque tranquiliza.
 *
 * Lo mismo vale para `release_date`: también viene de TMDB. Y las imágenes que publica están en su
 * propio CDN, así que tampoco hay hash de `image.tmdb.org` con el que confirmar (§4 bis).
 *
 * ── LO QUE SÍ ES SUYO ────────────────────────────────────────────────────────────────────────
 *
 * **El slug**, que lo escribe su web a partir del título y el año con que ELLA publica la obra. Es
 * la única señal de esta fuente que no ha pasado por TMDB, y por eso es la que manda aquí. Caza el
 * caso real que destapó todo esto:
 *
 *     amor-y-compasion-2015  →  dice tmdb 64802 = «Love! Valour! Compassion!» (1997)
 *                               18 años de diferencia → CONTRADICE
 *
 * El año va por delante del título justamente porque el título de su web sí puede parecerse al de
 * TMDB sin ser la misma obra (es el caso del homónimo), mientras que un desfase de años es un
 * desmentido difícil de fingir. Se mantiene la tolerancia de ±1 de siempre (desfase de
 * distribución: festival un año, estreno el siguiente).
 *
 * `sin-datos` NO respalda: un slug sin año no demuestra nada, y adoptar sobre nada es justo lo que
 * FUENTES.md §3 prohíbe.
 */
export function juzgarIdentidad(
  suyo: {
    year?: string;
    title?: string;
    slug?: string;
    /**
     * EL SEGUNDO VOTO: los `tmdb_id` que van escritos DENTRO de sus propios embeds.
     *
     * Sus páginas incrustan un reproductor de `videoapp.zip`, que es una piel de videoapi y
     * direcciona POR TMDB ID (`/e/movie/850439`) — este repositorio ya lo parsea así en
     * `videoapi.ts`. Ese número lo puso **otro matcher**, no el de este Worker: es la única señal
     * de identidad de esta fuente que no ha pasado por el mismo sitio que la que queremos juzgar.
     *
     * Medido sobre 30 fichas: **29 traen el segundo voto (97 %)**, 28 coinciden con el Worker y
     * **1 discrepa** (`hierarchy-2025`: el Worker dice 1488810, su embed dice 1461181). Un 3 % de
     * desacuerdo, que es el orden de magnitud del fallo que buscábamos.
     */
    idsDeEmbeds?: number[];
  },
  tmdb: { id: number; original_title?: string; title?: string; fecha?: string }
): VeredictoIdentidad {
  const delSlug = datosDelSlug(suyo.slug || '');
  const anioTmdb = Number(String(tmdb.fecha || '').slice(0, 4));

  /**
   * 1. EL SEGUNDO VOTO MANDA, y cuando los dos matchers discrepan no se elige ganador.
   *
   * No se adopta ninguno de los dos ids. Elegir sería volver a decidir a ojo justo lo que
   * FUENTES.md §3 prohíbe, y lo que está en juego —un `tmdb_id` equivocado— es lo que después
   * suelda dos filas en una. Es barato: al 3 % de las fichas se las deja fuera y se las mira otro
   * día; adoptar mal no se deshace.
   */
  const votos = (suyo.idsDeEmbeds || []).filter((n) => Number.isFinite(n) && n > 0);
  if (votos.length && tmdb.id > 0 && votos.includes(tmdb.id)) return 'confirma-segundo-voto';

  /**
   * QUE EL SEGUNDO VOTO DISCREPE NO BASTA PARA TIRAR LA FICHA, y esto se midió en las dos
   * direcciones antes de decidirlo.
   *
   * La primera versión vetaba: si el id del embed no era el del Worker, fuera. Rechazaba el 5 % y
   * casi todo era bueno — «Inocencia» (2020) contra tmdb 602296 «Inocencia» (2020) coincide en
   * título Y año exactos, y aun así caía. La explicación es simple y hay que tenerla presente:
   * **videoapp también empareja a ojo**. Son dos matchers falibles, y cuando discrepan no hay
   * forma de saber cuál se equivocó. Vetar con eso es tirar una moneda y llamarlo rigor.
   *
   * Así que el voto CONFIRMA cuando coincide y no desmiente cuando no. Lo que decide entonces es
   * el slug, que es lo único que escribe su web. Si tampoco corrobora nada, se cae a `sin-datos`
   * y la ficha NO se adopta — que es lo que pide §3: sin respaldo, no se toma la identidad ajena.
   */

  /**
   * 2. SIN SEGUNDO VOTO se cae al slug, que es lo único que escribe su web y no viene de TMDB.
   *
   * Y aquí el año NO desmiente, solo confirma. Sus fechas no son fiables —«Venganza» (Taken, 2008)
   * está publicada como 2020 y «Amor y Compasión» (1997) como 2015—, así que rechazar por desfase
   * costaba fichas buenas: de 99 medidas, las dos que caían eran correctas. El nombre suma
   * confianza y tampoco desmiente: los nombres regionales de la misma obra no se parecen entre sí
   * («En la tormenta» ES «Sin salida»), y retirar por falta de parecido es el error de §3.
   */
  const anioSuyo = delSlug.anio || Number(String(suyo.year || '').slice(0, 4));
  const hayAnios = Number.isFinite(anioSuyo) && Number.isFinite(anioTmdb) && anioSuyo > 0 && anioTmdb > 0;

  if (delSlug.titulo) {
    const s = Math.max(
      similarity(delSlug.titulo, tmdb.title || ''),
      similarity(delSlug.titulo, tmdb.original_title || '')
    );
    if (s >= 0.6) return 'confirma-original';
  }
  if (hayAnios && Math.abs(anioSuyo - anioTmdb) <= 1) return 'confirma-año';
  return 'sin-datos';
}

/** ¿Vale este veredicto para adoptar la ficha de TMDB? Solo lo respaldado; `sin-datos` no basta. */
export function respalda(v: VeredictoIdentidad): boolean {
  return v === 'confirma-segundo-voto' || v === 'confirma-original' || v === 'confirma-año';
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
