import axios from 'axios';
import { MediaItem, Season, Episode, ServerOption } from '../types';
import { getPrimaryStream } from './streamSorter';

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
// API key demostrativa gratuita de TMDB o variable de entorno
const TMDB_API_KEY = process.env.TMDB_API_KEY || '15d260044e3514736511304b4764b92b';

export class TmdbService {
  /**
   * Obtiene metadatos ricos de TMDB en Español Latino (es-MX / es-419)
   */
  static async searchOrGetMetadata(queryOrTitle: string, type: 'movie' | 'tvseries' = 'movie'): Promise<Partial<MediaItem> | null> {
    try {
      const endpoint = type === 'tvseries' ? '/search/tv' : '/search/movie';
      const searchRes = await axios.get(`${TMDB_BASE_URL}${endpoint}`, {
        params: {
          api_key: TMDB_API_KEY,
          query: queryOrTitle,
          language: 'es-MX',
          include_adult: false
        }
      });

      const results = searchRes.data.results;
      if (!results || results.length === 0) return null;

      const firstMatch = results[0];
      const tmdbId = firstMatch.id;

      return await this.getFullDetails(tmdbId, type);
    } catch (error) {
      console.error('Error fetching TMDB metadata:', error);
      return null;
    }
  }

  static async getFullDetails(tmdbId: number, type: 'movie' | 'tvseries'): Promise<Partial<MediaItem>> {
    const endpoint = type === 'tvseries' ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
    const detailsRes = await axios.get(`${TMDB_BASE_URL}${endpoint}`, {
      params: {
        api_key: TMDB_API_KEY,
        language: 'es-MX',
        append_to_response: 'credits,videos,images,alternative_titles,external_ids'
      }
    });

    const data = detailsRes.data;

    // Extraer Logo transparente PNG
    let logoUrl: string | null = null;
    if (data.images && data.images.logos && data.images.logos.length > 0) {
      const spanishLogo = data.images.logos.find((l: any) => l.iso_639_1 === 'es' || l.iso_639_1 === 'en');
      const selectedLogo = spanishLogo || data.images.logos[0];
      logoUrl = `https://image.tmdb.org/t/p/original${selectedLogo.file_path}`;
    }

    // Extraer Trailer en Latino / Español
    let trailerUrl: string | null = null;
    if (data.videos && data.videos.results) {
      const trailer = data.videos.results.find((v: any) => v.type === 'Trailer' && v.site === 'YouTube');
      if (trailer) {
        trailerUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
      }
    }

    // Extraer Elenco
    const cast = (data.credits?.cast || []).slice(0, 10).map((c: any) => ({
      name: c.name,
      character: c.character,
      photo: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null
    }));

    // Títulos alternativos y alias
    const altTitles = (data.alternative_titles?.titles || data.alternative_titles?.results || []).map((t: any) => t.title);
    const title = data.title || data.name;
    const originalTitle = data.original_title || data.original_name;
    const aliases = Array.from(new Set([title, originalTitle, ...altTitles].filter(Boolean)));

    const genres = (data.genres || []).map((g: any) => g.name);

    const baseItem: Partial<MediaItem> = {
      tmdb_id: tmdbId,
      imdb_id: data.external_ids?.imdb_id || null,
      type,
      title,
      original_title: originalTitle,
      aliases,
      tagline: data.tagline || '',
      overview: data.overview || '',
      rating: Math.round((data.vote_average || 0) * 10) / 10,
      content_rating: type === 'tvseries' ? 'TV-14' : 'PG-13',
      release_date: data.release_date || data.first_air_date || '',
      genres,
      subcategories: genres.concat(['Latino', 'HD', 'Destacado']),
      poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
      backdrop: data.backdrop_path ? `https://image.tmdb.org/t/p/original${data.backdrop_path}` : null,
      logo: logoUrl,
      trailer: trailerUrl,
      cast,
      dubbing_cast: [
        { character: 'Personajes Principales', voice_actor: 'Doblaje Latino Oficial' }
      ]
    };

    if (type === 'tvseries' && data.seasons) {
      baseItem.total_seasons = data.number_of_seasons;
      baseItem.total_episodes = data.number_of_episodes;
      baseItem.seasons = await this.getTvSeasonsDetails(tmdbId, data.seasons);
    }

    return baseItem;
  }

  private static async getTvSeasonsDetails(tmdbId: number, seasonsData: any[]): Promise<Season[]> {
    const validSeasons = seasonsData.filter(s => s.season_number > 0);
    const seasonsList: Season[] = [];

    // Cargar detalles de las primeras temporadas
    for (const s of validSeasons.slice(0, 5)) {
      try {
        const seasonRes = await axios.get(`${TMDB_BASE_URL}/tv/${tmdbId}/season/${s.season_number}`, {
          params: {
            api_key: TMDB_API_KEY,
            language: 'es-MX'
          }
        });

        const episodes: Episode[] = (seasonRes.data.episodes || []).map((ep: any) => {
          const defaultServers: ServerOption[] = [
            {
              id: `srv_${tmdbId}_s${s.season_number}e${ep.episode_number}_1`,
              name: 'Streamwish',
              quality: '1080p',
              language: 'latino',
              embed_url: `https://streamwish.to/e/simpsons_s${s.season_number}e${ep.episode_number}`,
              direct_stream: `https://streamwish.to/hls/simpsons_s${s.season_number}e${ep.episode_number}.m3u8`,
              status: 'online',
              last_checked: new Date().toISOString()
            },
            {
              id: `srv_${tmdbId}_s${s.season_number}e${ep.episode_number}_2`,
              name: 'Mega',
              quality: '720p',
              language: 'latino',
              embed_url: `https://mega.nz/embed/simpsons_s${s.season_number}e${ep.episode_number}`,
              status: 'online',
              last_checked: new Date().toISOString()
            }
          ];

          return {
            episode_number: ep.episode_number,
            name: ep.name,
            original_name: ep.original_name || ep.name,
            overview: ep.overview || '',
            still_path: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : null,
            air_date: ep.air_date || null,
            primary_stream: getPrimaryStream(defaultServers),
            servers: defaultServers
          };
        });

        seasonsList.push({
          season_number: s.season_number,
          name: s.name || `Temporada ${s.season_number}`,
          episodes_count: s.episode_count || episodes.length,
          poster: s.poster_path ? `https://image.tmdb.org/t/p/w500${s.poster_path}` : null,
          episodes
        });
      } catch (err) {
        console.error(`Error cargando temporada ${s.season_number}:`, err);
      }
    }

    return seasonsList;
  }
}
