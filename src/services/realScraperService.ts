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
 * Resuelve un token data-server en la URL real del iframe embed.
 * Flujo: data-server -> btoa(token) -> /player/ENCODED -> HTML con iframe src
 */
async function resolvePlayerUrl(dataServerToken: string, referer: string): Promise<string | null> {
  try {
    // El JS del sitio hace: /player/ + btoa(dataServerToken)
    const encodedForUrl = Buffer.from(dataServerToken).toString('base64');
    const playerPageUrl = `${BASE_URL}/player/${encodedForUrl}`;

    const res = await httpGet(playerPageUrl);
    const html = typeof res.data === 'string' ? res.data : '';

    // Buscar iframe src en la respuesta
    const $ = cheerio.load(html);
    const iframeSrc = $('iframe').attr('src') || $('iframe').attr('data-src');
    if (iframeSrc) {
      return iframeSrc.startsWith('//') ? `https:${iframeSrc}` : iframeSrc;
    }

    // Buscar URLs de embed en el HTML raw (excluir las propias del sitio)
    const urlMatches = html.match(/https?:\/\/[^\s"'<>]+/g) || [];
    const embedUrl = urlMatches.find((u: string) =>
      !u.includes('tioplus') && !u.includes('cloudflare') && !u.includes('tmdb') &&
      !u.includes('google') && !u.includes('facebook') && !u.includes('fonts.googleapis') &&
      !u.includes('disqus') && !u.includes('llvpn') && !u.includes('amung')
    );
    return embedUrl || null;
  } catch {
    return null;
  }
}

/**
 * Extrae el nombre del servidor embed a partir de su URL o label
 */
function getServerName(url: string, label?: string): string {
  if (label) return label.trim();
  const host = url.toLowerCase();
  if (host.includes('vidhide')) return 'VidHide';
  if (host.includes('streamwish')) return 'Streamwish';
  if (host.includes('filelions')) return 'FileLions';
  if (host.includes('voe')) return 'Voe';
  if (host.includes('doodstream') || host.includes('dood')) return 'DoodStream';
  if (host.includes('upstream')) return 'Upstream';
  if (host.includes('mp4upload')) return 'MP4Upload';
  if (host.includes('upfast') || host.includes('upf')) return 'UPFAST';
  if (host.includes('earnvids')) return 'Earnvids';
  if (host.includes('p2p')) return 'P2P';
  if (host.includes('mixdrop')) return 'MixDrop';
  if (host.includes('lulustream')) return 'LuluStream';
  return 'Servidor Latino';
}

/**
 * Extrae el slug canónico de cualquier URL de TioPlus (evita números de episodios o temporadas como slug)
 */
function extractCanonicalSlug(href: string): string {
  if (!href) return '';
  const match = href.match(/\/(pelicula|serie|anime|dorama)\/([^\/]+)/i);
  if (match) return match[2];
  const parts = href.split('/').filter(Boolean);
  return parts.pop() || '';
}

export class RealScraperService {
  /**
   * Scrapea el homepage completo de TioPlus (slider + secciones)
   */
  static async scrapeHomepage(): Promise<MediaItem[]> {
    try {
      const res = await httpGet(BASE_URL);
      const $ = cheerio.load(res.data);
      const items: MediaItem[] = [];
      const seenSlugs = new Set<string>();

      // 1. Slider principal (películas destacadas)
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
        const slug = extractCanonicalSlug(href);

        if (!slug || seenSlugs.has(slug)) return;
        seenSlugs.add(slug);

        const contentType = href.includes('/serie/') || href.includes('/anime/')
          ? 'tvseries' as const : 'movie' as const;

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
        } as any);
      });

      // 2. Secciones normales (articles)
      $('article.item').each((i, el) => {
        const $el = $(el);
        const linkEl = $el.find('a.itemA').first();
        const href = linkEl.attr('href') || '';
        const imgEl = $el.find('img').first();
        const poster = imgEl.attr('data-src') || imgEl.attr('src') || null;
        const titleText = $el.find('.title_over span').first().text().trim();

        if (!href || !titleText) return;

        const slug = extractCanonicalSlug(href);
        if (!slug || seenSlugs.has(slug)) return;
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
        } as any);
      });

      return items;
    } catch (err: any) {
      console.error('[TioPlus] Error scrapeando homepage:', err.message);
      return [];
    }
  }

  /**
   * Scrapea el detalle de una película/serie y resuelve los servidores embed REALES.
   * Cada token data-server se resuelve a una URL de iframe real (vidhideplus, streamwish, etc).
   */
  static async scrapeDetail(tioplusUrl: string): Promise<MediaItem | null> {
    try {
      const res = await httpGet(tioplusUrl);
      const $ = cheerio.load(res.data);

      // === METADATOS ===
      const h1 = $('h1.slugh1').first().text().trim() || $('h1').first().text().trim() || $('h2').first().text().trim() || $('title').text().trim();
      if (!h1) return null;

      const yearMatch = h1.match(/\((\d{4})\)/);
      const year = yearMatch ? yearMatch[1] : '';
      const title = h1.replace(/\s*\(\d{4}\)\s*$/, '').trim();
      const slug = tioplusUrl.split('/').filter(Boolean).pop() || title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

      const overview = $('.description p').first().text().trim();
      const originalTitle = $('h2').filter((_, el) => {
        return $(el).parent().find('b').text().includes('Titulo Original');
      }).text().trim() || title;

      // Rating
      const ratingText = $('span:contains("Rating:")').text();
      const ratingMatch = ratingText.match(/Rating:\s*([\d.]+)/);
      const rating = ratingMatch ? parseFloat(ratingMatch[1]) : 0;

      // Géneros
      const genres: string[] = [];
      $('a[href*="/genero/"]').each((_, el) => {
        const g = $(el).text().trim();
        if (g && !genres.includes(g)) genres.push(g);
      });

      // Poster & Backdrop
      const ogImage = $('meta[property="og:image"]').attr('content') || null;
      const posterUrl = ogImage ? ogImage.replace('/original/', '/w342/') : null;
      const bgStyle = $('.bg').first().attr('style') || '';
      const bgMatch = bgStyle.match(/url\("?([^"')]+)"?\)/);
      const backdrop = bgMatch ? bgMatch[1] : (ogImage || null);

      // Cast
      const cast: CastMember[] = [];
      $('a[href*="/actor/"]').each((_, el) => {
        cast.push({ name: $(el).text().trim(), character: '', photo: null });
      });

      // Director
      const directorEl = $('b:contains("Director")').parent().parent();
      const director = directorEl.find('p').first().text().trim();

      // Tipo
      const isMovie = tioplusUrl.includes('/pelicula/');
      const contentType = isMovie ? 'movie' as const : 'tvseries' as const;

      // === SERVIDORES DE STREAMING REALES ===
      const servers: ServerOption[] = [];
      const serverTokens: Array<{ token: string; label: string }> = [];

      $('li[data-server]').each((_, el) => {
        const token = $(el).attr('data-server') || '';
        const label = $(el).find('span').first().text().trim();
        if (token) serverTokens.push({ token, label });
      });

      // También el data-tr del player principal si no hay li[data-server]
      if (serverTokens.length === 0) {
        const playerTr = $('[data-tr]').first().attr('data-tr');
        if (playerTr) serverTokens.push({ token: playerTr, label: 'Reproductor Principal' });
      }

      // Resolver los tokens en paralelo (max 3 para no saturar)
      const tokensToResolve = serverTokens.slice(0, 5);
      const resolvedUrls = await Promise.allSettled(
        tokensToResolve.map(t => resolvePlayerUrl(t.token, tioplusUrl))
      );

      resolvedUrls.forEach((result, i) => {
        const embedUrl = result.status === 'fulfilled' ? result.value : null;
        const label = tokensToResolve[i].label;

        if (embedUrl) {
          servers.push({
            id: `srv_tio_${slug}_${i + 1}`,
            name: `${getServerName(embedUrl, '')} - ${label}`,
            quality: '1080p',
            language: 'latino',
            embed_url: embedUrl,
            status: 'online',
            last_checked: new Date().toISOString(),
          });
        }
      });

      // Detectar idioma del tab activo
      const activeTab = $('button.active.button').text().trim().toLowerCase();
      const language = activeTab.includes('subtitulado') ? 'subtitulado'
        : activeTab.includes('castellano') ? 'castellano' : 'latino';
      servers.forEach(s => { s.language = language as any; });

      // === TEMPORADAS Y EPISODIOS PARA SERIES ===
      let seasons: any[] = [];
      let totalSeasons = 0;
      let totalEpisodes = 0;

      if (!isMovie) {
        const rawHtml = typeof res.data === 'string' ? res.data : '';
        const seasonsMatch = rawHtml.match(/const\s+seasonsJson\s*=\s*(\{[\s\S]*?\});/);
        if (seasonsMatch) {
          try {
            const rawSeasons = JSON.parse(seasonsMatch[1]);
            const seasonKeys = Object.keys(rawSeasons);
            totalSeasons = seasonKeys.length;

            seasons = seasonKeys.map(sNum => {
              const epsRaw = rawSeasons[sNum] || [];
              totalEpisodes += epsRaw.length;
              const firstEpImage = epsRaw[0]?.image ? `https://image.tmdb.org/t/p/w500${epsRaw[0].image}` : posterUrl;

              return {
                season_number: parseInt(sNum),
                name: `Temporada ${sNum}`,
                episodes_count: epsRaw.length,
                poster: firstEpImage || posterUrl,
                episodes: epsRaw.map((e: any) => {
                  const epNum = e.episode;
                  const epName = e.title || `Episodio ${epNum}`;
                  const stillPath = e.image ? `https://image.tmdb.org/t/p/w500${e.image}` : (posterUrl || null);
                  return {
                    episode_number: epNum,
                    name: epName,
                    overview: `Episodio ${epNum}: "${epName}" de ${title}. Disponible en calidad HD con audio Español Latino.`,
                    still_path: stillPath,
                    air_date: year ? `${year}-01-01` : new Date().toISOString().split('T')[0],
                    servers: []
                  };
                })
              };
            });
          } catch (e) {}
        }
      }

      return {
        id: slug,
        tmdb_id: 0,
        imdb_id: null,
        type: contentType,
        title,
        original_title: originalTitle,
        aliases: [title, originalTitle].filter((v, i, a) => a.indexOf(v) === i),
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
        servers: isMovie ? servers : (servers.length > 0 ? servers : undefined),
        total_seasons: totalSeasons || undefined,
        total_episodes: totalEpisodes || undefined,
        seasons: seasons.length > 0 ? seasons : undefined,
      };
    } catch (err: any) {
      console.error('[TioPlus] Error scrapeando detalle:', err.message);
      return null;
    }
  }

  /**
   * Scrapea los servidores reales de un episodio específico de una serie
   */
  static async scrapeEpisodeDetail(seriesSlug: string, season: number, episode: number) {
    const episodeUrl = `${BASE_URL}/serie/${seriesSlug}/season/${season}/episode/${episode}`;
    const detail = await this.scrapeDetail(episodeUrl);
    if (!detail) return null;
    return {
      series_id: seriesSlug,
      season_number: season,
      episode_number: episode,
      primary_stream: detail.primary_stream,
      servers: detail.servers || []
    };
  }

  /**
   * Busca en TioPlus usando su API interna /api/search/QUERY
   * Devuelve resultados REALES con soporte de filtrado inteligente multi-palabra (evita colisiones de lematización y prefijos)
   */
  static async scrapeRealMovies(query: string): Promise<MediaItem[]> {
    const q = query.trim();
    if (!q) return [];

    // Helper interno para buscar una palabra en TioPlus
    const fetchSearchHtml = async (searchTerm: string): Promise<MediaItem[]> => {
      try {
        const searchUrl = `${BASE_URL}/api/search/${encodeURIComponent(searchTerm)}`;
        const res = await httpGet(searchUrl);
        const $ = cheerio.load(res.data);
        const items: MediaItem[] = [];

        $('article.item, .search-result, a[href*="/pelicula/"], a[href*="/serie/"], a[href*="/anime/"]').each((_, el) => {
          if (items.length >= 10) return false;
          const $el = $(el);
          let href = $el.attr('href') || $el.find('a').first().attr('href') || '';
          if (!href || (!href.includes('/pelicula/') && !href.includes('/serie/') && !href.includes('/anime/'))) return;

          const slug = extractCanonicalSlug(href);
          if (!slug || items.some(r => r.id === slug)) return;

          const imgEl = $el.find('img').first();
          const poster = imgEl.attr('data-src') || imgEl.attr('src') || null;
          let titleText = $el.find('.title_over span, h2, h3, .title').first().text().trim()
            || imgEl.attr('alt')?.replace(/^Ver\s+/, '') || '';

          if (!titleText) titleText = $el.text().trim().split('\n')[0];
          if (!titleText) return;

          const yearMatch = titleText.match(/\((\d{4})\)/);
          const year = yearMatch ? yearMatch[1] : '';
          const cleanTitle = titleText.replace(/\s*\(\d{4}\)\s*$/, '').trim();
          const contentType = href.includes('/serie/') || href.includes('/anime/')
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
          } as any);
        });

        return items;
      } catch {
        return [];
      }
    };

    // 1. Intentar búsqueda directa completa
    let results = await fetchSearchHtml(q);

    // 2. Si es una búsqueda multi-palabra y devolvió 0 resultados (debido a lematización/prefijos/stopwords)
    if (results.length === 0 && q.includes(' ')) {
      const STOPWORDS = new Set(['de', 'el', 'la', 'los', 'las', 'un', 'una', 'y', 'en', 'del', 'a', 'of', 'the', 'in', 'and']);
      const tokens = q.toLowerCase().split(/\s+/).filter(t => t.length > 0);
      const significantTokens = tokens.filter(t => !STOPWORDS.has(t) && t.length > 1);
      const searchCandidates = significantTokens.length > 0 ? significantTokens : tokens;

      const candidates: MediaItem[] = [];
      for (const token of searchCandidates) {
        const items = await fetchSearchHtml(token);
        candidates.push(...items);
      }

      // Post-filtrado estricto local: Cada token significativo DEBE estar presente en el título
      const filtered = candidates.filter(item => {
        const titleLower = item.title.toLowerCase();
        return searchCandidates.every(token => titleLower.includes(token));
      });

      // Eliminar duplicados
      const seen = new Set<string>();
      results = filtered.filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
    }

    // 3. Resolver servidores del primer resultado si existe
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
  }

  /**
   * Scrapea el listado de películas, series o animes
   */
  static async scrapeLatest(type: 'peliculas' | 'series' | 'animes' = 'peliculas', limit = 20): Promise<MediaItem[]> {
    try {
      const url = `${BASE_URL}/${type}`;
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

        const yearMatch = titleText.match(/\((\d{4})\)/);
        const year = yearMatch ? yearMatch[1] : '';
        const cleanTitle = titleText.replace(/\s*\(\d{4}\)\s*$/, '').trim();
        const slug = href.split('/').filter(Boolean).pop() || '';

        const contentType = type === 'peliculas' ? 'movie' as const : 'tvseries' as const;

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
        } as any);
      });

      return items;
    } catch (err: any) {
      console.error(`[TioPlus] Error scrapeando ${type}:`, err.message);
      return [];
    }
  }
}
