import axios from 'axios';
import * as cheerio from 'cheerio';
import { MediaItem, ContentType, CastMember } from '../types';
import { OverrideService } from './overrideService';
import { USER_AGENT } from '../utils/httpClient';
import { canonicalTitle, normalizeTitle, dedupeTitles, yearFromSlug } from '../utils/text';

const API_KEY = '99b8bc99e85e79fabd52b64513c9780d';
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
}

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

/** Limpia un título de listado para buscarlo en TMDB (sin año, sin ruido, sin temporada). */
function cleanForSearch(title: string): string {
  let t = (title || '')
    .replace(/\s*\(\d{4}\)\s*$/, '')
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
 * Logo del título (arte tipográfico) para el hero estilo Netflix/Prime.
 * Prioriza el logo en español, luego inglés, luego el que no declara idioma.
 */
function pickLogo(tmdbData: any): string | null {
  const logos: any[] = tmdbData?.images?.logos || [];
  if (logos.length === 0) return null;
  const byLang = (lang: string | null) => logos.find(l => l.iso_639_1 === lang && l.file_path);
  const chosen = byLang('es') || byLang('en') || byLang(null) || logos[0];
  return chosen?.file_path ? `https://image.tmdb.org/t/p/w500${chosen.file_path}` : null;
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
function similarity(a: string, b: string): number {
  const ca = canonicalTitle(a);
  const cb = canonicalTitle(b);
  if (!ca || !cb) return 0;
  if (ca === cb) return 1;
  if (ca.startsWith(cb) || cb.startsWith(ca)) return 0.85;
  if (ca.includes(cb) || cb.includes(ca)) return 0.7;

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
function tmdbImagePath(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = String(url).match(/image\.tmdb\.org\/t\/p\/[^/]+\/([\w-]+\.(?:jpg|jpeg|png|webp|svg))/i);
  if (m) return `/${m[1]}`;
  // TMDB devuelve poster_path/backdrop_path ya como "/<hash>.jpg": se normaliza por basename.
  const bare = String(url).match(/^\/?([\w-]+\.(?:jpg|jpeg|png|webp|svg))$/i);
  return bare ? `/${bare[1]}` : null;
}

/**
 * Puntúa un resultado de TMDB frente al título (y año) buscados.
 *
 * El año NO es un desempate menor: los títulos regionales chocan de lleno con películas
 * ajenas que se llaman exactamente igual. "Solo en casa" (el título de España de Home
 * Alone, 1990) coincide al 100% con "Gambling House", una película de 1944, y con una
 * penalización simbólica esa coincidencia exacta ganaba y se guardaba como match seguro.
 * Un desfase grande de estreno descarta el candidato salvo que el título alternativo lo
 * confirme después (ver scoreAgainstKnownTitles).
 */
function scoreResult(result: any, query: string, year?: string, imageHint?: string | null): number {
  // Confirmación por IMAGEN: si la página de origen trae la ruta de TMDB (og:image) y coincide
  // con el póster o el fondo del candidato, es la MISMA ficha con certeza, se llame como se llame
  // en es-MX (así "El fundador" fija a The Founder aunque su título latino sea "Hambre de poder").
  // Solo CONFIRMA; si no coincide no penaliza —la página pudo usar el póster de otro idioma—.
  if (imageHint) {
    if (imageHint === tmdbImagePath(result.poster_path) || imageHint === tmdbImagePath(result.backdrop_path)) {
      return 1;
    }
  }

  const candidates = [result.title, result.name, result.original_title, result.original_name].filter(Boolean);
  let best = 0;
  for (const c of candidates) best = Math.max(best, similarity(query, c));

  const date: string = result.release_date || result.first_air_date || '';
  if (year) {
    if (!date) {
      // Ficha sin fecha de estreno: TMDB está lleno de entradas vacías (cero votos, sin
      // datos) cuyo título calca al buscado. Sabiendo el año y no pudiendo confirmarlo,
      // el candidato no puede tratarse como si encajara.
      best -= 0.25;
    } else {
      const diff = Math.abs(parseInt(date.substring(0, 4), 10) - parseInt(year, 10));
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
  return Math.max(0, Math.min(1, best));
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
    opts: { filterYear?: string; knownYear?: string; imageHint?: string | null } = {}
  ): Promise<Array<{ id: number; score: number; credibility: number; endpoint: 'movie' | 'tv' }>> {
    // Los dos usos del año son distintos y confundirlos costaba matches equivocados:
    //  · filterYear → se manda a TMDB para acotar la búsqueda;
    //  · knownYear  → se usa SIEMPRE para puntuar, incluso en las consultas sin filtrar.
    // Cuando el año solo servía de filtro, las consultas sin él no penalizaban nada y una
    // coincidencia exacta de título de otra época ganaba: "Solo en casa" (Home Alone, 1990)
    // se resolvía como "Gambling House" (1944) con puntuación perfecta.
    const { filterYear, knownYear, imageHint } = opts;
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
        score: scoreResult(r, query, knownYear, imageHint),
        credibility: (r.vote_count || 0) * 1000 + (r.popularity || 0),
        // En /search/multi el tipo lo dice cada resultado; en el resto, el propio endpoint.
        endpoint: (endpoint === 'multi' ? (r.media_type === 'tv' ? 'tv' : 'movie') : endpoint) as 'movie' | 'tv'
      }));
    } catch (err: any) {
      console.warn(`[TMDB API Search Warning]: ${err.message}`);
      return [];
    }
  }

  /** El mejor candidato de una consulta, con el desempate por respaldo de público. */
  private static pickBest(
    candidates: Array<{ id: number; score: number; credibility: number }>
  ): { id: number; score: number } | null {
    // Ante similitud MUY parecida (p. ej. anime original vs. remake homónimo, o una
    // parodia con nombre casi idéntico al original) gana la ficha con respaldo real de
    // público: la parodia "Vengadores Chiflados" tiene 1 voto frente a los 24.000 del
    // título auténtico. Se compara con margen, no solo en el empate exacto.
    const TIE_MARGIN = 0.06;

    let best: { id: number; score: number; credibility: number } | null = null;
    for (const c of candidates) {
      const beatsBest = !best
        || c.score > best.score + TIE_MARGIN
        || (Math.abs(c.score - best.score) <= TIE_MARGIN && c.credibility > best.credibility);
      if (beatsBest) best = c;
    }
    return best ? { id: best.id, score: best.score } : null;
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
    opts: { originalTitle?: string | null; imageHint?: string | null } = {}
  ): Promise<TmdbMatch> {
    const cleanTitle = cleanForSearch(title);
    const imageHint = tmdbImagePath(opts.imageHint);
    // El título original ("The Founder") se busca como consulta APARTE del título en español:
    // en es-MX el candidato correcto puede rotularse distinto ("Hambre de poder") y no parecerse
    // al buscado, pero por su nombre original TMDB lo devuelve con original_title calcado (1.0).
    const cleanOriginal = opts.originalTitle ? cleanForSearch(opts.originalTitle) : '';
    const useOriginal = !!cleanOriginal && canonicalTitle(cleanOriginal) !== canonicalTitle(cleanTitle);

    const cacheKey = `${type}:${cleanTitle.toLowerCase()}:${year || ''}:${useOriginal ? canonicalTitle(cleanOriginal) : ''}:${imageHint || ''}`;
    const cached = tmdbIdCache.get(cacheKey);
    if (cached) return cached;

    const endpoint = type === 'tvseries' ? 'tv' : 'movie';
    const opposite = endpoint === 'tv' ? 'movie' : 'tv';

    let bestId = 0;
    let bestScore = 0;
    // Todos los candidatos vistos en la escalera, para el rescate por título alternativo:
    // el correcto puede estar hundido en la puntuación y no ser nunca "el mejor".
    const pool = new Map<number, { id: number; score: number; credibility: number; endpoint: 'movie' | 'tv' }>();
    const collect = (candidates: Array<{ id: number; score: number; credibility: number; endpoint: 'movie' | 'tv' }>) => {
      for (const c of candidates) {
        const prev = pool.get(c.id);
        if (!prev || c.score > prev.score) pool.set(c.id, c);
      }
      const best = this.pickBest(candidates);
      if (best && best.score > bestScore) {
        bestId = best.id;
        bestScore = best.score;
      }
      return bestScore >= CONFIDENT_SCORE;
    };

    // Cada variante de la consulta recorre la misma escalera. Se para en cuanto el match
    // es inequívoco, así que para los títulos "normales" el coste no cambia: la primera
    // variante es el título limpio de siempre.
    const runVariant = async (variant: string): Promise<boolean> => {
      if (year && collect(await this.searchCandidates(endpoint, variant, { filterYear: year, knownYear: year, imageHint }))) return true;
      if (collect(await this.searchCandidates(endpoint, variant, { knownYear: year, imageHint }))) return true;
      if (collect(await this.searchCandidates(opposite, variant, { knownYear: year, imageHint }))) return true;
      if (collect(await this.searchCandidates('multi', variant, { knownYear: year, imageHint }))) return true;
      return false;
    };

    for (const variant of queryVariants(cleanTitle)) {
      if (await runVariant(variant)) break;
      // Con un match ya aceptable no merece la pena seguir REESCRIBIENDO el mismo título.
      if (bestScore >= MATCH_THRESHOLD) break;
    }

    // El título original es una consulta DISTINTA, no una reescritura: se intenta siempre que el
    // match aún no sea INEQUÍVOCO —incluso si el título en español ya dio algo "aceptable" pero
    // dudoso—, porque ahí es donde se cuela el homónimo ("El fundador" 2016 vs. Bonifácio 2018).
    if (useOriginal && bestScore < CONFIDENT_SCORE) {
      for (const variant of queryVariants(cleanOriginal)) {
        if (await runVariant(variant)) break;
        if (bestScore >= CONFIDENT_SCORE) break;
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
    if (bestScore < CONFIDENT_SCORE && pool.size > 0) {
      const byPromise = Array.from(pool.values()).sort((a, b) =>
        (b.score - a.score) || (b.credibility - a.credibility)
      );

      for (const cand of byPromise.slice(0, ALT_TITLE_MAX_CANDIDATES)) {
        const alt = await this.scoreAgainstKnownTitles(cand.id, cand.endpoint, cleanTitle);
        if (alt.score < ALT_TITLE_ACCEPT) continue;

        // Un título alternativo que calca NO basta por sí solo: los nombres se reciclan
        // entre épocas. "Gambling House" (1950) tiene registrado "Solo en casa", el mismo
        // título con el que España estrenó Home Alone (1990), así que sin este control el
        // rescate confirmaba con total seguridad la película equivocada.
        if (year && alt.year && Math.abs(Number(alt.year) - Number(year)) > 5) continue;

        bestId = cand.id;
        bestScore = alt.score;
        break;
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

          const score = details
            ? scoreResult(details, cleanTitle, year)
            : Math.min(similarity(cleanTitle, cardTitle), MATCH_THRESHOLD - 0.01);

          if (score > bestScore) {
            bestId = scrapedId;
            bestScore = score;
          }
        }
      } catch {}
    }

    const result: TmdbMatch = bestScore >= MATCH_THRESHOLD && bestId > 0
      ? { id: bestId, matched: true, score: bestScore }
      : { id: syntheticTmdbId(seed || `${type}:${cleanTitle}`), matched: false, score: bestScore };

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
            include_image_language: 'es,en,null'
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
   * Obtiene la estructura completa de temporadas y episodios desde la API oficial de TMDB
   */
  static async getTmdbSeasons(tmdbId: number, numSeasons: number, posterUrl: string | null, defaultServers: any[] = []): Promise<any[]> {
    const seasonNumbers = Array.from({ length: Math.min(numSeasons, 15) }, (_, i) => i + 1);

    const seasonPromises = seasonNumbers.map(sNum =>
      axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${sNum}`, {
        params: { api_key: API_KEY, language: 'es-MX' },
        timeout: 2500
      }).catch(() => null)
    );

    const results = await Promise.all(seasonPromises);
    const seasons: any[] = [];

    results.forEach((res, index) => {
      const sNum = seasonNumbers[index];
      if (res && res.data && res.data.episodes) {
        const eps = res.data.episodes;
        seasons.push({
          season_number: sNum,
          name: res.data.name || `Temporada ${sNum}`,
          episodes_count: eps.length,
          poster: res.data.poster_path ? `https://image.tmdb.org/t/p/w500${res.data.poster_path}` : (posterUrl || null),
          episodes: eps.map((e: any) => ({
            episode_number: e.episode_number,
            name: e.name || `Episodio ${e.episode_number}`,
            overview: e.overview || `Episodio ${e.episode_number} de la serie. Disponible en HD con audio Español Latino.`,
            still_path: e.still_path ? `https://image.tmdb.org/t/p/w500${e.still_path}` : (posterUrl || null),
            air_date: e.air_date || '',
            servers: defaultServers || []
          }))
        });
      }
    });

    return seasons;
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
      overview: item.overview || `Ver ${item.title} online en HD con audio Latino.`,
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
        ? { id: item.tmdb_id, matched: true, score: 1 }
        : await this.resolveTmdb(item.title, item.type, year, item.id, {
            originalTitle: item.original_title,
            imageHint
          });

      // Sin match fiable en TMDB no pedimos detalles (traerían metadata de OTRO título):
      // nos quedamos con la del sitio de origen.
      const tmdbData = match.matched ? await this.getTmdbDetails(match.id, item.type) : null;
      if (!tmdbData) {
        return OverrideService.applyOverridesToItem(this.fromSourceMetadata(item, match.id));
      }

      const isTv = (tmdbData.number_of_seasons && tmdbData.number_of_seasons > 0) || item.type === 'tvseries' || tmdbData.first_air_date !== undefined;
      const contentType = isTv ? 'tvseries' as const : 'movie' as const;

      // Seleccionar Trailer oficial en YouTube (priorizar español)
      const videos = tmdbData.all_videos || tmdbData.videos?.results || [];
      const trailerObj = videos.find((v: any) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser') && (v.iso_639_1 === 'es' || v.iso_639_1 === 'es-MX'))
        || videos.find((v: any) => v.site === 'YouTube' && v.type === 'Trailer')
        || videos.find((v: any) => v.site === 'YouTube');

      const trailerUrl = trailerObj ? `https://www.youtube.com/watch?v=${trailerObj.key}` : item.trailer;

      // Mapear reparto con fotografías de TMDB y lista simple de nombres
      const castMembers: CastMember[] = tmdbData.credits?.cast?.slice(0, 12).map((c: any) => ({
        name: c.name,
        character: c.character || '',
        photo: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null
      })) || [];

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
      if (!opts.skipSeasons && isTv && (!seasons || seasons.length === 0) && tmdbData.number_of_seasons > 0) {
        seasons = await this.getTmdbSeasons(tmdbData.id, tmdbData.number_of_seasons, tmdbData.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}` : item.poster, item.servers || []);
      }

      const canonicalId = (item.id && isNaN(Number(item.id))) ? item.id : String(tmdbData.id);

      const enrichedItem = {
        ...item,
        id: canonicalId,
        tmdb_id: tmdbData.id,
        type: contentType,
        title: tmdbData.title || tmdbData.name || item.title,
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
}


