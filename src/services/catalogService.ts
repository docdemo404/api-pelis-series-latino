import { MediaItem, ServerOption, ContentType } from '../types';
import { supabase } from './supabaseService';
import { RealScraperService } from './realScraperService';
import { TmdbService } from './tmdbService';
import { sortServersBySourcePriority, getPrimaryStream } from './streamSorter';

const searchCache = new Map<string, { timestamp: number; data: MediaItem[] }>();
const getByIdCache = new Map<string, { timestamp: number; data: MediaItem }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos de caché en memoria

export class CatalogService {
  /**
   * Limpia toda la caché en memoria de la API
   */
  static clearCache(): void {
    searchCache.clear();
    getByIdCache.clear();
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
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }

    const liveItems = await RealScraperService.scrapeHomepage();
    if (liveItems.length > 0) {
      const enrichedList: MediaItem[] = [];
      for (const item of liveItems) {
        enrichedList.push(await TmdbService.enrichMediaItem(item));
      }
      searchCache.set(cacheKey, { timestamp: Date.now(), data: enrichedList });
      return enrichedList;
    }

    try {
      const { data } = await supabase.from('media_items').select('*').limit(50);
      if (data && data.length > 0) {
        const dbItems = data.map(this.mapDbItemToMediaItem);
        const enrichedList: MediaItem[] = [];
        for (const item of dbItems) {
          enrichedList.push(await TmdbService.enrichMediaItem(item));
        }
        searchCache.set(cacheKey, { timestamp: Date.now(), data: enrichedList });
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

    // Verificación de caché en memoria
    const cached = getByIdCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }

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

            // Disparar resolución de servidores en segundo plano sin bloquear la API
            this.search(title).catch(() => {});
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

    // 5. Garantía y Fusión Multifuente de Servidores (TioPlus + FuegoCine + Supabase DB)
    if (result) {
      const normTitle = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").trim();
      const targetTitleKey = normTitle(result.title);

      const allServers: ServerOption[] = [...(result.servers || [])];
      const existingUrls = new Set(allServers.map(s => s.embed_url));

      // Buscar servidores adicionales en paralelo de TioPlus y FuegoCine
      const searchResults = await this.search(result.title).catch(() => []);
      for (const item of searchResults) {
        if (item.tmdb_id === result.tmdb_id || normTitle(item.title) === targetTitleKey) {
          if (item.servers && item.servers.length > 0) {
            for (const s of item.servers) {
              if (!existingUrls.has(s.embed_url)) {
                allServers.push(s);
                existingUrls.add(s.embed_url);
              }
            }
          }
          if (item.seasons && item.seasons.length > 0 && (!result.seasons || result.seasons.length === 0)) {
            result.seasons = item.seasons;
          }
        }
      }

      // Si es una serie de TV y aún no tiene servidores cargados, resolver activamente los reproductores de S1:E1
      if ((result.type === 'tvseries' || (result.total_seasons && result.total_seasons > 0)) && allServers.length === 0) {
        try {
          const titleSlug = (result.title || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const ep1Detail = await RealScraperService.scrapeEpisodeDetail(titleSlug, 1, 1);
          if (ep1Detail && ep1Detail.servers && ep1Detail.servers.length > 0) {
            for (const s of ep1Detail.servers) {
              if (!existingUrls.has(s.embed_url)) {
                allServers.push(s);
                existingUrls.add(s.embed_url);
              }
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

    // 7. Herencia e inyección de servidores a la jerarquía de episodios en Series
    if (result && result.seasons && result.seasons.length > 0) {
      const activeServers = sortServersBySourcePriority(result.servers || []);
      for (const season of result.seasons) {
        if (season.episodes) {
          for (const ep of season.episodes) {
            ep.servers = sortServersBySourcePriority(ep.servers && ep.servers.length > 0 ? ep.servers : activeServers);
            if (ep.servers.length > 0) {
              ep.primary_stream = getPrimaryStream(ep.servers);
            }
          }
        }
      }
    }

    // ÚNICAMENTE almacenar en caché si se encontraron servidores o temporadas válidas
    if (result && ((result.servers && result.servers.length > 0) || (result.seasons && result.seasons.length > 0))) {
      getByIdCache.set(cacheKey, { timestamp: Date.now(), data: result });
      getByIdCache.set(result.id, { timestamp: Date.now(), data: result });
      getByIdCache.set(`${result.id}:${result.type}`, { timestamp: Date.now(), data: result });
      if (result.tmdb_id) {
        getByIdCache.set(String(result.tmdb_id), { timestamp: Date.now(), data: result });
        getByIdCache.set(`${result.tmdb_id}:${result.type}`, { timestamp: Date.now(), data: result });
      }
    }

    return result;
  }

  /**
   * Búsqueda en vivo con Caché en Memoria, Web Scraping y Unificación
   */
  static async search(query: string): Promise<MediaItem[]> {
    const q = query.toLowerCase().trim();

    // Verificación de caché en memoria
    const cached = searchCache.get(q);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }

    // 1. Scraping en vivo de fuentes activas
    const realScraped = await RealScraperService.scrapeRealMovies(q);
    
    // 2. Unificar catálogo para eliminar títulos duplicados y fusionar servidores
    const unified = await this.unifyMediaItems(realScraped);
    if (unified.length > 0) {
      searchCache.set(q, { timestamp: Date.now(), data: unified });
      return unified;
    }

    // 3. Fallback a Supabase
    try {
      const { data } = await supabase
        .from('media_items')
        .select('*')
        .or(`title.ilike.%${q}%,original_title.ilike.%${q}%`);

      if (data && data.length > 0) {
        const dbItems = data.map(this.mapDbItemToMediaItem);
        const res = await this.unifyMediaItems(dbItems);
        searchCache.set(q, { timestamp: Date.now(), data: res });
        return res;
      }
    } catch (err) {}

    return [];
  }

  /**
   * Unifica y agrupa elementos multimedia que corresponden al mismo título o TMDB ID,
   * fusionando SERVIDORES DE TODAS LAS FUENTES ACTIVAS en paralelo y enriqueciendo con TMDB en sub-segundos.
   */
  private static async unifyMediaItems(items: MediaItem[]): Promise<MediaItem[]> {
    const grouped = new Map<string, { item: MediaItem; sourceUrls: string[] }>();

    const getCanonicalKey = (t: string) => {
      let norm = t
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/\s*\(\d{4}\)\s*$/, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      return norm
        .replace(/\b(la pelicula|pelicula|the movie|hd)\b/g, "")
        .replace(/\bspiderman\b/g, "spider man")
        .replace(/\bspider man 1\b/g, "spider man")
        .replace(/sin camino a casa/g, "no way home")
        .replace(/lejos de casa/g, "far from home")
        .replace(/de regreso a casa/g, "homecoming")
        .replace(/un nuevo universo/g, "into the spider verse")
        .replace(/traves del spider verso/g, "across the spider verse")
        .replace(/\s+/g, " ")
        .trim();
    };

    // 1. Resolver TMDB ID en paralelo para cada ítem scraped
    const itemsWithTmdb = await Promise.all(
      items.map(async (item) => {
        const tmdbId = item.tmdb_id && item.tmdb_id > 0
          ? item.tmdb_id
          : await TmdbService.getTmdbId(item.title, item.type, item.release_date ? item.release_date.substring(0, 4) : undefined);
        return { ...item, tmdb_id: tmdbId };
      })
    );

    // 2. Agrupar por tmdb_id (si es > 0) o por clave canónica
    for (const item of itemsWithTmdb) {
      const key = (item.tmdb_id && item.tmdb_id > 0)
        ? `${item.type}:${item.tmdb_id}`
        : getCanonicalKey(item.title);
      const url = (item as any)._tioplus_url;

      if (!grouped.has(key)) {
        grouped.set(key, {
          item: { ...item, servers: [...(item.servers || [])] },
          sourceUrls: url ? [url] : []
        });
      } else {
        const entry = grouped.get(key)!;
        entry.item.overview = entry.item.overview || item.overview;
        entry.item.poster = entry.item.poster || item.poster;
        entry.item.backdrop = entry.item.backdrop || item.backdrop;
        entry.item.subcategories = Array.from(new Set([...(entry.item.subcategories || []), ...(item.subcategories || [])]));
        if (item.servers && item.servers.length > 0) {
          entry.item.servers = entry.item.servers || [];
          for (const s of item.servers) {
            if (!entry.item.servers.some(existing => existing.embed_url === s.embed_url)) {
              entry.item.servers.push(s);
            }
          }
        }
        if (url && !entry.sourceUrls.includes(url)) {
          entry.sourceUrls.push(url);
        }
      }
    }

    // 3. Procesamiento PARALELO ultrarrápido de todas las entradas unificadas
    const entries = Array.from(grouped.values()).slice(0, 10);

    const unifiedList = await Promise.all(
      entries.map(async (entry) => {
        const targetItem = entry.item;
        const allServers: ServerOption[] = [...(targetItem.servers || [])];
        const existingUrls = new Set(allServers.map(s => s.embed_url));

        // Resolver fuentes adicionales en paralelo con timeout de 1.2s
        if (entry.sourceUrls.length > 0) {
          const fetchPromises = entry.sourceUrls.slice(0, 3).map(sourceUrl => {
            const timeout = new Promise<any>((resolve) => setTimeout(() => resolve(null), 1200));
            return Promise.race([RealScraperService.scrapeDetail(sourceUrl), timeout]);
          });

          const details = await Promise.all(fetchPromises);
          for (const detail of details) {
            if (detail && detail.servers && detail.servers.length > 0) {
              for (const s of detail.servers) {
                if (!existingUrls.has(s.embed_url)) {
                  allServers.push(s);
                  existingUrls.add(s.embed_url);
                }
              }
            }
          }
        }

        targetItem.servers = sortServersBySourcePriority(allServers);
        if (targetItem.servers.length > 0) {
          targetItem.primary_stream = getPrimaryStream(targetItem.servers);
        }

        // Enriquecer con metadatos oficiales completos de TMDB
        const enriched = await TmdbService.enrichMediaItem(targetItem);

        // Herencia e inyección de servidores a episodios si es una serie
        if (enriched.seasons && enriched.seasons.length > 0) {
          const activeServers = sortServersBySourcePriority(enriched.servers || []);
          for (const season of enriched.seasons) {
            if (season.episodes) {
              for (const ep of season.episodes) {
                ep.servers = sortServersBySourcePriority(ep.servers && ep.servers.length > 0 ? ep.servers : activeServers);
                if (ep.servers.length > 0) {
                  ep.primary_stream = getPrimaryStream(ep.servers);
                }
              }
            }
          }
        }

        return enriched;
      })
    );

    return unifiedList;
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
