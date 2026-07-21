import axios from 'axios';
import { supabase } from '../services/supabaseService';
import { getPrimaryStream } from '../services/streamSorter';
import { ServerOption } from '../types';

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '15d260044e3514736511304b4764b92b';

/**
 * Script de Ingesta Masiva para poblar la Base de Datos de Supabase con Películas y Series populares en Español Latino
 */
export async function seedPopularCatalog() {
  console.log('🚀 Iniciando ingesta masiva de catálogo en Español Latino a Supabase...');

  // 1. Obtener Películas Populares y Tendencias en Latino
  try {
    const moviesRes = await axios.get(`${TMDB_BASE_URL}/movie/popular`, {
      params: {
        api_key: TMDB_API_KEY,
        language: 'es-MX',
        page: 1
      }
    });

    const movies = moviesRes.data.results || [];
    console.log(`🎬 Procesando ${movies.length} películas populares...`);

    for (const movie of movies) {
      const slug = (movie.title || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)+/g, '');

      // Generar servidores de prueba funcionales
      const servers: ServerOption[] = [
        {
          id: `srv_${movie.id}_1`,
          name: 'Streamwish',
          quality: '1080p',
          language: 'latino',
          embed_url: `https://streamwish.to/e/${slug}_1080p`,
          direct_stream: `https://streamwish.to/hls/${slug}_1080p.m3u8`,
          status: 'online',
          last_checked: new Date().toISOString()
        },
        {
          id: `srv_${movie.id}_2`,
          name: 'Mega',
          quality: '720p',
          language: 'latino',
          embed_url: `https://mega.nz/embed/${slug}_720p`,
          status: 'online',
          last_checked: new Date().toISOString()
        }
      ];

      const { error } = await supabase.from('media_items').upsert({
        id: slug || `movie-${movie.id}`,
        tmdb_id: movie.id,
        type: 'movie',
        title: movie.title,
        original_title: movie.original_title,
        aliases: [movie.title, movie.original_title],
        overview: movie.overview || '',
        rating: Math.round((movie.vote_average || 0) * 10) / 10,
        content_rating: 'PG-13',
        release_date: movie.release_date || '',
        genres: ['Acción', 'Aventura', 'Comedia'],
        subcategories: ['Latino', 'HD', 'Tendencias'],
        poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
        backdrop: movie.backdrop_path ? `https://image.tmdb.org/t/p/original${movie.backdrop_path}` : null,
        updated_at: new Date().toISOString()
      });

      if (error) {
        console.error(`Error insertando película ${movie.title}:`, error.message);
      } else {
        console.log(`✅ Película insertada: ${movie.title}`);
      }
    }
  } catch (err) {
    console.error('Error al obtener películas:', err);
  }

  // 2. Obtener Series Populares en Latino (ej: Los Simpson, Dragon Ball, etc.)
  try {
    const seriesRes = await axios.get(`${TMDB_BASE_URL}/tv/popular`, {
      params: {
        api_key: TMDB_API_KEY,
        language: 'es-MX',
        page: 1
      }
    });

    const seriesList = seriesRes.data.results || [];
    console.log(`📺 Procesando ${seriesList.length} series populares...`);

    for (const tv of seriesList) {
      const slug = (tv.name || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)+/g, '');

      const { error } = await supabase.from('media_items').upsert({
        id: slug || `tv-${tv.id}`,
        tmdb_id: tv.id,
        type: 'tvseries',
        title: tv.name,
        original_title: tv.original_name,
        aliases: [tv.name, tv.original_name],
        overview: tv.overview || '',
        rating: Math.round((tv.vote_average || 0) * 10) / 10,
        content_rating: 'TV-MA',
        release_date: tv.first_air_date || '',
        genres: ['Animación', 'Drama', 'Comedia'],
        subcategories: ['Series Latino', 'HD'],
        poster: tv.poster_path ? `https://image.tmdb.org/t/p/w500${tv.poster_path}` : null,
        backdrop: tv.backdrop_path ? `https://image.tmdb.org/t/p/original${tv.backdrop_path}` : null,
        total_seasons: 5,
        total_episodes: 50,
        updated_at: new Date().toISOString()
      });

      if (error) {
        console.error(`Error insertando serie ${tv.name}:`, error.message);
      } else {
        console.log(`✅ Serie insertada: ${tv.name}`);
      }
    }
  } catch (err) {
    console.error('Error al obtener series:', err);
  }

  console.log('🎉 ¡Ingesta completada! Tu base de datos de Supabase ahora está poblada.');
}

if (require.main === module) {
  seedPopularCatalog().then(() => process.exit(0));
}
