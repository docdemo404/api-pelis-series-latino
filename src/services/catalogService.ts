import { MediaItem, ServerOption } from '../types';
import { supabase } from './supabaseService';
import { TmdbService } from './tmdbService';

export class CatalogService {
  /**
   * Obtiene todos los títulos o consulta Supabase PostgreSQL
   */
  static async getAll(): Promise<MediaItem[]> {
    try {
      const { data, error } = await supabase.from('media_items').select('*').limit(50);
      if (error || !data || data.length === 0) {
        return this.getFallbackCatalog();
      }
      return data.map(this.mapDbItemToMediaItem);
    } catch (err) {
      return this.getFallbackCatalog();
    }
  }

  /**
   * Obtiene un título por ID o Slug
   */
  static async getById(id: string): Promise<MediaItem | null> {
    try {
      const { data, error } = await supabase
        .from('media_items')
        .select('*')
        .or(`id.eq.${id},tmdb_id.eq.${isNaN(Number(id)) ? -1 : Number(id)}`)
        .single();

      if (data) {
        return this.mapDbItemToMediaItem(data);
      }

      // Si no está en Supabase, consultar TMDB On-Demand
      const tmdbData = await TmdbService.searchOrGetMetadata(id, 'movie');
      return (tmdbData as MediaItem) || null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Búsqueda por texto o alias
   */
  static async search(query: string): Promise<MediaItem[]> {
    const q = query.toLowerCase().trim();
    try {
      const { data, error } = await supabase
        .from('media_items')
        .select('*')
        .or(`title.ilike.%${q}%,original_title.ilike.%${q}%`);

      if (data && data.length > 0) {
        return data.map(this.mapDbItemToMediaItem);
      }

      // Fallback On-Demand a TMDB
      const tmdbMatch = await TmdbService.searchOrGetMetadata(query, 'movie');
      return tmdbMatch ? [tmdbMatch as MediaItem] : [];
    } catch (err) {
      return [];
    }
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
      servers: [
        {
          id: `srv_${dbRow.id}_1`,
          name: 'Streamwish',
          quality: '1080p',
          language: 'latino',
          embed_url: `https://streamwish.to/e/${dbRow.id}`,
          direct_stream: `https://streamwish.to/hls/${dbRow.id}.m3u8`,
          status: 'online',
          last_checked: new Date().toISOString()
        }
      ]
    };
  }

  private static getFallbackCatalog(): MediaItem[] {
    return [];
  }
}
