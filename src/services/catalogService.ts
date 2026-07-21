import { MediaItem } from '../types';
import { supabase } from './supabaseService';
import { RealScraperService } from './realScraperService';

export class CatalogService {
  /**
   * Obtiene todos los títulos del homepage en vivo con Slugs canónicos como IDs (ej. "la-casa-del-dragon")
   */
  static async getAll(): Promise<MediaItem[]> {
    // 1. Scraping en vivo del homepage de TioPlus (Garantiza Slugs Canónicos reales)
    const liveItems = await RealScraperService.scrapeHomepage();
    if (liveItems.length > 0) {
      return liveItems;
    }

    // 2. Fallback a Supabase mapeando siempre a Slugs limpios
    try {
      const { data } = await supabase.from('media_items').select('*').limit(50);
      if (data && data.length > 0) {
        return data.map(this.mapDbItemToMediaItem);
      }
    } catch (err) {}

    return [];
  }

  /**
   * Obtiene un título por ID/Slug de forma consistente.
   * Acepta slugs canónicos (ej. "la-casa-del-dragon"), TMDB IDs o IDs numéricos.
   */
  static async getById(id: string): Promise<MediaItem | null> {
    const q = id.toLowerCase().trim();

    // 0. Intentar si es un slug de FuegoCine (ej. 2025-04-spiderman-lejos-de-casa-2019-html)
    const fuegocineMatch = q.match(/^(\d{4})-(\d{2})-(.+)-html$/);
    if (fuegocineMatch) {
      const fuegocineUrl = `https://www.fuegocine.com/${fuegocineMatch[1]}/${fuegocineMatch[2]}/${fuegocineMatch[3]}.html`;
      const fcDetail = await RealScraperService.scrapeFuegocineDetail(fuegocineUrl);
      if (fcDetail) return fcDetail;
    }

    // 1. Intentar por categorías directas en TioPlus (película, serie, anime, dorama)
    const categories = ['pelicula', 'serie', 'anime', 'dorama'];
    for (const cat of categories) {
      const detail = await RealScraperService.scrapeDetail(`https://tioplus.app/${cat}/${q}`);
      if (detail && (detail.servers?.length || detail.seasons?.length)) return detail;
    }

    // 2. Buscar por texto de forma inteligente en TioPlus & FuegoCine
    const scraped = await RealScraperService.scrapeRealMovies(q);
    if (scraped.length > 0) {
      // Si el primer resultado es de fuegocine, obtener sus detalles completos
      const rawUrl = (scraped[0] as any)._tioplus_url || '';
      if (rawUrl.includes('fuegocine.com')) {
        const fcDetail = await RealScraperService.scrapeFuegocineDetail(rawUrl);
        if (fcDetail) return fcDetail;
      }
      return scraped[0];
    }

    // 5. Fallback final a Supabase (buscando por id, slug o tmdb_id)
    try {
      const { data } = await supabase
        .from('media_items')
        .select('*')
        .or(`id.eq.${q},tmdb_id.eq.${isNaN(Number(q)) ? -1 : Number(q)}`)
        .single();

      if (data) return this.mapDbItemToMediaItem(data);
    } catch (err) {}

    return null;
  }

  /**
   * Búsqueda en vivo con Web Scraping Real (IDs son siempre Slugs) y Unificación de Catálogo
   */
  static async search(query: string): Promise<MediaItem[]> {
    const q = query.toLowerCase().trim();

    // 1. Scraping en vivo de fuentes activas
    const realScraped = await RealScraperService.scrapeRealMovies(q);
    
    // 2. Unificar catálogo para eliminar títulos duplicados y fusionar servidores
    const unified = await this.unifyMediaItems(realScraped);
    if (unified.length > 0) {
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
        return await this.unifyMediaItems(dbItems);
      }
    } catch (err) {}

    return [];
  }

  /**
   * Unifica y agrupa elementos multimedia que corresponden al mismo título,
   * fusionando sus servidores y respetando el orden de prioridad de las fuentes activas.
   */
  private static async unifyMediaItems(items: MediaItem[]): Promise<MediaItem[]> {
    const grouped = new Map<string, MediaItem>();

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

    for (const item of items) {
      const key = getCanonicalKey(item.title);
      if (!grouped.has(key)) {
        grouped.set(key, { ...item, servers: [...(item.servers || [])] });
      } else {
        const existing = grouped.get(key)!;
        existing.overview = existing.overview || item.overview;
        existing.poster = existing.poster || item.poster;
        existing.backdrop = existing.backdrop || item.backdrop;

        // Si el elemento entrante no tiene servidores pero tiene URL de detalle, resolver sus servidores
        let itemServers = item.servers || [];
        if (itemServers.length === 0 && (item as any)._tioplus_url) {
          const detailed = await RealScraperService.scrapeDetail((item as any)._tioplus_url);
          if (detailed && detailed.servers) {
            itemServers = detailed.servers;
          }
        }

        // Fusionar servidores evitando URLs de reproductor duplicadas
        const existingUrls = new Set(existing.servers?.map(s => s.embed_url));
        if (itemServers.length > 0) {
          existing.servers = existing.servers || [];
          for (const s of itemServers) {
            if (!existingUrls.has(s.embed_url)) {
              existing.servers.push(s);
              existingUrls.add(s.embed_url);
            }
          }
        }

        // Unificar subcategorías de fuentes
        existing.subcategories = Array.from(new Set([...(existing.subcategories || []), ...(item.subcategories || [])]));
        
        // Recalcular primary_stream
        if (existing.servers && existing.servers.length > 0) {
          existing.primary_stream = existing.servers.find(s => s.status === 'online') || existing.servers[0];
        }
      }
    }

    return Array.from(grouped.values());
  }

  private static mapDbItemToMediaItem(dbRow: any): MediaItem {
    // Garantizar que la propiedad id sea SIEMPRE un slug canónico de texto y nunca un entero arbitrario
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
      cast: dbRow.cast_data || [],
      dubbing_cast: dbRow.dubbing_cast_data || [],
      total_seasons: dbRow.total_seasons || 0,
      total_episodes: dbRow.total_episodes || 0,
      primary_stream: dbRow.servers?.[0] || undefined,
      servers: dbRow.servers || [],
    };
  }
}
