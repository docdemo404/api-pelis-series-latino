import axios from 'axios';
import * as cheerio from 'cheerio';
import { MediaItem, ServerOption, CastMember } from '../types';
import { SourceManager } from './sourceManager';
import { TmdbService } from './tmdbService';

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

const SOFT_ERROR_PATTERNS = [
  /file is no longer available/i,
  /expired or has been deleted/i,
  /player_blank\.jpg/i,
  /file not found/i,
  /file deleted/i,
  /video (has been|was) (deleted|removed)/i,
  /disabled due to copyright/i,
  /content removed/i,
  /video no disponible/i,
  /archivo (eliminado|no encontrado)/i,
  /file_deleted/i,
  /video_not_found/i,
  /404 not found/i,
  /this video (is|was) deleted/i,
  /media not found/i,
  /can't find the file/i,
  /we're sorry/i,
  /got deleted by the owner/i,
  /removed due a copyright/i,
  /copyright violation/i,
  /file you are looking for/i,
  /too many requests/i
];

/**
 * Verifica el estado real en la capa de aplicación de un iframe embed (detecta Soft Errors HTTP 200 y distingue WAF HTTP 403)
 */
async function verifyEmbedStatus(embedUrl: string): Promise<'online' | 'offline'> {
  if (!embedUrl) return 'offline';
  try {
    // 0. Detectar reproductores SPA basados en HASH (#hash_id) ej. upns.pro, rpmstream.live, 4meplayer.pro, strp2p.com
    const hashMatch = embedUrl.match(/https?:\/\/([^\/#]+)\/.*?#([a-zA-Z0-9_-]+)/);
    if (hashMatch) {
      const domain = hashMatch[1];
      const hashId = hashMatch[2];
      const apiUrl = `https://${domain}/api/v1/info?id=${hashId}`;
      try {
        const hashRes = await axios.get(apiUrl, {
          headers: { 'User-Agent': UA, 'Referer': embedUrl },
          timeout: 4000,
          validateStatus: () => true
        });
        const dataStr = typeof hashRes.data === 'string' ? hashRes.data : JSON.stringify(hashRes.data || '');
        if (hashRes.status !== 200 || dataStr.length < 3600 || dataStr.includes('error') || dataStr.includes('not found')) {
          return 'offline';
        }
      } catch {
        return 'offline';
      }
    }

    const res = await axios.get(embedUrl, {
      headers: {
        'User-Agent': UA,
        'Referer': BASE_URL,
      },
      timeout: 4000,
      validateStatus: () => true
    });

    // WAF / Anti-hotlink protection (ej. VidHide, StreamWish devuelven 403 Forbidden a scrapers automatizados pero funcionan 100% en navegador web)
    if (res.status === 403 || res.status === 401) {
      return 'online';
    }

    if (res.status >= 400) return 'offline';

    const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '');

    // Detectar mensajes de error en capa de aplicación (Soft Errors)
    for (const pattern of SOFT_ERROR_PATTERNS) {
      if (pattern.test(html)) {
        return 'offline';
      }
    }

    // Detectar redirecciones JS de window.location / document.location (ej. listeamed.net)
    const jsLocationMatch = html.match(/window\.location\.(?:replace|href)\s*=\s*['"]([^'"]+)['"]/i) ||
                            html.match(/document\.location\.(?:replace|href)\s*=\s*['"]([^'"]+)['"]/i);
    if (jsLocationMatch) {
      const redirectPath = jsLocationMatch[1];
      const targetUrl = redirectPath.startsWith('http') ? redirectPath : `${new URL(embedUrl).origin}${redirectPath}`;
      try {
        const jsRes = await axios.get(targetUrl, {
          headers: { 'User-Agent': UA, 'Referer': embedUrl },
          timeout: 4000,
          validateStatus: () => true
        });

        if (jsRes.status >= 400 || jsRes.status === 429 || jsRes.status === 410) {
          return 'offline';
        }

        const jsHtml = typeof jsRes.data === 'string' ? jsRes.data : '';
        for (const pattern of SOFT_ERROR_PATTERNS) {
          if (pattern.test(jsHtml)) {
            return 'offline';
          }
        }
      } catch {
        return 'offline';
      }
    }

    // Detectar redirección de huella JS de Vudeo (var redirect_link = '...') y seguir la redirección final
    const vudeoMatch = html.match(/var\s+redirect_link\s*=\s*['"]([^'"]+)['"]/i);
    if (vudeoMatch) {
      const targetUrl = vudeoMatch[1] + 'fp=-7';
      try {
        const vudeoRes = await axios.get(targetUrl, {
          headers: { 'User-Agent': UA, 'Referer': embedUrl },
          timeout: 4000,
          validateStatus: () => true
        });

        if (vudeoRes.status >= 400 || vudeoRes.status === 410) {
          return 'offline';
        }

        const vudeoHtml = typeof vudeoRes.data === 'string' ? vudeoRes.data : '';
        for (const pattern of SOFT_ERROR_PATTERNS) {
          if (pattern.test(vudeoHtml)) {
            return 'offline';
          }
        }
      } catch {
        return 'offline';
      }
    }

    // Inspeccionar iframe interno de nivel 2 si el reproductor está encapsulado (ej. waaw.to / netu)
    const innerIframeMatch = html.match(/iframe[^>]+src=["']([^"']+)["']/i);
    if (innerIframeMatch) {
      const innerPath = innerIframeMatch[1];
      const innerUrl = innerPath.startsWith('http') ? innerPath : `${new URL(embedUrl).origin}${innerPath}`;
      try {
        const innerRes = await axios.get(innerUrl, {
          headers: { 'User-Agent': UA, 'Referer': embedUrl },
          timeout: 3000,
          validateStatus: () => true
        });

        if (innerRes.status >= 400 || innerRes.status === 410) {
          return 'offline';
        }

        const innerHtml = typeof innerRes.data === 'string' ? innerRes.data : '';
        for (const pattern of SOFT_ERROR_PATTERNS) {
          if (pattern.test(innerHtml)) {
            return 'offline';
          }
        }
      } catch {}
    }

    // HTML extremadamente corto sin reproductores
    if (html.length < 250 && !html.includes('jwplayer') && !html.includes('video') && !html.includes('iframe') && !html.includes('source') && !html.includes('script')) {
      return 'offline';
    }

    return 'online';
  } catch {
    if (embedUrl.includes('vidhide') || embedUrl.includes('streamwish') || embedUrl.includes('upns') || embedUrl.includes('waaw')) {
      return 'online';
    }
    return 'offline';
  }
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

/**
 * Genera raíces morfológicas / lematización bidireccional (singular <-> plural, sin acentos)
 */
function getWordStems(word: string): string[] {
  const norm = word.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const stems = new Set<string>([word.toLowerCase(), norm]);

  if (norm.endsWith('es')) {
    stems.add(norm.slice(0, -2)); // dragones -> dragon
    stems.add(norm.slice(0, -1)); // dragones -> dragone
    if (norm.endsWith('ces')) {
      stems.add(norm.slice(0, -3) + 'z'); // actrices -> actriz
    }
  } else if (norm.endsWith('s') && !norm.endsWith('ss')) {
    stems.add(norm.slice(0, -1)); // peliculas -> pelicula
  }

  if (!norm.endsWith('s')) {
    stems.add(norm + 's');  // dragon -> dragons
    stems.add(norm + 'es'); // dragon -> dragones
    if (norm.endsWith('z')) {
      stems.add(norm.slice(0, -1) + 'ces'); // actriz -> actrices
    }
  }

  return Array.from(stems);
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
    if (tioplusUrl.includes('fuegocine.com')) {
      return this.scrapeFuegocineDetail(tioplusUrl);
    }
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

      // Resolver los tokens y verificar su salud en la capa de aplicación (Soft Errors / 200 OK falsos)
      const tokensToResolve = serverTokens.slice(0, 5);
      const resolvedUrls = await Promise.allSettled(
        tokensToResolve.map(t => resolvePlayerUrl(t.token, tioplusUrl))
      );

      const serverVerifications = await Promise.allSettled(
        resolvedUrls.map(async (result, i) => {
          const embedUrl = result.status === 'fulfilled' ? result.value : null;
          if (!embedUrl) return null;
          const status = await verifyEmbedStatus(embedUrl);
          return { embedUrl, status, label: tokensToResolve[i].label };
        })
      );

      serverVerifications.forEach((res, i) => {
        if (res.status === 'fulfilled' && res.value && res.value.embedUrl) {
          const { embedUrl, status, label } = res.value;
          servers.push({
            id: `srv_tio_${slug}_${i + 1}`,
            name: `${getServerName(embedUrl, '')} - ${label}`,
            quality: '1080p',
            language: 'latino',
            embed_url: embedUrl,
            status: status,
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

      // Para series/animes/doramas, auto-resolver los servidores del episodio 1 (S1:E1) para tener primary_stream y reproductores garantizados
      let primaryStream = isMovie ? servers[0] || undefined : undefined;

      if (!isMovie && seasons.length > 0 && (!tioplusUrl.includes('/season/') && !tioplusUrl.includes('/episode/'))) {
        try {
          const firstSeasonNum = seasons[0].season_number || 1;
          const firstEpNum = seasons[0].episodes[0]?.episode_number || 1;
          const cat = tioplusUrl.includes('/anime/') ? 'anime' : tioplusUrl.includes('/dorama/') ? 'dorama' : 'serie';
          const epUrl = `${BASE_URL}/${cat}/${slug}/season/${firstSeasonNum}/episode/${firstEpNum}`;
          const epDetail = await this.scrapeDetail(epUrl);
          if (epDetail && epDetail.servers && epDetail.servers.length > 0) {
            seasons[0].episodes[0].servers = epDetail.servers;
            primaryStream = epDetail.servers[0];
            servers.push(...epDetail.servers);
          }
        } catch {}
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
        primary_stream: primaryStream,
        servers: servers.length > 0 ? servers : undefined,
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
   * Scrapea los servidores reales de un episodio específico (soporta serie, anime y dorama)
   */
  static async scrapeEpisodeDetail(seriesSlug: string, season: number, episode: number) {
    const categories = ['serie', 'anime', 'dorama'];
    for (const cat of categories) {
      const episodeUrl = `${BASE_URL}/${cat}/${seriesSlug}/season/${season}/episode/${episode}`;
      const detail = await this.scrapeDetail(episodeUrl);
      if (detail && detail.servers && detail.servers.length > 0) {
        const tmdbId = isNaN(Number(seriesSlug)) ? await TmdbService.getTmdbId(detail.title || seriesSlug, 'tvseries') : Number(seriesSlug);
        return {
          id: `${tmdbId}-${season}-${episode}`,
          tmdb_id: tmdbId,
          series_id: String(tmdbId),
          season_number: season,
          episode_number: episode,
          primary_stream: detail.primary_stream,
          servers: detail.servers || []
        };
      }
    }
    return null;
  }

  /**
   * Busca en TioPlus usando su API interna /api/search/QUERY
   * Devuelve resultados REALES con soporte de filtrado inteligente multi-palabra (evita colisiones de lematización y prefijos)
   */
  static async scrapeRealMovies(query: string): Promise<MediaItem[]> {
    const q = query.trim();
    if (!q) return [];

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

    const activeSources = SourceManager.getSources().filter(s => s.enabled);
    const finalResults: MediaItem[] = [];

    for (const src of activeSources) {
      if (src.id === 'tioplus') {
        let tioItems = await fetchSearchHtml(q);
        if (tioItems.length === 0 && (q.includes(' ') || q.endsWith('s') || q.endsWith('es'))) {
          const STOPWORDS = new Set(['de', 'el', 'la', 'los', 'las', 'un', 'una', 'y', 'en', 'del', 'a', 'of', 'the', 'in', 'and']);
          const tokens = q.toLowerCase().split(/\s+/).filter(t => t.length > 0);
          const significantTokens = tokens.filter(t => !STOPWORDS.has(t) && t.length > 1);
          const searchTokens = significantTokens.length > 0 ? significantTokens : tokens;

          const candidates: MediaItem[] = [];
          for (const token of searchTokens) {
            const stems = getWordStems(token);
            for (const stem of stems) {
              const items = await fetchSearchHtml(stem);
              candidates.push(...items);
            }
          }

          const filtered = candidates.filter(item => {
            const titleNorm = item.title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            return searchTokens.every(token => {
              const stems = getWordStems(token);
              return stems.some(stem => titleNorm.includes(stem));
            });
          });

          const seen = new Set<string>();
          tioItems = filtered.filter(item => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
          });
        }
        finalResults.push(...tioItems);
      } else if (src.id === 'fuegocine') {
        const fuegocineItems = await this.scrapeFuegocine(q);
        finalResults.push(...fuegocineItems);
      }
    }

    if (finalResults.length > 0 && finalResults[0]) {
      const firstUrl = (finalResults[0] as any)._tioplus_url;
      if (firstUrl) {
        const detailed = await this.scrapeDetail(firstUrl);
        if (detailed) {
          finalResults[0] = { ...finalResults[0], ...detailed };
        }
      }
    }

    return finalResults;
  }

  /**
   * Scrapea los metadatos y servidores de un post en FuegoCine (fuegocine.com)
   */
  static async scrapeFuegocineDetail(fuegocineUrl: string): Promise<MediaItem | null> {
    try {
      const res = await axios.get(fuegocineUrl, { headers: { 'User-Agent': UA }, timeout: 5000 });
      const html = typeof res.data === 'string' ? res.data : '';
      const $ = cheerio.load(html);

      const titleRaw = $('h1.post-title, h1, .entry-title').first().text().trim();
      if (!titleRaw) return null;

      const slug = fuegocineUrl.replace(/^https?:\/\/[^\/]+/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
      const poster = $('meta[property="og:image"]').attr('content') || $('img').first().attr('src') || null;
      const overview = $('.post-body, .entry-content').text().trim().substring(0, 300);
      const isMovie = !titleRaw.toLowerCase().includes('temporada') && !/\d+x\d+/.test(titleRaw);

      const servers: ServerOption[] = [];
      const svMatch = html.match(/const\s+_SV_LINKS\s*=\s*(\[[\s\S]*?\]);/);
      if (svMatch) {
        const arrayText = svMatch[1];
        const objectRegex = /lang:\s*["']([^"']+)["'][\s\S]*?name:\s*["']([^"']+)["'][\s\S]*?quality:\s*["']([^"']+)["'][\s\S]*?url:\s*["']([^"']+)["']/g;
        let m;
        let idx = 1;
        while ((m = objectRegex.exec(arrayText)) !== null) {
          const lang = m[1];
          const rawName = m[2].replace(/&#9989;/g, ' (Verificado)').trim();
          const quality = m[3] || '1080p';
          const embedUrl = m[4];

          if (embedUrl) {
            const status = await verifyEmbedStatus(embedUrl);
            servers.push({
              id: `srv_fc_${slug}_${idx++}`,
              name: `FuegoCine - ${rawName}`,
              quality: '1080p',
              language: lang.includes('sub') ? 'subtitulado' : lang.includes('cas') ? 'castellano' : 'latino',
              embed_url: embedUrl,
              status,
              last_checked: new Date().toISOString()
            });
          }
        }
      }

      return {
        id: slug,
        tmdb_id: 0,
        imdb_id: null,
        type: isMovie ? 'movie' as const : 'tvseries' as const,
        title: titleRaw,
        original_title: titleRaw,
        aliases: [titleRaw],
        overview: overview || `Ver ${titleRaw} online gratis en FuegoCine con audio Latino.`,
        rating: 0,
        content_rating: 'PG-13',
        release_date: '',
        genres: [],
        subcategories: ['Latino HD', 'FuegoCine'],
        poster,
        backdrop: poster,
        logo: null,
        trailer: null,
        cast: [],
        dubbing_cast: [],
        primary_stream: servers[0] || undefined,
        servers: servers.length > 0 ? servers : undefined,
        _tioplus_url: fuegocineUrl
      } as any;
    } catch {
      return null;
    }
  }

  /**
   * Busca contenido en FuegoCine usando su Feed JSON de Blogger
   */
  static async scrapeFuegocine(query: string): Promise<MediaItem[]> {
    try {
      const feedUrl = `https://www.fuegocine.com/feeds/posts/summary?q=${encodeURIComponent(query)}&alt=json&max-results=10`;
      const res = await axios.get(feedUrl, { headers: { 'User-Agent': UA }, timeout: 4000 });
      const entries = res.data?.feed?.entry || [];
      const items: MediaItem[] = [];

      for (const e of entries) {
        const titleRaw = e.title?.$t || '';
        const link = e.link?.find((l: any) => l.rel === 'alternate')?.href || '';
        if (!titleRaw || !link) continue;

        const slug = link.replace(/^https?:\/\/[^\/]+/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
        const poster = e.media$thumbnail?.url ? e.media$thumbnail.url.replace(/\/s\d+(-c)?\//, '/s500/') : null;
        const yearMatch = titleRaw.match(/\((\d{4})\)/);
        const year = yearMatch ? yearMatch[1] : '';
        const cleanTitle = titleRaw.replace(/\s*\(\d{4}\)\s*$/, '').trim();
        const isTv = titleRaw.toLowerCase().includes('temporada') || titleRaw.toLowerCase().includes('serie') || /\d+x\d+/.test(titleRaw);

        items.push({
          id: slug,
          tmdb_id: 0,
          imdb_id: null,
          type: isTv ? 'tvseries' as const : 'movie' as const,
          title: cleanTitle,
          original_title: cleanTitle,
          aliases: [cleanTitle],
          overview: `Ver ${cleanTitle} online gratis en FuegoCine con audio Latino.`,
          rating: 0,
          release_date: year,
          genres: [],
          subcategories: ['Latino HD', 'FuegoCine'],
          poster,
          backdrop: poster,
          logo: null,
          trailer: null,
          cast: [],
          dubbing_cast: [],
          _tioplus_url: link
        } as any);
      }
      return items;
    } catch {
      return [];
    }
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
