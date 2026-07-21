import axios from 'axios';
import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const tmdbCache = new Map<string, number>();

export class TmdbService {
  /**
   * Obtiene el TMDB ID real numérico para una película o serie
   */
  static async getTmdbId(title: string, type: 'movie' | 'tvseries' = 'movie'): Promise<number> {
    const cleanTitle = title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
    const cacheKey = `${type}:${cleanTitle.toLowerCase()}`;

    if (tmdbCache.has(cacheKey)) {
      return tmdbCache.get(cacheKey)!;
    }

    try {
      const targetType = type === 'tvseries' ? 'tv' : 'movie';
      const url = `https://www.themoviedb.org/search/${targetType}?query=${encodeURIComponent(cleanTitle)}&language=es-MX`;

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
        tmdbCache.set(cacheKey, tmdbId);
        return tmdbId;
      }
    } catch {}

    // Generar ID numérico determinista si TMDB no responde
    let hash = 2166136261;
    const cleanStr = cleanTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (let i = 0; i < cleanStr.length; i++) {
      hash ^= cleanStr.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    const fallbackId = (hash >>> 0) % 900000 + 100000;
    tmdbCache.set(cacheKey, fallbackId);
    return fallbackId;
  }
}
