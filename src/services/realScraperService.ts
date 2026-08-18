import axios from 'axios';
import * as cheerio from 'cheerio';
import { MediaItem, ServerOption, CastMember, ContentType } from '../types';
import { SourceManager } from './sourceManager';
import { TmdbService, tmdbImagePath } from './tmdbService';
import { USER_AGENT, httpClient } from '../utils/httpClient';
import { inspectEmbed, getServerName } from '../scrapers/embedHealth';
import { nombreConTipo, getPrimaryStream } from './streamSorter';
import { extractDirect, describeDirect, deferredDirectFields, unwrapRedirector } from '../scrapers/directStream';
import { yearFromSlug, slugify } from '../utils/text';

const BASE_URL = 'https://tioplus.app';
/** Cinecalidad publica en varios dominios con la misma plantilla; `.am` es el que responde hoy. */
const CINECALIDAD_BASE = 'https://www.cinecalidad.am';
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
export async function resolvePlayerUrl(dataServerToken: string, referer: string): Promise<string | null> {
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

  // El `alt` de la imagen viene SIN el año ("Solo en casa" en vez de "Solo en casa (1990)"),
  // y sin año el emparejado con TMDB no puede distinguir a un homónimo de otra época: así se
  // guardó "Gambling House" (1950) como si fuera Home Alone. Se recupera del texto de la tarjeta,
  // que sí lo lleva ("Pelicúla Solo en casa (1990)").
  const alt = ($el.find('img').first().attr('alt') || '').replace(/^Ver\s+/i, '').trim();
  if (!alt) return '';

  const yearInCard = $el.text().match(/\((\d{4})\)/);
  return yearInCard && !/\(\d{4}\)/.test(alt) ? `${alt} (${yearInCard[1]})` : alt;
}

// Año final entre paréntesis, admitiendo el RANGO con el que las fuentes rotulan los packs de
// series ("Bridgerton - Todas las Temporadas (2020 - 2026)"), donde vale el año de estreno.
const TRAILING_YEAR_RANGE = /\((\d{4})(?:\s*[-–—/]\s*(?:\d{4}|presente|actualidad))?\)\s*$/i;

/**
 * Los formatos con los que las fuentes rotulan temporada y capítulo en el título.
 *
 * ESTO ANTES BUSCABA SOLO `S01E01`, Y ERA CIEGO JUSTO DONDE HACÍA FALTA. Los títulos que devuelve
 * `scrapeDetail` (el `h1`, no el `<title>`), medidos el 2026-08-17:
 *
 *   TioPlus    "Nadie quiere esto S01 E01 - Piloto"   ← sí casaba: la comprobación funcionaba
 *   FuegoCine  "Nadie quiere esto 1x1"                ← no casaba: se aceptaba SIEMPRE
 *
 * Y la fuente ciega es precisamente la de riesgo. Las URLs de TioPlus se derivan del slug que la
 * fuente publica y su esquema `/season/N/episode/M` es canónico: si el capítulo no existe, hay
 * 404. Las de FuegoCine se ADIVINAN —se reescribe el número dentro de `…-1x10.html` conservando el
 * mes de Blogger—, que es el único caso en el que una página puede contestar sin ser la pedida. O
 * sea que el guardarraíl cubría el camino seguro y dejaba suelto el camino inventado.
 *
 * Se añade también "Temporada N Capítulo M", que es como lo rotula el `<title>` de TioPlus: hoy no
 * se usa porque leemos el `h1`, y es seguro de balde si algún día cambian esa plantilla.
 */
const ROTULOS_DE_EPISODIO: RegExp[] = [
  // "S01 E01", "s1e3"
  // El separador es opcional: TioPlus rotula «S01 E01» y Cinecalidad «S1-E1».
  /\bS\s*(\d{1,3})\s*[-_ ]?\s*E\s*(\d{1,3})\b/i,
  // "Temporada 1 Capítulo 1", "Season 2 Episode 7". El hueco se acota para que no empareje la
  // temporada de un título con el capítulo de otra frase tres líneas más allá.
  /\b(?:Temporada|Season)\s*(\d{1,3})[^\d]{0,40}?(?:Cap[ií]tulo|Episodio|Episode)\s*(\d{1,4})\b/i,
  // "1x1", "4x8". Al FINAL del título, que es donde lo pone FuegoCine; anclarlo evita comerse
  // una resolución ("1920x960") o un año suelto que aparezca a media frase.
  /(?:^|\s)(\d{1,2})\s*x\s*(\d{1,3})\s*$/i,
];

/** Temporada y capítulo que DECLARA el título, o null si no lo declara en ningún formato conocido. */
export function rotuloDelEpisodio(titulo: string | undefined): { season: number; episode: number } | null {
  const t = String(titulo || '');
  for (const re of ROTULOS_DE_EPISODIO) {
    const m = t.match(re);
    if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  }
  return null;
}

/**
 * ¿La página que ha contestado es la del episodio que se pidió?
 *
 * Hace falta porque probar varias URLs y quedarse con la primera que traiga servidores es una
 * apuesta: si el sitio redirige, pagina distinto o cambia el orden de las temporadas, se sirve el
 * vídeo de otro capítulo — y eso el reproductor no lo nota, lo nota quien lo está viendo.
 *
 * Cuando la página NO declara nada, la respuesta depende de CÓMO se llegó a ella, y esa distinción
 * es la que faltaba:
 *
 *   · URL derivada de una `source_url` real (el slug lo publica la fuente y la ruta es su esquema
 *     canónico): si no existe, contesta 404. Que no rotule no es sospechoso — se acepta.
 *   · URL ADIVINADA (`exigeRotulo`): se ha inventado el número del capítulo dentro de una ruta
 *     —el mes de Blogger en `…-1x10.html` → `…-2x7.html`, o la categoría a ciegas con el id de la
 *     fila—. Ahí una página que responde y no se identifica no prueba nada, y aceptarla es
 *     exactamente cómo se sirve el capítulo equivocado. Sin rótulo, no se adopta.
 *
 * Un rótulo que dice OTRO capítulo se rechaza siempre, venga de donde venga.
 */
export function esDelEpisodio(
  titulo: string | undefined,
  season: number,
  episode: number,
  opts: { exigeRotulo?: boolean } = {}
): boolean {
  const rotulo = rotuloDelEpisodio(titulo);
  if (!rotulo) return !opts.exigeRotulo;
  return rotulo.season === season && rotulo.episode === episode;
}

/**
 * El título de una obra a partir del `<title>` de Cinecalidad.
 *
 * NO USA EL MISMO ORDEN EN TODAS SUS PÁGINAS, y esa diferencia dejó la fuente muda en los
 * episodios:
 *
 *   ficha     «Ver Breaking Bad Online Gratis HD - Cinecalidad»
 *   episodio  «Ver online gratis Breaking Bad 1x1 ⚜️ Cinecalidad»
 *
 * Quitar «Ver » por delante y todo lo que empieza en «Online Gratis» funciona en la primera y se
 * come el título ENTERO en la segunda: devolvía cadena vacía, el scraper contestaba null y el
 * episodio acababa resolviéndose contra otra fuente. Seis servidores esperando detrás.
 *
 * Se recortan los adornos estén donde estén, en vez de asumir dónde van.
 */
function tituloDeCinecalidad(raw: string | undefined): string {
  return String(raw || '')
    // La firma del sitio con lo que la separe. Se aceptan CUALESQUIERA caracteres no-palabra por
    // delante y no un separador de una lista: entre el adorno y el nombre va un selector de
    // variación invisible (U+FE0F) que no se ve al leer el título y hacía fallar la coincidencia,
    // dejando «Breaking Bad 1x1 ⚜️ Cinecalidad» como nombre de la obra.
    .replace(/[\s\W]*Cinecalidad\s*$/i, '')
    .replace(/\bOnline\s+Gratis(\s+HD)?\b/gi, '')
    .replace(/^\s*Ver\s+(Serie\s+)?/i, '')
    .replace(/^\s*online\s+gratis\s*/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Las temporadas de una serie de Cinecalidad, leídas de su lista de episodios.
 *
 * El número real está en `.numerando` con la forma `S1-E1`, no en el texto del enlace —que es
 * «Episodio 1» y se repite en todas las temporadas—. Fiarse del texto mezclaría el 1x1 con el 2x1,
 * y servir un capítulo por otro es el fallo que no da error y solo nota quien mira.
 *
 * El enlace del episodio (`…/ver-el-episodio/<slug>-1x1/`) se guarda en el propio episodio: es de
 * donde saldrán sus servidores cuando alguien lo abra, sin tener que adivinar la url.
 */
function cinecalidadTemporadas($: cheerio.CheerioAPI): any[] {
  const porTemporada = new Map<number, any[]>();

  $('ul.episodios li').each((_, el) => {
    // El mismo reconocedor que valida los episodios en `esDelEpisodio`, no una copia suya: es
    // el que ya sabe leer «S1-E1», «1x1» y «Temporada 1 Capítulo 1». Escribir aquí otra regex
    // es cómo se acaba con dos criterios que se desincronizan.
    const rotulo = rotuloDelEpisodio($(el).find('.numerando').first().text().trim());
    if (!rotulo) return;
    const { season, episode } = rotulo;
    const enlace = $(el).find('.episodiotitle a').first().attr('href') || '';
    const nombre = $(el).find('.episodiotitle a').first().text().trim() || `Episodio ${episode}`;
    const still = $(el).find('img').first().attr('data-src') || null;

    if (!porTemporada.has(season)) porTemporada.set(season, []);
    porTemporada.get(season)!.push({
      episode_number: episode,
      name: nombre,
      overview: '',
      still_path: still,
      air_date: null,
      servers: [],
      _source_url: enlace || undefined,
    });
  });

  return Array.from(porTemporada.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([season_number, episodes]) => ({
      season_number,
      name: `Temporada ${season_number}`,
      episodes_count: episodes.length,
      poster: null,
      episodes: episodes.sort((a: any, b: any) => a.episode_number - b.episode_number),
    }));
}

/** Señales de una página de origen que el emparejado con TMDB necesita para no fallar. */
export interface SourceSignals {
  /** Título de la ficha, ya sin el `(AAAA)`. */
  title: string;
  /** Año de estreno, o '' si la página no lo publica. */
  year: string;
  /** Título original ("Home Alone"), independiente del nombre regional. */
  originalTitle: string;
  /** `og:image`: en TioPlus apunta a image.tmdb.org, y ese hash señala UNA ficha concreta. */
  imageHint: string;
  /**
   * De qué episodio es la página, cuando su título lo declara ("INVENCIBLE 4x8").
   *
   * Las series agrupadas de FuegoCine se quedan con la página de su primer episodio como origen,
   * y esas páginas no publican ficha de datos: sin año ni título original no hay nada que
   * respalde una ficha de TMDB. Lo que sí traen es el fotograma del episodio, y ese hash
   * identifica la serie sin margen de error — pero para buscarlo hay que saber QUÉ episodio es.
   */
  episode?: { season: number; episode: number } | null;
  /**
   * Qué dice la PÁGINA que es, película o serie, cuando lo declara; `null` si no lo declara.
   *
   * No es un detalle menor: si la ficha se guarda con la clase equivocada, el emparejado busca en
   * el catálogo equivocado de TMDB y la ficha acaba con el póster y la sinopsis de otra obra. Pasó
   * con la miniserie "Eric" (2024), publicada por FuegoCine en un post sin la palabra "serie" en
   * el título: se guardó como película y se quedó con la ficha de un especial de monólogos.
   */
  type: ContentType | null;
}

/**
 * Lee la ficha de datos de FuegoCine (`ul.post-details`), donde la plantilla publica en atributos
 * `data-*` justo lo que hace falta para identificar la obra:
 *
 *   <ul class="post-details" data-backdrop="https://image.tmdb.org/t/p/original/2eX8….jpg">
 *     <li data-original-title="Eric">…  <li data-year="2024">…
 *     <li data-seasons-count="1">…      <li data-episodes-count="6">…
 *     <li data-release-data="2024-05-30">…
 *
 * Vive aquí, en una sola función, porque la usan los DOS caminos que leen una página de FuegoCine:
 * `fetchSourceSignals` (crawl y reparaciones) y `scrapeFuegocineDetail` (la API, cuando le piden un
 * slug que no está en la base). Tenerlo duplicado fue el problema: se arregló en el primero y el
 * segundo siguió tipando por el título del post, así que pedir `2026-01-eric-2024-html` seguía
 * devolviendo en vivo la ficha de un especial de monólogos en vez de la miniserie.
 */
function fuegocineDetalles($: cheerio.CheerioAPI): {
  originalTitle: string;
  year: string;
  imageHint: string;
  type: ContentType | null;
} {
  /**
   * La imagen de TMDB se busca en CUATRO sitios, no solo en la ficha de datos.
   *
   * Las páginas de EPISODIO de las series agrupadas no llevan `ul.post-details` —ni año, ni
   * título original, nada—, y son justo las que quedan como página de origen de esas series.
   * Pero sí enlazan el fondo de TMDB, en `link[rel=image_src]` y en un `div[data-backdrop]`
   * suelto. Buscarlo solo dentro de la ficha de datos dejó a "Invencible" sin metadata: la
   * prueba de identidad más fuerte que existe estaba en la página y no se miraba.
   *
   * `og:image` va el ÚLTIMO a propósito: en Blogger casi siempre es un `blogger_img_proxy`,
   * que no lleva hash de TMDB y no prueba nada.
   */
  const pistaDeImagen = (): string => {
    const candidatos = [
      $('ul.post-details').first().attr('data-backdrop'),
      $('[data-backdrop]').first().attr('data-backdrop'),
      $('link[rel="image_src"]').attr('href'),
      $('meta[property="og:image"]').attr('content'),
    ];
    for (const c of candidatos) {
      const url = (c || '').trim();
      if (url && /(?:image\.tmdb\.org|themoviedb\.org)\/t\/p\//i.test(url)) return url;
    }
    return '';
  };

  const vacio = { originalTitle: '', year: '', imageHint: pistaDeImagen(), type: null };
  const detalles = $('ul.post-details').first();
  if (detalles.length === 0) return vacio;

  const attr = (sel: string, name: string) => (detalles.find(sel).attr(name) || '').trim();

  const backdrop = (detalles.attr('data-backdrop') || '').trim();
  const fecha = attr('li[data-release-data]', 'data-release-data');
  const anoFicha = attr('li[data-year]', 'data-year');

  // Declarar temporadas o episodios es declararse serie. Si no los declara, película.
  const temporadas = Number(attr('li[data-seasons-count]', 'data-seasons-count')) || 0;
  const episodios = Number(attr('li[data-episodes-count]', 'data-episodes-count')) || 0;

  return {
    originalTitle: attr('li[data-original-title]', 'data-original-title'),
    // La fecha completa manda sobre el año suelto: es la de estreno, no la del post.
    year: (fecha.match(/^(\d{4})/) || [])[1] || (anoFicha.match(/^(\d{4})$/) || [])[1] || '',
    imageHint: /(?:image\.tmdb\.org|themoviedb\.org)\/t\/p\//i.test(backdrop) ? backdrop : pistaDeImagen(),
    type: temporadas > 0 || episodios > 0 ? 'tvseries' : 'movie'
  };
}

export class RealScraperService {
  /**
   * Lee de la PÁGINA de origen solo lo que el emparejado con TMDB necesita: título, año,
   * título original y `og:image`.
   *
   * Existe aparte de `scrapeDetail` por el coste: aquel resuelve además todos los servidores
   * embed de la ficha (una petición por servidor, más la inspección de cada uno), así que pasar
   * el catálogo entero por él no es viable. Esto es UNA petición y nada más.
   *
   * Los listados solo publican el título y, cuando el markup falla, ni siquiera el año; la ficha
   * de detalle sí trae las cuatro señales siempre. Sin ellas el matcher empareja a ciegas de
   * época y un homónimo gana ("Solo en casa" → "Gambling House", 1950).
   *
   * Devuelve `null` si la página no responde o no da ni título: no tener señales nunca puede
   * ser motivo para tocar una ficha.
   */
  static async fetchSourceSignals(url: string): Promise<SourceSignals | null> {
    /**
     * CINECALIDAD, que tiene su propia plantilla y no encaja con los selectores de las otras dos.
     *
     * Da la carátula de `image.tmdb.org` —la prueba fuerte— y el tipo desde la ruta. NO da el año
     * ni el título original: se devuelven vacíos a propósito, porque inventarlos es peor que no
     * tenerlos. Ver la nota de `scrapeCinecalidadDetail`.
     */
    if (/cinecalidad\./i.test(url)) {
      try {
        const res = await httpGet(url);
        if (res.status >= 400) return null;
        const $ = cheerio.load(String(res.data || ''));
        const title = tituloDeCinecalidad($('title').text());
        if (!title) return null;
        const img = $('img[data-src*="image.tmdb.org/t/p/w342"]').first().attr('data-src')
          || $('img[src*="image.tmdb.org/t/p/w342"]').first().attr('src') || '';
        const ep = url.match(/-(\d{1,2})x(\d{1,3})\/?$/i);
        return {
          title,
          year: '',
          originalTitle: '',
          imageHint: tmdbImagePath(img) || '',
          type: /\/ver-serie\/|\/ver-el-episodio\//i.test(url) ? 'tvseries' : 'movie',
          episode: ep ? { season: Number(ep[1]), episode: Number(ep[2]) } : null,
        };
      } catch {
        return null;
      }
    }

    if (!url || !/^https?:\/\//i.test(url)) return null;

    try {
      const res = await httpGet(url);
      const html = typeof res.data === 'string' ? res.data : '';
      if (!html) return null;

      const $ = cheerio.load(html);
      const isFuegocine = /fuegocine/i.test(url);

      const rawTitle = isFuegocine
        ? $('h1.post-title, h1, .entry-title').first().text().trim()
        : ($('h1.slugh1').first().text().trim() || $('.single-title, .title_over h1, h1').first().text().trim());
      if (!rawTitle || /404|no encontrada/i.test(rawTitle)) return null;

      // El año viaja en el título ("… (1990)"); TioPlus lo repite además en un campo aparte
      // cuando el h1 no lo trae, y FuegoCine lo lleva embebido en el slug (`…-2016-html`).
      // Los packs de series lo rotulan como RANGO ("Bridgerton … (2020 - 2026)"): vale el
      // primero, que es el del estreno, y es el que TMDB tiene como first_air_date.
      const fromTitle = rawTitle.match(TRAILING_YEAR_RANGE);
      let year = fromTitle ? fromTitle[1] : '';
      if (!year) {
        const label = $('span:contains("Año:")').first().text().match(/A[ñn]o:\s*([12]\d{3})/);
        year = label ? label[1] : (yearFromSlug(url.split('/').filter(Boolean).pop()) || '');
      }

      let originalTitle = $('h2')
        .filter((_, el) => $(el).parent().find('b').text().includes('Titulo Original'))
        .first().text().trim();

      let imageHint = $('meta[property="og:image"]').attr('content') || '';
      let type: ContentType | null = null;

      // La ficha de datos de FuegoCine trae el título original, el año exacto, la clase y —lo más
      // valioso— una ruta de image.tmdb.org, que señala UNA ficha concreta. Sin ella, las páginas
      // de esta fuente solo daban título y año: ni una señal con la que confirmar el emparejado.
      if (isFuegocine) {
        const d = fuegocineDetalles($);
        if (d.imageHint) imageHint = d.imageHint;
        if (d.originalTitle && !originalTitle) originalTitle = d.originalTitle;
        if (d.year) year = d.year;
        type = d.type;
      }

      // "INVENCIBLE 4x8" → la página es del episodio 8 de la temporada 4. Se guarda porque su
      // fotograma en TMDB puede ser la única prueba de identidad disponible (ver `episode`), y
      // el título se limpia: el `4x8` no forma parte del nombre de la serie.
      const marcaEpisodio = rawTitle.match(/\s(\d{1,2})\s*x\s*(\d{1,3})\s*$/i);
      const episode = marcaEpisodio
        ? { season: parseInt(marcaEpisodio[1], 10), episode: parseInt(marcaEpisodio[2], 10) }
        : null;

      return {
        title: rawTitle.replace(TRAILING_YEAR_RANGE, '').replace(/\s\d{1,2}\s*x\s*\d{1,3}\s*$/i, '').trim(),
        year,
        originalTitle,
        imageHint,
        type: type || (episode ? 'tvseries' : null),
        episode
      };
    } catch {
      return null;
    }
  }

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
          // El slider SOLO expone la imagen apaisada de fondo. Antes se fabricaba un
          // "póster" con ella cambiándole el tamaño (w1280 → w342), pero los prefijos de
          // tamaño de TMDB no recortan: w342 de un backdrop sigue siendo el mismo
          // apaisado, así que el campo poster acababa sirviendo una captura horizontal.
          // Sin póster vertical real se deja en null y el cliente cae a `backdrop`.
          poster: null,
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

    // Cinecalidad publica en varios dominios (.am, .ec, .rs…) con la misma plantilla dooplay.
    if (/cinecalidad\./i.test(tioplusUrl)) {
      return this.scrapeCinecalidadDetail(tioplusUrl);
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
      let year = yearMatch ? yearMatch[1] : '';
      // Fallback: la página muestra "Año: 2016" en un span aparte cuando el h1 no trae (YYYY).
      // El año es clave para no confundir homónimos de otra época al emparejar con TMDB.
      if (!year) {
        const yearLabel = $('span:contains("Año:")').first().text().match(/A[ñn]o:\s*([12]\d{3})/);
        if (yearLabel) year = yearLabel[1];
      }
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
          // inspectEmbed devuelve el HTML que de todas formas hacía falta para comprobar la
          // salud del embed, así que extraer el vídeo directo no cuesta una petición extra.
          const { status, html } = await inspectEmbed(embedUrl);
          const direct = await extractDirect(embedUrl, html);
          return { embedUrl, status, direct, label: tokensToResolve[i].label };
        })
      );

      serverVerifications.forEach((res, i) => {
        if (res.status === 'fulfilled' && res.value && res.value.embedUrl) {
          const { embedUrl, status, direct, label } = res.value;
          // Los campos de vídeo directo se resuelven ANTES del nombre porque el nombre los
          // describe: son ellos los que deciden si esto es un vídeo directo o un embed.
          //
          // Y no se le ponen a un embed que ACABAMOS de declarar muerto. Parece obvio y no lo era:
          // el envoltorio de FuegoCine lleva el fichero en su `link=`, así que la extracción sale
          // adelante aunque ese fichero esté borrado, y se guardaba un `direct_stream` que no
          // reproduce. Publicar un vídeo directo muerto es PEOR que no publicar ninguno — el
          // cliente lo prueba primero, pierde el tiempo y solo entonces cae al embed.
          const directo = status === 'offline'
            ? {}
            : direct ? describeDirect(embedUrl, direct) : deferredDirectFields(embedUrl);
          servers.push({
            id: `srv_tio_${slug}_${i + 1}`,
            name: nombreConTipo(`${getServerName(embedUrl, '')} - ${label}`, Boolean(directo.direct_stream)),
            quality: direct?.quality || '1080p',
            language: 'latino',
            embed_url: embedUrl,
            ...directo,
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
  static async scrapeEpisodeDetail(
    seriesSlug: string,
    season: number,
    episode: number,
    opts: { sourceUrls?: string[] } = {}
  ) {
    /**
     * La página del episodio se pide, PRIMERO, a partir de la página de origen de la serie.
     *
     * Antes se construía solo con el id de la fila, y el id no siempre es el slug de la fuente: la
     * ficha del anime de One Piece es `fc-one-piece` y su página es `/anime/one-piece-1999`, así que
     * las tres URLs que se probaban daban 404 y el episodio no se resolvía nunca. Toda serie cuyo id
     * no calque el slug —todas las de FuegoCine, para empezar— estaba en ese caso.
     */
    /**
     * Cada candidata viaja con si su ruta se ha ADIVINADO o se ha derivado de algo que la fuente
     * publica. Lo consume `esDelEpisodio`: a una ruta inventada se le exige que la página diga qué
     * capítulo es; a una derivada de `source_urls`, no. Ver el comentario de esa función.
     */
    type Candidata = { url: string; adivinada: boolean };

    const desdeFuente: Candidata[] = (opts.sourceUrls || [])
      .map(u => String(u).match(/\/(serie|anime|dorama)\/([^/?#]+)/i))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      // El slug lo publica la fuente y `/season/N/episode/M` es el esquema canónico de TioPlus:
      // si el capítulo no existe, contesta 404. No se está inventando nada.
      .map(m => ({ url: `${BASE_URL}/${m[1].toLowerCase()}/${m[2]}/season/${season}/episode/${episode}`, adivinada: false }));

    /**
     * Y LAS DE FUEGOCINE, que no tienen esa forma en absoluto.
     *
     * Sus páginas de episodio son `/2026/04/ronaldinho-1x3.html`: ni `/serie/`, ni `/season/`, ni
     * `/episode/`. El filtro de arriba no casaba ninguna, así que `desdeFuente` salía VACÍO y solo
     * quedaba probar a ciegas con el id contra tioplus — URLs que no existen. Resultado: toda serie
     * agrupada de FuegoCine devolvía sus capítulos sin un solo servidor, y desde fuera se ve como
     * "la serie aparece y no tiene nada que reproducir".
     *
     * La página guardada ya trae el número de UN capítulo, así que la del capítulo pedido se saca
     * sustituyéndolo: de `…ronaldinho-1x3.html` a `…ronaldinho-2x7.html`. Se conserva el mes y el
     * año del post porque son parte de la ruta de Blogger, y si el capítulo pedido se publicó en
     * otro mes esta candidata fallará — pero `esDelEpisodio` comprueba después que la página sea la
     * del capítulo correcto, así que fallar aquí nunca sirve el capítulo equivocado.
     *
     * Va marcada como ADIVINADA justamente por el mes: la ruta se inventa a partir de la de otro
     * capítulo, y Blogger es capaz de contestar algo a una URL que no es la que se pidió.
     */
    const deFuegocine: Candidata[] = (opts.sourceUrls || [])
      .map(u => String(u).match(/^(https?:\/\/[^/]*fuegocine[^/]*\/\d{4}\/\d{2}\/.+?)-\d{1,2}x\d{1,3}(\.html)$/i))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map(m => ({ url: `${m[1]}-${season}x${episode}${m[2]}`, adivinada: true }));

    /**
     * Y LAS DE CINECALIDAD, que sí publican el número en una ruta propia:
     * `/ver-serie/linternas/` → `/ver-el-episodio/linternas-1x1/`.
     *
     * No va marcada como adivinada: el slug sale de la `source_url` real y el número es el que se
     * pide, así que si el capítulo no existe la página contesta 404 en vez de otra cosa. Y su
     * `.numerando` rotula «S1-E1», que `esDelEpisodio` ya sabe leer.
     */
    const deCinecalidad: Candidata[] = (opts.sourceUrls || [])
      .map(u => String(u).match(/^(https?:\/\/[^/]*cinecalidad[^/]*)\/ver-serie\/([^/?#]+)/i))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map(m => ({ url: `${m[1]}/ver-el-episodio/${m[2]}-${season}x${episode}/`, adivinada: false }));

    desdeFuente.push(...deFuegocine, ...deCinecalidad);

    // Y después, a ciegas por categoría con el id, que es lo que sirve cuando el id SÍ es el slug.
    // A ciegas de verdad: el id de la fila puede no ser el slug de ninguna serie de TioPlus, así
    // que lo que conteste tiene que identificarse.
    const porId: Candidata[] = ['serie', 'anime', 'dorama']
      .map(cat => ({ url: `${BASE_URL}/${cat}/${seriesSlug}/season/${season}/episode/${episode}`, adivinada: true }));

    /**
     * POR TANDAS, no todas a la vez.
     *
     * Antes se lanzaban las 4-6 candidatas en paralelo y se esperaba a TODAS (`allSettled`), así
     * que la respuesta costaba lo que la más lenta aunque la primera ya fuera la buena: 4,5 s
     * medidos cuando una sola página tarda 2. Las que salen de `source_urls` son la página de esta
     * serie, así que aciertan casi siempre; las del id son el respaldo para cuando el id ES el
     * slug. Se prueba la primera tanda y solo si no sale nada se paga la segunda.
     */
    const yaEsta = new Set(desdeFuente.map(c => c.url));
    const tandas = [desdeFuente, porId.filter(c => !yaEsta.has(c.url))].filter(t => t.length > 0);

    /**
     * SE FUSIONAN TODAS LAS CANDIDATAS VÁLIDAS, no se elige la primera.
     *
     * Antes se cogía la primera página que diera servidores y se tiraba el resto. Con una sola
     * fuente daba igual; con tres es la diferencia entre reproducir y no: el 1x1 de «Breaking Bad»
     * salía de TioPlus con un único vídeo directo —un emturbovid cuyas variantes están muertas— y
     * los tres directos que tenía Cinecalidad no se miraban siquiera, porque su candidata iba
     * detrás en la lista.
     *
     * Es lo que el camino de las PELÍCULAS lleva haciendo desde siempre (`addServers` en
     * `getStreams`), y lo que a los episodios les faltaba. La deduplicación es la misma:
     * `unwrapRedirector` sobre el embed, para que el mismo servidor publicado por dos fuentes no
     * entre dos veces.
     *
     * Las tandas siguen existiendo por lo que existían —no pagar la segunda si la primera ya
     * resolvió— pero ahora la primera tiene que haber aportado algo publicable, no solo algo.
     */
    let detail = null as Awaited<ReturnType<typeof this.scrapeDetail>>;
    const servidores: ServerOption[] = [];
    const clavesVistas = new Set<string>();

    for (const tanda of tandas) {
      const settled = await Promise.allSettled(tanda.map(c => this.scrapeDetail(c.url)));
      settled.forEach((r, i) => {
        const d = r.status === 'fulfilled' ? r.value : null;
        const cand = tanda[i];
        if (!d || !d.servers || d.servers.length === 0) return;
        if (!esDelEpisodio(d.title, season, episode, { exigeRotulo: cand.adivinada })) return;
        if (!detail) detail = d;   // la primera válida da nombre, imagen y sinopsis al capítulo
        for (const sv of d.servers) {
          const clave = unwrapRedirector(sv.embed_url);
          if (!clave || clavesVistas.has(clave)) continue;
          clavesVistas.add(clave);
          servidores.push(sv);
        }
      });
      // Solo se paga la siguiente tanda si esta no ha dejado nada que el cliente pueda reproducir.
      if (servidores.some(sv => sv.direct_stream)) break;
    }

    if (!detail) return null;

    const tmdbId = isNaN(Number(seriesSlug))
      ? await TmdbService.getTmdbId(detail.title || seriesSlug, 'tvseries',
          detail.release_date ? detail.release_date.substring(0, 4) : undefined,
          { originalTitle: detail.original_title, imageHint: detail.poster })
      : Number(seriesSlug);
    return {
      id: `${tmdbId}-${season}-${episode}`,
      tmdb_id: tmdbId,
      series_id: String(tmdbId),
      season_number: season,
      episode_number: episode,
      primary_stream: getPrimaryStream(servidores),
      servers: servidores,
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
      } else if (src.id === 'cinecalidad') {
        finalResults.push(...await this.scrapeCinecalidadSearch(q, limit));
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
   * Las fichas que aparecen en un listado de Cinecalidad (archivo, portada o búsqueda).
   *
   * La tarjeta trae ya la carátula de `image.tmdb.org`, que es la prueba de identidad, así que se
   * guarda desde aquí: el emparejado con TMDB puede confirmar la obra sin abrir la ficha. Es lo
   * que en FuegoCine costó meses descubrir —su `og:image` era un proxy que no identificaba nada— y
   * aquí viene servido.
   *
   * NO se inventa el año: esta fuente no lo publica. Es preferible dejarlo vacío a deducirlo del
   * título, que es como «Blade Runner 2049» acaba estrenándose en 2049.
   */
  private static parseCinecalidadCards(html: string, limit: number): MediaItem[] {
    const $ = cheerio.load(html);
    const items: MediaItem[] = [];
    const vistos = new Set<string>();

    $('a[href*="/ver-pelicula/"], a[href*="/ver-serie/"]').each((_, el) => {
      if (items.length >= limit) return false;
      const href = $(el).attr('href') || '';
      const m = href.match(/\/ver-(pelicula|serie)\/([^/?#]+)/i);
      if (!m) return;
      const id = slugify(href.replace(/^https?:\/\/[^/]+/i, ''));
      if (!id || vistos.has(id)) return;

      // El título de la tarjeta: el texto del enlace no vale (suele ser «Watch Movies»), así que se
      // busca en el bloque de la ficha o en el `alt` de su carátula.
      /**
       * El contenedor NO es siempre el mismo: el archivo de películas usa
       * `<article class="post dfx fcl movies">` y el de series `<article class="item movies">`.
       * Se busca cualquier `<article>` y, si no lo hay, el `<li>` que lo envuelva — atarse a una
       * clase concreta dejaba las series y el buscador devolviendo cero.
       */
      const $card = $(el).closest('article').length ? $(el).closest('article') : $(el).closest('li');
      if ($card.length === 0) return;

      /**
       * El TÍTULO sale del `alt` de la carátula, no del texto de la tarjeta. La tarjeta lleva
       * dentro el año, la sinopsis y los géneros, y leerla entera producía títulos como
       * «Batman Ninja2018Batman, junto con varios de sus aliados…». El `alt` trae el nombre y nada
       * más; `.in_title` es el equivalente en la plantilla de series.
       */
      /**
       * La carátula se busca en la tarjeta y, si no aparece, en el bloque que la envuelve: en la
       * plantilla de series la imagen y el enlace son hermanos dentro de otro contenedor, así que
       * mirar solo dentro del `<article>` del enlace la dejaba fuera y las series salían sin
       * póster — perdiendo de paso su prueba de identidad.
       */
      const selImg = 'img[src*="image.tmdb.org"], img[data-src*="image.tmdb.org"]';
      let poster = $card.find(selImg).first();
      if (poster.length === 0) poster = $(el).closest('li, div').find(selImg).first();
      if (poster.length === 0) poster = $card.parent().find(selImg).first();
      const titulo = (poster.attr('alt')
        || $card.find('.in_title').first().text().trim()
        || $card.find('.entry-title').first().text().trim()
        || '').replace(/^Ver\s+/i, '').trim();
      if (!titulo) return;
      vistos.add(id);
      items.push({
        id,
        tmdb_id: 0,
        imdb_id: null,
        type: m[1].toLowerCase() === 'serie' ? 'tvseries' : 'movie',
        title: titulo,
        original_title: titulo,
        aliases: [titulo],
        overview: '',
        rating: 0,
        release_date: '',
        genres: [],
        subcategories: ['Cinecalidad'],
        poster: (poster.attr('src') || poster.attr('data-src') || null),
        backdrop: null,
        logo: null,
        trailer: null,
        cast: [],
        dubbing_cast: [],
        servers: [],
        _source_url: href,
      } as MediaItem);
    });

    return items;
  }

  /**
   * Los últimos títulos de Cinecalidad, por archivo y con paginación.
   *
   * Sus archivos son `/ver-pelicula/` y `/ver-serie/`, y pagina con `/page/N/`. Se para en cuanto
   * una página no aporta nada nuevo: seguir pidiendo páginas vacías es lo que convertía un crawl en
   * una hora de peticiones inútiles.
   */
  static async scrapeCinecalidadLatest(tipo: 'movie' | 'tvseries', limit = 20): Promise<MediaItem[]> {
    const archivo = tipo === 'tvseries' ? 'ver-serie' : 'ver-pelicula';
    const items: MediaItem[] = [];
    const vistos = new Set<string>();

    for (let page = 1; items.length < limit && page <= 6; page++) {
      const url = page === 1
        ? `${CINECALIDAD_BASE}/${archivo}/`
        : `${CINECALIDAD_BASE}/${archivo}/page/${page}/`;
      let nuevos = 0;
      try {
        const res = await httpGet(url);
        if (res.status >= 400) break;
        for (const it of this.parseCinecalidadCards(String(res.data || ''), limit * 2)) {
          if (it.type !== tipo || vistos.has(it.id) || items.length >= limit) continue;
          vistos.add(it.id);
          items.push(it);
          nuevos++;
        }
      } catch {
        break;
      }
      if (nuevos === 0) break;
    }
    return items;
  }

  /** Búsqueda en Cinecalidad. Su buscador es el de WordPress: `?s=`. */
  static async scrapeCinecalidadSearch(query: string, limit = 12): Promise<MediaItem[]> {
    const q = query.trim();
    if (!q) return [];
    try {
      const res = await httpGet(`${CINECALIDAD_BASE}/?s=${encodeURIComponent(q)}`);
      if (res.status >= 400) return [];
      return this.parseCinecalidadCards(String(res.data || ''), limit);
    } catch {
      return [];
    }
  }

  /**
   * CINECALIDAD (cinecalidad.am) — tercera fuente.
   *
   * Se añade porque las dos anteriores dejaron media serie sin nada cuando murió la familia upns:
   * un catálogo con dos fuentes no tiene a dónde caer. De sus cuatro reproductores, `vimeos.net` y
   * `goodstream.one` YA se extraen y se ha comprobado que entregan vídeo desde el datacenter —que
   * es la prueba que no se hizo con vidhideplus y costó 57.970 servidores inservibles—.
   *
   * Es el tema dooplay de WordPress, así que publica lo que hace falta y en sitios fijos:
   *
   *   tipo        la ruta: `/ver-pelicula/` frente a `/ver-serie/`
   *   identidad   `image.tmdb.org/t/p/w342/…` — el hash señala UNA ficha de TMDB (FUENTES.md §1)
   *   servidores  `<li data-option="https://host/…">`
   *   episodios   `<ul class="episodios"> … <div class="numerando">S1-E1</div>`
   *
   * LO QUE NO PUBLICA ES EL AÑO, ni en la url ni en el cuerpo, y conviene saberlo: el año es lo
   * que separa homónimos de distinta época («Sin salida» son cuatro películas). Lo compensa el
   * hash de la imagen, que es una prueba MÁS fuerte —señala la ficha exacta— pero cuando una
   * página no traiga imagen, esa ficha se quedará sin respaldo y caerá a metadata de la fuente con
   * id sintético. Es la degradación prevista, no un fallo.
   */
  static async scrapeCinecalidadDetail(url: string): Promise<MediaItem | null> {
    try {
      const res = await httpGet(url);
      const html = typeof res.data === 'string' ? res.data : '';
      if (res.status >= 400 || !html) return null;
      const $ = cheerio.load(html);

      // El <h1> es el logotipo del sitio, así que el título sale del <title>, que trae siempre la
      // misma envoltura: «Ver [Serie] X Online Gratis HD - Cinecalidad».
      const title = tituloDeCinecalidad($('title').text());
      if (!title) return null;

      const esSerie = /\/ver-serie\//i.test(url);
      // La carátula es la única `w342`: las `w185` son las miniaturas de «relacionadas» y de los
      // episodios, y quedarse con una de ésas emparejaría la ficha con OTRA obra.
      const poster = ($('img[data-src*="image.tmdb.org/t/p/w342"]').first().attr('data-src')
        || $('img[src*="image.tmdb.org/t/p/w342"]').first().attr('src') || '').trim() || null;

      const servers: ServerOption[] = [];
      const opciones = $('li[data-option]').map((_, el) => $(el).attr('data-option') || '').get()
        // El tráiler de YouTube viaja como una opción más y no es un servidor de la película.
        .filter(u => u && !/youtube\.com|youtu\.be/i.test(u));

      const vistos = await Promise.allSettled(opciones.slice(0, 6).map(async embedUrl => {
        const { status, html: embedHtml } = await inspectEmbed(embedUrl);
        const direct = await extractDirect(embedUrl, embedHtml);
        return { embedUrl, status, direct };
      }));

      vistos.forEach((r, i) => {
        if (r.status !== 'fulfilled' || !r.value?.embedUrl) return;
        const { embedUrl, status, direct } = r.value;
        // Igual que en las otras fuentes: a un embed recién declarado muerto no se le cuelga un
        // vídeo directo, porque publicarlo muerto es peor que no publicarlo.
        const directo = status === 'offline'
          ? {}
          : direct ? describeDirect(embedUrl, direct) : deferredDirectFields(embedUrl);
        servers.push({
          id: `srv_cc_${i + 1}`,
          name: nombreConTipo(getServerName(embedUrl, ''), Boolean((directo as any).direct_stream)),
          quality: direct?.quality || '1080p',
          language: 'latino',
          embed_url: embedUrl,
          ...directo,
          status,
          last_checked: new Date().toISOString(),
          source_id: 'cinecalidad',
        });
      });

      const seasons = esSerie ? cinecalidadTemporadas($) : [];

      return {
        id: slugify(url.replace(/^https?:\/\/[^/]+/i, '')),
        tmdb_id: 0,
        imdb_id: null,
        type: esSerie ? 'tvseries' : 'movie',
        title,
        original_title: title,
        aliases: [],
        overview: $('meta[name="description"]').attr('content')?.trim() || '',
        rating: 0,
        release_date: '',
        genres: [],
        subcategories: ['Cinecalidad'],
        poster,
        backdrop: null,
        logo: null,
        trailer: null,
        cast: [],
        dubbing_cast: [],
        servers,
        primary_stream: getPrimaryStream(servers),
        seasons: seasons.length ? seasons : undefined,
        total_seasons: seasons.length || undefined,
        _source_url: url,
      } as MediaItem;
    } catch {
      return null;
    }
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
      // El año viene en el título ("… (2016)") o embebido en el slug de FuegoCine (`…-2016-html`).
      // Antes se guardaba release_date:'' y el emparejado con TMDB se hacía a ciegas de época.
      const fcYearMatch = titleRaw.match(/\((\d{4})\)/);
      const poster = $('meta[property="og:image"]').attr('content') || $('img').first().attr('src') || null;
      const overview = $('.post-body, .entry-content').text().trim().substring(0, 300);

      // La ficha de datos de la página manda sobre lo que se pueda adivinar del título: da el año
      // de estreno, el título original, la clase y una imagen de TMDB con la que confirmar la
      // identidad. Deducir la clase del título es lo que convirtió la miniserie "Eric" (2024) en un
      // especial de monólogos: su post se titula "Eric (2024)" y no lleva la palabra "temporada".
      const d = fuegocineDetalles($);
      const year = d.year || (fcYearMatch ? fcYearMatch[1] : (yearFromSlug(slug) || ''));
      const isMovie = d.type
        ? d.type === 'movie'
        : (!titleRaw.toLowerCase().includes('temporada') && !/\d+x\d+/.test(titleRaw));

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
          // FuegoCine no enlaza el reproductor: enlaza un redirector de Blogger que lleva el
          // destino real en base64. Se decodifica antes de nada, así que hasta el embed que se
          // guarda deja de ser el intermediario con publicidad.
          const embedUrl = unwrapRedirector(m[4]);

          if (embedUrl) {
            const { status, html: embedHtml } = await inspectEmbed(embedUrl, 'https://www.fuegocine.com');
            const direct = await extractDirect(embedUrl, embedHtml);
            // Un embed declarado muerto no se anuncia con vídeo directo, por el mismo motivo que
            // en el camino de tioplus: aquí el `link=` es justo el que puede apuntar a un fichero
            // de pixeldrain borrado y la extracción saldría adelante igualmente.
            const directo = status === 'offline'
              ? {}
              : direct ? describeDirect(embedUrl, direct) : deferredDirectFields(embedUrl);
            servers.push({
              id: `srv_fc_${slug}_${idx++}`,
              name: nombreConTipo(`FuegoCine - ${rawName}`, Boolean(directo.direct_stream)),
              quality: direct?.quality || '1080p',
              language: lang.includes('sub') ? 'subtitulado' : lang.includes('cas') ? 'castellano' : 'latino',
              embed_url: embedUrl,
              ...directo,
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
        // El título original de la página es una señal INDEPENDIENTE del nombre regional, y es lo
        // que permite confirmar el emparejado; repetir el título mostrado no aporta nada.
        original_title: d.originalTitle || titleRaw,
        aliases: [titleRaw],
        overview: overview || `Ver ${titleRaw} online gratis en FuegoCine con audio Latino.`,
        rating: 0,
        content_rating: 'PG-13',
        release_date: year,
        genres: [],
        subcategories: ['Latino HD', 'FuegoCine'],
        poster,
        // El `data-backdrop` de la página apunta a image.tmdb.org: su hash señala UNA ficha concreta
        // de TMDB, así que `enrichMediaItem` lo usa para confirmar la identidad. Va en `backdrop`
        // porque es apaisado — meterlo en `poster` daría una vertical falsa.
        backdrop: d.imageHint || poster,
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
      // Año si la serie lo trae en el nombre ("Doctor Who (2005)") o en el slug; si no, ''.
      const seriesYearMatch = group.seriesName.match(/\((\d{4})\)/);
      const seriesYear = seriesYearMatch ? seriesYearMatch[1] : (yearFromSlug(seriesSlug) || '');

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
        release_date: seriesYear,
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
        /**
         * PÁGINA DE ORIGEN DE LA SERIE: la del primer episodio.
         *
         * Una serie de FuegoCine no tiene página propia —se arma agrupando los posts de sus
         * episodios—, así que estas fichas se quedaban SIN ninguna url de origen. Y sin url no hay
         * señales que leer: ni año, ni título original, ni la imagen de TMDB. Con eso el emparejado
         * no se puede corroborar, y desde que adoptar la ficha de TMDB exige respaldo, todas estas
         * series caían a la metadata de su fuente: 62 fichas sin póster y con id sintético, entre
         * ellas "Invencible". El post de cualquiera de sus episodios SÍ publica esos datos.
         */
        _source_url: group.episodes[0]?.link || undefined,
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
    /**
     * TODAS LAS FUENTES, no solo TioPlus.
     *
     * Esta función es la puerta por la que el crawl descubre títulos, y estaba atada a un solo
     * sitio. Añadir una fuente y no engancharla aquí la deja escrita pero muda: sabe leer una
     * ficha y nadie le pasa nunca una url. Le pasó a Cinecalidad hasta que el usuario preguntó por
     * qué no aparecía Breaking Bad —que esa fuente sí tiene— y resultó que el catálogo no la
     * estaba recorriendo.
     *
     * Se piden en paralelo y lo de Cinecalidad va al final de la lista: no compite con lo de
     * TioPlus, se suma. La deduplicación por id la hace quien recibe (`unifyItems`).
     */
    const deCinecalidad = this.scrapeCinecalidadLatest(
      type === 'peliculas' ? 'movie' : 'tvseries',
      Math.max(10, Math.floor(limit / 2))
    ).catch(() => [] as MediaItem[]);

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

    /**
     * Y lo de Cinecalidad, con SITIO RESERVADO.
     *
     * La primera versión lo añadía solo si quedaba hueco bajo el `limit`, y como TioPlus llena el
     * cupo por sí solo, la segunda fuente aportaba CERO: quedaba enganchada y seguía sin
     * descubrirse ni un título suyo. Una fuente que solo entra cuando la otra falla no es una
     * fuente, es un repuesto.
     *
     * Se le reserva un tercio del cupo. Si trae menos, lo que sobre se queda para la otra.
     */
    const extra = await deCinecalidad;
    const vistos = new Set(items.map(x => x.id));
    const nuevos = extra.filter(it => !vistos.has(it.id));
    const reservado = Math.min(nuevos.length, Math.max(1, Math.ceil(limit / 3)));
    const salida = items.slice(0, Math.max(0, limit - reservado)).concat(nuevos.slice(0, reservado));
    return salida;
  }
}
