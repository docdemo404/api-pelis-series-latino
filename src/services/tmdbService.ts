import axios from 'axios';
import * as cheerio from 'cheerio';
import { MediaItem, ContentType, CastMember } from '../types';
import { OverrideService } from './overrideService';
import { USER_AGENT } from '../utils/httpClient';
import { canonicalTitle, normalizeTitle, dedupeTitles, yearFromSlug } from '../utils/text';

const API_KEY = '99b8bc99e85e79fabd52b64513c9780d';

/**
 * La misma clave, para los servicios que hablan con TMDB desde FUERA de este módulo.
 *
 * La usa `complementoService`, que necesita preguntarle a TMDB por el id de TheTVDB de una serie
 * antes de poder pedirle su logo a Fanart.tv (los dos catálogos se numeran distinto). Se exporta
 * en vez de copiarla allí para que siga habiendo una sola clave que cambiar.
 */
export const TMDB_API_KEY = API_KEY;

/**
 * La plantilla de SEO con la que las webs rellenan la sinopsis («Ver X online gratis en FuegoCine
 * con audio Latino»). No es metadata: es publicidad de la fuente, y publicada ocupa el sitio de la
 * sinopsis de verdad — ver `rotuladoPorLaWeb` y `rotularEpisodiosConTmdb`.
 */
const PUBLICIDAD_DE_LA_WEB = /fuegocine|online gratis|tioplus|cinecalidad/i;
const UA = USER_AGENT;

// Regiones hispanohablantes: de aquí salen los títulos ALTERNATIVOS que de verdad busca la
// audiencia (el nombre de España frente al de Latinoamérica). '419' es el código que TMDB usa
// para "Latinoamérica". Se deja fuera US a propósito: sus títulos alternativos suelen estar en
// inglés (nombres de mercado, versiones 3D) y el inglés ya lo cubre el original_title.
const SPANISH_REGIONS = new Set([
  'ES', 'MX', 'AR', 'CO', 'CL', 'PE', 'VE', 'EC', 'GT', 'CU', 'BO',
  'DO', 'HN', 'PY', 'SV', 'NI', 'CR', 'PA', 'UY', 'PR', '419'
]);

const tmdbIdCache = new Map<string, TmdbMatch>();
const tmdbDetailCache = new Map<string, any>();
/** Títulos alternativos/traducciones + año por ficha, para el rescate de resolveTmdb. */
const knownTitlesCache = new Map<string, { titles: string[]; year: string | null }>();

/** Resultado de resolver un título contra TMDB. `matched: false` ⇒ id sintético (negativo). */
export interface TmdbMatch {
  id: number;
  matched: boolean;
  score: number;
  /** Ver `scoreResult`: el parecido del título viene respaldado por una señal INDEPENDIENTE. */
  verified: boolean;
  /**
   * A QUÉ catálogo de TMDB pertenece el id, que no siempre es el tipo por el que se preguntó:
   * la escalera busca también en el endpoint contrario y en /search/multi. Los ids de película
   * y de serie se numeran POR SEPARADO y se repiten entre sí —74586 es la israelí "כלבת" y a la
   * vez la serie "¿Solo en casa?"—, así que pedir la ficha por el tipo equivocado no da un 404:
   * da los datos de otro título.
   */
  type: ContentType;
}

/**
 * Puntuación de un candidato + si algo AJENO al título lo respalda.
 *
 * La distinción es la que faltaba: "Solo en casa" calca al 100% el nombre de "Gambling House"
 * (1950) y el de Home Alone (1990), así que la puntuación por sí sola no puede decidir. Solo el
 * año, el `og:image` de la página de origen o el título original distinguen una de otra.
 */
interface ScoredResult {
  score: number;
  verified: boolean;
  /**
   * El título ORIGINAL de la ficha coincide con el que publica la fuente.
   *
   * Es la señal que desempata a los que se llaman igual Y se estrenaron el mismo año, donde ni
   * el título ni la fecha distinguen nada: buscando "Big Bang" (2007), TMDB devuelve la serie
   * "Big Bang" (2 votos) con el nombre calcado y The Big Bang Theory rotulada "La Teoría del
   * Big Bang", que se parece menos. Solo el original —"The Big Bang Theory"— dice cuál es.
   */
  originalMatch: boolean;
}

/** Un resultado de /search ya puntuado, tal y como circula por la escalera de `resolveTmdb`. */
interface Candidate extends ScoredResult {
  id: number;
  credibility: number;
  endpoint: 'movie' | 'tv';
}

// Ante puntuaciones MUY parecidas (p. ej. anime original vs. remake homónimo, o una parodia con
// nombre casi idéntico al original) no decide la similitud, que ya no distingue nada.
const TIE_MARGIN = 0.06;

// Puntuación mínima de similitud para aceptar un resultado de TMDB como el mismo título.
// Por debajo preferimos NO emparejar (mejor metadata de la fuente que metadata de otra peli).
const MATCH_THRESHOLD = 0.6;
// A partir de aquí el match es inequívoco y dejamos de probar más estrategias de búsqueda.
const CONFIDENT_SCORE = 0.9;

// Rescate por título alternativo (ver scoreAgainstKnownTitles). La precisión NO la da
// filtrar candidatos por puntuación —el título regional correcto puede puntuar 0.10—, sino
// exigir que uno de los nombres que TMDB tiene registrados para la ficha coincida casi al
// pie de la letra con el buscado. Se revisan unos pocos candidatos para acotar el coste.
const ALT_TITLE_ACCEPT = 0.9;
const ALT_TITLE_MAX_CANDIDATES = 4;

// Ruido de scraping al principio/final del título ("Ver X online gratis HD Latino").
const LEAD_NOISE = /^(ver|descargar|pelicula|película|serie|anime)\s+/i;
const TAIL_NOISE = /\s+(online|gratis|completa|hd|full\s*hd|4k|1080p|720p|480p|latino|castellano|subtitulado|sub\s*espa(n|ñ)ol|audio\s*latino|espa(n|ñ)ol\s*latino|en\s*espa(n|ñ)ol|mega|torrent)$/i;

// Coletillas de "pack" que las fuentes añaden a las series y que TMDB no reconoce:
// con ellas dentro, /search devuelve CERO resultados ("Gen V Todas Las Temporadas" → vacío).
const PACK_NOISE = /\b(todas\s+las\s+temporadas?|temporadas?\s+completas?|serie\s+completa|saga\s+completa|coleccion\s+completa|colección\s+completa|todos\s+los\s+capitulos|todos\s+los\s+capítulos)\b/gi;

// Artículo inicial en español. TMDB indexa "Vengadores: La era de Ultrón", así que buscar
// "LOS Vengadores…" no devuelve nada y el único resultado acaba siendo una parodia.
const LEADING_ARTICLE = /^(los|las|el|la|un|una|unos|unas)\s+/i;

// Año final entre paréntesis, incluido el RANGO con el que las fuentes rotulan los packs de
// series ("Bridgerton - Todas las Temporadas (2020 - 2026)"). Sin contemplar el rango, el
// paréntesis sobrevivía a la limpieza y /search devolvía cero resultados.
const TRAILING_YEAR = /\s*\((\d{4})(?:\s*[-–—/]\s*(?:\d{4}|presente|actualidad))?\)\s*$/i;

/** Limpia un título de listado para buscarlo en TMDB (sin año, sin ruido, sin temporada). */
function cleanForSearch(title: string): string {
  let t = (title || '')
    .replace(TRAILING_YEAR, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(PACK_NOISE, ' ')
    .replace(/\b(temporada|season|capitulo|capítulo|episodio)\s*\d+\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  t = t.replace(/^gru\s*(\d+)\s*/i, 'Mi villano favorito $1 ');

  let prev = '';
  while (prev !== t) {
    prev = t;
    t = t.replace(LEAD_NOISE, '').replace(TAIL_NOISE, '').replace(/[\s\-–—:,.]+$/, '').trim();
  }

  return t || title.trim();
}

/**
 * Variantes de consulta para el mismo título, de la más literal a la más laxa.
 * El buscador de TMDB es sensible a artículos y puntuación: si la forma exacta no
 * devuelve nada, estas reescrituras son las que encuentran la ficha correcta.
 */
function queryVariants(cleanTitle: string): string[] {
  const variants = [cleanTitle];

  const noArticle = cleanTitle.replace(LEADING_ARTICLE, '').trim();
  if (noArticle && noArticle !== cleanTitle) variants.push(noArticle);

  // Sin puntuación: "Vengadores: Era de Ultrón" → "Vengadores Era de Ultrón".
  const noPunct = noArticle.replace(/[:;,\-–—_]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (noPunct && !variants.includes(noPunct)) variants.push(noPunct);

  return variants;
}

/**
 * Idiomas de logo aceptables cuando no hay ni español ni inglés ni uno sin idioma.
 *
 * Un logo es arte TIPOGRÁFICO: se lee. Uno en portugués o en italiano dice el título de la
 * película con letras que el espectador reconoce —«L'Arca di Noè» se entiende—, mientras que uno
 * en cirílico o en kana no es una alternativa al texto, es peor que el texto, y la caída a texto
 * ya existe en la app (ver `TitleArt` en Billboard.kt).
 *
 * Medido sobre 50 fichas del catálogo sin logo: 4 tenían uno en TMDB y las cuatro en un idioma
 * que el filtro `include_image_language` dejaba fuera (ru, pt, de, it). Con esta lista se
 * recuperan las de alfabeto latino y se sigue descartando la rusa.
 */
const IDIOMAS_DE_LOGO_LEGIBLES = ['pt', 'it', 'fr', 'de', 'ca', 'gl'];

/**
 * Logo del título (arte tipográfico) para el hero estilo Netflix/Prime.
 * Prioriza el logo en español, luego inglés, luego el que no declara idioma, y como último
 * recurso cualquiera escrito en alfabeto latino (ver IDIOMAS_DE_LOGO_LEGIBLES).
 */
function pickLogo(tmdbData: any): string | null {
  const logos: any[] = (tmdbData?.images?.logos || []).filter((l: any) => l?.file_path);
  if (logos.length === 0) return null;
  const byLang = (lang: string | null) => logos.find(l => l.iso_639_1 === lang);
  const chosen = byLang('es') || byLang('en') || byLang(null)
    || logos.find(l => IDIOMAS_DE_LOGO_LEGIBLES.includes(l.iso_639_1));
  return chosen ? `https://image.tmdb.org/t/p/w500${chosen.file_path}` : null;
}

/** Duración en minutos: `runtime` en películas, media del episodio en series. */
function pickRuntime(tmdbData: any): number | undefined {
  if (typeof tmdbData?.runtime === 'number' && tmdbData.runtime > 0) return tmdbData.runtime;
  const epRuntime = Array.isArray(tmdbData?.episode_run_time) ? tmdbData.episode_run_time[0] : undefined;
  return typeof epRuntime === 'number' && epRuntime > 0 ? epRuntime : undefined;
}

/**
 * Clasificación por edades REAL (antes se emitía siempre 'PG-13' hardcodeado).
 * Prioriza los mercados hispanohablantes y cae a US, que es el que TMDB tiene
 * cubierto de forma más consistente.
 */
function pickContentRating(tmdbData: any): string | undefined {
  const preferred = ['MX', 'AR', 'CL', 'ES', 'CO', 'US'];

  // Series: content_ratings.results = [{ iso_3166_1, rating }]
  const tvResults: any[] = tmdbData?.content_ratings?.results || [];
  if (tvResults.length > 0) {
    for (const country of preferred) {
      const hit = tvResults.find(r => r.iso_3166_1 === country && r.rating);
      if (hit) return hit.rating;
    }
    const any = tvResults.find(r => r.rating);
    if (any) return any.rating;
  }

  // Películas: release_dates.results = [{ iso_3166_1, release_dates: [{ certification }] }]
  const movieResults: any[] = tmdbData?.release_dates?.results || [];
  if (movieResults.length > 0) {
    const certOf = (entry: any) => (entry?.release_dates || []).map((d: any) => d.certification).find((c: string) => c);
    for (const country of preferred) {
      const hit = movieResults.find(r => r.iso_3166_1 === country);
      const cert = certOf(hit);
      if (cert) return cert;
    }
    for (const entry of movieResults) {
      const cert = certOf(entry);
      if (cert) return cert;
    }
  }

  return undefined;
}

/**
 * Alfabetos distintos del latino: cirílico, hebreo, árabe, devanagari, tailandés, hangul, kana y
 * CJK. Sirve para reconocer un título que la audiencia hispanohablante no puede ni leer.
 */
export const OTRO_ALFABETO = /[Ѐ-ӿ֐-׿؀-ۿऀ-ॿ฀-๿ᄀ-ᇿ぀-ヿ㄰-㆏一-鿿가-힯]/;

/**
 * Con qué nombre se muestra la ficha.
 *
 * Normalmente el de TMDB en es-MX, que es el que busca la audiencia. Pero cuando TMDB no tiene
 * traducción devuelve el título ORIGINAL, y eso deja fichas rotuladas en coreano o en japonés en
 * una API que sirve en español: la ficha `submundo` pasó a llamarse "파인: 촌뜨기들". Si la fuente
 * publicó un nombre en alfabeto latino y TMDB no aporta traducción, manda el de la fuente.
 *
 * La condición es estrecha a propósito: se exige que el título de TMDB esté escrito en OTRO
 * ALFABETO, no simplemente que no tenga letras. Preguntar por las letras confundía los títulos
 * numéricos, que son legibles y correctos y hay unos cuantos: "1917", "1883", "9-1-1", "3%". Y los
 * títulos en inglés no se tocan nunca: son legibles y mucha gente busca por ellos. El nombre de
 * TMDB tampoco se pierde —`collectAliases` lo deja como alias—, así que la ficha se encuentra
 * igual por los dos.
 */
function pickDisplayTitle(tmdbData: any, sourceTitle: string): string {
  const tmdbTitle: string = tmdbData.title || tmdbData.name || '';
  const original: string = tmdbData.original_title || tmdbData.original_name || '';

  const sinTraducir = !!tmdbTitle && tmdbTitle === original && OTRO_ALFABETO.test(tmdbTitle);
  if (sinTraducir && sourceTitle && !OTRO_ALFABETO.test(sourceTitle)) return sourceTitle;

  return tmdbTitle || sourceTitle;
}

/**
 * Tráiler oficial en YouTube, con el de español por delante.
 *
 * `all_videos` lo deja puesto `getTmdbDetails`: es la lista GLOBAL de vídeos, que se pide aparte
 * porque la de es-MX viene vacía en la mayoría de las fichas. Sin ella la ficha se quedaba sin
 * tráiler teniéndolo TMDB, que es la mitad del hueco del 21,8 % que mide diag_metadatos.
 */
function pickTrailer(tmdbData: any): string | null {
  const videos: any[] = tmdbData?.all_videos || tmdbData?.videos?.results || [];
  const elegido = videos.find(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser') && (v.iso_639_1 === 'es' || v.iso_639_1 === 'es-MX'))
    || videos.find(v => v.site === 'YouTube' && v.type === 'Trailer')
    || videos.find(v => v.site === 'YouTube');
  return elegido?.key ? `https://www.youtube.com/watch?v=${elegido.key}` : null;
}

/** Reparto principal con sus fotos (doce nombres: los que caben en la ficha). */
function pickCast(tmdbData: any): CastMember[] {
  return (tmdbData?.credits?.cast || []).slice(0, 12).map((c: any) => ({
    name: c.name,
    character: c.character || '',
    photo: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null,
  }));
}

/** Director (películas) tomado del equipo técnico. */
function pickDirector(tmdbData: any): string | undefined {
  const crew: any[] = tmdbData?.credits?.crew || [];
  const director = crew.find(c => c.job === 'Director');
  return director?.name || undefined;
}

/** Creadores (series). */
function pickCreators(tmdbData: any): string[] | undefined {
  const creators: any[] = tmdbData?.created_by || [];
  const names = creators.map(c => c.name).filter(Boolean);
  return names.length > 0 ? names : undefined;
}

/** Similitud 0..1 entre dos títulos: exacto > prefijo > substring > solapamiento de palabras. */
export function similarity(a: string, b: string): number {
  // IDÉNTICOS letra por letra, aunque el alfabeto no sea latino. Va antes que todo lo demás
  // porque `canonicalTitle` solo conserva [a-z0-9]: un título tailandés, japonés o coreano se
  // queda VACÍO y entonces puntuaba 0 incluso comparado consigo mismo. Es la única señal que
  // tienen esas fichas —su nombre original— y sin esto TMDB no podía confirmarlo, así que
  // `confirmsTitle` daba por huérfano el original tailandés de una ficha que era el suyo.
  const la = normalizeTitle(a).replace(/\s+/g, ' ').trim();
  const lb = normalizeTitle(b).replace(/\s+/g, ' ').trim();
  if (la && la === lb) return 1;

  const ca = canonicalTitle(a);
  const cb = canonicalTitle(b);
  if (!ca || !cb) return 0;
  if (ca === cb) return 1;

  // NO se penaliza aquí el número de entrega discordante ("Die Hart 2: Die Harter" frente a
  // "Die Hart"). Se probó y sale más caro que el problema: las fuentes numeran entregas que TMDB
  // deja sin numerar, así que "Rápidos y Furiosos 4" (2009) se quedaba sin emparejar con su
  // propia ficha. A las entregas de una saga las separan AÑOS, y de eso ya se encarga el año en
  // `scoreResult`; lo que confundía a las dos "Die Hart" era otra cosa —el rescate por título
  // alternativo daba por respaldado un desfase de 5 años—, y eso está arreglado donde tocaba.

  /**
   * Prefijo y substring se miden por PALABRAS COMPLETAS, no por caracteres.
   *
   * Sobre la clave canónica —que va sin espacios— "humo" es prefijo de "humoreinereisemitbully",
   * así que "Humo" (2025) puntuaba 0,85 contra el documental alemán "Humor - Eine Reise mit
   * Bully" (2025) y, cuadrando el año, se daba por respaldado: la ficha se quedó con esa
   * carátula y esa sinopsis. Cortando por palabras la coincidencia desaparece, porque la palabra
   * es "humor" y no "humo".
   *
   * Los casos legítimos son subtítulos, y esos empiezan justo en un límite de palabra: "Carrie" ⊂
   * "Carrie: un extraño presentimiento", "Avengers 2" ⊂ "Avengers 2: Era de Ultrón". Siguen
   * puntuando igual. Y la equivalencia "Spider-Man" == "spiderman" no se toca: la resuelve la
   * comparación exacta de arriba, que sí es sin espacios.
   */
  const wa = normalizeTitle(a).replace(/[^a-z0-9]+/g, ' ').trim();
  const wb = normalizeTitle(b).replace(/[^a-z0-9]+/g, ' ').trim();
  if (wa && wb) {
    const empiezaPor = (corto: string, largo: string) => largo.startsWith(`${corto} `);
    if (empiezaPor(wa, wb) || empiezaPor(wb, wa)) return 0.85;
    const contiene = (corto: string, largo: string) => ` ${largo} `.includes(` ${corto} `);
    if (contiene(wa, wb) || contiene(wb, wa)) return 0.7;
  }

  // VARIANTES DE ESCRITURA. Por palabras no coinciden porque las palabras están partidas de otra
  // manera ("SpiderMan: Loto" frente a "Spider-Man: Lotus"), pero seguidas casi calcan. Se acepta
  // el prefijo/substring a nivel de caracteres SOLO si los dos títulos miden casi lo mismo: eso es
  // una variante del mismo nombre, mientras que un largo muy distinto es otro título con el que
  // solo se comparte el arranque —"Humo" dentro de "Humor - Eine Reise mit Bully"—.
  const proporcion = Math.min(ca.length, cb.length) / Math.max(ca.length, cb.length);
  if (proporcion >= 0.8 && (ca.startsWith(cb) || cb.startsWith(ca) || ca.includes(cb) || cb.includes(ca))) {
    return 0.85;
  }

  const tokens = (s: string) => new Set(normalizeTitle(s).split(/[^a-z0-9]+/).filter(Boolean));
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;

  let inter = 0;
  let alphaInter = 0;
  ta.forEach(t => {
    if (!tb.has(t)) return;
    inter++;
    if (/[a-z]/.test(t)) alphaInter++;
  });

  // Los títulos en alfabetos no latinos se quedan sin letras al normalizar ("영구람보 3" → "3"),
  // así que empataban por el NÚMERO con títulos como "Rambo 3" y ganaban al original.
  // Si ambos lados tienen palabras y no comparten ninguna, la coincidencia no vale.
  const hasAlpha = (t: Set<string>) => Array.from(t).some(x => /[a-z]/.test(x));
  if (alphaInter === 0 && hasAlpha(ta) && hasAlpha(tb)) return 0;

  return (2 * inter) / (ta.size + tb.size);
}

/**
 * Ruta canónica de una imagen de TMDB (`/<hash>.jpg`) a partir de una URL.
 * Las páginas de origen (og:image) enlazan directo a `image.tmdb.org/t/p/<size>/<hash>.jpg`,
 * y ese hash es huella casi única de la ficha exacta. Sirve para CONFIRMAR un candidato sin
 * depender del título. Devuelve null si la URL no es de TMDB. `poster_path`/`backdrop_path`
 * que ya vienen como `/<hash>.jpg` se normalizan igual (por su nombre de archivo).
 */
/**
 * Imágenes de una ficha que NO son su póster ni su fondo principal: las de sus temporadas y las
 * de sus episodios. Se rellena antes de resolver, con `precargarImagenesDeFicha`.
 *
 * Existe por "Invencible", que se quedó sin metadata teniendo la prueba delante. Su página de
 * origen es la de un episodio (`invencible-4x8`) —esas páginas de FuegoCine no llevan ficha de
 * datos: ni año, ni título original, nada— pero enlaza una imagen de TMDB. Esa imagen no era el
 * póster ni el fondo de la serie, ni estaba entre sus 351 imágenes generales: es el FOTOGRAMA del
 * episodio 4x8. Comprobando solo póster y fondo, la única prueba disponible pasaba desapercibida
 * y la serie se quedaba con un tmdb_id sintético y una sinopsis de relleno.
 *
 * Es un mapa en memoria y no una petición dentro de `scoreCandidate` a propósito: puntuar es
 * síncrono y se hace sobre decenas de candidatos por búsqueda. Aquí solo se consulta.
 */
const imagenesExtra = new Map<string, Set<string>>();

/**
 * La clave lleva el CAPÍTULO, no solo la ficha.
 *
 * Con la clave puesta solo en el id, el primer capítulo que se preguntara de una serie dejaba sus
 * fotogramas cacheados como si fueran los de la serie entera, y cualquier consulta posterior sobre
 * OTRO capítulo de la misma ficha se contestaba con los del primero — que nunca coinciden, porque
 * cada capítulo tiene los suyos. O sea: un «no» rotundo sin haber preguntado.
 *
 * No es teórico ni raro: es exactamente lo que hace falta para poder probar la identidad de una
 * serie con varias de sus páginas (`identidadPorFotograma`), que es como se identifican las series
 * de FuegoCine cuando la página que quedó de origen no lleva un fotograma registrado.
 */
const claveDeFotogramas = (id: number, temporada: number, episodio: number) => `${id}:${temporada}x${episodio}`;

function imagenExtraDeLaFicha(
  id: number | undefined,
  hash: string,
  episodio?: { season: number; episode: number } | null
): boolean {
  if (!id || !episodio) return false;
  return imagenesExtra.get(claveDeFotogramas(id, episodio.season, episodio.episode))?.has(hash) === true;
}

/**
 * Descarga los fotogramas de UN episodio y los deja disponibles para la comprobación por imagen.
 *
 * Una sola petición, y solo cuando hace falta: la página de origen tiene que ser de un episodio
 * concreto (`4x8`) y traer una imagen de TMDB que no haya casado por las vías baratas.
 */
export async function precargarImagenesDeFicha(
  id: number,
  temporada: number,
  episodio: number
): Promise<void> {
  const clave = claveDeFotogramas(id, temporada, episodio);
  if (imagenesExtra.has(clave)) return;
  try {
    const res = await axios.get(`https://api.themoviedb.org/3/tv/${id}/season/${temporada}/episode/${episodio}/images`, {
      params: { api_key: API_KEY },
      timeout: 4000,
      validateStatus: () => true,
    });
    const stills: any[] = res.data?.stills || [];
    imagenesExtra.set(clave, new Set(stills.map(s => tmdbImagePath(s.file_path)).filter((p): p is string => !!p)));
  } catch {
    imagenesExtra.set(clave, new Set());
  }
}

export function tmdbImagePath(url: string | null | undefined): string | null {
  if (!url) return null;
  // Se aceptan LOS DOS hosts desde los que TMDB sirve la misma ruta `/t/p/<tamaño>/<hash>`:
  // `image.tmdb.org` (el CDN) y `www.themoviedb.org` (su web). Reconocer solo el primero costó
  // la metadata entera de "Invencible": su página de FuegoCine enlaza el fondo como
  // `https://www.themoviedb.org/t/p/w1280/zmmrC3E0…jpg`, o sea que la prueba de identidad MÁS
  // fuerte que existe —el hash de una imagen de TMDB— estaba delante y se descartaba por el
  // nombre del servidor. La ficha se quedó sin año, sin sinopsis y con un tmdb_id sintético.
  // Las barras se admiten REPETIDAS. TMDB devuelve `poster_path` ya con su barra inicial, así
  // que quien concatena `"/t/p/w342" + poster_path` publica `/t/p/w342//hash.jpg` — y es
  // exactamente lo que hace Cinecalidad. Con `\/` a secas, la prueba de identidad MÁS fuerte
  // que existe se descartaba por una barra de más.
  const m = String(url).match(/(?:image\.tmdb\.org|themoviedb\.org)\/t\/p\/[^/]+\/+([\w-]+\.(?:jpg|jpeg|png|webp|svg))/i);
  if (m) return `/${m[1]}`;
  // TMDB devuelve poster_path/backdrop_path ya como "/<hash>.jpg": se normaliza por basename.
  const bare = String(url).match(/^\/?([\w-]+\.(?:jpg|jpeg|png|webp|svg))$/i);
  return bare ? `/${bare[1]}` : null;
}

/**
 * Puntúa un resultado de TMDB frente al título (y año) buscados, y dice si algo INDEPENDIENTE
 * del título respalda al candidato (`verified`).
 *
 * El año NO es un desempate menor: los títulos regionales chocan de lleno con películas
 * ajenas que se llaman exactamente igual. "Solo en casa" (el título de España de Home
 * Alone, 1990) coincide al 100% con "Gambling House", una película de 1944, y con una
 * penalización simbólica esa coincidencia exacta ganaba y se guardaba como match seguro.
 * Un desfase grande de estreno descarta el candidato salvo que el título alternativo lo
 * confirme después (ver scoreAgainstKnownTitles).
 *
 * Cuando NO se conoce el año, ninguna penalización llega a aplicarse y los dos homónimos
 * puntúan 1.00 exacto. Por eso la puntuación no basta para dar el match por cerrado: hace falta
 * saber si viene respaldada, que es lo que responde `verified`.
 */
function scoreResult(
  result: any,
  query: string,
  year?: string,
  imageHint?: string | null,
  knownOriginal?: string | null,
  /** De qué capítulo es la página que trajo `imageHint`, para poder comparar su fotograma. */
  episodeHint?: { season: number; episode: number } | null
): ScoredResult {
  // Confirmación por IMAGEN: si la página de origen trae la ruta de TMDB (og:image) y coincide
  // con el póster o el fondo del candidato, es la MISMA ficha con certeza, se llame como se llame
  // en es-MX (así "El fundador" fija a The Founder aunque su título latino sea "Hambre de poder").
  // Solo CONFIRMA; si no coincide no penaliza —la página pudo usar el póster de otro idioma—.
  if (imageHint) {
    if (imageHint === tmdbImagePath(result.poster_path) || imageHint === tmdbImagePath(result.backdrop_path)) {
      return { score: 1, verified: true, originalMatch: true };
    }
  }
  if (imageHint && imagenExtraDeLaFicha(result.id, imageHint, episodeHint)) {
    return { score: 1, verified: true, originalMatch: true };
  }

  const candidates = [result.title, result.name, result.original_title, result.original_name].filter(Boolean);
  let best = 0;
  for (const c of candidates) best = Math.max(best, similarity(query, c));

  // El título ORIGINAL de la fuente ("Home Alone") es una segunda señal independiente del nombre
  // regional que se está buscando: si calca el original de la ficha, esta es la película.
  const original = result.original_title || result.original_name || '';
  const originalConfirms = !!knownOriginal && !!original
    && canonicalTitle(knownOriginal) === canonicalTitle(original);

  /**
   * EL TÍTULO ORIGINAL DE LA FUENTE TAMBIÉN PUEDE DESMENTIR, no solo confirmar.
   *
   * Aquí se coló "Sin salida (2024)" con el vídeo de "Bunker (2025)". La página de FuegoCine
   * declaraba `data-original-title="Bunker"` y `data-year="2025"`; el candidato de TMDB se
   * llamaba "Sin salida" y se estrenó en 2024. O sea que la fuente estaba diciendo, con todas
   * las letras, que esa película se llama Bunker — y se le hizo caso omiso, porque un año de
   * diferencia bastaba para marcar la ficha como respaldada.
   *
   * El fallo de fondo era tratar el título original como una señal que solo SUMA. Un dato que
   * confirma cuando coincide tiene que restar cuando contradice; si no, no es una prueba, es un
   * atajo. Y el año no distingue nada por sí solo: estrenos contiguos hay a miles.
   *
   * DOS CALIBRACIONES QUE HAY QUE RESPETAR, las dos comprobadas contra casos reales:
   *
   * 1. Se compara contra TODOS los nombres del candidato, no solo contra su `original_title`.
   *    Es lo que salva a los pares legítimos original/regional: "Home Alone" no se parece NADA
   *    a "Mi pobre angelito" (0,00), exactamente igual que "Bunker" no se parece a "Sin salida".
   *    Lo que los distingue es que el candidato bueno SÍ se llama "Home Alone" por su original.
   *
   * 2. El listón es el umbral de emparejamiento, no el de alias (0,9). Con 0,9 se vetaba a
   *    "Gigantes, una Aventura extraordinaria" (0,85 contra "Gigantes") y a "A Marvel Television
   *    Special Presentation - The Punisher: One Last Kill" (0,70): títulos de cartel que
   *    CONTIENEN al real. Un desmentido es no parecerse a nada, no ser más largo.
   */
  const originalContradice = !!knownOriginal && candidates.length > 0 && !originalConfirms
    && !candidates.some(c => similarity(knownOriginal, c) >= MATCH_THRESHOLD);

  let verified = originalConfirms;

  const date: string = result.release_date || result.first_air_date || '';
  if (year) {
    if (!date) {
      // Ficha sin fecha de estreno: TMDB está lleno de entradas vacías (cero votos, sin
      // datos) cuyo título calca al buscado. Sabiendo el año y no pudiendo confirmarlo,
      // el candidato no puede tratarse como si encajara.
      best -= 0.25;
    } else {
      const diff = Math.abs(parseInt(date.substring(0, 4), 10) - parseInt(year, 10));
      // Un estreno que cuadra es el respaldo más común: descarta de un plumazo al homónimo
      // de otra época, que es de donde salen casi todos los emparejados equivocados.
      //
      // Pero NO cuando la propia fuente dice que la película se llama de otra manera: ahí el año
      // ya no respalda nada, solo tapa un desmentido. Ver `originalContradice`.
      if (diff <= 1 && !originalContradice) verified = true;
      if (diff === 0) best += 0.1;
      else if (diff === 1) { /* desfase de distribución (festival vs. estreno): ni premia ni penaliza */ }
      // Dos años de diferencia YA distinguen homónimos: "El fundador" (2016) frente a
      // "Bonifácio - O Fundador do Brasil" (2018). Sin esta penalización, la coincidencia de
      // substring (0.7) de la peli equivocada superaba el umbral y se guardaba como match seguro.
      else if (diff === 2) best -= 0.15;
      else if (diff <= 5) best -= 0.2;
      // Con más de un lustro de diferencia ya no es la misma película: se hunde por debajo
      // del umbral aunque el título calce al pie de la letra.
      else best -= 0.45;
    }
  }
  return { score: Math.max(0, Math.min(1, best)), verified, originalMatch: originalConfirms };
}

/**
 * ¿`c` es mejor candidato que `best`? Único criterio de comparación, compartido por el ganador
 * de cada consulta y por el mejor de toda la escalera.
 *
 * Con puntuaciones dentro del margen deciden, por este orden:
 *  1. ser del tipo que se pidió — la escalera rebusca en el catálogo contrario y en
 *     /search/multi, y de ahí salen coincidencias reales pero de otra clase: buscando la
 *     película "Solo en casa" aparece la serie "¿Solo en casa?" (2017), cuyo nombre original
 *     es literalmente "Home Alone". Si la fuente dice que es película, es película;
 *  2. venir RESPALDADO por el año, el `og:image` o el título original;
 *  3. el respaldo de público, que distingue a la parodia "Vengadores Chiflados" (1 voto) del
 *     título auténtico (24.000) pero no puede pesar más que una confirmación real —así es como
 *     ganaba "Gambling House", la más votada de las fichas llamadas "Solo en casa"—.
 */
function beatsCandidate(c: Candidate, best: Candidate | null, wanted: 'movie' | 'tv'): boolean {
  if (!best) return true;
  if (c.score > best.score + TIE_MARGIN) return true;
  if (Math.abs(c.score - best.score) > TIE_MARGIN) return false;
  if ((c.endpoint === wanted) !== (best.endpoint === wanted)) return c.endpoint === wanted;
  if (c.originalMatch !== best.originalMatch) return c.originalMatch;
  if (c.verified !== best.verified) return c.verified;
  return c.credibility > best.credibility;
}

/**
 * ID sintético DETERMINISTA y NEGATIVO para títulos sin match en TMDB.
 * Al ser negativo nunca colisiona con un tmdb_id real, así que no genera duplicados
 * ni choca con el UNIQUE de media_items.tmdb_id (el antiguo hash 100000-999999 sí lo hacía).
 */
function syntheticTmdbId(seed: string): number {
  let hash = 2166136261;
  const clean = canonicalTitle(seed) || seed.toLowerCase();
  for (let i = 0; i < clean.length; i++) {
    hash ^= clean.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return -(1 + ((hash >>> 0) % 2000000000));
}

export class TmdbService {
  /**
   * Una consulta a /search/{endpoint} con TODOS sus resultados puntuados.
   *
   * Se devuelve la lista entera, no solo el ganador, porque el buscador de TMDB SÍ indexa
   * los títulos alternativos: al buscar "Zootrópolis" devuelve Zootopia, pero rotulada con
   * su título es-MX ("Zootopia"), que apenas se parece. El candidato correcto está ahí,
   * hundido en la puntuación, y es el rescate por título alternativo quien lo reconoce.
   */
  private static async searchCandidates(
    endpoint: 'movie' | 'tv' | 'multi',
    query: string,
    opts: {
      filterYear?: string;
      knownYear?: string;
      imageHint?: string | null;
      knownOriginal?: string | null;
      episodeHint?: { season: number; episode: number } | null;
    } = {}
  ): Promise<Candidate[]> {
    // Los dos usos del año son distintos y confundirlos costaba matches equivocados:
    //  · filterYear → se manda a TMDB para acotar la búsqueda;
    //  · knownYear  → se usa SIEMPRE para puntuar, incluso en las consultas sin filtrar.
    // Cuando el año solo servía de filtro, las consultas sin él no penalizaban nada y una
    // coincidencia exacta de título de otra época ganaba: "Solo en casa" (Home Alone, 1990)
    // se resolvía como "Gambling House" (1944) con puntuación perfecta.
    const { filterYear, knownYear, imageHint, knownOriginal, episodeHint } = opts;
    try {
      const res = await axios.get(`https://api.themoviedb.org/3/search/${endpoint}`, {
        params: {
          api_key: API_KEY,
          query,
          language: 'es-MX',
          include_adult: false,
          ...(filterYear ? (endpoint === 'tv' ? { first_air_date_year: filterYear } : { year: filterYear }) : {})
        },
        timeout: 4000
      });

      const results: any[] = (res.data?.results || [])
        .filter((r: any) => endpoint !== 'multi' || r.media_type === 'movie' || r.media_type === 'tv');

      return results.slice(0, 10).map((r: any) => ({
        id: r.id,
        ...scoreResult(r, query, knownYear, imageHint, knownOriginal, episodeHint),
        credibility: (r.vote_count || 0) * 1000 + (r.popularity || 0),
        // En /search/multi el tipo lo dice cada resultado; en el resto, el propio endpoint.
        endpoint: (endpoint === 'multi' ? (r.media_type === 'tv' ? 'tv' : 'movie') : endpoint) as 'movie' | 'tv'
      }));
    } catch (err: any) {
      console.warn(`[TMDB API Search Warning]: ${err.message}`);
      return [];
    }
  }

  /** El mejor candidato de una consulta, con el desempate de `beatsCandidate`. */
  private static pickBest(candidates: Candidate[], wanted: 'movie' | 'tv'): Candidate | null {
    let best: Candidate | null = null;
    for (const c of candidates) {
      if (beatsCandidate(c, best, wanted)) best = c;
    }
    return best;
  }

  /**
   * Segunda opinión para un candidato que se quedó corto: la mejor similitud entre el
   * título buscado y los títulos ALTERNATIVOS y TRADUCCIONES registrados en TMDB.
   *
   * `/search` devuelve el título LOCALIZADO (pedimos es-MX), así que una película
   * distribuida con nombres distintos a cada lado del Atlántico puntúa bajo aunque sea
   * exactamente la misma ficha: "Minions: El origen de Gru" (España) frente a
   * "Minions: Nace un villano" (Latinoamérica), ambos TMDB 438148. Sin esta comprobación
   * el título se quedaba sin match, recibía un id sintético negativo y entraba en el
   * catálogo como una ficha DUPLICADA, con sus enlaces separados de los de la original.
   *
   * Devuelve 0 si la ficha no declara otros títulos o la consulta falla.
   */
  private static async scoreAgainstKnownTitles(
    id: number,
    endpoint: 'movie' | 'tv',
    query: string
  ): Promise<{ score: number; year: string | null }> {
    const cacheKey = `${endpoint}:${id}`;
    let entry = knownTitlesCache.get(cacheKey);

    if (!entry) {
      try {
        const res = await axios.get(`https://api.themoviedb.org/3/${endpoint}/${id}`, {
          params: { api_key: API_KEY, append_to_response: 'alternative_titles,translations' },
          timeout: 3000
        });
        const data = res.data || {};
        // Películas: alternative_titles.titles[] · Series: alternative_titles.results[]
        const alt: any[] = data.alternative_titles?.titles || data.alternative_titles?.results || [];
        const translations: any[] = data.translations?.translations || [];
        const date: string = data.release_date || data.first_air_date || '';
        entry = {
          titles: [
            data.title,
            data.name,
            data.original_title,
            data.original_name,
            ...alt.map(t => t?.title),
            ...translations.map(t => t?.data?.title || t?.data?.name)
          ].filter((t): t is string => Boolean(t)),
          // El año viaja con los títulos: se necesita para no aceptar un homónimo de otra
          // época, y sale de la MISMA llamada (sin coste añadido).
          year: date ? date.substring(0, 4) : null
        };
        knownTitlesCache.set(cacheKey, entry);
      } catch {
        // Un id que no existe en este endpoint (el match vino de /search/multi) responde
        // 404: se cachea el vacío para no repetir la consulta.
        knownTitlesCache.set(cacheKey, { titles: [], year: null });
        return { score: 0, year: null };
      }
    }

    let best = 0;
    for (const t of entry.titles) best = Math.max(best, similarity(query, t));
    return { score: best, year: entry.year };
  }

  /**
   * ¿TMDB reconoce `title` como uno de los nombres de esta ficha?
   *
   * Es la comprobación que autoriza a FUNDIR dos filas del catálogo en una. No sirve pedir
   * que los dos títulos se parezcan entre sí —"Minions: El origen de Gru" y "Minions: Nace
   * un villano" son la misma película y apenas comparten palabras—, ni fiarse solo de la
   * puntuación del matcher, que puede acertar de más: así fue como "Solo en casa 4" acabó
   * absorbida dentro de "Yu-Gi-Oh! GX". La pregunta correcta es si el nombre está
   * REGISTRADO en TMDB para ese id.
   */
  static async confirmsTitle(id: number, type: ContentType, title: string): Promise<boolean> {
    if (!id || id <= 0 || !title) return false;
    const endpoint = type === 'tvseries' ? 'tv' : 'movie';
    const alt = await this.scoreAgainstKnownTitles(id, endpoint, cleanForSearch(title));
    return alt.score >= ALT_TITLE_ACCEPT;
  }

  /**
   * Resuelve un título contra TMDB verificando que el resultado SEA el mismo título.
   * Prueba, en orden y parando en cuanto el match es inequívoco:
   *   endpoint+año → endpoint sin año → endpoint contrario → /search/multi → scraping de TMDB.
   * Si nada supera el umbral devuelve `matched: false` con un id sintético negativo,
   * para que el llamador conserve la metadata original de la fuente.
   */
  static async resolveTmdb(
    title: string,
    type: ContentType = 'movie',
    year?: string,
    seed?: string,
    opts: {
      originalTitle?: string | null;
      imageHint?: string | null;
      /** De qué episodio venía la página, cuando lo declara ("INVENCIBLE 4x8"). */
      episodeHint?: { season: number; episode: number } | null;
    } = {}
  ): Promise<TmdbMatch> {
    const cleanTitle = cleanForSearch(title);
    const imageHint = tmdbImagePath(opts.imageHint);
    // El título original ("The Founder") se busca como consulta APARTE del título en español:
    // en es-MX el candidato correcto puede rotularse distinto ("Hambre de poder") y no parecerse
    // al buscado, pero por su nombre original TMDB lo devuelve con original_title calcado (1.0).
    const cleanOriginal = opts.originalTitle ? cleanForSearch(opts.originalTitle) : '';
    const useOriginal = !!cleanOriginal && canonicalTitle(cleanOriginal) !== canonicalTitle(cleanTitle);

    /**
     * EL CAPÍTULO DEL QUE VIENE LA PÁGINA FORMA PARTE DE LA PREGUNTA, así que va en la clave.
     *
     * Es la última prueba de identidad que se intenta (ver el final de esta función) y cambia la
     * respuesta: la misma serie sale respaldada con él y sin respaldar sin él. Faltando en la
     * clave, la primera resolución sin capítulo dejaba cacheado el «no hay respaldo» y la
     * siguiente —que sí traía el capítulo— se lo comía sin llegar a preguntar. Se midió aquí
     * mismo, resolviendo "La casa del dragón" dos veces en el mismo proceso.
     */
    const cacheKey = `${type}:${cleanTitle.toLowerCase()}:${year || ''}:${useOriginal ? canonicalTitle(cleanOriginal) : ''}:${imageHint || ''}:${opts.episodeHint ? `${opts.episodeHint.season}x${opts.episodeHint.episode}` : ''}`;
    const cached = tmdbIdCache.get(cacheKey);
    if (cached) return cached;

    const endpoint = type === 'tvseries' ? 'tv' : 'movie';
    const opposite = endpoint === 'tv' ? 'movie' : 'tv';

    let bestCand: Candidate | null = null;
    let bestId = 0;
    let bestScore = 0;
    let bestVerified = false;
    let bestOriginalMatch = false;
    let bestEndpoint: 'movie' | 'tv' = endpoint;

    /**
     * ¿Hay ya un match que cierre la búsqueda? Debe ser inequívoco, RESPALDADO y DEL TIPO PEDIDO.
     *
     * Una puntuación perfecta no basta: sin año, el homónimo de otra época también puntúa 1.00, y
     * dar por cerrado ahí era lo que impedía llegar a probar el título original ("Home Alone"),
     * que sí lo desempata. Un acierto en el catálogo contrario tampoco cierra nada: la serie
     * "¿Solo en casa?" (2017) se llama en original "Home Alone" y calcaba las dos consultas,
     * cerrando la búsqueda antes de mirar una sola película.
     *
     * Y si la fuente publica un título ORIGINAL que aún no ha confirmado nadie, la búsqueda sigue
     * abierta por bueno que parezca lo encontrado: para "Big Bang" (2007) TMDB devuelve una serie
     * de 2 votos llamada exactamente así, que calca título y año, mientras The Big Bang Theory
     * vuelve rotulada "La Teoría del Big Bang" y puntúa menos. Cerrar ahí guardaba la serie
     * equivocada sin llegar a preguntar por "The Big Bang Theory", que las separa sin lugar a duda.
     */
    const settled = () =>
      bestScore >= CONFIDENT_SCORE && bestVerified && bestEndpoint === endpoint
      && (!useOriginal || bestOriginalMatch);
    // Todos los candidatos vistos en la escalera, para el rescate por título alternativo:
    // el correcto puede estar hundido en la puntuación y no ser nunca "el mejor".
    // La clave lleva el endpoint porque los ids se repiten entre películas y series: con la
    // clave numérica a secas, la serie "¿Solo en casa?" pisaba a la película 74586 en el pool
    // y el rescate acababa devolviendo un id que luego se leía del catálogo equivocado.
    const pool = new Map<string, Candidate>();
    const collect = (candidates: Candidate[]) => {
      for (const c of candidates) {
        const key = `${c.endpoint}:${c.id}`;
        const prev = pool.get(key);
        if (!prev || c.score > prev.score) pool.set(key, c);
      }
      const best = this.pickBest(candidates, endpoint);
      if (best && beatsCandidate(best, bestCand, endpoint)) {
        bestCand = best;
        bestId = best.id;
        bestScore = best.score;
        bestVerified = best.verified;
        bestOriginalMatch = best.originalMatch;
        bestEndpoint = best.endpoint;
      }
      return settled();
    };

    // Cada variante de la consulta recorre la misma escalera. Se para en cuanto el match
    // es inequívoco, así que para los títulos "normales" el coste no cambia: la primera
    // variante es el título limpio de siempre.
    /**
     * UN TÍTULO ORIGINAL QUE REPITE EL TÍTULO BUSCADO NO RESPALDA NADA: es el mismo dato dos veces.
     *
     * `scoreResult` trata el título original de la fuente como una señal INDEPENDIENTE del nombre
     * regional —si calca al `original_name` del candidato, esa es la obra— y con eso da la ficha
     * por respaldada. Pero muchas fuentes no publican título original y el scraper rellena el
     * hueco con el que ya tenían: FuegoCine agrupa sus series por el nombre del post y guarda
     * `original_title` = `title`, y `scrapeFuegocineDetail` hace lo mismo con `d.originalTitle ||
     * titleRaw`. Eso convierte «el título se parece» en «algo independiente lo confirma», que es
     * justo lo que la regla existía para impedir.
     *
     * Y cuando hay un homónimo antiguo cuyo nombre ORIGINAL es de verdad el título buscado, el
     * eco lo corona. Medido: la serie "Merlina" de FuegoCine —Wednesday, 2022, tmdb 119051—
     * entraba con el eco `original_title: "Merlina"`, y TMDB tiene una serie de 1983 cuyo
     * `original_name` es literalmente "Merlina" (tmdb 61564):
     *
     *     con el eco:  61564  «Merlina» (1983)  respaldada   ← se guardó ESTA
     *     sin el eco:  119051 «Merlina» (2022)  sin respaldo, gana por respaldo de público
     *     sin el eco + fotograma del capítulo:  119051 RESPALDADA
     *
     * `useOriginal` ya sabe distinguirlo —por eso no gasta una consulta aparte repitiendo la
     * misma palabra—; lo que faltaba era no darle valor de PRUEBA. Sin eco, el desempate vuelve a
     * donde debe: el fotograma del capítulo, y si no lo hay, el respaldo del público.
     */
    const knownOriginal = useOriginal ? (opts.originalTitle || null) : null;
    const runVariant = async (variant: string): Promise<boolean> => {
      const common = { knownYear: year, imageHint, knownOriginal, episodeHint: opts.episodeHint || null };
      if (year && collect(await this.searchCandidates(endpoint, variant, { ...common, filterYear: year }))) return true;
      if (collect(await this.searchCandidates(endpoint, variant, common))) return true;
      if (collect(await this.searchCandidates(opposite, variant, common))) return true;
      if (collect(await this.searchCandidates('multi', variant, common))) return true;
      return false;
    };

    for (const variant of queryVariants(cleanTitle)) {
      if (await runVariant(variant)) break;
      // Con un match ya aceptable Y RESPALDADO no merece la pena seguir REESCRIBIENDO el mismo
      // título. Sin respaldo sí compensa: las reescrituras son gratis comparadas con guardar
      // la ficha de otra película.
      if (settled()) break;
    }

    // El título original es una consulta DISTINTA, no una reescritura: se intenta siempre que el
    // match aún no sea INEQUÍVOCO —incluso si el título en español ya dio algo "aceptable" pero
    // dudoso—, porque ahí es donde se cuela el homónimo ("El fundador" 2016 vs. Bonifácio 2018).
    if (useOriginal && !settled()) {
      for (const variant of queryVariants(cleanOriginal)) {
        if (await runVariant(variant)) break;
        if (settled()) break;
      }
    }

    // Rescate por título alternativo. Los títulos regionales son el punto ciego del
    // matcher: /search sí encuentra la ficha —indexa los nombres alternativos— pero la
    // devuelve rotulada con su título es-MX, que puede no parecerse en nada al buscado
    // ("Zootrópolis" → "Zootopia", "Bitelchús" → "Beetlejuice"). Por eso NO se filtra por
    // puntuación mínima: se revisan los candidatos más plausibles y se acepta solo si uno
    // de sus títulos registrados en TMDB calca al buscado (ALT_TITLE_ACCEPT).
    //
    // Se intenta mientras el match no sea INEQUÍVOCO, no solo cuando está por debajo del
    // umbral: un parecido parcial puede colarse por encima del umbral y aun así ser la
    // ficha equivocada. "Rápidos y furiosos" puntuaba 0.85 contra un cortometraje sin
    // votos titulado "Rápidos y Furiosos: Hobbs y Reyes", mientras la película de verdad
    // lleva ese mismo nombre como título alternativo registrado. Un nombre oficial que
    // calca es mejor prueba que un parecido a medias.
    if (!settled() && pool.size > 0) {
      const byScore = Array.from(pool.values()).sort((a, b) =>
        (b.score - a.score) || (b.credibility - a.credibility)
      );
      // Los nombres regionales hunden en la puntuación justo a la ficha buena: buscando "Solo en
      // casa", Home Alone vuelve rotulada "Mi pobre angelito" y puntúa 0, así que por parecido
      // nunca entra en la revisión. Se añaden también los candidatos con más respaldo de público,
      // que es donde aparece. Las fichas ya consultadas quedan cacheadas, así que el coste real
      // de mirar unas cuantas más es casi nulo.
      const byCredibility = Array.from(pool.values()).sort((a, b) => b.credibility - a.credibility);
      const examined = new Map<number, Candidate>();
      for (const c of byScore.slice(0, ALT_TITLE_MAX_CANDIDATES)) examined.set(c.id, c);
      for (const c of byCredibility.slice(0, ALT_TITLE_MAX_CANDIDATES)) examined.set(c.id, c);

      // Un título alternativo que calca NO basta por sí solo: los nombres se reciclan entre
      // épocas y TMDB además arrastra fichas con títulos ajenos mal registrados. "Gambling
      // House" (1950) tiene anotado "Solo en casa", el mismo título con el que España estrenó
      // Home Alone (1990), y quedarse con el PRIMERO que calcaba confirmaba con total seguridad
      // la película equivocada.
      //
      // Con el año se descarta al homónimo de otra época. Sin año no hay forma de descartarlo,
      // pero sí de elegir bien entre los que comparten nombre: manda el respaldo del público.
      // Entre las dos fichas llamadas "Solo en casa" hay 12.616 votos frente a 10.
      let rescued: { cand: Candidate; score: number; verified: boolean } | null = null;
      for (const cand of examined.values()) {
        const alt = await this.scoreAgainstKnownTitles(cand.id, cand.endpoint, cleanTitle);
        if (alt.score < ALT_TITLE_ACCEPT) continue;

        // El año encaja ⇒ la ficha queda confirmada; se desvía mucho ⇒ es la homónima y se
        // descarta. Sin año por ninguna de las dos partes, el candidato sigue en juego pero sin
        // respaldo.
        //
        // Confirmar exige el MISMO ±1 que en el resto del matcher, no la ventana de 5 años que se
        // usa para descartar: son dos preguntas distintas. Con 5 años bastaba para dar por
        // respaldada una ficha que solo comparte nombre, y de ahí salían adopciones malas — TMDB
        // registra "Die Hart 2: Die Harter" (película de 2024) como título alternativo de la SERIE
        // "Die Hart" (2020), así que el nombre calcaba, el hueco de 4 años entraba, y una ficha de
        // película se quedaba con el póster y la sinopsis de una serie.
        let verified = cand.verified;
        if (year && alt.year) {
          const diff = Math.abs(Number(alt.year) - Number(year));
          if (diff > 5) continue;
          if (diff <= 1) verified = true;
        }

        // Mismo orden de preferencias que `beatsCandidate` (tipo pedido → respaldo → público),
        // aquí sobre candidatos que YA calcan un nombre oficial, así que la similitud no ordena.
        const wanted = cand.endpoint === endpoint;
        const rescuedWanted = rescued ? rescued.cand.endpoint === endpoint : false;
        const better = !rescued
          || (wanted !== rescuedWanted ? wanted
            : verified !== rescued.verified ? verified
            : cand.credibility > rescued.cand.credibility);
        if (better) rescued = { cand, score: alt.score, verified };
      }

      if (rescued) {
        bestId = rescued.cand.id;
        bestScore = rescued.score;
        bestVerified = rescued.verified;
        bestOriginalMatch = rescued.cand.originalMatch;
        bestEndpoint = rescued.cand.endpoint;
      }
    }

    // Fallback a scraping del buscador de TMDB (útil cuando la API limita por rate),
    // aceptado solo si el título de la ficha se parece de verdad al buscado.
    if (bestScore < MATCH_THRESHOLD) {
      try {
        const url = `https://www.themoviedb.org/search/${endpoint}?query=${encodeURIComponent(cleanTitle)}&language=es-MX`;
        const res = await axios.get(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, timeout: 4000 });
        const $ = cheerio.load(res.data);
        const card = $('.card.style_1 a[href*="/movie/"], .card.style_1 a[href*="/tv/"], .results .item a[href*="/movie/"], .results .item a[href*="/tv/"]').first();
        const href = card.attr('href') || '';
        const idMatch = href.match(/\/(movie|tv)\/(\d+)/);
        const cardTitle = (card.attr('title') || card.find('h2').first().text() || card.text() || '').trim();
        if (idMatch) {
          const scrapedId = parseInt(idMatch[2], 10);
          const scrapedEndpoint = idMatch[1] === 'tv' ? 'tv' : 'movie';
          // La tarjeta de la web solo da el título, así que aceptar por parecido dejaba
          // pasar homónimos de otra época sin ningún control: "Solo en casa" (Home Alone,
          // 1990) acababa resuelto como "Gambling House" (1950) con puntuación perfecta.
          // Se confirma contra la ficha real, con el mismo baremo de año que el resto.
          const details = await this.getTmdbDetails(
            scrapedId,
            scrapedEndpoint === 'tv' ? 'tvseries' : 'movie'
          ).catch(() => null);

          const scored: ScoredResult = details
            ? scoreResult(details, cleanTitle, year, imageHint, knownOriginal, opts.episodeHint || null)
            : { score: Math.min(similarity(cleanTitle, cardTitle), MATCH_THRESHOLD - 0.01), verified: false, originalMatch: false };

          if (scored.score > bestScore) {
            bestId = scrapedId;
            bestScore = scored.score;
            bestVerified = scored.verified;
            bestOriginalMatch = scored.originalMatch;
            bestEndpoint = scrapedEndpoint;
          }
        }
      } catch {}
    }

    /**
     * ÚLTIMO RESPALDO: el fotograma del episodio del que viene la página.
     *
     * Solo se intenta cuando ya hay un candidato bueno por título pero NADA lo respalda, y la
     * página que lo trajo era la de un episodio concreto con una imagen de TMDB. Es el caso de
     * las series agrupadas de FuegoCine, cuyas páginas de episodio no publican ni año ni título
     * original: sin esto se quedan para siempre con la metadata de relleno de la fuente, que es
     * exactamente lo que le pasaba a "Invencible".
     *
     * Cuesta UNA petición y solo en ese callejón. Y sigue siendo una prueba dura, no una
     * concesión: comparar el hash de una imagen no admite parecidos.
     */
    if (!bestVerified && bestId > 0 && imageHint && opts.episodeHint && bestEndpoint === 'tv') {
      await precargarImagenesDeFicha(bestId, opts.episodeHint.season, opts.episodeHint.episode);
      if (imagenExtraDeLaFicha(bestId, imageHint, opts.episodeHint)) {
        bestVerified = true;
        bestScore = 1;
      }
    }

    const matchedType: ContentType = bestEndpoint === 'tv' ? 'tvseries' : 'movie';
    const result: TmdbMatch = bestScore >= MATCH_THRESHOLD && bestId > 0
      ? { id: bestId, matched: true, score: bestScore, verified: bestVerified, type: matchedType }
      : { id: syntheticTmdbId(seed || `${type}:${cleanTitle}`), matched: false, score: bestScore, verified: false, type };

    tmdbIdCache.set(cacheKey, result);
    return result;
  }

  /**
   * Obtiene el TMDB ID numérico de un título (id sintético negativo si no hay match real).
   */
  static async getTmdbId(
    title: string,
    type: ContentType = 'movie',
    year?: string,
    opts?: { originalTitle?: string | null; imageHint?: string | null }
  ): Promise<number> {
    return (await this.resolveTmdb(title, type, year, undefined, opts)).id;
  }

  /**
   * Obtiene la información completa de metadatos desde TMDB por TMDB ID de forma ultra-rápida (Paralelizada).
   */
  static async getTmdbDetails(tmdbId: number, type: ContentType = 'movie'): Promise<any | null> {
    const cacheKey = `${type}:${tmdbId}`;
    if (tmdbDetailCache.has(cacheKey)) {
      return tmdbDetailCache.get(cacheKey);
    }

    const endpoint = type === 'tvseries' ? 'tv' : 'movie';
    try {
      // Peticiones paralelas en una sola ida y vuelta de red (sub-300ms)
      const [primaryRes, fallbackEsRes, fallbackVidRes] = await Promise.allSettled([
        axios.get(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}`, {
          params: {
            api_key: API_KEY,
            language: 'es-MX',
            // images → logo del título (arte para el hero estilo Netflix)
            // release_dates / content_ratings → clasificación por edades real
            // alternative_titles + translations → los OTROS nombres regionales de la ficha
            //   ("Solo en casa" ⇄ "Mi pobre angelito"), que alimentan aliases para que la
            //   búsqueda encuentre el título por cualquiera de sus nombres (ver collectAliases).
            append_to_response: `credits,videos,images,alternative_titles,translations,${endpoint === 'tv' ? 'content_ratings' : 'release_dates'}`,
            // Con 'es,en,null' a secas se descartaban logos que SÍ existen: de 50 fichas sin
            // logo, las 4 que TMDB tenía estaban todas en un idioma no pedido. Ver pickLogo,
            // que es quien decide cuál de ellos es legible y cuál no.
            include_image_language: `es,en,null,${IDIOMAS_DE_LOGO_LEGIBLES.join(',')}`
          },
          timeout: 2500
        }),
        axios.get(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}`, {
          params: { api_key: API_KEY, language: 'es-ES' },
          timeout: 2000
        }),
        axios.get(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}/videos`, {
          params: { api_key: API_KEY },
          timeout: 2000
        })
      ]);

      if (primaryRes.status !== 'fulfilled' || !primaryRes.value.data) {
        return null;
      }

      let data = primaryRes.value.data;

      // Usar sinopsis en español de España si la de México está vacía
      if (!data.overview && fallbackEsRes.status === 'fulfilled' && fallbackEsRes.value.data?.overview) {
        data.overview = fallbackEsRes.value.data.overview;
      }

      /**
       * Y si TMDB no la tiene en NINGÚN español, se busca entre sus traducciones antes de rendirse.
       *
       * Sin esto, "Max Is Missing" se quedaba con el relleno de la fuente —"Ver Max ha desaparecido
       * online gratis en HD con audio Latino"—, que no cuenta nada de la película, teniendo TMDB
       * una sinopsis en inglés perfectamente escrita. La ficha había adoptado su póster, su título
       * y su tmdb_id: la única parte que se quedó atrás fue el texto.
       *
       * No cuesta una petición más: `translations` ya viene en la respuesta principal
       * (`append_to_response`), así que esto es solo leer lo que ya está descargado. Se recorren
       * primero todas las variantes del español (es-AR, es-CL…) y solo después el inglés: una
       * sinopsis real en otro idioma informa; una plantilla de SEO no informa en ninguno.
       */
      if (!data.overview) {
        const traducciones: any[] = data.translations?.translations || [];
        const texto = (t: any) => (t?.data?.overview || '').trim();
        const enEspanol = traducciones.find(t => t?.iso_639_1 === 'es' && texto(t));
        const enIngles = traducciones.find(t => t?.iso_639_1 === 'en' && texto(t));
        if (enEspanol || enIngles) data.overview = texto(enEspanol || enIngles);
      }

      // Usar vídeos globales si los de es-MX están vacíos
      let videos = data.videos?.results || [];
      if (videos.length === 0 && fallbackVidRes.status === 'fulfilled' && fallbackVidRes.value.data?.results) {
        videos = fallbackVidRes.value.data.results;
      }
      data.all_videos = videos;

      tmdbDetailCache.set(cacheKey, data);
      return data;
    } catch (err: any) {
      console.warn(`[TMDB Detail Warning] ID ${tmdbId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Los campos de una ficha que TMDB puede aportar, YA ELEGIDOS, sin tocar nada más.
   *
   * `enrichWithTmdb` construye la ficha ENTERA —título, alias, temporadas, árbol de capítulos— y
   * eso es justo lo que no quiere quien solo viene a tapar un hueco: volver a decidir el título de
   * una ficha que lleva meses correcta es arriesgar una regresión a cambio de nada. Esto expone la
   * parte escalar, que es la única que `scripts/rellenarMetadatos.ts` necesita, con exactamente los
   * mismos criterios de selección (los `pick*` de arriba) para que las dos vías no se separen.
   *
   * Las claves son las de la TABLA, no las del `MediaItem`, porque el destino es un UPDATE.
   */
  static camposDeTmdb(tmdbData: any): Record<string, any> {
    const cast = pickCast(tmdbData);
    return {
      logo: pickLogo(tmdbData),
      poster: tmdbData?.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}` : null,
      backdrop: tmdbData?.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tmdbData.backdrop_path}` : null,
      trailer: pickTrailer(tmdbData),
      runtime: pickRuntime(tmdbData) ?? null,
      content_rating: pickContentRating(tmdbData) || null,
      director: pickDirector(tmdbData) || null,
      genres: (tmdbData?.genres || []).map((g: any) => g.name).filter(Boolean),
      cast_data: cast.length > 0 ? cast : null,
      overview: (tmdbData?.overview || '').trim() || null,
      tagline: (tmdbData?.tagline || '').trim() || null,
      release_date: tmdbData?.release_date || tmdbData?.first_air_date || null,
      rating: typeof tmdbData?.vote_average === 'number' && tmdbData.vote_average > 0
        ? Number(tmdbData.vote_average.toFixed(1)) : null,
      // Solo las películas lo traen en el detalle; en series habría que pedir external_ids.
      imdb_id: /^tt\d+$/.test(tmdbData?.imdb_id || '') ? tmdbData.imdb_id : null,
    };
  }

  /**
   * Todos los nombres CONOCIDOS del título en español (España + Latinoamérica) según TMDB:
   * el título mostrado, el original y los títulos alternativos/traducciones de las regiones
   * hispanohablantes. Es lo que se vuelca en `aliases` para que la búsqueda encuentre la ficha
   * por CUALQUIERA de sus nombres ("Solo en casa" ⇄ "Mi pobre angelito"), sin depender de que
   * las dos variantes se hayan scrapeado por separado.
   *
   * Hacen falta LAS DOS fuentes: algunas variantes viven solo en `translations` (Home Alone
   * no tiene ningún alternative_title español; sus nombres regionales están en las traducciones
   * es-ES/es-MX) y otras solo en `alternative_titles` (el "Zootrópolis" de España). Requiere que
   * el detalle se haya pedido con `append_to_response=alternative_titles,translations`.
   */
  static collectAliases(tmdbData: any): string[] {
    if (!tmdbData) return [];
    // Películas: alternative_titles.titles[] · Series: alternative_titles.results[]
    const alt: any[] = tmdbData.alternative_titles?.titles || tmdbData.alternative_titles?.results || [];
    const translations: any[] = tmdbData.translations?.translations || [];

    const names: Array<string | undefined> = [
      tmdbData.title,
      tmdbData.name,
      tmdbData.original_title,
      tmdbData.original_name,
      ...alt.filter(t => t && SPANISH_REGIONS.has(t.iso_3166_1)).map(t => t.title),
      ...translations.filter(t => t && t.iso_639_1 === 'es').map(t => t?.data?.title || t?.data?.name)
    ];

    // Tope defensivo: aun sumando todas las regiones hispanas el conjunto es pequeño, pero no
    // dejamos que un título con decenas de variantes infle title_normalized sin límite.
    return dedupeTitles(names).slice(0, 25);
  }

  /**
   * Las temporadas que pide TMDB, EN CRUDO y solo las que se le piden.
   *
   * Se pide por número de temporada y no «de la 1 a la N» porque quien ya tiene un árbol de
   * capítulos (FuegoCine publica dos o tres temporadas de una serie que tiene ocho) solo necesita
   * rotular las suyas, y cada temporada de más es una petición de más en un crawl que ya se
   * cancela por ráfagas de conexiones.
   */
  private static async temporadasCrudas(tmdbId: number, numeros: number[]): Promise<Map<number, any>> {
    const pedidos = Array.from(new Set(numeros.filter(n => Number.isFinite(n) && n >= 0))).slice(0, 15);
    const results = await Promise.all(pedidos.map(sNum =>
      axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${sNum}`, {
        params: { api_key: API_KEY, language: 'es-MX' },
        timeout: 2500
      }).catch(() => null)
    ));

    const porNumero = new Map<number, any>();
    results.forEach((res, i) => {
      if (res?.data?.episodes) porNumero.set(pedidos[i], res.data);
    });
    return porNumero;
  }

  /**
   * Obtiene la estructura completa de temporadas y episodios desde la API oficial de TMDB
   */
  static async getTmdbSeasons(tmdbId: number, numSeasons: number, posterUrl: string | null, defaultServers: any[] = []): Promise<any[]> {
    const seasonNumbers = Array.from({ length: Math.min(numSeasons, 15) }, (_, i) => i + 1);
    const crudas = await this.temporadasCrudas(tmdbId, seasonNumbers);

    const seasons: any[] = [];
    for (const sNum of seasonNumbers) {
      const data = crudas.get(sNum);
      if (!data) continue;
      const eps = data.episodes;
      seasons.push({
        season_number: sNum,
        name: data.name || `Temporada ${sNum}`,
        episodes_count: eps.length,
        poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : (posterUrl || null),
        episodes: eps.map((e: any) => ({
          episode_number: e.episode_number,
          name: e.name || `Episodio ${e.episode_number}`,
          overview: e.overview || '',
          still_path: e.still_path ? `https://image.tmdb.org/t/p/w500${e.still_path}` : (posterUrl || null),
          air_date: e.air_date || '',
          servers: defaultServers || []
        }))
      });
    }

    return seasons;
  }

  /**
   * ¿Este árbol de capítulos lo rotuló la web en vez de TMDB?
   *
   * Se pregunta ANTES de pedir nada para no gastar una petición por temporada en las series que ya
   * están bien —las de moviedays llegan sin árbol y se construyen desde TMDB—, y para que llamar a
   * `rotularEpisodiosConTmdb` sea gratis en el caso normal. Las tres señales son las que se midieron
   * sobre lo guardado: el nombre del post en vez del título del capítulo («Bridgerton 1x3»), la
   * plantilla de SEO de la web como sinopsis, y el capítulo que TMDB no ha tocado nunca — sin
   * fotograma Y sin fecha de emisión, que es como llegan los de FuegoCine.
   */
  private static rotuladoPorLaWeb(seasons: any[]): boolean {
    for (const t of seasons) {
      for (const e of (t?.episodes || [])) {
        if (/\d{1,2}\s*x\s*\d{1,3}/i.test(String(e?.name || ''))) return true;
        if (PUBLICIDAD_DE_LA_WEB.test(String(e?.overview || ''))) return true;
        if (!e?.still_path && !e?.air_date) return true;
      }
    }
    return false;
  }

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   * LOS CAPÍTULOS TAMBIÉN SE ROTULAN CON TMDB. La fuente pone los ENLACES; el nombre, la
   * sinopsis, el fotograma y la fecha los pone TMDB, igual que en la ficha.
   *
   * `enrichMediaItem` solo pedía las temporadas a TMDB cuando el ítem llegaba SIN ninguna. Una
   * serie de FuegoCine llega siempre con las suyas —se arma agrupando los posts de sus capítulos—
   * así que su árbol entraba al catálogo tal cual y se guardaba: la ficha con metadata de TMDB y
   * los capítulos rotulados por la web. Medido sobre lo guardado: 618 capítulos anunciando «Ver
   * INVENCIBLE 1x1 en FuegoCine con audio Latino», 638 llamados «Bridgerton 1x3» en vez de por su
   * título, y el 48 % sin fotograma. Es exactamente lo que se ve en la app al abrir una serie.
   *
   * Aquí se PISA lo que publicó la web, no se rellena solo el hueco: el rótulo de la fuente no es
   * metadata incompleta, es publicidad suya, y mientras estuviera puesto TMDB no tenía por dónde
   * entrar. Lo que NO se toca es lo que la fuente sí aporta: los servidores y sus campos internos
   * (`_fuegocine_url`, que es de donde salen los enlaces de cada capítulo y la prueba de quién es
   * la serie — ver `paginasDeCapitulos`).
   *
   * Un capítulo que TMDB no conoce se queda como está: perderlo sería peor que enseñarlo con el
   * nombre de la web, y una temporada que TMDB no publica tampoco se descarta.
   * ══════════════════════════════════════════════════════════════════════════════════════════
   */
  static async rotularEpisodiosConTmdb(
    tmdbId: number,
    seasons: any[] | null | undefined,
    posterUrl: string | null
  ): Promise<any[]> {
    const previas = Array.isArray(seasons) ? seasons : [];
    if (previas.length === 0) return previas;
    if (!this.rotuladoPorLaWeb(previas)) return previas;

    const numeros = previas.map(t => Number(t?.season_number)).filter(n => Number.isFinite(n));

    /**
     * Sin ficha de TMDB no hay con qué rotular, pero sí hay algo que hacer: quitar la publicidad
     * de la web. Una ficha sin identidad no se anuncia (`veredictoDisponibilidad`), y aun así su
     * texto se ve desde el panel y volvería a viajar el día que el matcher la reconozca.
     */
    const crudas = tmdbId > 0 && numeros.length
      ? await this.temporadasCrudas(tmdbId, numeros).catch(() => new Map<number, any>())
      : new Map<number, any>();

    /**
     * Un capítulo que TMDB no publica se queda con el nombre de la web —es el único que tiene—
     * pero NO con su publicidad por sinopsis. Pasa de verdad, y no solo capítulo a capítulo: TMDB
     * contesta 404 a la temporada 2 de «Solo Leveling» y a la de «Kaiju No. 8», que FuegoCine sí
     * numera como 2xN. Esos 17 capítulos no tienen con qué rotularse; lo que sí se puede es no
     * publicar el anuncio de la web como si fuera su sinopsis.
     */
    const sinPublicidad = (e: any) =>
      PUBLICIDAD_DE_LA_WEB.test(String(e?.overview || '')) ? { ...e, overview: '' } : e;

    return previas.map(t => {
      const data = crudas.get(Number(t?.season_number));
      if (!data) return { ...t, episodes: (t?.episodes || []).map(sinPublicidad) };

      const porNumero = new Map<number, any>(
        (data.episodes || []).map((e: any) => [Number(e.episode_number), e])
      );

      return {
        ...t,
        name: data.name || t?.name || `Temporada ${t?.season_number}`,
        poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : (t?.poster || posterUrl || null),
        episodes: (t?.episodes || []).map((e: any) => {
          const oficial = porNumero.get(Number(e?.episode_number));
          if (!oficial) return sinPublicidad(e);
          return {
            ...e,
            name: oficial.name || e?.name || `Episodio ${e?.episode_number}`,
            overview: oficial.overview || '',
            still_path: oficial.still_path
              ? `https://image.tmdb.org/t/p/w500${oficial.still_path}`
              : (e?.still_path || null),
            air_date: oficial.air_date || e?.air_date || ''
          };
        })
      };
    });
  }

  /**
   * Enriquece un MediaItem con metadatos oficiales de TMDB:
   * sinopsis completa en español, trailers oficiales de YouTube, imágenes HD, reparto con fotos, géneros, temporadas, etc.
   */
  /**
   * ÚLTIMO RECURSO: completa el item con la metadata que traía del sitio de origen
   * (póster, sinopsis y año del scraping) para que ninguna ficha quede vacía.
   * Conserva el slug como id y marca metadata_source='source' para poder auditarlo.
   */
  static fromSourceMetadata(item: MediaItem, tmdbId?: number): MediaItem {
    // Sin id válido generamos uno sintético negativo y estable por slug (nunca 0: rompería el UNIQUE).
    const id = tmdbId && tmdbId !== 0 ? tmdbId : syntheticTmdbId(item.id || item.title);
    return {
      ...item,
      id: item.id || String(Math.abs(id)),
      tmdb_id: id,
      original_title: item.original_title || item.title,
      aliases: item.aliases && item.aliases.length ? item.aliases : [item.title],
      // Ni aquí se inventa una sinopsis. Esta ficha se quedó SIN identidad en TMDB; taparlo con
      // «Ver X online en HD con audio Latino» solo consigue que `isMetadataComplete` la dé por
      // completa y que no se vuelva a intentar nunca.
      overview: item.overview || '',
      // Los dos campos NO son intercambiables y rellenar uno con el otro era la causa de
      // que la API sirviera capturas apaisadas en `poster` (y pósters verticales en
      // `backdrop`). Cada uno vale lo que traiga la fuente, o null: una imagen ausente es
      // mejor contrato que una imagen con la orientación equivocada.
      poster: item.poster || null,
      backdrop: item.backdrop || null,
      metadata_source: 'source' as const
    };
  }

  static async enrichMediaItem(item: MediaItem, opts: { skipSeasons?: boolean } = {}): Promise<MediaItem> {
    try {
      // El año sale de release_date; si la fuente lo dejó vacío (FuegoCine) se recupera del
      // slug (`…-2015-html`), que es donde de verdad viaja. Sin año, un homónimo de otra época
      // puede ganar el emparejado.
      const year = (item.release_date ? item.release_date.substring(0, 4) : '') || yearFromSlug(item.id);
      // Pista de imagen: el og:image de la página apunta directo a la ficha exacta de TMDB, así
      // que confirma el candidato aunque el título en es-MX no se parezca al buscado.
      const imageHint = tmdbImagePath(item.poster) || tmdbImagePath(item.backdrop);
      const match: TmdbMatch = item.tmdb_id && item.tmdb_id > 0
        // Ficha que ya venía resuelta (la trae la BD): se toma tal cual, no se vuelve a
        // emparejar. Quien deba revisarla es `repair:catalog --verify`, que sí visita la fuente.
        ? { id: item.tmdb_id, matched: true, score: 1, verified: true, type: item.type }
        : await this.resolveTmdb(item.title, item.type, year, item.id, {
            originalTitle: item.original_title,
            imageHint,
            /**
             * DE QUÉ CAPÍTULO ES LA PÁGINA, cuando quien trae el ítem lo sabe (`_episode_hint`).
             *
             * Sin esto, el único respaldo que una serie agrupada de FuegoCine puede llegar a
             * tener no se intentaba NUNCA por este camino, que es el del crawl. Sus series no
             * tienen página propia: se arman juntando los posts de sus capítulos, y esos posts no
             * publican ni año ni título original. Lo único que traen es el fotograma del capítulo
             * —una ruta de image.tmdb.org—, y para poder compararlo hay que saber de qué capítulo
             * es. `resolveTmdb` ya sabía hacerlo; nadie le pasaba el dato.
             *
             * Medido con "La casa del dragón" (tmdb 94997), que es como se encontró:
             *
             *     sin el capítulo:  94997 encontrada, SIN respaldo → id sintético negativo,
             *                       ficha aparte, sin carátula y sin fundirse con la que ya
             *                       existía por moviedays.
             *     con el capítulo:  94997 RESPALDADA por el fotograma de 3x8.
             */
            episodeHint: (item as any)._episode_hint || null
          });

      /**
       * SIN RESPALDO NO SE ADOPTA LA FICHA DE TMDB.
       *
       * `matched` solo dice que el título se parece lo suficiente (score ≥ 0,6), y con eso se
       * estaba sobreescribiendo título, póster, sinopsis y reparto con los de OTRA película. Es
       * la vía por la que una ficha acaba con la carátula equivocada: "Solo en casa" calca al
       * 100% el nombre de "Gambling House" (1950), y "Atómica" (2017) el de otra "Atomica" del
       * mismo año. El propio matcher ya calcula si algo INDEPENDIENTE del título respalda al
       * candidato —el año, el `og:image` de la página o el título original—; lo que faltaba era
       * exigirlo antes de escribir.
       *
       * Sin respaldo nos quedamos con la metadata de la fuente: un póster peor, pero SUYO. Y con
       * un id sintético, no con el ajeno, porque ese número es lo que después funde dos fichas en
       * una. Medido sobre el catálogo: de 148 fichas correctas, ninguna se apoyaba solo en el
       * parecido del título, así que esto no degrada nada — solo corta el paso a los errores.
       */
      const respaldado = match.matched && match.verified;

      // La ficha se pide por el tipo del MATCH, no por el del ítem: la escalera busca también
      // en el catálogo contrario, y los ids se repiten entre películas y series (ver TmdbMatch).
      const tmdbData = respaldado ? await this.getTmdbDetails(match.id, match.type) : null;
      if (!tmdbData) {
        // `matched` sin respaldo: se descarta el id ajeno y la ficha se queda con uno sintético.
        return OverrideService.applyOverridesToItem(
          this.fromSourceMetadata(item, match.matched && !match.verified ? undefined : match.id)
        );
      }

      const isTv = (tmdbData.number_of_seasons && tmdbData.number_of_seasons > 0) || item.type === 'tvseries' || tmdbData.first_air_date !== undefined;
      const contentType = isTv ? 'tvseries' as const : 'movie' as const;

      const trailerUrl = pickTrailer(tmdbData) || item.trailer;
      const castMembers: CastMember[] = pickCast(tmdbData);

      const existingCastStrings: string[] = Array.isArray(item.cast)
        ? item.cast.map((c: any) => (typeof c === 'string' ? c : (c.name || '')))
        : [];

      const castNames: string[] = castMembers.length > 0
        ? castMembers.map(c => c.name)
        : existingCastStrings;

      // Mapear géneros oficiales
      const genres = tmdbData.genres?.map((g: any) => g.name) || item.genres;

      // Mapear temporadas y episodios si es una serie de TV
      let seasons = item.seasons || [];
      const posterOficial = tmdbData.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}` : item.poster;
      if (!opts.skipSeasons && isTv && (!seasons || seasons.length === 0) && tmdbData.number_of_seasons > 0) {
        seasons = await this.getTmdbSeasons(tmdbData.id, tmdbData.number_of_seasons, posterOficial, item.servers || []);
      } else if (isTv && seasons.length > 0) {
        /**
         * La serie llega CON su árbol de capítulos (solo FuegoCine los trae así). `skipSeasons`
         * no exime de esto: lo que ahorra es CONSTRUIR un árbol que no existe —quince peticiones
         * a ciegas—, no publicar los rótulos de la web. Aquí se piden únicamente las temporadas
         * que la fuente ya trajo, y si no se hiciera en el crawl la fila se guardaría mal rotulada
         * y nadie volvería a mirarla.
         */
        seasons = await this.rotularEpisodiosConTmdb(tmdbData.id, seasons, posterOficial).catch(() => seasons);
      }

      const canonicalId = (item.id && isNaN(Number(item.id))) ? item.id : String(tmdbData.id);

      const enrichedItem = {
        ...item,
        id: canonicalId,
        tmdb_id: tmdbData.id,
        type: contentType,
        title: pickDisplayTitle(tmdbData, item.title),
        original_title: tmdbData.original_title || tmdbData.original_name || item.original_title,
        // Nombres regionales que conoce TMDB + el/los que ya traía la fuente. Alimentan
        // title_normalized (la única columna sobre la que busca el RPC), de modo que la ficha
        // aparezca al buscar por CUALQUIERA de sus títulos, no solo por el que se scrapeó.
        aliases: dedupeTitles([...(item.aliases || []), item.title, ...TmdbService.collectAliases(tmdbData)]),
        tagline: tmdbData.tagline || item.tagline || '',
        overview: tmdbData.overview || item.overview || '',
        rating: tmdbData.vote_average ? Number(tmdbData.vote_average.toFixed(1)) : item.rating,
        release_date: tmdbData.release_date || tmdbData.first_air_date || item.release_date || '',
        genres: genres.length > 0 ? genres : item.genres,
        poster: tmdbData.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}` : item.poster,
        backdrop: tmdbData.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tmdbData.backdrop_path}` : item.backdrop,
        logo: pickLogo(tmdbData) || item.logo,
        trailer: trailerUrl,
        cast: castNames,
        cast_details: castMembers.length > 0 ? castMembers : item.cast_details,
        runtime: pickRuntime(tmdbData) ?? item.runtime,
        content_rating: pickContentRating(tmdbData) || item.content_rating,
        director: pickDirector(tmdbData) || item.director,
        created_by: pickCreators(tmdbData) || item.created_by,
        total_seasons: tmdbData.number_of_seasons || item.total_seasons,
        total_episodes: tmdbData.number_of_episodes || item.total_episodes,
        seasons: seasons.length > 0 ? seasons : item.seasons,
        metadata_source: 'tmdb' as const
      };

      return OverrideService.applyOverridesToItem(enrichedItem);
    } catch (err: any) {
      console.warn(`[TMDB Enrich Error]: ${err.message}`);
      return OverrideService.applyOverridesToItem(this.fromSourceMetadata(item, item.tmdb_id));
    }
  }

  /**
   * Obtiene todas las imágenes/posters/backdrops alternativos de TMDB para un contenido
   */
  static async getTmdbImages(tmdbId: number, type: ContentType = 'movie'): Promise<{ posters: string[]; backdrops: string[] }> {
    const endpoint = type === 'tvseries' ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}/images?api_key=${API_KEY}&include_image_language=es,en,null`;

    try {
      const res = await axios.get(url, { timeout: 5000 });
      const posters = (res.data?.posters || []).map((p: any) => `https://image.tmdb.org/t/p/w500${p.file_path}`);
      const backdrops = (res.data?.backdrops || []).map((b: any) => `https://image.tmdb.org/t/p/w1280${b.file_path}`);
      return { posters, backdrops };
    } catch (err: any) {
      console.warn(`[TMDB Images Error]: ${err.message}`);
      return { posters: [], backdrops: [] };
    }
  }

  /**
   * Búsqueda multi en TMDB (películas y series) para el panel de administración
   */
  static async searchTmdbMulti(query: string): Promise<Array<{ tmdb_id: number; title: string; release_date: string; type: ContentType; poster: string | null; backdrop: string | null }>> {
    const q = query.trim();
    if (!q) return [];

    try {
      const res = await axios.get(`https://api.themoviedb.org/3/search/multi`, {
        params: {
          api_key: API_KEY,
          query: q,
          language: 'es-MX',
          include_adult: false
        },
        timeout: 5000
      });

      const results = res.data?.results || [];
      return results
        .filter((item: any) => item.media_type === 'movie' || item.media_type === 'tv')
        .slice(0, 10)
        .map((item: any) => ({
          tmdb_id: item.id,
          title: item.title || item.name || '',
          release_date: item.release_date || item.first_air_date || '',
          type: item.media_type === 'tv' ? 'tvseries' as const : 'movie' as const,
          poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
          backdrop: item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : null,
        }));
    } catch (err: any) {
      console.warn(`[TMDB Multi Search Error]: ${err.message}`);
      return [];
    }
  }

  /**
   * TMDB COMO ÍNDICE, no solo como fichero de consulta.
   *
   * Hasta ahora TMDB solo se usaba para RESPONDER sobre un título que una web ya había publicado:
   * el crawl descubría, TMDB confirmaba. Moviedays no tiene índice que recorrer —es un oráculo por
   * id, no un catálogo—, así que para ella el orden se invierte: TMDB dice qué obras existen y
   * moviedays contesta de cuáles tiene vídeo.
   *
   * Se usa `/discover` y no `/popular` a propósito: `popular` devuelve siempre las mismas ~40
   * fichas y con eso el catálogo dejaría de crecer a la segunda pasada, mientras que `discover`
   * acepta orden y paginación de verdad, así que el crawl puede seguir bajando por la lista tanto
   * como se le pida. El orden por votos y no por fecha evita llenar el catálogo de estrenos sin
   * copia, que es justo lo que ninguna fuente tendrá todavía.
   *
   * Devuelve solo ids: la metadata la pone después `enrichMediaItem`, que es quien sabe hacerlo
   * bien, y pedirla aquí sería pagar dos veces por lo mismo.
   */
  static async discoverIds(
    type: ContentType,
    opts: { pages?: number; desde?: number; orderBy?: string } = {}
  ): Promise<number[]> {
    const endpoint = type === 'tvseries' ? 'tv' : 'movie';
    const pages = Math.max(1, opts.pages || 1);
    const primera = Math.max(1, opts.desde || 1);
    const ids: number[] = [];

    for (let page = primera; page < primera + pages; page++) {
      try {
        const res = await axios.get(`https://api.themoviedb.org/3/discover/${endpoint}`, {
          params: {
            api_key: API_KEY,
            language: 'es-MX',
            sort_by: opts.orderBy || 'vote_count.desc',
            include_adult: false,
            page,
          },
          timeout: 10000,
        });
        const results = res.data?.results || [];
        // TMDB corta en la página 500; más allá contesta 422 y seguir pidiendo es gastar por nada.
        if (results.length === 0) break;
        for (const r of results) if (r?.id) ids.push(Number(r.id));
      } catch {
        break;
      }
    }
    return ids;
  }
}


