import { MediaItem, ServerOption, ContentType } from '../types';
import { supabase, getSupabaseAdmin } from './supabaseService';
import { RealScraperService } from './realScraperService';
import { TmdbService } from './tmdbService';
import { sortServersBySourcePriority, getPrimaryStream } from './streamSorter';
import { normalizeTitle, slugify } from '../utils/text';
import { CacheStore } from '../cache/store';

// TTL del caché de catálogo/búsqueda. Con Redis (KV_REST_API_* / UPSTASH_*) las entradas
// se comparten entre lambdas y sobreviven cold starts; sin Redis degrada a memoria local.
const CACHE_TTL_SECONDS = 10 * 60;

// La METADATA (sinopsis, pósters, reparto…) apenas cambia: se cachea mucho más tiempo que
// los enlaces, que sí caducan. Es lo que permite que la ficha emergente abra al instante.
const METADATA_TTL_SECONDS = 6 * 60 * 60;

// Enlaces persistidos por debajo de esta antigüedad se sirven de la DB sin volver a scrapear.
const STREAMS_FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * Clave canónica de título para AGRUPAR variantes del mismo contenido entre fuentes
 * (regionalizaciones ES/EN, sufijos "HD"/"La Película", casos Spider-Man). Insensible a
 * acentos y puntuación. Reutilizada por la fusión multifuente y el agrupamiento de búsqueda.
 */
function canonicalTitleKey(t: string): string {
  const norm = (t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return norm
    .replace(/\b(la pelicula|pelicula|the movie|hd)\b/g, '')
    .replace(/\bspiderman\b/g, 'spider man')
    .replace(/\bspider man 1\b/g, 'spider man')
    .replace(/sin camino a casa/g, 'no way home')
    .replace(/lejos de casa/g, 'far from home')
    .replace(/de regreso a casa/g, 'homecoming')
    .replace(/un nuevo universo/g, 'into the spider verse')
    .replace(/traves del spider verso/g, 'across the spider verse')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalización estricta alfanumérica para comparación EXACTA de títulos/slugs. */
function strictKey(t: string): string {
  return (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '').trim();
}

export class CatalogService {
  private static dedupeById(items: MediaItem[]): MediaItem[] {
    const seen = new Set<string>();
    return items.filter(item => {
      if (!item.id || seen.has(item.id)) {
        return false;
      }
      seen.add(item.id);
      return true;
    });
  }

  /**
   * Limpia toda la caché en memoria de la API
   */
  static clearCache(): void {
    CacheStore.clear();
  }

  /**
   * Propaga los servidores a la jerarquía de episodios de una serie.
   * Cada episodio usa sus PROPIOS servidores (reales, por episodio) si los tiene; si no,
   * hereda los de nivel serie como fallback reproducible en la portada. Los enlaces reales
   * por episodio se obtienen bajo demanda vía /series/:id/season/:s/episode/:e.
   * Consolida la lógica antes duplicada en getById y la unificación de búsqueda.
   */
  private static inheritServersToEpisodes(item: MediaItem | null | undefined): void {
    if (!item || !item.seasons || item.seasons.length === 0) return;
    const seriesLevel = sortServersBySourcePriority(item.servers || []);
    for (const season of item.seasons) {
      if (!season.episodes) continue;
      for (const ep of season.episodes) {
        const own = ep.servers && ep.servers.length > 0 ? ep.servers : seriesLevel;
        ep.servers = sortServersBySourcePriority(own);
        if (ep.servers.length > 0) {
          ep.primary_stream = getPrimaryStream(ep.servers);
        }
      }
    }
  }

  /**
   * Resuelve un slug directamente contra las fuentes reales:
   * FuegoCine (ids con forma 2025-04-titulo-2012-html) y TioPlus (por categoría).
   * Devuelve el detalle SIN enriquecer, o null si el slug no existe en ninguna fuente.
   */
  private static async resolveFromSource(slug: string): Promise<MediaItem | null> {
    const fuegocineMatch = slug.match(/^(\d{4})-(\d{2})-(.+)-html$/);
    if (fuegocineMatch) {
      const fuegocineUrl = `https://www.fuegocine.com/${fuegocineMatch[1]}/${fuegocineMatch[2]}/${fuegocineMatch[3]}.html`;
      const fcDetail = await RealScraperService.scrapeFuegocineDetail(fuegocineUrl).catch(() => null);
      if (fcDetail) return fcDetail;
    }

    // Las 4 categorías se prueban EN PARALELO: en serie costaban hasta 4 round-trips
    // encadenados en el peor caso (el que más pesaba en la latencia del detalle).
    const categories = ['pelicula', 'serie', 'anime', 'dorama'];
    const probes = await Promise.all(
      categories.map(cat =>
        RealScraperService.scrapeDetail(`https://tioplus.app/${cat}/${slug}`).catch(() => null)
      )
    );

    // Se conserva el orden de preferencia original (película > serie > anime > dorama).
    for (const detail of probes) {
      if (detail && (detail.servers?.length || detail.seasons?.length)) return detail;
    }

    return null;
  }

  /**
   * Puntuación mínima para tratar una fila como LA ficha pedida. Por debajo de este umbral
   * la coincidencia es solo parcial y se prefiere resolver contra las fuentes en vivo.
   */
  private static readonly DB_MATCH_CONFIDENT = 70;

  /**
   * Todas las formas de slug bajo las que puede pedirse una fila, derivadas de su id.
   * FuegoCine antepone la fecha del post y añade el año + "-html":
   *   2025-04-shrek-2-2004-html  →  {id completo, "shrek-2-2004", "shrek-2"}
   * Es lo que permite reconocer "shrek-2" como EXACTAMENTE esa fila, y no como un trozo
   * suelto de "2025-04-shrek-2001-html" (donde "shrek-2" solo aparece dentro del año).
   */
  private static idSlugVariants(rowId: string): Set<string> {
    const variants = new Set<string>();
    const base = String(rowId || '').toLowerCase().trim();
    if (!base) return variants;

    variants.add(base);
    const fuegocine = base.match(/^\d{4}-\d{2}-(.+)-html$/);
    if (fuegocine) {
      variants.add(fuegocine[1]);
      variants.add(fuegocine[1].replace(/-\d{4}$/, ''));
    }
    return variants;
  }

  /**
   * Cuánto se parece una fila al slug pedido. Solo cuentan las coincidencias de UNIDAD
   * COMPLETA (id canónico, título, título original, alias); el "contiene" suelto puntúa
   * por debajo del umbral de confianza porque es justo lo que cruzaba fichas distintas
   * ("shrek" → Shrek Tercero, "shrek-2" → Shrek).
   */
  private static scoreDbCandidate(row: any, slug: string, typeHint?: ContentType): number {
    const idVariants = this.idSlugVariants(row?.id);
    const titleSlug = slugify(row?.title);
    let score = 0;

    if (idVariants.has(slug)) score = 100;
    else if (titleSlug && titleSlug === slug) score = 95;
    else if (slugify(row?.original_title) === slug && slug) score = 80;
    else if ((row?.aliases || []).some((a: string) => slugify(a) === slug)) score = 70;
    else {
      // Prefijo de segmento completo ("shrek" ⊂ "shrek-2"): plausible, nunca concluyente.
      const isSegmentPrefix = (v: string) => v === slug || v.startsWith(`${slug}-`);
      if (Array.from(idVariants).some(isSegmentPrefix) || (titleSlug && isSegmentPrefix(titleSlug))) score = 30;
      else if (Array.from(idVariants).some(v => v.includes(slug))) score = 10;
    }

    if (score === 0) return 0;

    // Desempates: no cruzan de nivel, solo ordenan dentro del mismo tipo de coincidencia.
    if (typeHint && row?.type === typeHint) score += 3;
    if (row?.poster) score += 2;
    if (row?.overview && String(row.overview).length > 20) score += 1;
    return score;
  }

  /**
   * Localiza la fila del catálogo que corresponde a CUALQUIER forma de id que la API haya
   * podido emitir: el id de la fuente, el tmdb_id, el slug corto de TioPlus, el slug
   * embebido en el id de FuegoCine o un slug derivado del título.
   *
   * Devuelve la mejor candidata JUNTO CON su puntuación: el llamador decide si la acepta
   * como definitiva (>= DB_MATCH_CONFIDENT) o si primero intenta resolver en vivo. Antes se
   * devolvía el primer `ilike '%slug%'` que apareciera, sin orden ni verificación, y los
   * slugs cortos acababan apuntando a la película equivocada.
   */
  private static async findDbRowScored(id: string, typeHint?: ContentType): Promise<{ row: any; score: number } | null> {
    const slug = id.trim().toLowerCase();
    if (!slug) return null;

    // a) id exacto de la fuente: no hay nada más que verificar.
    try {
      const { data } = await supabase.from('media_items').select('*').eq('id', slug).limit(1);
      if (data && data.length > 0) return { row: data[0], score: 100 };
    } catch {}

    // b) tmdb_id numérico.
    if (!isNaN(Number(slug))) {
      try {
        const { data } = await supabase.from('media_items').select('*').eq('tmdb_id', Number(slug)).limit(1);
        if (data && data.length > 0) return { row: data[0], score: 100 };
      } catch {}
    }

    // Solo [a-z0-9-] llega a los patrones LIKE, así que no hay riesgo de inyección de comodines.
    const safeSlug = slugify(slug);
    if (!safeSlug) return null;
    const deslugged = safeSlug.replace(/-/g, ' ');

    // Los pases van EN PARALELO. Los dos primeros están anclados a la gramática de los ids
    // de FuegoCine (`_` = un carácter en LIKE, `____` = el año), así que traen la fila
    // correcta aunque el pase suelto se quede corto por el límite de filas. El cuarto usa
    // `%` como separador para que la puntuación que el slug perdió ("9: el" ← "9-el") no
    // impida encontrar el título. Todos son CANDIDATOS: quien decide es la puntuación.
    const candidateSets = await Promise.all([
      supabase.from('media_items').select('*').ilike('id', `%-${safeSlug}-html`).limit(10),
      supabase.from('media_items').select('*').ilike('id', `%-${safeSlug}-____-html`).limit(10),
      supabase.from('media_items').select('*').ilike('title_normalized', `${deslugged}%`).limit(25),
      supabase.from('media_items').select('*').ilike('title_normalized', `${safeSlug.replace(/-/g, '%')}%`).limit(25),
      supabase.from('media_items').select('*').ilike('id', `%${safeSlug}%`).limit(25)
    ].map(p => Promise.resolve(p).then((r: any) => (r?.data as any[]) || []).catch(() => [] as any[])));

    let best: { row: any; score: number } | null = null;
    const seen = new Set<string>();
    for (const row of candidateSets.flat()) {
      if (!row?.id || seen.has(row.id)) continue;
      seen.add(row.id);
      const score = this.scoreDbCandidate(row, safeSlug, typeHint);
      if (score > 0 && (!best || score > best.score)) best = { row, score };
    }

    return best;
  }

  /**
   * Mapea un MediaItem a un payload compacto optimizado para listados y vistas rápidas
   */
  static toCompactItem(item: MediaItem): Partial<MediaItem> {
    return {
      id: item.id,
      tmdb_id: item.tmdb_id,
      type: item.type,
      title: item.title,
      original_title: item.original_title,
      poster: item.poster,
      backdrop: item.backdrop,
      rating: item.rating,
      release_date: item.release_date,
      genres: item.genres,
      subcategories: item.subcategories,
      primary_stream: item.primary_stream,
      servers: item.servers
    };
  }

  /**
   * Proyección LEAN para resultados de BÚSQUEDA: solo lo necesario para pintar una tarjeta.
   * Sin cast, servers, seasons ni overview → payload pequeño y respuesta ultrarrápida.
   * El detalle completo se obtiene al abrir el título (getById).
   */
  static toSearchItem(item: MediaItem): Partial<MediaItem> {
    return {
      id: item.id,
      tmdb_id: item.tmdb_id,
      type: item.type,
      title: item.title,
      original_title: item.original_title,
      poster: item.poster,
      backdrop: item.backdrop,
      release_date: item.release_date,
      rating: item.rating,
      genres: item.genres,
      subcategories: item.subcategories
    };
  }

  /**
   * Proyección de TARJETA para el home y los carruseles. Lleva la metadata completa que
   * necesita la ficha emergente (sinopsis, tagline, logo, duración, clasificación, tráiler),
   * de modo que la app pueda abrir el popup SIN pedir nada más; solo los enlaces se piden
   * aparte, al pulsar Reproducir. Sin cast, servidores ni temporadas.
   */
  static toCardItem(item: MediaItem): Partial<MediaItem> & Record<string, unknown> {
    return {
      id: item.id,
      tmdb_id: item.tmdb_id,
      type: item.type,
      title: item.title,
      original_title: item.original_title,
      tagline: item.tagline || '',
      overview: item.overview || '',
      poster: item.poster,
      backdrop: item.backdrop,
      logo: item.logo,
      rating: item.rating,
      content_rating: item.content_rating,
      runtime: item.runtime,
      release_date: item.release_date,
      year: item.release_date ? Number(String(item.release_date).substring(0, 4)) || null : null,
      genres: item.genres,
      subcategories: item.subcategories,
      trailer: item.trailer,
      total_seasons: item.total_seasons,
      total_episodes: item.total_episodes,
      detail_url: `/api/v1/media/${item.id}`,
      streams_url: `/api/v1/media/${item.id}/streams`
    };
  }

  /**
   * Proyección de HÉROE (destacados del home): la tarjeta + reparto y dirección.
   */
  static toHeroItem(item: MediaItem): Partial<MediaItem> & Record<string, unknown> {
    return {
      ...this.toCardItem(item),
      cast: (item.cast || []).slice(0, 8),
      cast_details: (item.cast_details || []).slice(0, 8),
      dubbing_cast: item.dubbing_cast || [],
      director: item.director,
      created_by: item.created_by,
      original_language_title: item.original_title
    };
  }

  /**
   * Consulta múltiples títulos en lote (Batching Request).
   * Usa el camino RÁPIDO (metadata sin resolución de enlaces) para que prefetchear
   * una fila entera del home siga siendo barato.
   */
  static async getBatch(ids: string[]): Promise<MediaItem[]> {
    const results = await Promise.all(ids.map(id => this.getMetadata(id)));
    return results.filter((item): item is MediaItem => item !== null);
  }

  /**
   * ¿Está aplicada la migración 005? Se comprueba UNA sola vez por proceso: sin ella las
   * columnas de disponibilidad no existen y cualquier consulta que las filtre sería
   * rechazada ENTERA, dejando el home y el discover vacíos. Ante la duda, no se filtra.
   */
  private static availabilityColumnProbe: Promise<boolean> | null = null;
  private static hasAvailabilityColumn(): Promise<boolean> {
    if (!this.availabilityColumnProbe) {
      // Aquí SÍ queremos ejecutar la consulta: `await` sobre el builder la lanza y basta
      // con mirar si Postgres se queja de que la columna no existe.
      this.availabilityColumnProbe = (async () => {
        try {
          const { error } = await supabase.from('media_items').select('has_streams').limit(1);
          return !error;
        } catch {
          return false;
        }
      })();
    }
    return this.availabilityColumnProbe;
  }

  /**
   * Predicado que deja fuera de un listado las fichas FANTASMA: las que se comprobaron a
   * fondo y no tienen ningún enlace reproducible (`has_streams = false`). Las que nunca se
   * han comprobado (NULL) siguen apareciendo — son la mayor parte del catálogo, y ocultarlas
   * por no estar verificadas vaciaría la API en vez de limpiarla. Devuelve null si la
   * migración 005 no está aplicada: entonces no se filtra nada.
   *
   * Se devuelve el PREDICADO, no la consulta ya filtrada, y no es casual: un
   * PostgrestFilterBuilder es "thenable", así que devolverlo desde una función `async` hace
   * que la promesa lo adopte y EJECUTE la consulta a medio construir. El llamador recibía
   * entonces un objeto de resultado en lugar del builder, los filtros siguientes se perdían
   * y el home se quedaba sin una sola fila.
   */
  private static async ghostFilter(): Promise<string | null> {
    return (await this.hasAvailabilityColumn())
      ? 'has_streams.is.null,has_streams.eq.true'
      : null;
  }

  /**
   * Pool de títulos para construir el home. Una sola query a Postgres (sin scraping),
   * cacheada, lo bastante ancha para alimentar ~15 carruseles temáticos. Cae a getAll()
   * (que sí sabe scrapear en vivo) cuando la DB todavía no está poblada.
   *
   * Se exigen póster y géneros: el job de refresco escribe AL FINAL los títulos sin match
   * en TMDB (sin géneros ni sinopsis), así que ordenar solo por frescura llenaba el pool
   * entero con ellos y el home se quedaba sin carruseles temáticos ni destacados.
   */
  static async getHomePool(limit: number = 800): Promise<MediaItem[]> {
    const cacheKey = `home_pool:${limit}`;
    const cached = await CacheStore.get<MediaItem[]>(cacheKey);
    if (cached) return cached;

    try {
      let query = supabase
        .from('media_items')
        .select('*')
        .not('poster', 'is', null)
        .not('genres', 'eq', '{}')
        .order('updated_at', { ascending: false })
        .limit(limit);

      const ghosts = await this.ghostFilter();
      if (ghosts) query = query.or(ghosts);

      const { data } = await query;

      if (data && data.length >= 30) {
        const items = data.map(this.mapDbItemToMediaItem);
        await CacheStore.set(cacheKey, items, CACHE_TTL_SECONDS);
        return items;
      }
    } catch {}

    // Sin la columna genres poblada (catálogo recién creado) se repite sin filtros.
    try {
      const { data } = await supabase
        .from('media_items')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(limit);

      if (data && data.length >= 30) {
        const items = data.map(this.mapDbItemToMediaItem);
        await CacheStore.set(cacheKey, items, CACHE_TTL_SECONDS);
        return items;
      }
    } catch {}

    const fallback = await this.getAll();
    if (fallback.length > 0) {
      await CacheStore.set(cacheKey, fallback, CACHE_TTL_SECONDS);
    }
    return fallback;
  }

  /**
   * Consulta de UNA fila del home resuelta en Postgres.
   *
   * A partir de unos pocos miles de fichas ya no sirve filtrar un pool común en memoria:
   * "las N más recientes" son en realidad "las N últimas que escribió el crawl", así que
   * categorías enteras (anime, documentales…) quedaban fuera por puro orden de escritura.
   * Cada carrusel pide lo suyo con los índices de la migración 004.
   */
  static async queryRow(spec: {
    type?: ContentType;
    /** Basta con que la ficha tenga UNO de estos géneros (cubre las variantes de TMDB). */
    genres?: string[];
    /** Valor exacto dentro de subcategories (p. ej. 'Anime'). */
    subcategory?: string;
    minRating?: number;
    /** Estrenos anteriores a este año (clásicos). */
    beforeYear?: number;
    order?: 'recent' | 'rating';
    limit?: number;
  }): Promise<MediaItem[]> {
    const limit = Math.max(1, Math.min(spec.limit || 60, 200));

    try {
      let query = supabase
        .from('media_items')
        .select('*')
        .not('poster', 'is', null)
        .not('genres', 'eq', '{}');

      // Los carruseles del home no anuncian títulos que ya sabemos que no se reproducen.
      const ghosts = await this.ghostFilter();
      if (ghosts) query = query.or(ghosts);

      if (spec.type) query = query.eq('type', spec.type);
      if (spec.genres && spec.genres.length > 0) query = query.overlaps('genres', spec.genres);
      if (spec.subcategory) query = query.contains('subcategories', [spec.subcategory]);
      if (spec.minRating) query = query.gte('rating', spec.minRating);
      if (spec.beforeYear) {
        // release_date es texto ('2009-05-01' o '2009'): la comparación lexicográfica
        // funciona con ambos formatos mientras se acote por abajo para excluir los vacíos.
        query = query.gte('release_date', '1900').lt('release_date', String(spec.beforeYear));
      }

      query = spec.order === 'recent'
        ? query.order('updated_at', { ascending: false })
        : query.order('rating', { ascending: false, nullsFirst: false });

      const { data, error } = await query.limit(limit);
      if (error || !data) return [];
      return data.map(this.mapDbItemToMediaItem);
    } catch {
      return [];
    }
  }

  /**
   * Listado paginado DIRECTO en Postgres (tipo + género + rango), con total exacto.
   * Habilita el "ver todo" de cada fila del home y el scroll infinito sin traer el
   * catálogo entero a memoria. Devuelve null si la DB no está poblada o la consulta
   * falla, para que el llamador caiga al filtrado en memoria de siempre.
   */
  static async discoverPaged(
    page: number,
    limit: number,
    type?: string,
    genre?: string
  ): Promise<{ items: MediaItem[]; total: number } | null> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const from = Math.max(0, (Math.max(1, page) - 1) * safeLimit);

    try {
      let query = supabase
        .from('media_items')
        .select('*', { count: 'exact' })
        .order('updated_at', { ascending: false })
        .range(from, from + safeLimit - 1);

      // El "ver todo" tampoco debe pasear fichas sin reproducción posible.
      const ghosts = await this.ghostFilter();
      if (ghosts) query = query.or(ghosts);

      if (type) query = query.eq('type', type);
      if (genre) query = query.contains('genres', [genre]);

      const { data, count, error } = await query;
      if (error || !data || data.length === 0) return null;

      return { items: data.map(this.mapDbItemToMediaItem), total: count ?? data.length };
    } catch {
      return null;
    }
  }

  /**
   * Obtiene todos los títulos del homepage en vivo enriquecidos con TMDB
   */
  static async getAll(): Promise<MediaItem[]> {
    const cacheKey = 'all_homepage';
    const cached = await CacheStore.get<MediaItem[]>(cacheKey);
    if (cached) return cached;

    // 0. DB-FIRST: catálogo pre-scrapeado en background (scripts/refreshCatalog.ts).
    //    Si Supabase tiene catálogo suficiente y fresco (< 24h), se sirve directo de la DB
    //    (1 query) en lugar de lanzar 4 scrapes en vivo por cold start.
    try {
      const { data } = await supabase
        .from('media_items')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(200);
      if (data && data.length >= 30) {
        const newest = Date.parse(data[0].updated_at || '') || 0;
        const isFresh = Date.now() - newest < 24 * 60 * 60 * 1000;
        if (isFresh) {
          const dbItems = data.map(this.mapDbItemToMediaItem);
          await CacheStore.set(cacheKey, dbItems, CACHE_TTL_SECONDS);
          return dbItems;
        }
      }
    } catch {}

    // 1. Scraping en vivo (fallback cuando la DB está vacía o desactualizada)
    const [homepageItems, latestMovies, latestSeries, latestAnimes] = await Promise.all([
      RealScraperService.scrapeHomepage(),
      RealScraperService.scrapeLatest('peliculas', 60),
      RealScraperService.scrapeLatest('series', 60),
      RealScraperService.scrapeLatest('animes', 60)
    ]);

    const liveItems = this.dedupeById([
      ...homepageItems,
      ...latestMovies,
      ...latestSeries,
      ...latestAnimes
    ]);

    if (liveItems.length > 0) {
      const enrichedList: MediaItem[] = [];
      for (const item of liveItems) {
        enrichedList.push(await TmdbService.enrichMediaItem(item));
      }
      await CacheStore.set(cacheKey, enrichedList, CACHE_TTL_SECONDS);
      return enrichedList;
    }

    // 2. Último recurso: lo que haya en Supabase aunque esté desactualizado
    try {
      const { data } = await supabase.from('media_items').select('*').limit(50);
      if (data && data.length > 0) {
        const dbItems = data.map(this.mapDbItemToMediaItem);
        const enrichedList: MediaItem[] = [];
        for (const item of dbItems) {
          enrichedList.push(await TmdbService.enrichMediaItem(item));
        }
        await CacheStore.set(cacheKey, enrichedList, CACHE_TTL_SECONDS);
        return enrichedList;
      }
    } catch (err) {}

    return [];
  }

  /** Clave de caché estable para un id + pista de tipo. */
  private static cacheKeyFor(q: string, typeHint?: ContentType): string {
    return typeHint ? `${q}:${typeHint}` : q;
  }

  /**
   * Guarda un ítem bajo TODAS las formas de id con las que puede volver a pedirse
   * (id de la fuente, tmdb_id, con y sin tipo), para que la segunda visita sea gratis.
   */
  private static async cacheItem(prefix: 'meta' | 'byid', cacheKey: string, item: MediaItem, ttl: number): Promise<void> {
    const keys = new Set<string>([cacheKey, item.id, `${item.id}:${item.type}`]);
    if (item.tmdb_id) {
      keys.add(String(item.tmdb_id));
      keys.add(`${item.tmdb_id}:${item.type}`);
    }
    await Promise.all(Array.from(keys).filter(Boolean).map(k => CacheStore.set(`${prefix}:${k}`, item, ttl)));
  }

  /** ¿La ficha de la DB ya trae metadata utilizable, o hay que pasarla por TMDB? */
  private static isMetadataComplete(item: MediaItem): boolean {
    return Boolean(item.title && item.poster && item.overview && item.overview.length > 20);
  }

  /** ¿Los enlaces persistidos siguen siendo válidos (menos de 24 h)? */
  private static hasFreshStreams(item: MediaItem): boolean {
    if (!item.servers || item.servers.length === 0) return false;
    if (!item.streams_updated_at) return false;
    const ts = Date.parse(item.streams_updated_at);
    return Number.isFinite(ts) && Date.now() - ts < STREAMS_FRESH_MS;
  }

  /**
   * Escribe de vuelta en Supabase los enlaces recién resueltos (write-through). Se llama en
   * fire-and-forget: NUNCA debe retrasar ni tumbar la respuesta. Si la migración 004 aún no
   * se ejecutó, el update falla en silencio y todo sigue funcionando desde el caché.
   *
   * `verified` marca que la resolución fue EXHAUSTIVA (fusión multifuente incluida), lo
   * único que autoriza a anotar un veredicto de disponibilidad: que un camino barato no
   * encuentre enlaces no significa que la ficha sea un fantasma.
   */
  private static async persistStreams(item: MediaItem, verified: boolean = false): Promise<void> {
    if (!item.id) return;

    const hasServers = Boolean(item.servers && item.servers.length > 0);
    const update: Record<string, unknown> = {
      servers: item.servers || [],
      seasons: item.seasons || [],
      source_url: item._source_url || null,
      streams_updated_at: new Date().toISOString()
    };
    if (verified) {
      update.has_streams = hasServers || this.hasEpisodeServers(item);
      update.streams_checked_at = new Date().toISOString();
    }
    if (item._source_urls && item._source_urls.length > 0) {
      update.source_urls = item._source_urls;
    }

    try {
      const { error } = await getSupabaseAdmin().from('media_items').update(update).eq('id', item.id);
      if (!error) return;
    } catch {}

    // Sin la migración 005 las columnas nuevas no existen y el update entero se rechaza:
    // se reintenta con el conjunto de campos de la 004 para no perder los enlaces.
    try {
      delete update.has_streams;
      delete update.streams_checked_at;
      delete update.source_urls;
      await getSupabaseAdmin().from('media_items').update(update).eq('id', item.id);
    } catch {}
  }

  /** ¿Algún episodio de la serie tiene enlaces propios? (una serie se reproduce por episodio). */
  private static hasEpisodeServers(item: MediaItem): boolean {
    return (item.seasons || []).some(season =>
      (season.episodes || []).some(ep => (ep.servers || []).length > 0)
    );
  }

  /** Copia pública de un ítem: elimina los campos internos (`_source_url`, `_tioplus_url`). */
  static toPublicItem<T extends Record<string, any>>(item: T): T {
    const { _source_url, _source_urls, _tioplus_url, ...rest } = item as any;
    return rest as T;
  }

  /**
   * Obtiene un título por ID/Slug CON los enlaces ya resueltos. Es la composición de los
   * dos caminos: metadata instantánea + resolución de servidores. Se conserva para los
   * clientes que quieren todo en una sola respuesta (`?streams=wait`) y para usos internos.
   */
  static async getById(id: string, typeHint?: ContentType): Promise<MediaItem | null> {
    return this.getStreams(id, typeHint);
  }

  /**
   * CAMINO RÁPIDO — metadata sin resolver enlaces (lo que necesita la ficha emergente).
   *
   * Orden: caché → Supabase (tolerante a cualquier forma de id) → fuentes en vivo.
   * No hace búsquedas por título en las fuentes ni fusión multifuente: eso es lo que
   * convertía cada apertura de popup en varios segundos de scraping. El resultado se
   * cachea SIEMPRE (antes solo se guardaba si traía servidores, así que los títulos
   * sin enlaces se re-scrapeaban en cada request).
   */
  static async getMetadata(id: string, typeHint?: ContentType): Promise<MediaItem | null> {
    const q = id.toLowerCase().trim();
    if (!q) return null;
    const cacheKey = this.cacheKeyFor(q, typeHint);

    // Un detalle completo ya caliente sirve también como metadata.
    const full = await CacheStore.get<MediaItem>(`byid:${cacheKey}`);
    if (full) return full;

    const cached = await CacheStore.get<MediaItem>(`meta:${cacheKey}`);
    if (cached) return cached;

    let result: MediaItem | null = null;

    // 1. DB-FIRST: el catálogo pre-scrapeado ya trae la ficha completa (job de refresh).
    //    Solo se acepta directamente si la coincidencia es inequívoca; una parcial se
    //    guarda como red de seguridad para el paso 3.
    const dbMatch = await this.findDbRowScored(q, typeHint);
    const fromDbRow = async (row: any): Promise<MediaItem> => {
      const mapped = this.mapDbItemToMediaItem(row);
      return this.isMetadataComplete(mapped)
        ? mapped
        : await TmdbService.enrichMediaItem(mapped, { skipSeasons: true });
    };

    if (dbMatch && dbMatch.score >= CatalogService.DB_MATCH_CONFIDENT) {
      result = await fromDbRow(dbMatch.row);
    }

    // 2. Fuera de la DB: resolver contra TMDB / las fuentes reales.
    if (!result) {
      result = await this.resolveMetadataLive(q, typeHint);
    }

    // 3. Ni la DB ni las fuentes en vivo dieron una ficha exacta: se usa la mejor
    //    coincidencia parcial de la DB antes que devolver 404.
    if (!result && dbMatch) {
      result = await fromDbRow(dbMatch.row);
    }

    if (!result) return null;

    // 3. Temporadas de series (desde la DB si están persistidas, si no desde TMDB).
    await this.ensureSeasons(result);
    this.inheritServersToEpisodes(result);

    await this.cacheItem('meta', cacheKey, result, METADATA_TTL_SECONDS);
    return result;
  }

  /**
   * Resolución de metadata contra TMDB y las fuentes reales, para ids que NO están en la DB.
   */
  private static async resolveMetadataLive(q: string, typeHint?: ContentType): Promise<MediaItem | null> {
    let result: MediaItem | null = null;

    // 0. Si el ID es numérico (ID oficial de TMDB), consultar primero DB/Caché y luego TMDB
    if (!isNaN(Number(q))) {
      const tmdbNumericId = Number(q);

      // Verificación directa en Supabase DB (ultra rápido sub-30ms)
      try {
        const { data: dbData } = await supabase
          .from('media_items')
          .select('*')
          .or(`tmdb_id.eq.${tmdbNumericId},id.eq.${q}`)
          .single();

        if (dbData) {
          result = await TmdbService.enrichMediaItem(this.mapDbItemToMediaItem(dbData));
        }
      } catch (err) {}

      if (!result) {
        const [tmdbMovieData, tmdbTvData] = await Promise.all([
          TmdbService.getTmdbDetails(tmdbNumericId, 'movie'),
          TmdbService.getTmdbDetails(tmdbNumericId, 'tvseries')
        ]);

        let tmdbData: any = null;
        let contentType: ContentType = 'movie';

        if (tmdbMovieData && !tmdbTvData) {
          tmdbData = tmdbMovieData;
          contentType = 'movie';
        } else if (!tmdbMovieData && tmdbTvData) {
          tmdbData = tmdbTvData;
          contentType = 'tvseries';
        } else if (tmdbMovieData && tmdbTvData) {
          const movieVotes = tmdbMovieData.vote_count || 0;
          const tvVotes = tmdbTvData.vote_count || 0;

          const tvTitle = tmdbTvData.name || tmdbTvData.original_name || '';
          const movieTitle = tmdbMovieData.title || tmdbMovieData.original_title || '';

          if (typeHint === 'tvseries') {
            tmdbData = tmdbTvData;
            contentType = 'tvseries';
          } else if (typeHint === 'movie') {
            tmdbData = tmdbMovieData;
            contentType = 'movie';
          } else {
            const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").trim();
            const tvNorm = norm(tvTitle);
            const movieNorm = norm(movieTitle);

            const [tvSearch, movieSearch] = await Promise.all([
              this.search(tvTitle).catch(() => []),
              this.search(movieTitle).catch(() => [])
            ]);

            const tvMatch = tvSearch.some(r => r.tmdb_id === tmdbNumericId || norm(r.title) === tvNorm);
            const movieMatch = movieSearch.some(r => r.tmdb_id === tmdbNumericId || norm(r.title) === movieNorm);

            if (movieMatch && !tvMatch) {
              tmdbData = tmdbMovieData;
              contentType = 'movie';
            } else {
              tmdbData = tmdbTvData;
              contentType = 'tvseries';
            }
          }
        }

        if (tmdbData) {
          const title = tmdbData.title || tmdbData.name;

          // Búsqueda con timeout estricto de 1.5s para no congelar la respuesta del cliente
          const timeoutPromise = new Promise<MediaItem[]>((resolve) => setTimeout(() => resolve([]), 1500));
          const searchResults = await Promise.race([this.search(title), timeoutPromise]);

          const getCanonicalKey = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").trim();
          const targetKey = getCanonicalKey(title);
          const match = searchResults.find(r => r.tmdb_id === tmdbNumericId || getCanonicalKey(r.title) === targetKey);

          if (match) {
            result = await TmdbService.enrichMediaItem(match);
          } else {
            // Construcción directa e instantánea desde metadatos TMDB (preservando ID y título exactos)
            result = await TmdbService.enrichMediaItem({
              id: String(tmdbData.id),
              tmdb_id: tmdbData.id,
              imdb_id: null,
              type: contentType,
              title: tmdbData.title || tmdbData.name,
              original_title: tmdbData.original_title || tmdbData.original_name,
              aliases: [tmdbData.title || tmdbData.name],
              tagline: tmdbData.tagline || '',
              overview: tmdbData.overview || '',
              rating: tmdbData.vote_average ? Number(tmdbData.vote_average.toFixed(1)) : 0,
              content_rating: 'PG-13',
              release_date: tmdbData.release_date || tmdbData.first_air_date || '',
              genres: tmdbData.genres?.map((g: any) => g.name) || [],
              subcategories: ['Latino HD'],
              poster: tmdbData.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}` : null,
              backdrop: tmdbData.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tmdbData.backdrop_path}` : null,
              logo: null,
              trailer: null,
              cast: [],
              dubbing_cast: [],
              servers: []
            });

          }
        }
      }
    }

    // 1-2. Resolver el slug contra las fuentes reales (FuegoCine y TioPlus).
    if (!result) {
      const fromSource = await this.resolveFromSource(q);
      if (fromSource) result = await TmdbService.enrichMediaItem(fromSource);
    }

    // 3. Buscar por texto o TMDB ID de forma inteligente con filtro estricto de título / slug / alias.
    //    El término se des-sluguifica ("madagascar-3-los-fugitivos" → "madagascar 3 los fugitivos")
    //    porque la búsqueda opera sobre títulos, no sobre slugs con guiones.
    if (!result) {
      const scraped = await this.search(q.replace(/-/g, ' ').trim());
      if (scraped.length > 0) {
        const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").trim();
        const targetNorm = norm(q);
        const match = scraped.find(r => r.id === q || String(r.tmdb_id) === q || norm(r.title) === targetNorm || (r.aliases && r.aliases.some(a => norm(a) === targetNorm)));
        if (match) {
          result = match;
        }
      }
    }

    return result;
  }

  /**
   * Garantía de temporadas para series: si la ficha no las trae (ni de la DB ni de la
   * fuente), se reconstruyen desde TMDB. Las llamadas por temporada ya van en paralelo
   * dentro de getTmdbSeasons.
   */
  private static async ensureSeasons(item: MediaItem): Promise<void> {
    const isSeries = item.type === 'tvseries' || (item.total_seasons != null && item.total_seasons > 0);
    if (!isSeries || (item.seasons && item.seasons.length > 0)) return;

    const tmdbId = item.tmdb_id || Number(item.id);
    if (!tmdbId || tmdbId <= 0) return;

    try {
      item.seasons = await TmdbService.getTmdbSeasons(tmdbId, item.total_seasons || 1, item.poster, item.servers || []);
    } catch {}
  }

  /** scrapeDetail con techo de latencia: una fuente lenta no puede bloquear la respuesta. */
  private static async scrapeDetailWithTimeout(url: string, ms: number = 2500): Promise<MediaItem | null> {
    const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), ms));
    return Promise.race([RealScraperService.scrapeDetail(url).catch(() => null), timeout]);
  }

  /**
   * CAMINO DE ENLACES — resuelve los servidores reproducibles de un título.
   *
   * Se pide aparte de la metadata (GET /api/v1/media/:id/streams), normalmente cuando el
   * usuario pulsa Reproducir, por lo que la ficha ya está pintada mientras esto ocurre.
   * Orden de coste creciente:
   *   A. Enlaces persistidos en Supabase con menos de 24 h → 0 scrapes.
   *   B. `source_url` de la fila → UN solo scrapeDetail contra la URL exacta.
   *   C. Fusión multifuente (búsqueda por título en tioplus + fuegocine) — el camino
   *      histórico, ahora reservado para cuando A y B no dan enlaces o se pide `deep`.
   * Lo resuelto se escribe de vuelta en la DB para que la próxima apertura sea instantánea.
   *
   * `cheap` corta en B: sirve para que el DETALLE pueda intentar traer los enlaces en la
   * misma respuesta sin arriesgar la latencia de la fusión multifuente.
   */
  static async getStreams(id: string, typeHint?: ContentType, opts: { deep?: boolean; cheap?: boolean } = {}): Promise<MediaItem | null> {
    const q = id.toLowerCase().trim();
    if (!q) return null;
    const cacheKey = this.cacheKeyFor(q, typeHint);

    const cached = await CacheStore.get<MediaItem>(`byid:${cacheKey}`);
    if (cached && !opts.deep) return cached;

    const result = await this.getMetadata(q, typeHint);
    if (!result) return null;

    // A. Enlaces persistidos y frescos: nada que scrapear.
    if (!opts.deep && this.hasFreshStreams(result)) {
      await this.cacheItem('byid', cacheKey, result, CACHE_TTL_SECONDS);
      return result;
    }

    const allServers: ServerOption[] = [...(result.servers || [])];
    const existingUrls = new Set(allServers.map(s => s.embed_url));
    const addServers = (servers?: ServerOption[] | null) => {
      for (const s of servers || []) {
        if (s && !existingUrls.has(s.embed_url)) {
          allServers.push(s);
          existingUrls.add(s.embed_url);
        }
      }
    };
    const adoptSeasons = (seasons?: any[] | null) => {
      if (seasons && seasons.length > 0 && (!result.seasons || result.seasons.length === 0)) {
        result.seasons = seasons;
      }
    };

    // Todas las páginas de origen conocidas de esta ficha. Cuando la misma película existe
    // en TioPlus y en FuegoCine, el catálogo la guarda UNA sola vez (tmdb_id es UNIQUE)
    // pero con las dos URLs: hay que visitarlas TODAS o los servidores de la fuente
    // absorbida no aparecen nunca. Ver migración 005.
    const knownSources = new Set<string>(
      [...(result._source_urls || []), result._source_url].filter((u): u is string => Boolean(u))
    );

    // B. URLs exactas de las fuentes (persistidas por el job): un detalle por fuente,
    //    en paralelo y sin búsqueda por título.
    if (knownSources.size > 0) {
      const details = await Promise.all(
        Array.from(knownSources).slice(0, 4).map(u => this.scrapeDetailWithTimeout(u))
      );
      for (const detail of details) {
        addServers(detail?.servers);
        adoptSeasons(detail?.seasons);
      }
    }

    // B-bis. Sin source_url: el id de la fila SÍ resuelve por categoría contra la fuente.
    if (allServers.length === 0) {
      const fromSource = await this.resolveFromSource(result.id);
      addServers(fromSource?.servers);
      adoptSeasons(fromSource?.seasons);
    }

    // C. Fusión multifuente (TioPlus + FuegoCine) por título. Es el camino caro: solo cuando
    //    no hemos conseguido enlaces por las vías baratas, o cuando se pide explícitamente
    //    (`deep`, que usa el job de pre-calentado para dejar el set completo en la DB).
    //    Es también el ÚNICO camino lo bastante exhaustivo como para concluir que una ficha
    //    no tiene enlaces en ninguna parte (ver `exhaustive` más abajo).
    const exhaustive = (allServers.length === 0 && !opts.cheap) || Boolean(opts.deep);
    if (exhaustive) {
      const targetStrict = strictKey(result.title);
      const targetCanonical = canonicalTitleKey(result.title);

      const matchesTarget = (it: MediaItem) =>
        (!!it.tmdb_id && !!result.tmdb_id && it.tmdb_id === result.tmdb_id) ||
        strictKey(it.title) === targetStrict ||
        (!!targetCanonical && canonicalTitleKey(it.title) === targetCanonical);

      // Candidatos por título de AMBAS fuentes (scrapeRealMovies itera tioplus + fuegocine).
      const candidates = await RealScraperService.scrapeRealMovies(result.title, 8).catch(() => [] as MediaItem[]);

      const sourceUrls: string[] = [];
      for (const cand of candidates) {
        if (!matchesTarget(cand)) continue;
        const url = (cand as any)._tioplus_url;
        if (url && !sourceUrls.includes(url)) sourceUrls.push(url);
        addServers(cand.servers);
        adoptSeasons(cand.seasons);
      }

      // Detalle (servidores) de cada URL de fuente en paralelo, con timeout acotado.
      const details = await Promise.all(sourceUrls.slice(0, 4).map(u => this.scrapeDetailWithTimeout(u)));
      for (const detail of details) {
        addServers(detail?.servers);
        adoptSeasons(detail?.seasons);
      }

      // Guardamos TODAS las URLs descubiertas, no solo la primera: son las fuentes que
      // aportan servidores a esta misma ficha, y la próxima resolución las reutiliza sin
      // volver a buscar por título.
      for (const url of sourceUrls) knownSources.add(url);
      if (!result._source_url && sourceUrls.length > 0) {
        result._source_url = sourceUrls[0];
      }
    }

    result._source_urls = Array.from(knownSources);

    // D. Serie sin servidores → resolver activamente S1:E1.
    const isSeries = result.type === 'tvseries' || (result.total_seasons != null && result.total_seasons > 0);
    if (isSeries && allServers.length === 0 && !opts.cheap) {
      try {
        const titleSlug = normalizeTitle(result.title || '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const ep1Detail = await RealScraperService.scrapeEpisodeDetail(titleSlug, 1, 1);
        addServers(ep1Detail?.servers);
      } catch {}
    }

    result.servers = sortServersBySourcePriority(allServers);
    if (result.servers.length > 0) {
      result.primary_stream = getPrimaryStream(result.servers);
      result.streams_updated_at = new Date().toISOString();
    }

    await this.ensureSeasons(result);
    this.inheritServersToEpisodes(result);

    // Veredicto de disponibilidad: solo una resolución EXHAUSTIVA puede concluir que una
    // ficha no tiene enlaces en ninguna fuente. Es lo que permite dejar de anunciar en el
    // home y en la búsqueda títulos que nunca podrán reproducirse (fichas fantasma).
    if (exhaustive) {
      result.has_streams = result.servers.length > 0 || this.hasEpisodeServers(result);
      result.streams_checked_at = new Date().toISOString();
    }

    if (result.servers.length > 0 || (result.seasons && result.seasons.length > 0)) {
      await this.cacheItem('byid', cacheKey, result, CACHE_TTL_SECONDS);
      if (result.servers.length > 0) {
        // Coherencia de caché: la ficha ya cacheada como metadata (TTL de 6 h) se escribió
        // ANTES de resolver los enlaces, con `servers: []`. Sin refrescarla aquí, el detalle
        // seguía anunciando `streams.status: "pending"` durante horas para un título cuyos
        // servidores ya conocemos.
        await this.cacheItem('meta', cacheKey, result, METADATA_TTL_SECONDS);
      }
    }

    // Write-through: la próxima apertura (incluso desde otra lambda) sale de la DB. Se
    // escribe TAMBIÉN cuando la búsqueda exhaustiva terminó sin enlaces: es justo ese
    // resultado negativo el que marca la ficha como fantasma, y sin guardarlo la API
    // repetiría la fusión multifuente completa en cada petición del mismo título.
    if (result.servers.length > 0 || exhaustive) {
      void this.persistStreams(result, exhaustive).catch(() => {});
    }

    return result;
  }

  /**
   * Búsqueda en vivo con Caché en Memoria, Web Scraping y Unificación
   * Implementa ponderación por título, búsqueda por prefijos y ordenamiento por relevancia
   */
  /**
   * Pase local de PREFIJO sobre Supabase: ilike 'q%' con acentos normalizados.
   * Usa la columna title_normalized (migración 001, índice text_pattern_ops => milisegundos)
   * y cae a title si la columna aún no existe. Nunca lanza: si la DB no está poblada
   * simplemente aporta 0 candidatos y la búsqueda sigue dependiendo del scraping.
   */
  private static async searchDbByPrefix(query: string, limit: number = 30): Promise<MediaItem[]> {
    const nq = normalizeTitle(query).trim();
    if (!nq) return [];
    try {
      const { data, error } = await supabase
        .from('media_items')
        .select('*')
        .ilike('title_normalized', `${nq}%`)
        .limit(limit);
      // Si la columna existe (sin error), confiar en su resultado aunque venga vacío.
      if (!error) return (data || []).map(this.mapDbItemToMediaItem);
    } catch {}
    try {
      // Fallback: la columna title_normalized aún no existe en esta DB.
      const { data } = await supabase
        .from('media_items')
        .select('*')
        .ilike('title', `${nq}%`)
        .limit(limit);
      return (data || []).map(this.mapDbItemToMediaItem);
    } catch {}
    return [];
  }

  /**
   * Búsqueda pública (compat): devuelve solo la primera página de ítems.
   * Callers internos (getById) y scripts de dev siguen usando esta firma.
   */
  static async search(query: string, maxResults: number = 25): Promise<MediaItem[]> {
    const { items } = await this.searchPaged(query, 1, maxResults);
    return items;
  }

  /**
   * Búsqueda paginada DB-FIRST con total exacto (habilita el scroll infinito).
   *  - Catálogo poblado: sirve del RPC `search_media` (substring + prefijo, rankeado,
   *    con COUNT total) en milisegundos, SIN scraping ni TMDB en el request.
   *  - DB vacía / sin migrar: cae a un scrape en vivo LEAN (sin enriquecer ni resolver
   *    servidores por ítem) y pagina en memoria.
   */
  static async searchPaged(query: string, page: number = 1, limit: number = 25): Promise<{ items: MediaItem[]; total: number }> {
    const q = query.toLowerCase().trim();
    if (!q) return { items: [], total: 0 };

    const nq = normalizeTitle(q).trim();
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const safePage = Math.max(1, page);
    const offset = (safePage - 1) * safeLimit;

    const cacheKey = `searchp:${nq}:${safePage}:${safeLimit}`;
    const cached = await CacheStore.get<{ items: MediaItem[]; total: number }>(cacheKey);
    if (cached) return cached;

    // 1. DB-FIRST: RPC rankeado sobre el catálogo poblado (prefijo-primero + rating).
    const dbResult = await this.searchDbPaged(nq, safeLimit, offset);
    if (dbResult && dbResult.total > 0) {
      await CacheStore.set(cacheKey, dbResult, CACHE_TTL_SECONDS);
      return dbResult;
    }

    // 2. FALLBACK: DB vacía o RPC ausente → scrape en vivo LEAN, paginado en memoria.
    const pool = await this.liveSearch(q, 150);
    const ranked = this.scoreAndSortResults(pool, q);
    const out = { items: ranked.slice(offset, offset + safeLimit), total: ranked.length };
    await CacheStore.set(cacheKey, out, CACHE_TTL_SECONDS);
    return out;
  }

  /**
   * Pase DB paginado vía RPC `search_media(q, lim, off)` (migración 002). Devuelve null
   * si el RPC no existe (DB sin migrar) o no hay coincidencias, para caer al scrape en vivo.
   */
  private static async searchDbPaged(nq: string, limit: number, offset: number): Promise<{ items: MediaItem[]; total: number } | null> {
    if (!nq) return null;
    try {
      const { data, error } = await supabase.rpc('search_media', { q: nq, lim: limit, off: offset });
      if (error || !data || (data as any[]).length === 0) return null;
      const rows = data as any[];
      const total = Number(rows[0].total) || rows.length;
      const items = rows.map(row => this.mapDbItemToMediaItem(row.item));
      return { items, total };
    } catch {
      return null;
    }
  }

  /**
   * Scrape en vivo LEAN para el fallback de búsqueda: une fuentes activas + pase de prefijo
   * en DB + substring del catálogo homepage, y agrupa SIN enriquecer con TMDB ni resolver
   * servidores por ítem (eso encarecía cada búsqueda). Ver unifyForSearch.
   */
  private static async liveSearch(q: string, max: number): Promise<MediaItem[]> {
    const normalizedMax = Math.max(1, max);
    const [realScraped, dbPrefixMatches] = await Promise.all([
      RealScraperService.scrapeRealMovies(q, normalizedMax),
      this.searchDbByPrefix(q)
    ]);
    const pool = [...realScraped, ...dbPrefixMatches];

    if (pool.length < normalizedMax) {
      // Substring insensible a acentos sobre el catálogo homepage (aporta 0 si está vacío).
      const nq = normalizeTitle(q);
      const catalogMatches = (await this.getAll()).filter(item => {
        const haystack = normalizeTitle([item.title, item.original_title, ...(item.aliases || [])].join(' '));
        return haystack.includes(nq);
      });
      pool.push(...catalogMatches);
    }

    return this.unifyForSearch(pool, normalizedMax);
  }
  /**
   * Calcula el score de relevancia para cada resultado y ordena por puntaje descendente
   * Ponderación (Relevance Scoring) - PRIORIDAD AL TÍTULO VISIBLE QUE COMIENZA CON EL TÉRMINO:
   *   - Peso 200: El título visible (title) COMIENZA con la frase completa buscada (ej: "el c" -> "El Chavo", "El Calabozo")
   *   - Peso 150: Coincidencia EXACTA completa en title (título completo igual al query)
   *   - Peso 120: El título visible COMIENZA con la primera palabra del query
   *   - Peso 100: El título original (original_title) COMIENZA con la frase completa
   *   - Peso 80: Coincidencia exacta de palabra completa en original_title
   *   - Peso 50: Contiene la palabra completa en title u original_title
   *   - Peso 10: Coincidencia por prefijo débil
   *   - Peso 1: Coincidencia en overview/sinopsis o aliases
   */
  private static scoreAndSortResults(items: MediaItem[], query: string): MediaItem[] {
    const queryLower = query.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 0);

    const scored = items.map(item => {
      let score = 0;

      const titleLower = (item.title || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const originalTitleLower = (item.original_title || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const overviewLower = (item.overview || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const aliasesLower = (item.aliases || []).map(a => a.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));

      // --- PRIORIDAD MÁXIMA: El título visible COMIENZA con la frase completa buscada ---
      // Ej: Busca "el c" -> Match máximo para "El Chavo", "El Calabozo", "El Chavo Animado"
      if (titleLower.startsWith(queryLower)) {
        score = 200;
      }
      // --- PRIORIDAD MUY ALTA: Título visible comienza con la primera palabra del query ---
      else if (queryWords.length > 0 && titleLower.startsWith(queryWords[0])) {
        score = 120;
      }
      // --- PRIORIDAD MEDIA-ALTA: Título original comienza con la frase completa ---
      else if (originalTitleLower.startsWith(queryLower)) {
        score = 100;
      }
      // --- PRIORIDAD MEDIA: Coincidencia exacta en original_title ---
      else if (originalTitleLower === queryLower) {
        score = 80;
      }

      // Si ya tiene score alto por prefix match, no necesitamos sumar más
      if (score >= 100) {
        // Bonus pequeño por rating como desempate
        const popularityBonus = (item.rating || 0) / 1000;
        return { item, score: score + popularityBonus };
      }

      // Coincidencias por palabra (acumulativas) para el resto de candidatos.
      // Usa conjuntos de palabras en vez de RegExp dinámico (evita el bug de escape
      // y el SyntaxError con queries que contienen metacaracteres como "(").
      const titleWords = new Set(titleLower.split(/\s+/));
      const originalWords = new Set(originalTitleLower.split(/\s+/));
      for (const word of queryWords) {
        if (word.length < 2) continue;
        if (titleWords.has(word)) score += 50;             // palabra completa en title
        else if (originalWords.has(word)) score += 40;     // palabra completa en original_title
        else if (titleLower.includes(word)) score += 10;   // substring en title
        else if (originalTitleLower.includes(word)) score += 8;
        else if (aliasesLower.some(a => a.includes(word))) score += 2;
        else if (overviewLower.includes(word)) score += 1;
      }

      // Sin relevancia textual no se muestra (el rating por sí solo no basta para aparecer).
      if (score <= 0) return { item, score: 0 };
      // Desempate por rating, acotado a <= 0.01 para no cruzar de nivel.
      const popularityBonus = Math.min(Math.max(item.rating || 0, 0), 10) / 1000;

      return { item, score: score + popularityBonus };
    });

    // Ordenar por score descendente
    scored.sort((a, b) => b.score - a.score);

    // Filtrar solo items con score > 0 (que tengan alguna relevancia)
    return scored.filter(s => s.score > 0).map(s => s.item);
  }
  /**
   * Agrupa/dedup ítems de BÚSQUEDA por clave canónica (o tmdb_id si ya viene resuelto),
   * fusionando metadatos básicos. NO enriquece con TMDB ni resuelve servidores por ítem:
   * la búsqueda debe ser ultraligera (sin cast ni reproductores). El detalle completo
   * (servidores multifuente, temporadas, cast) se resuelve bajo demanda en getById.
   */
  private static unifyForSearch(items: MediaItem[], maxResults: number = 25): MediaItem[] {
    const grouped = new Map<string, MediaItem>();

    for (const item of items) {
      const key = (item.tmdb_id && item.tmdb_id > 0)
        ? `${item.type}:${item.tmdb_id}`
        : (canonicalTitleKey(item.title) || strictKey(item.title) || item.id);
      if (!key) continue;

      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, { ...item });
      } else {
        existing.overview = existing.overview || item.overview;
        existing.poster = existing.poster || item.poster;
        existing.backdrop = existing.backdrop || item.backdrop;
        existing.release_date = existing.release_date || item.release_date;
        existing.rating = existing.rating || item.rating;
        existing.subcategories = Array.from(new Set([...(existing.subcategories || []), ...(item.subcategories || [])]));
        existing.aliases = Array.from(new Set([...(existing.aliases || []), ...(item.aliases || [])]));
      }
    }

    return Array.from(grouped.values()).slice(0, maxResults);
  }

  private static mapDbItemToMediaItem(dbRow: any): MediaItem {
    // El id de la fila ES el slug de la fuente (tioplus/fuegocine): el ÚNICO valor con el que
    // getById puede volver a resolver el detalle y los servidores. Derivarlo del título
    // ("Madagascar 3: Los Fugitivos" → "madagascar-3-los-fugitivos") devolvía en la búsqueda
    // un id que no existía en ninguna fuente y el detalle respondía 404.
    const sourceId = String(dbRow.id || '').trim();
    const titleSlug = slugify(dbRow.slug || dbRow.title || '');

    return {
      id: sourceId || titleSlug || String(dbRow.tmdb_id || ''),
      tmdb_id: dbRow.tmdb_id || 0,
      imdb_id: dbRow.imdb_id || null,
      type: dbRow.type,
      title: dbRow.title,
      original_title: dbRow.original_title || dbRow.title,
      aliases: dbRow.aliases || [dbRow.title],
      tagline: dbRow.tagline || '',
      overview: dbRow.overview || '',
      rating: dbRow.rating || 0.0,
      // Sin dato real preferimos omitirlo: el 'PG-13' fijo que se emitía antes era
      // simplemente falso para la mayoría del catálogo.
      content_rating: dbRow.content_rating || undefined,
      release_date: dbRow.release_date || '',
      genres: dbRow.genres || [],
      subcategories: dbRow.subcategories || [],
      poster: dbRow.poster || null,
      backdrop: dbRow.backdrop || null,
      logo: dbRow.logo || null,
      trailer: dbRow.trailer || null,
      cast: Array.isArray(dbRow.cast_data) ? dbRow.cast_data.map((c: any) => (typeof c === 'string' ? c : (c.name || ''))) : [],
      cast_details: Array.isArray(dbRow.cast_data) && typeof dbRow.cast_data[0] === 'object' ? dbRow.cast_data : undefined,
      dubbing_cast: dbRow.dubbing_cast_data || [],
      runtime: typeof dbRow.runtime === 'number' && dbRow.runtime > 0 ? dbRow.runtime : undefined,
      director: dbRow.director || undefined,
      metadata_source: dbRow.metadata_source === 'source' ? 'source' : 'tmdb',
      total_seasons: dbRow.total_seasons || 0,
      total_episodes: dbRow.total_episodes || 0,
      // Temporadas y enlaces persistidos por el job (migración 004): con ellos el detalle
      // se resuelve sin scraping en vivo.
      seasons: Array.isArray(dbRow.seasons) && dbRow.seasons.length > 0 ? dbRow.seasons : undefined,
      streams_updated_at: dbRow.streams_updated_at || null,
      // `has_streams` es TRI-estado: false ⇒ verificada sin enlaces; null/undefined ⇒ sin
      // comprobar. Traducirlo a booleano con `|| false` borraría justo esa distinción.
      has_streams: typeof dbRow.has_streams === 'boolean' ? dbRow.has_streams : undefined,
      streams_checked_at: dbRow.streams_checked_at || null,
      _source_url: dbRow.source_url || undefined,
      // Migración 005. Sin ella la columna no existe y se degrada a la URL única.
      _source_urls: Array.isArray(dbRow.source_urls) && dbRow.source_urls.length > 0
        ? dbRow.source_urls.filter(Boolean)
        : (dbRow.source_url ? [dbRow.source_url] : []),
      primary_stream: getPrimaryStream((dbRow.servers || []).map((s: any) => ({ ...s, source_id: s.source_id || 'supabase' }))),
      servers: sortServersBySourcePriority((dbRow.servers || []).map((s: any) => ({ ...s, source_id: s.source_id || 'supabase' }))),
    };
  }
}
