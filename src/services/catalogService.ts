import { MediaItem, ServerOption, ContentType } from '../types';
import { supabase } from './supabaseService';
import { RealScraperService } from './realScraperService';
import { TmdbService } from './tmdbService';
import { sortServersBySourcePriority, getPrimaryStream } from './streamSorter';
import { normalizeTitle } from '../utils/text';
import { CacheStore } from '../cache/store';

// TTL del caché de catálogo/búsqueda. Con Redis (KV_REST_API_* / UPSTASH_*) las entradas
// se comparten entre lambdas y sobreviven cold starts; sin Redis degrada a memoria local.
const CACHE_TTL_SECONDS = 10 * 60;

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
   * Consulta múltiples títulos en lote (Batching Request)
   */
  static async getBatch(ids: string[]): Promise<MediaItem[]> {
    const results = await Promise.all(ids.map(id => this.getById(id)));
    return results.filter((item): item is MediaItem => item !== null);
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

  /**
   * Obtiene un título por ID/Slug de forma consistente (Caché ultrarrápida en sub-10ms).
   */
  static async getById(id: string, typeHint?: ContentType): Promise<MediaItem | null> {
    const q = id.toLowerCase().trim();
    const cacheKey = typeHint ? `${q}:${typeHint}` : q;

    // Verificación de caché (compartida entre lambdas si hay Redis)
    const cached = await CacheStore.get<MediaItem>(`byid:${cacheKey}`);
    if (cached) return cached;

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

    // 1. Intentar si es un slug de FuegoCine (ej. 2025-04-spiderman-lejos-de-casa-2019-html)
    if (!result) {
      const fuegocineMatch = q.match(/^(\d{4})-(\d{2})-(.+)-html$/);
      if (fuegocineMatch) {
        const fuegocineUrl = `https://www.fuegocine.com/${fuegocineMatch[1]}/${fuegocineMatch[2]}/${fuegocineMatch[3]}.html`;
        const fcDetail = await RealScraperService.scrapeFuegocineDetail(fuegocineUrl);
        if (fcDetail) {
          result = await TmdbService.enrichMediaItem(fcDetail);
        }
      }
    }

    // 2. Intentar por categorías directas en TioPlus (película, serie, anime, dorama)
    if (!result) {
      const categories = ['pelicula', 'serie', 'anime', 'dorama'];
      for (const cat of categories) {
        const detail = await RealScraperService.scrapeDetail(`https://tioplus.app/${cat}/${q}`);
        if (detail && (detail.servers?.length || detail.seasons?.length)) {
          result = await TmdbService.enrichMediaItem(detail);
          break;
        }
      }
    }

    // 3. Buscar por texto o TMDB ID de forma inteligente con filtro estricto de título / slug / alias
    if (!result) {
      const scraped = await this.search(q);
      if (scraped.length > 0) {
        const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").trim();
        const targetNorm = norm(q);
        const match = scraped.find(r => r.id === q || String(r.tmdb_id) === q || norm(r.title) === targetNorm || (r.aliases && r.aliases.some(a => norm(a) === targetNorm)));
        if (match) {
          result = match;
        }
      }
    }

    // 4. Fallback final a Supabase
    if (!result) {
      try {
        const { data } = await supabase
          .from('media_items')
          .select('*')
          .or(`id.eq.${q},tmdb_id.eq.${isNaN(Number(q)) ? -1 : Number(q)}`)
          .single();

        if (data) result = await TmdbService.enrichMediaItem(this.mapDbItemToMediaItem(data));
      } catch (err) {}
    }

    // 5. Garantía y Fusión Multifuente de Servidores (TioPlus + FuegoCine).
    //    La búsqueda pública es LEAN (sin servidores); aquí resolvemos AMBAS fuentes
    //    directamente. scrapeRealMovies ya devuelve candidatos de tioplus Y fuegocine
    //    (cada uno con su _tioplus_url), y traemos el detalle/servidores de cada uno.
    if (result) {
      const targetStrict = strictKey(result.title);
      const targetCanonical = canonicalTitleKey(result.title);
      const allServers: ServerOption[] = [...(result.servers || [])];
      const existingUrls = new Set(allServers.map(s => s.embed_url));

      const matchesTarget = (it: MediaItem) =>
        (!!it.tmdb_id && !!result!.tmdb_id && it.tmdb_id === result!.tmdb_id) ||
        strictKey(it.title) === targetStrict ||
        (!!targetCanonical && canonicalTitleKey(it.title) === targetCanonical);

      // Candidatos por título de AMBAS fuentes (scrapeRealMovies itera tioplus + fuegocine).
      const candidates = await RealScraperService.scrapeRealMovies(result.title, 8).catch(() => [] as MediaItem[]);

      const sourceUrls: string[] = [];
      for (const cand of candidates) {
        if (!matchesTarget(cand)) continue;
        const url = (cand as any)._tioplus_url;
        if (url && !sourceUrls.includes(url)) sourceUrls.push(url);
        if (cand.servers && cand.servers.length > 0) {
          for (const s of cand.servers) {
            if (!existingUrls.has(s.embed_url)) { allServers.push(s); existingUrls.add(s.embed_url); }
          }
        }
        if (cand.seasons && cand.seasons.length > 0 && (!result.seasons || result.seasons.length === 0)) {
          result.seasons = cand.seasons;
        }
      }

      // Detalle (servidores) de cada URL de fuente en paralelo (tioplus + fuegocine), timeout acotado.
      const details = await Promise.all(sourceUrls.slice(0, 4).map(u => {
        const timeout = new Promise<any>(resolve => setTimeout(() => resolve(null), 2500));
        return Promise.race([RealScraperService.scrapeDetail(u), timeout]);
      }));
      for (const detail of details) {
        if (detail && detail.servers && detail.servers.length > 0) {
          for (const s of detail.servers) {
            if (!existingUrls.has(s.embed_url)) { allServers.push(s); existingUrls.add(s.embed_url); }
          }
        }
        if (detail && detail.seasons && detail.seasons.length > 0 && (!result.seasons || result.seasons.length === 0)) {
          result.seasons = detail.seasons;
        }
      }

      // Serie sin servidores → resolver activamente S1:E1.
      if ((result.type === 'tvseries' || (result.total_seasons && result.total_seasons > 0)) && allServers.length === 0) {
        try {
          const titleSlug = normalizeTitle(result.title || '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const ep1Detail = await RealScraperService.scrapeEpisodeDetail(titleSlug, 1, 1);
          if (ep1Detail && ep1Detail.servers && ep1Detail.servers.length > 0) {
            for (const s of ep1Detail.servers) {
              if (!existingUrls.has(s.embed_url)) { allServers.push(s); existingUrls.add(s.embed_url); }
            }
          }
        } catch {}
      }

      result.servers = sortServersBySourcePriority(allServers);
      if (result.servers.length > 0) {
        result.primary_stream = getPrimaryStream(result.servers);
      }
    }

    // 6. Garantía de Temporadas: Si es una serie (tvseries) y sus temporadas están vacías, poblar desde TMDB
    if (result && (result.type === 'tvseries' || (result.total_seasons && result.total_seasons > 0))) {
      if (!result.seasons || result.seasons.length === 0) {
        const numSeasons = result.total_seasons || 1;
        const tmdbId = result.tmdb_id || Number(result.id);
        if (tmdbId > 0) {
          try {
            result.seasons = await TmdbService.getTmdbSeasons(tmdbId, numSeasons, result.poster, result.servers || []);
          } catch {}
        }
      }
    }

    // 7. Herencia de servidores a la jerarquía de episodios en series
    this.inheritServersToEpisodes(result);

    // ÚNICAMENTE almacenar en caché si se encontraron servidores o temporadas válidas
    if (result && ((result.servers && result.servers.length > 0) || (result.seasons && result.seasons.length > 0))) {
      const keys = [cacheKey, result.id, `${result.id}:${result.type}`];
      if (result.tmdb_id) {
        keys.push(String(result.tmdb_id), `${result.tmdb_id}:${result.type}`);
      }
      await Promise.all(keys.map(k => CacheStore.set(`byid:${k}`, result, CACHE_TTL_SECONDS)));
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
    const canonicalSlug = (dbRow.slug || dbRow.title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || String(dbRow.id);

    return {
      id: canonicalSlug,
      tmdb_id: dbRow.tmdb_id || 0,
      imdb_id: dbRow.imdb_id || null,
      type: dbRow.type,
      title: dbRow.title,
      original_title: dbRow.original_title || dbRow.title,
      aliases: dbRow.aliases || [dbRow.title],
      tagline: dbRow.tagline || '',
      overview: dbRow.overview || '',
      rating: dbRow.rating || 0.0,
      content_rating: dbRow.content_rating || 'PG-13',
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
      total_seasons: dbRow.total_seasons || 0,
      total_episodes: dbRow.total_episodes || 0,
      primary_stream: getPrimaryStream((dbRow.servers || []).map((s: any) => ({ ...s, source_id: s.source_id || 'supabase' }))),
      servers: sortServersBySourcePriority((dbRow.servers || []).map((s: any) => ({ ...s, source_id: s.source_id || 'supabase' }))),
    };
  }
}
