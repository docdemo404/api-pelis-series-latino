import { MediaItem, ServerOption } from '../types';
import { supabase } from './supabaseService';
import { RealScraperService } from './realScraperService';
import { TmdbService } from './tmdbService';

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
  static async getById(id: string): Promise<MediaItem | null> {
    const q = id.toLowerCase().trim();

    // Verificación de caché en memoria
    const cached = getByIdCache.get(q);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }

    let result: MediaItem | null = null;

    // 0. Si el ID es numérico (ID oficial de TMDB), obtener metadatos de TMDB y resolver servidores
    if (!isNaN(Number(q))) {
      const tmdbNumericId = Number(q);
      const tmdbMovieData = await TmdbService.getTmdbDetails(tmdbNumericId, 'movie');
      const tmdbTvData = tmdbMovieData ? null : await TmdbService.getTmdbDetails(tmdbNumericId, 'tvseries');
      const tmdbData = tmdbMovieData || tmdbTvData;

      if (tmdbData) {
        const title = tmdbData.title || tmdbData.name;
        const searchResults = await this.search(title);
        const match = searchResults.find(r => r.tmdb_id === tmdbNumericId) || searchResults[0];
        if (match) {
          result = await TmdbService.enrichMediaItem(match);
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

    // 3. Buscar por texto o TMDB ID de forma inteligente con unificación profunda
    if (!result) {
      const scraped = await this.search(q);
      if (scraped.length > 0) {
        result = scraped[0];
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

    if (result) {
      getByIdCache.set(q, { timestamp: Date.now(), data: result });
      getByIdCache.set(result.id, { timestamp: Date.now(), data: result });
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
   * Unifica y agrupa elementos multimedia que corresponden al mismo título,
   * fusionando SERVIDORES DE TODAS LAS FUENTES ACTIVAS y enriqueciendo con metadatos oficiales TMDB.
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

    // 1. Agrupar ítems por clave canónica y acumular sus URLs de fuentes
    for (const item of items) {
      const key = getCanonicalKey(item.title);
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
        if (url && !entry.sourceUrls.includes(url)) {
          entry.sourceUrls.push(url);
        }
      }
    }

    const unifiedList: MediaItem[] = [];

    // 2. Para cada grupo unificado, resolver y fusionar SERVIDORES DE TODAS LAS FUENTES y enriquecer con TMDB
    for (const [key, entry] of grouped.entries()) {
      const targetItem = entry.item;
      const allServers: ServerOption[] = [...(targetItem.servers || [])];
      const existingUrls = new Set(allServers.map(s => s.embed_url));

      for (const sourceUrl of entry.sourceUrls) {
        try {
          const detail = await RealScraperService.scrapeDetail(sourceUrl);
          if (detail && detail.servers && detail.servers.length > 0) {
            for (const s of detail.servers) {
              if (!existingUrls.has(s.embed_url)) {
                allServers.push(s);
                existingUrls.add(s.embed_url);
              }
            }
          }
        } catch {}
      }

      targetItem.servers = allServers;
      if (allServers.length > 0) {
        targetItem.primary_stream = allServers.find(s => s.status === 'online') || allServers[0];
      }

      // Enriquecer con metadatos oficiales completos de TMDB
      const enrichedItem = await TmdbService.enrichMediaItem(targetItem);
      unifiedList.push(enrichedItem);
    }

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
      primary_stream: dbRow.servers?.[0] || undefined,
      servers: dbRow.servers || [],
    };
  }
}
