import axios from 'axios';
import * as cheerio from 'cheerio';
import { MediaItem, ServerOption, CastMember } from '../types';

const BASE_URL = 'https://tioplus.app';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT = 8000;

function httpGet(url: string) {
  return axios.get(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9',
      'Referer': BASE_URL,
    },
    timeout: TIMEOUT,
  });
}

/**
 * Decodifica el token Base64 de data-server para obtener la URL del iframe embed.
 * TioPlus codifica en Base64 (a veces doble) las URLs de los reproductores.
 */
function decodeServerToken(encoded: string): string | null {
  try {
    let decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    // A veces es doble Base64
    if (/^[A-Za-z0-9+/=]+$/.test(decoded) && decoded.length > 20) {
      decoded = Buffer.from(decoded, 'base64').toString('utf-8');
    }
    // Buscar URL dentro del decoded string
    const urlMatch = decoded.match(/https?:\/\/[^\s"'<>]+/);
    if (urlMatch) return urlMatch[0];
    // Si el decoded string parece una URL sin protocolo
    if (decoded.includes('.') && decoded.includes('/')) {
      return decoded.startsWith('//') ? `https:${decoded}` : decoded;
    }
    return decoded.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Extrae el nombre del servidor embed a partir de su URL
 */
function getServerName(url: string, label?: string): string {
  if (label) return label.trim();
  if (url.includes('streamwish')) return 'Streamwish';
  if (url.includes('filelions')) return 'FileLions';
  if (url.includes('voe')) return 'Voe';
  if (url.includes('doodstream') || url.includes('dood')) return 'DoodStream';
  if (url.includes('upstream')) return 'Upstream';
  if (url.includes('mp4upload')) return 'MP4Upload';
  if (url.includes('embed')) return 'EmbedPlayer';
  if (url.includes('upfast') || url.includes('upf')) return 'UPFAST';
  if (url.includes('earnvids')) return 'Earnvids';
  if (url.includes('tioplus')) return 'TioPlus';
  if (url.includes('p2p')) return 'P2P';
  return 'Servidor Latino';
}

export class RealScraperService {
  /**
   * Scrapea la homepage de TioPlus para obtener las últimas películas y series REALES
   */
  static async scrapeLatest(type: 'peliculas' | 'series' | 'animes' = 'peliculas', limit = 20): Promise<MediaItem[]> {
    try {
      const url = type === 'peliculas' ? `${BASE_URL}/peliculas` : `${BASE_URL}/${type}`;
      const res = await httpGet(url);
      const $ = cheerio.load(res.data);
      const items: MediaItem[] = [];

      $('article.item').each((i, el) => {
        if (items.length >= limit) return false;

        const $el = $(el);
        const linkEl = $el.find('a.itemA').first();
        const href = linkEl.attr('href') || '';
        const imgEl = $el.find('img').first();
        const poster = imgEl.attr('data-src') || imgEl.attr('src') || null;
        const titleText = $el.find('.title_over span').first().text().trim();

        if (!href || !titleText) return;

        // Extraer año del título "Scary Movie 6 (2026)"
        const yearMatch = titleText.match(/\((\d{4})\)/);
        const year = yearMatch ? yearMatch[1] : '';
        const cleanTitle = titleText.replace(/\s*\(\d{4}\)\s*$/, '').trim();
        const slug = href.split('/').filter(Boolean).pop() || cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-');

        const contentType = href.includes('/serie/') || href.includes('/anime/') ? 'tvseries' as const : 'movie' as const;

        items.push({
          id: slug,
          tmdb_id: 0,
          imdb_id: null,
          type: contentType,
          title: cleanTitle,
          original_title: cleanTitle,
          aliases: [cleanTitle],
          overview: `Ver ${cleanTitle} online gratis en HD con audio Latino.`,
          rating: 0,
          release_date: year,
          genres: [],
          subcategories: ['Latino HD'],
          poster: poster && !poster.includes('placeholder') ? poster : null,
          backdrop: null,
          logo: null,
          trailer: null,
          cast: [],
          dubbing_cast: [],
          servers: [],
          _tioplus_url: href,
        } as MediaItem & { _tioplus_url: string });
      });

      return items;
    } catch (err: any) {
      console.error(`[TioPlus] Error scrapeando ${type}:`, err.message);
      return [];
    }
  }

  /**
   * Scrapea el homepage completo de TioPlus (slider + todas las secciones)
   */
  static async scrapeHomepage(): Promise<MediaItem[]> {
    try {
      const res = await httpGet(BASE_URL);
      const $ = cheerio.load(res.data);
      const items: MediaItem[] = [];
      const seenSlugs = new Set<string>();

      // 1. Slider principal (las películas destacadas)
      $('.swiper-slide article, .home__slider_index .swiper-slide').each((i, el) => {
        const $el = $(el);
        const linkEl = $el.find('a.itemA').first();
        const href = linkEl.attr('href') || '';
        const h2Text = $el.find('h2').first().text().trim();
        const description = $el.find('.description p').first().text().trim();
        const bgStyle = $el.find('.bg').attr('style') || '';
        const bgMatch = bgStyle.match(/url\("?([^"')]+)"?\)/);
        const backdrop = bgMatch ? bgMatch[1] : null;

        if (!href || !h2Text) return;

        const yearMatch = h2Text.match(/\((\d{4})\)/);
        const year = yearMatch ? yearMatch[1] : '';
        const cleanTitle = h2Text.replace(/\s*\(\d{4}\)\s*$/, '').trim();
        const slug = href.split('/').filter(Boolean).pop() || '';

        if (seenSlugs.has(slug)) return;
        seenSlugs.add(slug);

        const contentType = href.includes('/serie/') || href.includes('/anime/') ? 'tvseries' as const : 'movie' as const;

        items.push({
          id: slug,
          tmdb_id: 0,
          imdb_id: null,
          type: contentType,
          title: cleanTitle,
          original_title: cleanTitle,
          aliases: [cleanTitle],
          overview: description || `Ver ${cleanTitle} online gratis en HD.`,
          rating: 0,
          release_date: year,
          genres: [],
          subcategories: ['Destacado', 'Latino HD'],
          poster: backdrop ? backdrop.replace('w1280', 'w342') : null,
          backdrop,
          logo: null,
          trailer: null,
          cast: [],
          dubbing_cast: [],
          servers: [],
          _tioplus_url: href,
        } as MediaItem & { _tioplus_url: string });
      });

      // 2. Secciones del homepage (articles normales)
      $('article.item').each((i, el) => {
        const $el = $(el);
        const linkEl = $el.find('a.itemA').first();
        const href = linkEl.attr('href') || '';
        const imgEl = $el.find('img').first();
        const poster = imgEl.attr('data-src') || imgEl.attr('src') || null;
        const titleText = $el.find('.title_over span').first().text().trim();

        if (!href || !titleText) return;

        const slug = href.split('/').filter(Boolean).pop() || '';
        if (seenSlugs.has(slug)) return;
        seenSlugs.add(slug);

        const yearMatch = titleText.match(/\((\d{4})\)/);
        const year = yearMatch ? yearMatch[1] : '';
        const cleanTitle = titleText.replace(/\s*\(\d{4}\)\s*$/, '').trim();
        const contentType = href.includes('/serie/') || href.includes('/anime/') || href.includes('/dorama/')
          ? 'tvseries' as const : 'movie' as const;

        items.push({
          id: slug,
          tmdb_id: 0,
          imdb_id: null,
          type: contentType,
          title: cleanTitle,
          original_title: cleanTitle,
          aliases: [cleanTitle],
          overview: `Ver ${cleanTitle} online gratis en HD con audio Latino.`,
          rating: 0,
          release_date: year,
          genres: [],
          subcategories: ['Latino HD'],
          poster: poster && !poster.includes('placeholder') ? poster : null,
          backdrop: null,
          logo: null,
          trailer: null,
          cast: [],
          dubbing_cast: [],
          servers: [],
          _tioplus_url: href,
        } as MediaItem & { _tioplus_url: string });
      });

      return items;
    } catch (err: any) {
      console.error('[TioPlus] Error scrapeando homepage:', err.message);
      return [];
    }
  }

  /**
   * Scrapea el detalle completo de una película/serie desde TioPlus.
   * Extrae metadatos reales + servidores de streaming con tokens Base64.
   */
  static async scrapeDetail(tioplusUrl: string): Promise<MediaItem | null> {
    try {
      const res = await httpGet(tioplusUrl);
      const $ = cheerio.load(res.data);

      // === METADATOS ===
      const h1 = $('h1.slugh1').first().text().trim() || $('h1').first().text().trim();
      const yearMatch = h1.match(/\((\d{4})\)/);
      const year = yearMatch ? yearMatch[1] : '';
      const title = h1.replace(/\s*\(\d{4}\)\s*$/, '').trim();
      const slug = tioplusUrl.split('/').filter(Boolean).pop() || title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

      const overview = $('.description p').first().text().trim();
      const originalTitle = $('.genres:has(b:contains("Titulo Original")) h2').text().trim() || title;

      // Rating
      const ratingText = $('span:contains("Rating:")').text();
      const ratingMatch = ratingText.match(/Rating:\s*([\d.]+)/);
      const rating = ratingMatch ? parseFloat(ratingMatch[1]) : 0;

      // Géneros
      const genres: string[] = [];
      $('.genres:has(b:contains("Generos")) a').each((_, el) => {
        genres.push($(el).text().trim());
      });

      // Poster (og:image fallback)
      const ogImage = $('meta[property="og:image"]').attr('content') || null;
      const posterUrl = ogImage ? ogImage.replace('/original/', '/w342/') : null;
      const backdropUrl = ogImage ? ogImage.replace('/w342/', '/w1280/').replace('/original/', '/w1280/') : null;

      // Background del slider
      const bgStyle = $('.bg').first().attr('style') || '';
      const bgMatch = bgStyle.match(/url\("?([^"')]+)"?\)/);
      const backdrop = bgMatch ? bgMatch[1] : backdropUrl;

      // Cast/Actores
      const cast: CastMember[] = [];
      $('.genres:has(b:contains("Actores")) a').each((_, el) => {
        cast.push({
          name: $(el).text().trim(),
          character: '',
          photo: null,
        });
      });

      // Director
      const director = $('.genres:has(b:contains("Director")) p').first().text().trim();

      // Tipo
      const isMovie = tioplusUrl.includes('/pelicula/');
      const contentType = isMovie ? 'movie' as const : 'tvseries' as const;

      // === SERVIDORES DE STREAMING (datos REALES) ===
      const servers: ServerOption[] = [];
      let serverCount = 0;

      // Los servidores están en <li data-server="BASE64_TOKEN">
      $('li[data-server]').each((_, el) => {
        const $li = $(el);
        const encodedToken = $li.attr('data-server') || '';
        if (!encodedToken) return;

        const labelSpan = $li.find('span').first().text().trim();
        const decodedUrl = decodeServerToken(encodedToken);

        serverCount++;
        servers.push({
          id: `srv_tio_${slug}_${serverCount}`,
          name: labelSpan || `Servidor ${serverCount}`,
          quality: '1080p',
          language: 'latino',
          embed_url: decodedUrl || `${BASE_URL}/player/${encodedToken}`,
          status: 'online',
          last_checked: new Date().toISOString(),
        });
      });

      // También extraer el data-tr del player principal
      const playerTr = $('[data-tr]').first().attr('data-tr');
      if (playerTr && servers.length === 0) {
        const decodedUrl = decodeServerToken(playerTr);
        servers.push({
          id: `srv_tio_${slug}_main`,
          name: 'Reproductor Principal',
          quality: '1080p',
          language: 'latino',
          embed_url: decodedUrl || `${BASE_URL}/player/${playerTr}`,
          status: 'online',
          last_checked: new Date().toISOString(),
        });
      }

      // Detectar idioma del tab activo
      const activeTab = $('button.active.button').text().trim().toLowerCase();
      const language = activeTab.includes('subtitulado') ? 'subtitulado'
        : activeTab.includes('castellano') ? 'castellano' : 'latino';

      // Actualizar idioma de los servidores
      servers.forEach(s => { s.language = language as any; });

      const item: MediaItem = {
        id: slug,
        tmdb_id: 0,
        imdb_id: null,
        type: contentType,
        title,
        original_title: originalTitle,
        aliases: [title, originalTitle].filter(Boolean),
        tagline: director ? `Dirigida por ${director}` : '',
        overview: overview || `Ver ${title} online gratis en HD con audio Latino.`,
        rating,
        content_rating: 'PG-13',
        release_date: year,
        genres,
        subcategories: ['Latino HD', 'TioPlus'],
        poster: posterUrl,
        backdrop: backdrop || null,
        logo: null,
        trailer: null,
        cast,
        dubbing_cast: [],
        primary_stream: servers[0] || undefined,
        servers,
      };

      return item;
    } catch (err: any) {
      console.error('[TioPlus] Error scrapeando detalle:', err.message);
      return null;
    }
  }

  /**
   * Busca películas/series en TioPlus por título.
   * Scrapea el listado y devuelve resultados REALES.
   */
  static async scrapeRealMovies(query: string): Promise<MediaItem[]> {
    const q = query.trim();
    if (!q) return [];

    try {
      // TioPlus usa /search?s=QUERY para búsquedas
      const searchUrl = `${BASE_URL}/search?s=${encodeURIComponent(q)}`;
      const res = await httpGet(searchUrl);
      const $ = cheerio.load(res.data);
      const results: MediaItem[] = [];

      $('article.item').each((i, el) => {
        if (results.length >= 10) return false;

        const $el = $(el);
        const linkEl = $el.find('a.itemA').first();
        const href = linkEl.attr('href') || '';
        const imgEl = $el.find('img').first();
        const poster = imgEl.attr('data-src') || imgEl.attr('src') || null;
        const titleText = $el.find('.title_over span').first().text().trim()
          || imgEl.attr('alt')?.replace(/^Ver\s+/, '') || '';

        if (!href || !titleText) return;

        const yearMatch = titleText.match(/\((\d{4})\)/);
        const year = yearMatch ? yearMatch[1] : '';
        const cleanTitle = titleText.replace(/\s*\(\d{4}\)\s*$/, '').trim();
        const slug = href.split('/').filter(Boolean).pop() || '';

        const contentType = href.includes('/serie/') || href.includes('/anime/') || href.includes('/dorama/')
          ? 'tvseries' as const : 'movie' as const;

        results.push({
          id: slug,
          tmdb_id: 0,
          imdb_id: null,
          type: contentType,
          title: cleanTitle,
          original_title: cleanTitle,
          aliases: [cleanTitle],
          overview: `Ver ${cleanTitle} online gratis en HD con audio Latino.`,
          rating: 0,
          release_date: year,
          genres: [],
          subcategories: ['Latino HD'],
          poster: poster && !poster.includes('placeholder') ? poster : null,
          backdrop: null,
          logo: null,
          trailer: null,
          cast: [],
          dubbing_cast: [],
          servers: [],
          _tioplus_url: href,
        } as MediaItem & { _tioplus_url: string });
      });

      // Si hay un resultado exacto, traer sus servidores de detalle
      if (results.length > 0) {
        const firstUrl = (results[0] as any)._tioplus_url;
        if (firstUrl) {
          const detailed = await this.scrapeDetail(firstUrl);
          if (detailed) {
            results[0] = { ...results[0], ...detailed };
          }
        }
      }

      return results;
    } catch (err: any) {
      console.error('[TioPlus] Error buscando:', err.message);
      return [];
    }
  }
}
