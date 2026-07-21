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

    // 1. Intentar por categorías directas en TioPlus (película, serie, anime, dorama)
    const categories = ['pelicula', 'serie', 'anime', 'dorama'];
    for (const cat of categories) {
      const detail = await RealScraperService.scrapeDetail(`https://tioplus.app/${cat}/${q}`);
      if (detail && (detail.servers?.length || detail.seasons?.length)) return detail;
    }

    // 4. Buscar por texto de forma inteligente en TioPlus
    const scraped = await RealScraperService.scrapeRealMovies(q);
    if (scraped.length > 0) {
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
   * Búsqueda en vivo con Web Scraping Real de TioPlus (IDs son siempre Slugs)
   */
  static async search(query: string): Promise<MediaItem[]> {
    const q = query.toLowerCase().trim();

    // 1. Scraping en vivo de TioPlus
    const realScraped = await RealScraperService.scrapeRealMovies(q);
    if (realScraped.length > 0) {
      return realScraped;
    }

    // 2. Fallback a Supabase
    try {
      const { data } = await supabase
        .from('media_items')
        .select('*')
        .or(`title.ilike.%${q}%,original_title.ilike.%${q}%`);

      if (data && data.length > 0) {
        return data.map(this.mapDbItemToMediaItem);
      }
    } catch (err) {}

    return [];
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
