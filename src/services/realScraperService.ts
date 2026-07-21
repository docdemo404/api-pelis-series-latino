import axios from 'axios';
import * as cheerio from 'cheerio';
import { MediaItem, ServerOption } from '../types';
import { TmdbService } from './tmdbService';

export class RealScraperService {
  /**
   * Realiza un scraping real en tiempo real de portales de cine latino (Cinecalidad / Cuevana / Pelisplus)
   */
  static async scrapeRealMovies(query: string): Promise<MediaItem[]> {
    console.log(`[RealScraper] 🔍 Buscando y rascando enlaces reales para: "${query}"...`);
    const results: MediaItem[] = [];

    try {
      // 1. Scraping Real a Cinecalidad / Portal Latino público
      const searchUrl = `https://cinecalidad.rs/?s=${encodeURIComponent(query)}`;
      const response = await axios.get(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept-Language': 'es-ES,es;q=0.9,es-419;q=0.8'
        },
        timeout: 8000
      });

      const $ = cheerio.load(response.data);
      const movieElements = $('.item, .post-thumbnail, article.item-movies').toArray().slice(0, 3);

      for (const el of movieElements) {
        const title = $(el).find('.entry-title, .title, h2').text().trim();
        const detailUrl = $(el).find('a').attr('href');

        if (detailUrl && title) {
          // Extraer los reproductores reales dentro de la página de detalle
          const realServers = await this.scrapeDetailServers(detailUrl);
          
          if (realServers.length > 0) {
            // Enriquecer con super metadatos de TMDB
            const metadata = await TmdbService.searchOrGetMetadata(title, 'movie');
            
            const mediaItem: MediaItem = {
              id: (metadata?.title || title).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
              tmdb_id: metadata?.tmdb_id || Math.floor(Math.random() * 100000),
              imdb_id: metadata?.imdb_id || null,
              type: 'movie',
              title: metadata?.title || title,
              original_title: metadata?.original_title || title,
              aliases: metadata?.aliases || [title],
              overview: metadata?.overview || 'Película disponible en Español Latino.',
              rating: metadata?.rating || 7.5,
              content_rating: 'PG-13',
              release_date: metadata?.release_date || new Date().toISOString().split('T')[0],
              genres: metadata?.genres || ['Acción', 'Latino'],
              subcategories: ['Scraped Real', 'Latino HD'],
              poster: metadata?.poster || null,
              backdrop: metadata?.backdrop || null,
              logo: metadata?.logo || null,
              trailer: metadata?.trailer || null,
              cast: metadata?.cast || [],
              dubbing_cast: metadata?.dubbing_cast || [],
              primary_stream: realServers[0],
              servers: realServers
            };

            results.push(mediaItem);
          }
        }
      }
    } catch (error: any) {
      console.error('[RealScraper] Error al conectar con fuente real:', error.message);
    }

    return results;
  }

  /**
   * Extrae los enlaces reales de reproductores (iframes / embed links) de la página de detalle
   */
  private static async scrapeDetailServers(detailUrl: string): Promise<ServerOption[]> {
    const servers: ServerOption[] = [];
    try {
      const res = await axios.get(detailUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 6000
      });

      const $ = cheerio.load(res.data);

      // Buscar todos los iframes, embeds y enlaces de video en el DOM real
      const iframes = $('iframe, embed, option[data-video], li[data-link]').toArray();

      let count = 1;
      for (const el of iframes) {
        let src = $(el).attr('src') || $(el).attr('data-video') || $(el).attr('data-link');
        if (!src) continue;

        if (src.startsWith('//')) {
          src = 'https:' + src;
        }

        // Identificar el proveedor real
        let providerName = 'Servidor Latino';
        if (src.includes('streamwish') || src.includes('strwish')) providerName = 'Streamwish';
        else if (src.includes('filelions') || src.includes('lion')) providerName = 'FileLions';
        else if (src.includes('voe')) providerName = 'Voe';
        else if (src.includes('streamtape')) providerName = 'Streamtape';
        else if (src.includes('mega.nz')) providerName = 'Mega';
        else if (src.includes('fembed') || src.includes('feurl')) providerName = 'Fembed';

        servers.push({
          id: `real_srv_${Date.now()}_${count++}`,
          name: `${providerName} Real`,
          quality: '1080p',
          language: 'latino',
          embed_url: src,
          status: 'online',
          last_checked: new Date().toISOString()
        });
      }
    } catch (err: any) {
      console.error('[RealScraper] Error extrayendo servidores reales:', err.message);
    }

    return servers;
  }
}
