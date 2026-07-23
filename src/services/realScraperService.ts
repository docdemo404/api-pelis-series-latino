import axios from 'axios';
import * as cheerio from 'cheerio';
import { MediaItem, ServerOption, CastMember } from '../types';
import { SourceManager } from './sourceManager';
import { TmdbService } from './tmdbService';
import { USER_AGENT, httpClient } from '../utils/httpClient';
import { verifyEmbedStatus, getServerName } from '../scrapers/embedHealth';

const BASE_URL = 'https://tioplus.app';
const UA = USER_AGENT;
const TIMEOUT = 8000;

function httpGet(url: string) {
  // Usa el cliente compartido con keep-alive: reutiliza la conexión TCP/TLS a
  // tioplus.app entre peticiones (homepage, búsqueda, detalle, /player), reduciendo latencia.
  return httpClient.get(url, {
    headers: {
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

    // Detectar redirección window.location.href en JS del reproductor
    const jsRedirectMatch = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/i) ||
                            html.match(/location\.href\s*=\s*['"]([^'"]+)['"]/i);
    if (jsRedirectMatch) {
      return jsRedirectMatch[1];
    }

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

/**
 * Título de una tarjeta de listado de TioPlus, probando todas las variantes de markup.
 *
 * El sitio dejó de rellenar `.title_over span` (hoy viene VACÍO en todos los listados) y
 * pasó a `h2`/`h3`. Como ese era el único selector que se consultaba, los listados de
 * películas, series y animes devolvían cero títulos y el catálogo acabó alimentándose
 * solo de FuegoCine. Se consulta en cascada y se cae al `alt` de la imagen.
 */
function extractCardTitle($el: cheerio.Cheerio<any>): string {
  const fromMarkup = $el.find('.title_over span, h2, h3, .title').first().text().trim();
  if (fromMarkup) return fromMarkup;

  const alt = $el.find('img').first().attr('alt') || '';
  return alt.replace(/^Ver\s+/i, '').trim();
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
        const titleText = extractCardTitle($el);

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

    // Evitar hacer peticiones con IDs numéricos directos a tioplus.app (TioPlus usa slugs de texto, no IDs de TMDB)
    const urlSlug = tioplusUrl.split('/').filter(Boolean).pop() || '';
    if (!isNaN(Number(urlSlug)) && !tioplusUrl.includes('/episode/') && !tioplusUrl.includes('/season/')) {
      return null;
    }

    try {
      const res = await httpGet(tioplusUrl);
      const html = typeof res.data === 'string' ? res.data : '';

      // Validación estricta de páginas de error 404
      if (res.status === 404 || /404\s*not\s*found/i.test(html) || /página\s*no\s*encontrada/i.test(html)) {
        return null;
      }

      const $ = cheerio.load(html);

      // Detectar si la respuesta es un widget de recomendados de página 404
      if ($('.error-404, .not-found, .error404, body.error404').length > 0) {
        return null;
      }

      // === METADATOS ===
      const h1 = $('h1.slugh1').first().text().trim() 
        || $('.single-title, .title_over h1, h1, h2').first().text().trim()
        || $('title').text().replace(/^Ver\s+/i, '').replace(/\s*-.*$/, '').trim();
      if (!h1 || h1.toLowerCase().includes('404') || h1.toLowerCase().includes('no encontrada')) return null;

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
      const cast: string[] = [];
      $('a[href*="/actor/"]').each((_, el) => {
        const actorName = $(el).text().trim();
        if (actorName && !cast.includes(actorName)) cast.push(actorName);
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
            source_id: 'tioplus',
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

      // Para series/animes/doramas, resolver los servidores REALES del episodio 1 (S1:E1)
      // como preview del título (primary_stream + reproductores garantizados en la portada).
      let primaryStream = isMovie ? servers[0] || undefined : undefined;

      if (!isMovie && seasons.length > 0 && (!tioplusUrl.includes('/season/') && !tioplusUrl.includes('/episode/'))) {
        try {
          const firstSeasonNum = seasons[0].season_number || 1;
          const firstEpNum = seasons[0].episodes[0]?.episode_number || 1;
          const cat = tioplusUrl.includes('/anime/') ? 'anime' : tioplusUrl.includes('/dorama/') ? 'dorama' : 'serie';
          const epUrl = `${BASE_URL}/${cat}/${slug}/season/${firstSeasonNum}/episode/${firstEpNum}`;
          const epDetail = await this.scrapeDetail(epUrl);
          if (epDetail && epDetail.servers && epDetail.servers.length > 0) {
            primaryStream = epDetail.servers[0];
            servers.push(...epDetail.servers);
            // Asignar los enlaces reales SOLO al episodio 1 (el que realmente resolvimos).
            // El resto de episodios se resuelve bajo demanda vía
            // /series/:id/season/:s/episode/:e para no exponer enlaces incorrectos.
            const firstEp = seasons[0]?.episodes?.[0];
            if (firstEp) firstEp.servers = [...epDetail.servers];
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
    // Probar las 3 categorías EN PARALELO (antes era secuencial => hasta 3x la latencia).
    // Las 2 categorías incorrectas devuelven 404 rápido; se conserva la prioridad serie>anime>dorama.
    const settled = await Promise.allSettled(
      categories.map(cat =>
        this.scrapeDetail(`${BASE_URL}/${cat}/${seriesSlug}/season/${season}/episode/${episode}`)
      )
    );
    const detail = settled
      .map(r => (r.status === 'fulfilled' ? r.value : null))
      .find(d => d && d.servers && d.servers.length > 0);

    if (!detail) return null;

    const tmdbId = isNaN(Number(seriesSlug))
      ? await TmdbService.getTmdbId(detail.title || seriesSlug, 'tvseries')
      : Number(seriesSlug);
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

  /**
   * Busca en TioPlus usando su API interna /api/search/QUERY
   * Devuelve resultados REALES con soporte de filtrado inteligente multi-palabra (evita colisiones de lematización y prefijos)
   */
  static async scrapeRealMovies(query: string, limit = 25): Promise<MediaItem[]> {
    const q = query.trim();
    if (!q) return [];

    const fetchSearchHtml = async (searchTerm: string): Promise<MediaItem[]> => {
      try {
        const searchUrl = `${BASE_URL}/api/search/${encodeURIComponent(searchTerm)}`;
        const res = await httpGet(searchUrl);
        const $ = cheerio.load(res.data);
        const items: MediaItem[] = [];

        $('article.item, .search-result, a[href*="/pelicula/"], a[href*="/serie/"], a[href*="/anime/"]').each((_, el) => {
          if (items.length >= limit) return false;
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
            subcategories: href.includes('/anime/') ? ['Latino HD', 'Anime'] : ['Latino HD'],
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

    const sources = await SourceManager.getSourcesAsync();
    const activeSources = sources.filter(s => s.enabled);
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
              last_checked: new Date().toISOString(),
              source_id: 'fuegocine'
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
   * Busca contenido en FuegoCine usando su Feed JSON de Blogger.
   * Agrupa episodios (categoría "Episode" + id-XXXX + patrón SxE) bajo una sola serie,
   * evitando que cada capítulo aparezca como un MediaItem individual.
   */
  static async scrapeFuegocine(query: string): Promise<MediaItem[]> {
    try {
      const feedUrl = `https://www.fuegocine.com/feeds/posts/summary?q=${encodeURIComponent(query)}&alt=json&max-results=30`;
      const res = await axios.get(feedUrl, { headers: { 'User-Agent': UA }, timeout: 6000 });
      const entries = res.data?.feed?.entry || [];
      return this.parseFuegocineEntries(entries);
    } catch {
      return [];
    }
  }

  /**
   * Enumera TODO el catálogo de FuegoCine paginando el feed Blogger (sin q) por start-index,
   * hasta agotar entradas o alcanzar el tope de seguridad. Junta todas las entradas antes de
   * parsear para agrupar correctamente las series que abarcan varias páginas del feed.
   */
  static async scrapeAllFuegocine(maxItems = 5000): Promise<MediaItem[]> {
    const PAGE = 150;
    const allEntries: any[] = [];
    for (let start = 1; allEntries.length < maxItems; start += PAGE) {
      const feedUrl = `https://www.fuegocine.com/feeds/posts/summary?alt=json&max-results=${PAGE}&start-index=${start}`;
      try {
        const res = await axios.get(feedUrl, { headers: { 'User-Agent': UA }, timeout: 8000 });
        const entries = res.data?.feed?.entry || [];
        if (entries.length === 0) break;
        allEntries.push(...entries);
        if (entries.length < PAGE) break;
      } catch {
        break;
      }
    }
    return this.parseFuegocineEntries(allEntries);
  }

  /** Parser compartido de entradas del feed Blogger de FuegoCine (películas + series agrupadas). */
  private static parseFuegocineEntries(entries: any[]): MediaItem[] {
    const movieItems: MediaItem[] = [];
    // Map: bloggerSeriesId -> { seriesName, episodes[] }
    const seriesMap = new Map<string, {
      seriesName: string;
      poster: string | null;
      episodes: Array<{ season: number; episode: number; title: string; link: string }>;
    }>();

    for (const e of entries) {
      const titleRaw = e.title?.$t || '';
      const link = e.link?.find((l: any) => l.rel === 'alternate')?.href || '';
      if (!titleRaw || !link) continue;

      const categories = (e.category || []).map((c: any) => c.term as string);
      const isEpisode = categories.includes('Episode');
      const bloggerIdCat = categories.find((c: string) => /^id-\d+$/.test(c));
      const sxeMatch = titleRaw.match(/^(.+?)\s+(\d+)x(\d+)\s*$/i);

      if (isEpisode && bloggerIdCat && sxeMatch) {
        // --- Es un episodio de serie ---
        const seriesName = sxeMatch[1].trim();
        const seasonNum = parseInt(sxeMatch[2], 10);
        const episodeNum = parseInt(sxeMatch[3], 10);

        let group = seriesMap.get(bloggerIdCat);
        if (!group) {
          const poster = e.media$thumbnail?.url ? e.media$thumbnail.url.replace(/\/s\d+(-c)?\//, '/s500/') : null;
          group = { seriesName, poster, episodes: [] };
          seriesMap.set(bloggerIdCat, group);
        }
        group.episodes.push({ season: seasonNum, episode: episodeNum, title: titleRaw, link });
      } else {
        // --- Es una película u otro contenido no-episódico ---
        const slug = link.replace(/^https?:\/\/[^\/]+/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
        const poster = e.media$thumbnail?.url ? e.media$thumbnail.url.replace(/\/s\d+(-c)?\//, '/s500/') : null;
        const yearMatch = titleRaw.match(/\((\d{4})\)/);
        const year = yearMatch ? yearMatch[1] : '';
        const cleanTitle = titleRaw.replace(/\s*\(\d{4}\)\s*$/, '').trim();
        const isTv = titleRaw.toLowerCase().includes('temporada') || titleRaw.toLowerCase().includes('serie');

        movieItems.push({
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
    }

    // Convertir series agrupadas a MediaItems con estructura de temporadas/episodios
    for (const [bloggerIdCat, group] of seriesMap) {
      const seriesSlug = `fc-${group.seriesName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

      // Organizar episodios por temporada
      const seasonMap = new Map<number, Array<{ episode: number; title: string; link: string }>>();
      for (const ep of group.episodes) {
        let seasonEps = seasonMap.get(ep.season);
        if (!seasonEps) {
          seasonEps = [];
          seasonMap.set(ep.season, seasonEps);
        }
        seasonEps.push({ episode: ep.episode, title: ep.title, link: ep.link });
      }

      const seasons: import('../types').Season[] = [];
      for (const [sNum, eps] of [...seasonMap.entries()].sort((a, b) => a[0] - b[0])) {
        eps.sort((a, b) => a.episode - b.episode);
        seasons.push({
          season_number: sNum,
          name: `Temporada ${sNum}`,
          episodes_count: eps.length,
          poster: group.poster,
          episodes: eps.map(ep => ({
            episode_number: ep.episode,
            name: ep.title,
            overview: `Ver ${ep.title} en FuegoCine con audio Latino.`,
            still_path: null,
            air_date: null,
            servers: [],
            _fuegocine_url: ep.link,
          } as any)),
        });
      }

      const totalEps = group.episodes.length;

      movieItems.push({
        id: seriesSlug,
        tmdb_id: 0,
        imdb_id: null,
        type: 'tvseries' as const,
        title: group.seriesName,
        original_title: group.seriesName,
        aliases: [group.seriesName],
        overview: `Ver ${group.seriesName} online gratis en FuegoCine con audio Latino.`,
        rating: 0,
        release_date: '',
        genres: [],
        subcategories: ['Latino HD', 'FuegoCine'],
        poster: group.poster,
        backdrop: group.poster,
        logo: null,
        trailer: null,
        cast: [],
        dubbing_cast: [],
        total_seasons: seasons.length,
        total_episodes: totalEps,
        seasons,
        _fuegocine_blogger_id: bloggerIdCat,
      } as any);
    }

    return movieItems;
  }

  /**
   * Crawl PROFUNDO de una categoría tioplus. Reutiliza scrapeLatest, que ya pagina el índice
   * y corta cuando una página no aporta títulos nuevos; con un límite alto recorre todo.
   */
  static async scrapeAllOfType(type: 'peliculas' | 'series' | 'animes', maxItems = 20000): Promise<MediaItem[]> {
    return this.scrapeLatest(type, maxItems);
  }

  /**
   * Crawl COMPLETO del catálogo de todas las fuentes activas para scripts/refreshCatalog.ts.
   * Deduplica por id. La resolución de TMDB y la escritura las hace el job de refresh.
   */
  static async crawlFullCatalog(): Promise<MediaItem[]> {
    const [peliculas, series, animes, fuego] = await Promise.all([
      this.scrapeAllOfType('peliculas').catch(() => [] as MediaItem[]),
      this.scrapeAllOfType('series').catch(() => [] as MediaItem[]),
      this.scrapeAllOfType('animes').catch(() => [] as MediaItem[]),
      this.scrapeAllFuegocine().catch(() => [] as MediaItem[])
    ]);
    const seen = new Set<string>();
    return [...peliculas, ...series, ...animes, ...fuego].filter(it => {
      if (!it.id || seen.has(it.id)) return false;
      seen.add(it.id);
      return true;
    });
  }

  /**
   * Scrapea el listado de películas, series o animes recorriendo páginas reales del índice.
   */
  static async scrapeLatest(type: 'peliculas' | 'series' | 'animes' = 'peliculas', limit = 20): Promise<MediaItem[]> {
    const items: MediaItem[] = [];
    const seen = new Set<string>();
    const maxPages = Math.max(1, Math.ceil(limit / 10) + 2);

    for (let page = 1; items.length < limit && page <= maxPages; page++) {
      // La paginación real del sitio es /peliculas/2, /peliculas/3… El patrón /page/2 que
      // se usaba antes devuelve 404 (y ?page=2 responde 200 pero repite la primera página),
      // así que el crawl se quedaba SIEMPRE en los 24 títulos de la portada de cada categoría.
      const url = page === 1 ? `${BASE_URL}/${type}` : `${BASE_URL}/${type}/${page}`;

      try {
        const res = await httpGet(url);
        const $ = cheerio.load(res.data);
        const pageItems: MediaItem[] = [];

        $('article.item').each((i, el) => {
          if (items.length + pageItems.length >= limit) return false;

          const $el = $(el);
          const linkEl = $el.find('a.itemA').first();
          const href = linkEl.attr('href') || '';
          const imgEl = $el.find('img').first();
          const poster = imgEl.attr('data-src') || imgEl.attr('src') || null;
          const titleText = extractCardTitle($el);

          if (!href || !titleText) return;

          const yearMatch = titleText.match(/\((\d{4})\)/);
          const year = yearMatch ? yearMatch[1] : '';
          const cleanTitle = titleText.replace(/\s*\(\d{4}\)\s*$/, '').trim();
          const slug = href.split('/').filter(Boolean).pop() || '';

          if (!slug || seen.has(slug)) return;
          seen.add(slug);

          const contentType = type === 'peliculas' ? 'movie' as const : 'tvseries' as const;

          pageItems.push({
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
            // La categoría de origen se conserva como subcategoría: es el único dato que
            // distingue el anime del resto de series (TMDB no lo marca) y con él el home
            // puede armar su carrusel de anime.
            subcategories: type === 'animes' ? ['Latino HD', 'Anime'] : ['Latino HD'],
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

        if (pageItems.length === 0) {
          break;
        }

        items.push(...pageItems);
      } catch (err: any) {
        if (page === 1) {
          console.error(`[TioPlus] Error scrapeando ${type}:`, err.message);
        }
        break;
      }
    }

    return items;
  }
}
