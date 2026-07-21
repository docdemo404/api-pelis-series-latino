import { MediaItem } from '../types';
import { supabase } from './supabaseService';
import { RealScraperService } from './realScraperService';

export class CatalogService {
  /**
   * Obtiene todos los títulos
   */
  static async getAll(): Promise<MediaItem[]> {
    try {
      const { data } = await supabase.from('media_items').select('*').limit(50);
      if (data && data.length > 0) {
        return data.map(this.mapDbItemToMediaItem);
      }
    } catch (err) {}
    return [];
  }

  /**
   * Obtiene un título por ID o Slug
   */
  static async getById(id: string): Promise<MediaItem | null> {
    const q = id.toLowerCase().trim();
    try {
      const { data } = await supabase
        .from('media_items')
        .select('*')
        .or(`id.eq.${q},tmdb_id.eq.${isNaN(Number(q)) ? -1 : Number(q)}`)
        .single();

      if (data) return this.mapDbItemToMediaItem(data);
    } catch (err) {}

    // Intentar Web Scraping Real si no está en DB
    const scraped = await RealScraperService.scrapeRealMovies(q);
    return scraped[0] || null;
  }

  /**
   * Búsqueda por texto con Web Scraping Real en Vivo
   */
  static async search(query: string): Promise<MediaItem[]> {
    const q = query.toLowerCase().trim();

    // 1. Ejecutar Web Scraping Real en vivo a los portales
    const realScraped = await RealScraperService.scrapeRealMovies(q);
    if (realScraped.length > 0) {
      return realScraped;
    }

    // 2. Consultar Supabase
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
      primary_stream: {
        id: `srv_${dbRow.id}_1`,
        name: 'Streamwish',
        quality: '1080p',
        language: 'latino',
        embed_url: `https://streamwish.to/e/${dbRow.id}`,
        direct_stream: `https://streamwish.to/hls/${dbRow.id}.m3u8`,
        status: 'online',
        last_checked: new Date().toISOString()
      }
    };
  }
}

