import { MediaItem } from '../types';
import { supabase } from './supabaseService';
import { RealScraperService } from './realScraperService';

export class CatalogService {
  /**
   * Obtiene todos los títulos: primero de Supabase, luego scraping en vivo de TioPlus
   */
  static async getAll(): Promise<MediaItem[]> {
    // 1. Intentar desde Supabase
    try {
      const { data } = await supabase.from('media_items').select('*').limit(50);
      if (data && data.length > 0) {
        return data.map(this.mapDbItemToMediaItem);
      }
    } catch (err) {}

    // 2. Scraping en vivo del homepage de TioPlus
    return RealScraperService.scrapeHomepage();
  }

  /**
   * Obtiene un título por ID/Slug. Si no está en DB, scrapea el detalle de TioPlus
   */
  static async getById(id: string): Promise<MediaItem | null> {
    const q = id.toLowerCase().trim();

    // 1. Buscar en Supabase
    try {
      const { data } = await supabase
        .from('media_items')
        .select('*')
        .or(`id.eq.${q},tmdb_id.eq.${isNaN(Number(q)) ? -1 : Number(q)}`)
        .single();

      if (data) return this.mapDbItemToMediaItem(data);
    } catch (err) {}

    // 2. Intentar como slug directo en TioPlus (película)
    let detail = await RealScraperService.scrapeDetail(`https://tioplus.app/pelicula/${q}`);
    if (detail && (detail.servers?.length || detail.seasons?.length)) return detail;

    // 3. Intentar como serie
    detail = await RealScraperService.scrapeDetail(`https://tioplus.app/serie/${q}`);
    if (detail && (detail.servers?.length || detail.seasons?.length)) return detail;

    // 4. Intentar como anime
    detail = await RealScraperService.scrapeDetail(`https://tioplus.app/anime/${q}`);
    if (detail && (detail.servers?.length || detail.seasons?.length)) return detail;

    // 5. Buscar por texto
    const scraped = await RealScraperService.scrapeRealMovies(q);
    return scraped[0] || null;
  }

  /**
   * Búsqueda en vivo con Web Scraping Real de TioPlus
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
    return {
      id: dbRow.id,
      tmdb_id: dbRow.tmdb_id,
      imdb_id: dbRow.imdb_id || null,
      type: dbRow.type,
      title: dbRow.title,
      original_title: dbRow.original_title,
      aliases: dbRow.aliases || [],
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
