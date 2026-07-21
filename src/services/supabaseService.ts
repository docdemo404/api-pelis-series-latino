import { createClient } from '@supabase/supabase-js';
import { MediaItem } from '../types';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://kgeytmocuitbchpdcoad.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtnZXl0bW9jdWl0YmNocGRjb2FkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1OTY1NTQsImV4cCI6MjEwMDE3MjU1NH0._t2cRnkx_BCXP-J7TaK3Iymhk_bod2Xb5RlzsqSScxg';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export class SupabaseService {
  /**
   * Guarda o actualiza una película/serie en Supabase PostgreSQL
   */
  static async upsertMediaItem(item: MediaItem) {
    try {
      const { error } = await supabase.from('media_items').upsert({
        id: item.id,
        tmdb_id: item.tmdb_id,
        imdb_id: item.imdb_id,
        type: item.type,
        title: item.title,
        original_title: item.original_title,
        aliases: item.aliases,
        tagline: item.tagline,
        overview: item.overview,
        rating: item.rating,
        content_rating: item.content_rating,
        release_date: item.release_date,
        genres: item.genres,
        subcategories: item.subcategories,
        poster: item.poster,
        backdrop: item.backdrop,
        logo: item.logo,
        trailer: item.trailer,
        cast_data: item.cast,
        dubbing_cast_data: item.dubbing_cast,
        total_seasons: item.total_seasons || 0,
        total_episodes: item.total_episodes || 0,
        updated_at: new Date().toISOString()
      });

      if (error) {
        console.error('Error guardando en Supabase:', error.message);
      }
    } catch (err) {
      console.error('Exception guardando en Supabase:', err);
    }
  }

  /**
   * Busca en Supabase por título o alias
   */
  static async searchMedia(query: string): Promise<any[]> {
    try {
      const q = query.toLowerCase().trim();
      const { data, error } = await supabase
        .from('media_items')
        .select('*')
        .or(`title.ilike.%${q}%,original_title.ilike.%${q}%`);

      if (error) {
        console.error('Error buscando en Supabase:', error.message);
        return [];
      }
      return data || [];
    } catch (err) {
      return [];
    }
  }
}
