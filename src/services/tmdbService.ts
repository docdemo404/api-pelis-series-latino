import axios from 'axios';
import * as cheerio from 'cheerio';
import { MediaItem, ContentType, CastMember } from '../types';

const API_KEY = '99b8bc99e85e79fabd52b64513c9780d';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const tmdbIdCache = new Map<string, number>();
const tmdbDetailCache = new Map<string, any>();

export class TmdbService {
  /**
   * Obtiene el TMDB ID real numérico utilizando la API oficial de TMDB con fallback
   */
  static async getTmdbId(title: string, type: ContentType = 'movie', year?: string): Promise<number> {
    // Normalización de título eliminando prefijos de scraping (ej. "gru 3 mi villano favorito" -> "Mi villano favorito 3")
    let cleanTitle = title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
    cleanTitle = cleanTitle.replace(/^gru\s*(\d+)\s*/i, 'Mi villano favorito $1 ');
    cleanTitle = cleanTitle.replace(/^ver\s+/i, '').trim();

    const cacheKey = `${type}:${cleanTitle.toLowerCase()}:${year || ''}`;

    if (tmdbIdCache.has(cacheKey)) {
      return tmdbIdCache.get(cacheKey)!;
    }

    const endpoint = type === 'tvseries' ? 'tv' : 'movie';
    const numMatch = cleanTitle.match(/\b(\d+)\b/);
    const targetNum = numMatch ? numMatch[1] : null;

    // 1. Consulta a la API oficial de TMDB v3
    try {
      const searchRes = await axios.get(`https://api.themoviedb.org/3/search/${endpoint}`, {
        params: {
          api_key: API_KEY,
          query: cleanTitle,
          language: 'es-MX',
          ...(year ? (type === 'movie' ? { year } : { first_air_date_year: year }) : {})
        },
        timeout: 4000
      });

      const results = searchRes.data?.results || [];
      if (results.length > 0) {
        let bestMatch = results[0];
        if (targetNum) {
          const matchedResult = results.find((r: any) => {
            const resTitle = (r.title || r.name || '').toLowerCase();
            return resTitle.includes(` ${targetNum}`) || resTitle.includes(`:${targetNum}`) || resTitle.endsWith(` ${targetNum}`);
          });
          if (matchedResult) bestMatch = matchedResult;
        }

        const tmdbId = bestMatch.id;
        tmdbIdCache.set(cacheKey, tmdbId);
        return tmdbId;
      }
    } catch (err: any) {
      console.warn(`[TMDB API Search Warning]: ${err.message}`);
    }

    // 2. Fallback a Web Scraping de TMDB Search
    try {
      const url = `https://www.themoviedb.org/search/${endpoint}?query=${encodeURIComponent(cleanTitle)}&language=es-MX`;
      const res = await axios.get(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html' },
        timeout: 4000
      });

      const $ = cheerio.load(res.data);
      const firstLink = $('a[data-id], .card.style_1 a[href*="/movie/"], .card.style_1 a[href*="/tv/"], .results .item a[href*="/movie/"], .results .item a[href*="/tv/"]').first();
      const href = firstLink.attr('href') || '';
      const match = href.match(/\/(movie|tv)\/(\d+)/);

      if (match) {
        const tmdbId = parseInt(match[2]);
        tmdbIdCache.set(cacheKey, tmdbId);
        return tmdbId;
      }
    } catch {}

    // 3. Fallback a ID numérico determinista estilo TMDB
    let hash = 2166136261;
    const cleanStr = cleanTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (let i = 0; i < cleanStr.length; i++) {
      hash ^= cleanStr.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    const fallbackId = (hash >>> 0) % 900000 + 100000;
    tmdbIdCache.set(cacheKey, fallbackId);
    return fallbackId;
  }

  /**
   * Obtiene la información completa de metadatos desde TMDB por TMDB ID de forma ultra-rápida (Paralelizada).
   */
  static async getTmdbDetails(tmdbId: number, type: ContentType = 'movie'): Promise<any | null> {
    const cacheKey = `${type}:${tmdbId}`;
    if (tmdbDetailCache.has(cacheKey)) {
      return tmdbDetailCache.get(cacheKey);
    }

    const endpoint = type === 'tvseries' ? 'tv' : 'movie';
    try {
      // Peticiones paralelas en una sola ida y vuelta de red (sub-300ms)
      const [primaryRes, fallbackEsRes, fallbackVidRes] = await Promise.allSettled([
        axios.get(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}`, {
          params: { api_key: API_KEY, language: 'es-MX', append_to_response: 'credits,videos' },
          timeout: 2500
        }),
        axios.get(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}`, {
          params: { api_key: API_KEY, language: 'es-ES' },
          timeout: 2000
        }),
        axios.get(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}/videos`, {
          params: { api_key: API_KEY },
          timeout: 2000
        })
      ]);

      if (primaryRes.status !== 'fulfilled' || !primaryRes.value.data) {
        return null;
      }

      let data = primaryRes.value.data;

      // Usar sinopsis en español de España si la de México está vacía
      if (!data.overview && fallbackEsRes.status === 'fulfilled' && fallbackEsRes.value.data?.overview) {
        data.overview = fallbackEsRes.value.data.overview;
      }

      // Usar vídeos globales si los de es-MX están vacíos
      let videos = data.videos?.results || [];
      if (videos.length === 0 && fallbackVidRes.status === 'fulfilled' && fallbackVidRes.value.data?.results) {
        videos = fallbackVidRes.value.data.results;
      }
      data.all_videos = videos;

      tmdbDetailCache.set(cacheKey, data);
      return data;
    } catch (err: any) {
      console.warn(`[TMDB Detail Warning] ID ${tmdbId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Obtiene la estructura completa de temporadas y episodios desde la API oficial de TMDB
   */
  static async getTmdbSeasons(tmdbId: number, numSeasons: number, posterUrl: string | null, defaultServers: any[] = []): Promise<any[]> {
    const seasonNumbers = Array.from({ length: Math.min(numSeasons, 15) }, (_, i) => i + 1);

    const seasonPromises = seasonNumbers.map(sNum =>
      axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${sNum}`, {
        params: { api_key: API_KEY, language: 'es-MX' },
        timeout: 2500
      }).catch(() => null)
    );

    const results = await Promise.all(seasonPromises);
    const seasons: any[] = [];

    results.forEach((res, index) => {
      const sNum = seasonNumbers[index];
      if (res && res.data && res.data.episodes) {
        const eps = res.data.episodes;
        seasons.push({
          season_number: sNum,
          name: res.data.name || `Temporada ${sNum}`,
          episodes_count: eps.length,
          poster: res.data.poster_path ? `https://image.tmdb.org/t/p/w500${res.data.poster_path}` : (posterUrl || null),
          episodes: eps.map((e: any) => ({
            episode_number: e.episode_number,
            name: e.name || `Episodio ${e.episode_number}`,
            overview: e.overview || `Episodio ${e.episode_number} de la serie. Disponible en HD con audio Español Latino.`,
            still_path: e.still_path ? `https://image.tmdb.org/t/p/w500${e.still_path}` : (posterUrl || null),
            air_date: e.air_date || '',
            servers: defaultServers || []
          }))
        });
      }
    });

    return seasons;
  }

  /**
   * Enriquece un MediaItem con metadatos oficiales de TMDB:
   * sinopsis completa en español, trailers oficiales de YouTube, imágenes HD, reparto con fotos, géneros, temporadas, etc.
   */
  static async enrichMediaItem(item: MediaItem): Promise<MediaItem> {
    try {
      const year = item.release_date ? item.release_date.substring(0, 4) : undefined;
      const tmdbId = item.tmdb_id && item.tmdb_id > 0
        ? item.tmdb_id
        : await this.getTmdbId(item.title, item.type, year);

      const tmdbData = await this.getTmdbDetails(tmdbId, item.type);
      if (!tmdbData) {
        item.tmdb_id = tmdbId;
        item.id = String(tmdbId);
        return item;
      }

      const isTv = (tmdbData.number_of_seasons && tmdbData.number_of_seasons > 0) || item.type === 'tvseries' || tmdbData.first_air_date !== undefined;
      const contentType = isTv ? 'tvseries' as const : 'movie' as const;

      // Seleccionar Trailer oficial en YouTube (priorizar español)
      const videos = tmdbData.all_videos || tmdbData.videos?.results || [];
      const trailerObj = videos.find((v: any) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser') && (v.iso_639_1 === 'es' || v.iso_639_1 === 'es-MX'))
        || videos.find((v: any) => v.site === 'YouTube' && v.type === 'Trailer')
        || videos.find((v: any) => v.site === 'YouTube');

      const trailerUrl = trailerObj ? `https://www.youtube.com/watch?v=${trailerObj.key}` : item.trailer;

      // Mapear reparto con fotografías de TMDB y lista simple de nombres
      const castMembers: CastMember[] = tmdbData.credits?.cast?.slice(0, 12).map((c: any) => ({
        name: c.name,
        character: c.character || '',
        photo: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null
      })) || [];

      const existingCastStrings: string[] = Array.isArray(item.cast)
        ? item.cast.map((c: any) => (typeof c === 'string' ? c : (c.name || '')))
        : [];

      const castNames: string[] = castMembers.length > 0
        ? castMembers.map(c => c.name)
        : existingCastStrings;

      // Mapear géneros oficiales
      const genres = tmdbData.genres?.map((g: any) => g.name) || item.genres;

      // Mapear temporadas y episodios si es una serie de TV
      let seasons = item.seasons || [];
      if (isTv && (!seasons || seasons.length === 0) && tmdbData.number_of_seasons > 0) {
        seasons = await this.getTmdbSeasons(tmdbData.id, tmdbData.number_of_seasons, tmdbData.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}` : item.poster, item.servers || []);
      }

      const canonicalId = (item.id && isNaN(Number(item.id))) ? item.id : String(tmdbData.id);

      return {
        ...item,
        id: canonicalId,
        tmdb_id: tmdbData.id,
        type: contentType,
        title: tmdbData.title || tmdbData.name || item.title,
        original_title: tmdbData.original_title || tmdbData.original_name || item.original_title,
        tagline: tmdbData.tagline || item.tagline || '',
        overview: tmdbData.overview || item.overview || '',
        rating: tmdbData.vote_average ? Number(tmdbData.vote_average.toFixed(1)) : item.rating,
        release_date: tmdbData.release_date || tmdbData.first_air_date || item.release_date || '',
        genres: genres.length > 0 ? genres : item.genres,
        poster: tmdbData.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}` : item.poster,
        backdrop: tmdbData.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tmdbData.backdrop_path}` : item.backdrop,
        trailer: trailerUrl,
        cast: castNames,
        cast_details: castMembers.length > 0 ? castMembers : item.cast_details,
        total_seasons: tmdbData.number_of_seasons || item.total_seasons,
        total_episodes: tmdbData.number_of_episodes || item.total_episodes,
        seasons: seasons.length > 0 ? seasons : item.seasons
      };
    } catch (err: any) {
      console.warn(`[TMDB Enrich Error]: ${err.message}`);
      return item;
    }
  }
}
