import axios from 'axios';
import * as cheerio from 'cheerio';
import { MediaItem, ServerOption, CastMember, ContentType } from '../types';
import { SourceManager } from './sourceManager';
import { TmdbService, tmdbImagePath, TmdbMatch } from './tmdbService';
import { USER_AGENT, httpClient } from '../utils/httpClient';
import { inspectEmbed, getServerName } from '../scrapers/embedHealth';
import { nombreConTipo, getPrimaryStream } from './streamSorter';
import { extractDirect, describeDirect, deferredDirectFields, unwrapRedirector } from '../scrapers/directStream';
import {
  esUrlDeMoviedays,
  parseMoviedaysUrl,
  moviedaysSourceUrl,
  pedirMoviedays,
  servidoresDeMoviedays,
  fechaDeMoviedays,
  generosDeMoviedays,
  tituloDeMoviedays,
  temporadasDeMoviedays,
  pedirTemporadasMoviedays,
  sondaDeServidoresMoviedays,
} from '../scrapers/moviedays';
import { yearFromSlug, slugify, canonicalTitle } from '../utils/text';

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
  // El separador es opcional: TioPlus rotula «S01 E01» y otras plantillas «S1-E1».
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

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * INTERNET ARCHIVE — la única fuente cuyos ficheros no caducan POR DISEÑO.
 *
 * Todas las demás webs firman sus urls de vídeo con una caducidad dentro, y por eso el catálogo
 * dejó de guardarlas. archive.org publica ficheros públicos sin firma, tiene API abierta (nada
 * de scrapear HTML) y no pone captcha. Encaja con el modelo entero.
 *
 * PERO SU METADATA LA ESCRIBE QUIEN SUBE, y eso obliga a una regla de identidad propia. Medido
 * el 2026-08-20 sobre 1.000 items de cada `subject`:
 *
 *   `metadata.year` NO ES EL AÑO DE LA OBRA. Es el de la edición o el de la subida, y discrepa
 *   del año real en el 31 % de las películas que lo llevan también en el título. El caso que lo
 *   dejó claro: «007 - Nuestro hombre de Bond Street (1984)» tiene `year: 1997` — el año del
 *   doblaje. Emparejar con TMDB usando ese año elige otra película, y una ficha sirviendo el
 *   vídeo de otra es el peor fallo de este proyecto (FUENTES.md §1).
 *
 * De ahí que aquí el año salga del TÍTULO o de la ficha estructurada de la descripción, y que
 * un item sin año NO ENTRE. Cuesta contenido —solo el 4 % de las películas y el 2 % de las
 * series llevan el año en el título— y es el precio de no inventar identidades.
 *
 * Y ese mismo item de 007 enseña la otra trampa: tiene CERO ficheros de vídeo. Es una subida de
 * doblaje con carátula. Por eso no basta con que la metadata cuadre: tiene que haber fichero.
 * ══════════════════════════════════════════════════════════════════════════════════════════
 */
const ARCHIVE_BASE = 'https://archive.org';

/**
 * Las etiquetas por las que se le pregunta al archivo, MEDIDAS UNA A UNA Y ENTERAS.
 *
 * No son las que suenan bien: son las que dejan títulos después del filtro de identidad, contando
 * la etiqueta completa y no sus primeros cien items (2026-08-22).
 *
 *   Pelicula   3.759 items → 849 pasan        Serie       5.555 → 92
 *   Peliculas  2.777 items → 144 pasan        Telenovela    311 → 45
 *   Pelis        110 items →   0 pasan        Series     10.000 → 13
 *
 * «Pelis» estaba y no aporta ni uno; «Peliculas» y «Telenovela» no estaban y aportan 189. Quien
 * quiera añadir otra que la mida igual: una etiqueta de más son miles de items que filtrar.
 */
const ETIQUETAS_ARCHIVE: Record<ContentType, string[]> = {
  movie: ['Pelicula', 'Peliculas'],
  tvseries: ['Serie', 'Telenovela', 'Series'],
};

/**
 * El año de la OBRA. Nunca `metadata.year` — ver el bloque de arriba.
 *
 * Dos sitios, los dos escritos por quien sube pero los dos referidos a la obra y no a la subida:
 * el `(AAAA)` del título, y la ficha estructurada que muchos ponen en la descripción
 * («Año: 1984»). Si ninguno lo dice, se devuelve '' y el item se descarta más arriba.
 */
export function anioDeArchive(titulo: string, descripcion: string): string {
  const t = /\((19|20)\d{2}\)/.exec(String(titulo || ''));
  if (t) return t[0].slice(1, 5);
  const d = /(?:a[ñn]o|year)\s*(?:de\s+estreno\s*)?:?\s*(?:<[^>]*>\s*)*((?:19|20)\d{2})/i.exec(String(descripcion || ''));
  return d ? d[1] : '';
}

/**
 * ¿Es un PACK y no una obra? Se mira ANTES de tocar TMDB.
 *
 * archive.org está lleno de subidas como «PELÍCULAS DE OLMEDO Y PORCEL 37 PELICULAS» o
 * «Peliculas De Accion Completas Gratis 2018»: un item con veinte películas dentro. Emparejarlo
 * con TMDB produce una ficha que dice ser una obra y entrega otra en cada reproducción.
 */
const PACK_ARCHIVE: RegExp[] = [
  /\d+\s*pel[ií]culas/i,
  /completas\s+gratis/i,
  /\b(pack|colecci[óo]n|coleccion|saga\s+completa|recopilaci[óo]n)\b/i,
  /\b\d{1,3}\s*-\s*\d{1,3}\b/,
];
export function esPackArchive(titulo: string): boolean {
  const t = String(titulo || '');
  return PACK_ARCHIVE.some(re => re.test(t));
}

/**
 * La clase que DECLARA la fuente en sus etiquetas (FUENTES.md §2.2), nunca deducida del título.
 *
 * `subject` es una lista libre que escribe quien sube, así que se aceptan las grafías que se han
 * visto de verdad: la ficha de Shrek que ya estaba en el catálogo viene etiquetada «Pelis», no
 * «Pelicula». Lo que NO se hace es adivinar: sin una etiqueta de clase, el item no entra.
 *
 * La serie se comprueba primero porque un item puede llevar las dos («Serie», «Peliculas») y en
 * ese caso manda la más específica: una serie mal clasificada como película se anuncia entera
 * por lo que traiga su primer fichero, que es el fallo de FUENTES.md §4.
 */
export function claseDeArchive(subject: unknown): ContentType | null {
  const etiquetas = (Array.isArray(subject) ? subject : [subject])
    .map(s => String(s || '').toLowerCase());
  const hay = (re: RegExp) => etiquetas.some(t => re.test(t));
  if (hay(/^series?$|^serie\s|telenovela|temporada/i)) return 'tvseries';
  if (hay(/^pel[ií]culas?$|^pelis?$|^movies?$|^cine$|^largometraje$/i)) return 'movie';
  return null;
}

/**
 * Los ficheros de vídeo de un item, EL MÁS REPRODUCIBLE PRIMERO.
 *
 * Ordenaba por tamaño descendente, o sea que elegía siempre la copia más pesada. Sobre el host
 * más lento del catálogo eso es exactamente al revés de lo que conviene. En Fight Club, el mismo
 * item ofrece las dos:
 *
 *   (1999) Fight Club (David Fincher).mkv    3.312 MB   original     ← se elegía esta
 *   (1999) Fight Club (David Fincher).mp4      835 MB   derivative
 *
 * Cuatro veces más bytes por el mismo minuto de película. Y archive.org da ~1,1 MB/s: a 3.312 MB
 * para 139 minutos son 3,2 Mbps, que con esa conexión va justo y se corta; a 835 MB son 0,8 Mbps,
 * que entra de sobra. No es un ajuste de calidad, es la diferencia entre verla y no verla.
 *
 * Dos criterios, en este orden:
 *
 *   1. `.mp4` antes que `.mkv`, `.webm` o `.avi`. No es solo tamaño: ExoPlayer abre un mp4
 *      progresivo sin sorpresas, y en un mkv depende del códec que lleve dentro.
 *   2. Entre las del mismo tipo, LA MÁS LIGERA que siga siendo la obra completa.
 *
 * El suelo contra coger un tráiler o una muestra es doble: `MINIMO_VIDEO_BYTES` en absoluto, y un
 * cuarto del fichero mayor del item en relativo. Un derivado legítimo pesa una fracción del
 * original —aquí, la cuarta parte—, no una centésima.
 *
 * Se sigue descartando `.ia.mp4`, que es la recodificación de archive para su propio reproductor
 * web y sí es de bastante peor calidad. Los derivados buenos se llaman `<nombre>.mp4`.
 *
 * El mínimo absoluto va bajo a propósito (40 MB): un capítulo de serie de 20 minutos pesa poco y
 * es legítimo.
 */
/**
 * ¿Este fichero declara en su nombre un AÑO DISTINTO al de la ficha? Entonces es OTRA película.
 *
 * `esPackArchive` caza los items que se anuncian como recopilación («37 PELICULAS»), pero no los
 * que no lo dicen. `asterix-el-galo-1967-cine.flipax.es` se llama como una sola obra y dentro
 * lleva tres, cada una en dos contenedores:
 *
 *     Asterix El Galo (1967) - (cine.flipax.es).avi / .mp4     ← la de la ficha
 *     Asterix En America (1994) - (cine.flipax.es).avi / .mp4  ← otra película
 *     Asterix En Bretaña (1986) - (cine.flipax.es).avi / .mp4  ← otra película
 *
 * Los seis colgaban de la ficha «Astérix El Galo», así que el reproductor empezaba por una
 * película que nadie había pedido y, cuando esa no abría, iba probando las demás. Reportado como
 * que ese título tarda muchísimo — y el riesgo peor no era la tardanza: era entregar otra obra
 * sin dar ningún error, que es el fallo que FUENTES.md §4 llama el peor de todos.
 *
 * El año es el desempate honesto, y es el mismo criterio que el catálogo ya exige para conceder
 * identidad a una ficha. Se descarta SOLO cuando el nombre declara un año y ese año no es el de
 * la ficha: si el fichero no dice ninguno no se puede demostrar nada y se queda, igual que en
 * series un fichero que no declara capítulo no se coloca a ciegas.
 *
 * Sin año de ficha no se filtra nada: quien no sabe contra qué comparar no debe descartar.
 */
function declaraOtroAnio(nombre: string, anioDeLaFicha?: string): boolean {
  const esperado = String(anioDeLaFicha || '').trim();
  if (!/^(19|20)\d{2}$/.test(esperado)) return false;

  const m = /\((19|20)\d{2}\)/.exec(String(nombre || ''));
  if (!m) return false;

  return m[0].slice(1, 5) !== esperado;
}

const MINIMO_VIDEO_BYTES = 40 * 1024 * 1024;

/** Y al menos esta fracción del fichero mayor del item: por debajo es un extra, no la obra. */
const FRACCION_MINIMA_DEL_MAYOR = 0.25;

export function ficherosDeVideoArchive(
  files: any[],
  anioDeLaFicha?: string,
): Array<{ name: string; size: number }> {
  const candidatos = (files || [])
    .map(f => ({ name: String(f?.name || ''), size: Number(f?.size || 0) }))
    .filter(f => /\.(mp4|mkv|webm|avi)$/i.test(f.name))
    .filter(f => !/\.ia\.mp4$/i.test(f.name))
    .filter(f => f.size >= MINIMO_VIDEO_BYTES)
    .filter(f => !declaraOtroAnio(f.name, anioDeLaFicha));

  if (!candidatos.length) return [];

  const mayor = Math.max(...candidatos.map(f => f.size));
  const completos = candidatos.filter(f => f.size >= mayor * FRACCION_MINIMA_DEL_MAYOR);

  const esMp4 = (n: string) => /\.mp4$/i.test(n);

  return completos.sort((a, b) => {
    // Primero el contenedor que el reproductor abre sin pensar.
    if (esMp4(a.name) !== esMp4(b.name)) return esMp4(a.name) ? -1 : 1;
    // Y entre iguales, la más ligera: menos bytes por minuto es menos que descargar.
    return a.size - b.size;
  });
}

/**
 * El capítulo que DECLARA el nombre del fichero. `null` si no lo declara.
 *
 * Un item de serie suele ser una temporada entera con los capítulos sueltos, y hay que emparejar
 * fichero → capítulo. SI EL NOMBRE NO LO DICE, ESE FICHERO NO SE USA: colocar un vídeo en el
 * capítulo equivocado es el fallo que FUENTES.md §4 llama el peor sin dar error — el enlace
 * existe, reproduce, y entrega otra cosa. Adivinar por el orden alfabético es exactamente eso.
 */
export function capituloDeArchive(nombre: string): { season: number; episode: number } | null {
  const n = String(nombre || '');
  let m = /[sS](\d{1,2})[\s._-]*[eE](\d{1,3})/.exec(n);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = /\b(\d{1,2})\s*[xX]\s*(\d{1,3})\b/.exec(n);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = /(?:cap[ií]tulo|capitulo|cap|episodio|ep)[\s._-]*(\d{1,3})\b/i.exec(n);
  if (m) return { season: 1, episode: Number(m[1]) };
  m = /\s-\s*(\d{1,3})\s*-\s/.exec(n);
  if (m) return { season: 1, episode: Number(m[1]) };
  return null;
}

/**
 * El NOMBRE DE LA OBRA, sacado del título que escribió quien subió el fichero.
 *
 * Hace falta porque en archive.org el título no es un campo de catálogo: es el nombre que le puso
 * una persona, y viene con todo lo que a esa persona le pareció útil. Medido abriendo las diez
 * primeras películas que pasan el filtro de identidad, el matcher de TMDB falló en cuatro y las
 * cuatro por lo mismo — ruido, no ambigüedad:
 *
 *   «Volver Al Futuro en español latino»      → no casó con Volver al futuro
 *   «Fight Club (David Fincher)»              → no casó con El club de la lucha
 *   «12 Hombres En Pugna (VOSE)»              → no casó con Doce hombres sin piedad
 *   «¡Qué Verde Era Mi Valle! - 1941»         → no casó con ¡Qué verde era mi valle!
 *
 * Sin match no hay ficha: el título se queda con un tmdb_id sintético negativo, sin carátula ni
 * sinopsis, y el catálogo gana un enlace que no sabe enseñar. Por eso esto limpia de verdad.
 *
 * Lo que NO se toca es el año: se lee ANTES (`anioDeArchive`) y sigue siendo la señal que impide
 * que un título limpio empareje con la obra equivocada. Limpiar el nombre sin exigir el año sería
 * volver a fusionar por título, que es lo que FUENTES.md §1 prohíbe.
 */
export function tituloDeArchive(crudo: string): string {
  let t = String(crudo || '');

  // Lo que va entre corchetes es siempre añadido del que sube: «[Doblaje + Carátula VHS]».
  t = t.replace(/\[[^\]]*\]/g, ' ');
  // El año, en cualquiera de sus formas: «(1941)», «- 1941», « 1941» al final.
  t = t.replace(/\((19|20)\d{2}\)/g, ' ').replace(/[\s-]+(19|20)\d{2}\s*$/g, ' ');
  // Paréntesis con el director o la versión: «(David Fincher)», «(VOSE)», «( Alfred Hitchcock)».
  t = t.replace(/\([^)]*\)/g, ' ');

  /**
   * LA COLA DE IDIOMA Y SUBTÍTULOS SE LLEVA TODO LO QUE VENGA DETRÁS.
   *
   * archive.org corta los títulos largos, así que la coletilla llega a medias y no hay forma de
   * enumerarla: «Hallam Foe Inglés + Subtítulos En», «Lust, Caution Mandarín + Subtítulos En»,
   * «The Concubine Coreano + Subtítulos En». Lo que sí es constante es dónde EMPIEZA —el idioma
   * seguido de «+ Subtítulos»—, y desde ahí no queda nada del nombre de la obra.
   *
   * Se recorta desde la palabra que abre la cola, no solo la palabra: quitar «Subtítulos» y dejar
   * «Hallam Foe Inglés En» no arregla nada, y era el estado en el que estaban cuatro fichas.
   */
  t = t.replace(/\s*\b(ingl[eé]s|mandar[ií]n|coreano|japon[eé]s|franc[eé]s|italiano|alem[aá]n|portugu[eé]s|ruso|chino|hindi|tailand[eé]s|sueco|dan[eé]s|noruego|polaco|turco|[aá]rabe|hebreo|griego|checo|h[uú]ngaro|finland[eé]s|holand[eé]s|neerland[eé]s|catal[aá]n|vasco|gallego|coreana|original)?\s*[+·|-]*\s*\b(subt[ií]tulos?|subs)\b.*$/i, ' ');

  /**
   * Coletillas de idioma, formato y fuente. Se quitan de DONDE ESTÉN, no solo del final: aparecen
   * también en medio («Volver Al Futuro en español latino [1080p] remasterizada»).
   */
  const COLETILLAS = [
    /\b(en\s+)?(audio\s+)?espa[ñn]ol\s+latino\b/gi,
    /\b(en\s+)?(audio\s+)?latino\b/gi,
    /\b(en\s+)?castellano\b/gi,
    /\bespa[ñn]ol\b/gi,
    /\bdoblaje[s]?(\s+\w+)?\b/gi,
    /\bsubtitulad[ao]s?\b/gi,
    /\bv\.?o\.?s\.?[ae]?\b/gi,
    /\b(dual|remasterizad[ao]|completa|pel[ií]cula\s+completa)\b/gi,
    /**
     * El doblaje REGIONAL, que es una coletilla más: «Vecinos Invasores Mexicano» no es una
     * película distinta de «Vecinos invasores», es la misma con el doblaje de México. Sin esto
     * el matcher no daba con ella y la ficha entraba sin identidad.
     */
    /\b(mexicano|mexicana|latinoamericano|latinoamericana|sudamericano|sudamericana)\b/gi,
    /\b(1080p|720p|480p|360p|4k|hd|full\s*hd|dvdrip|brrip|bluray|blu-ray|web-?dl|hdtv|vhs|dvd|betamax|cinta)\b/gi,
    /\bmp4\b/gi,
  ];
  for (const re of COLETILLAS) t = t.replace(re, ' ');

  // Signos sueltos que deja la limpieza, y espacios de más.
  t = t.replace(/[-–—_.]+\s*$/g, ' ').replace(/^\s*[-–—_.]+/g, ' ');
  t = t.replace(/\s{2,}/g, ' ').trim();

  // Si la limpieza se lo comió entero, vale más el original que una cadena vacía.
  return t || String(crudo || '').trim();
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * EL IDENTIFICADOR DICE MEJOR QUÉ OBRA ES QUE EL TÍTULO QUE ESCRIBIÓ QUIEN SUBIÓ EL FICHERO.
 *
 * El título de archive.org es texto libre y llega con todo lo que a esa persona le pareció útil,
 * a menudo cortado a media coletilla. El identificador —`hallam-foe-2007`, `lust-caution_2007`,
 * `vecinos-invasores-2006-espanol-mexicano`— es el slug del propio archivo: mismo nombre, sin
 * el ruido, y con el año dentro las más de las veces.
 *
 * Medido sobre las 12 fichas de archive.org que se habían quedado sin identidad en TMDB: por el
 * título mostrado se recuperaban CERO; por el identificador, ocho, todas respaldadas.
 *
 * Tres clases de basura numérica se descartan aquí, y cada una tiene su forma:
 *   · el año (`2007`)               → se devuelve aparte, no se tira;
 *   · el sufijo de subida (`202508`) → seis dígitos o más, nunca es un año;
 *   · el número de catálogo (`0059`) → empieza por cero y va delante del nombre.
 *
 * El «40» de `0059-40-pistolas` NO es ninguna de las tres y se queda: un número sin cero
 * delante forma parte del título tantas veces como no.
 * ═══════════════════════════════════════════════════════════════════════════════════════
 */
/**
 * EL OTRO NOMBRE DE LA OBRA, EL QUE QUIEN SUBE ESCRIBE EN LA DESCRIPCIÓN.
 *
 * En archive.org es costumbre abrir la descripción con el nombre de verdad y el año antes de
 * enlazar la sinopsis: «Cuarenta pistolas (1957) Sinopsis: filmaffinity…», mientras el título
 * mostrado dice «40 Pistolas» y el identificador `0059-40-pistolas`. TMDB registra la película
 * como «Dragones de la violencia» y conoce «Cuarenta pistolas» como nombre alternativo, así que
 * ese es el único de los tres con el que se la encuentra.
 *
 * Se exige que el paréntesis contenga EXACTAMENTE el año y que esté al principio: así una sinopsis
 * que empieza «Durante la II Guerra Mundial (1939-1945)…» no se confunde con un título. Lo que
 * salga de aquí es un CANDIDATO más para el matcher, no una identidad: si TMDB no lo reconoce, no
 * pasa nada.
 */
export function nombreDeLaDescripcion(descripcion: string): string {
  const texto = String(descripcion || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').trim();
  const m = /^\s*(.{2,80}?)\s*\((?:19|20)\d{2}\)/.exec(texto);
  if (!m) return '';
  const limpio = tituloDeArchive(m[1]);
  // Una línea que solo trae puntuación o una palabra suelta no es un título.
  return /[a-záéíóúñ]/i.test(limpio) ? limpio : '';
}

export function identidadDeArchive(identifier: string): { titulo: string; year: string } {
  const tokens = String(identifier || '').split(/[-_\s]+/).filter(Boolean);
  let year = '';
  const palabras: string[] = [];

  for (const tk of tokens) {
    if (/^(19|20)\d{2}$/.test(tk)) { if (!year) year = tk; continue; }
    if (/^\d{6,}$/.test(tk)) continue;
    if (/^0\d+$/.test(tk) && palabras.length === 0) continue;
    palabras.push(tk);
  }

  /**
   * El identificador viene todo en minúsculas y ese nombre puede acabar EN LA FICHA: `pickDisplayTitle`
   * se queda con el de la fuente cuando el de TMDB está en otro alfabeto (tmdb 4588 se titula «色‧戒»
   * hasta en es-MX). Se pone en mayúscula la primera letra y ya está — al matcher le da igual la caja,
   * y capitalizar cada palabra convertiría «la gorra 2» en algo que no se escribe así en español.
   */
  const limpio = tituloDeArchive(palabras.join(' '));
  return { titulo: limpio ? limpio.charAt(0).toUpperCase() + limpio.slice(1) : '', year };
}

/**
 * ¿ESTE ITEM ES PARA ESTE CATÁLOGO? O sea: ¿está en español latino?
 *
 * Faltaba, y se notó enseguida: entraron «Brat 2» (rusa) y «Приключения Буратино» (rusa también).
 * archive.org es un archivo del mundo entero — la etiqueta `Pelicula` la pone quien sube, y la
 * pone gente que sube cine de cualquier idioma.
 *
 * Se mira lo que el item DECLARA, nunca lo que parezca el título. Medido sobre 100 items de
 * `subject:"Pelicula"`: 47 traen `language: spa`, 44 no traen nada, y el resto son `eng`, `rus`
 * y `ger`. O sea que el campo sirve para descartar en la mitad de los casos y hay que apoyarse en
 * el texto para la otra mitad.
 *
 * Tres reglas, en este orden:
 *
 *   1. Si DECLARA idioma y no es español, fuera. Es la señal más fuerte y la que mata a Brat 2.
 *   2. Si no declara, tiene que haber una marca de audio español en el título, las etiquetas o la
 *      descripción. Sin ninguna prueba de idioma NO ENTRA: es la misma regla que el año — este
 *      archivo no da garantías, así que lo que no se puede demostrar se queda fuera.
 *   3. Y entre los españoles, se exige LATINO: un item que se rotula «castellano» o «España» y en
 *      ningún sitio dice latino es un doblaje de España, que no es lo que este catálogo sirve.
 *
 * También caen aquí los subtitulados (`VOSE`, `sub español`, `legendado`): el audio no es español
 * aunque el texto lo sea, y «Yojimbo - Japonés-sub.español» es exactamente el caso.
 */
export function esEnEspanolLatino(md: any): boolean {
  const idiomaCrudo = Array.isArray(md?.language) ? md.language.join(' ') : String(md?.language || '');
  const idioma = idiomaCrudo.toLowerCase().trim();
  const ES_ESPANOL = /(^|[^a-z])(spa|spanish|español|espanol|castellano|es)([^a-z]|$)/i;

  // 1. Declara idioma y no es español.
  if (idioma && !ES_ESPANOL.test(idioma)) return false;

  const texto = [
    md?.title,
    Array.isArray(md?.subject) ? md.subject.join(' ') : md?.subject,
    md?.description,
  ].map(x => String(x || '')).join(' ').toLowerCase();

  // Subtitulado o doblado a otra cosa: el audio no es español.
  if (/\bvose\b|v\.o\.s|subtitulad|sub\.?\s*espa[ñn]ol|legendado|dublado|\bsubs?\b/i.test(texto)) return false;

  const diceLatino = /\blatino\b|latinoam|hispanoam|\bmx\b|m[ée]xico|argentin|colombia|venezuel|chile|per[úu]/i.test(texto);
  const diceEspanol = ES_ESPANOL.test(idioma) || /\bespa[ñn]ol\b|\bcastellano\b|\bdoblaje\b|\bdoblad[ao]\b/i.test(texto);

  // 2. Sin ninguna prueba de idioma, fuera.
  if (!diceLatino && !diceEspanol) return false;

  // 3. Castellano declarado y latino en ninguna parte: es el doblaje de España.
  if (!diceLatino && /\bcastellano\b|\bespa[ñn]a\b|\bibérico\b/i.test(texto)) return false;

  return true;
}

/** La url canónica y estable de un fichero. Ver `canonicalArchiveOrg` para por qué no la del nodo. */
export function urlDeFicheroArchive(identifier: string, nombre: string): string {
  return `${ARCHIVE_BASE}/download/${identifier}/${nombre.split('/').map(encodeURIComponent).join('/')}`;
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
     * MOVIEDAYS, que es el único caso en el que estas señales no hacen falta para nada.
     *
     * Todo lo que hay debajo existe para adivinar a qué obra de TMDB pertenece una página que solo
     * publica un título. Aquí la respuesta VIENE CON LA PREGUNTA: la `_source_url` lleva el
     * `tmdb_id` dentro, así que no hay nada que emparejar ni homónimo que pueda ganar.
     *
     * Se rellenan igual, y con las cuatro señales completas, porque el contrato es el contrato: el
     * matcher las usa para CONFIRMAR lo que ya sabe, y un respaldo que confirma es exactamente lo
     * que FUENTES.md pide. El `poster` de moviedays es de `image.tmdb.org`, o sea la prueba fuerte
     * del punto 2, y el `original_title` la del punto 3.
     */
    if (esUrlDeMoviedays(url)) {
      const ref = parseMoviedaysUrl(url);
      if (!ref) return null;
      const payload = await pedirMoviedays(ref.tmdbId, ref.type, ref.season, ref.episode);
      // El título de la OBRA, no el del capítulo con el que se sondeó: `embed.php` rotula las
      // series «Breaking Bad — T1E1: Piloto», y darle eso al matcher es pedirle que empareje una
      // serie contra el nombre de su primer episodio.
      const titulo = payload ? tituloDeMoviedays(payload) : '';
      if (!payload || !titulo) return null;
      return {
        title: titulo,
        year: fechaDeMoviedays(payload).substring(0, 4),
        originalTitle: String(payload.original_title || '').trim(),
        imageHint: String(payload.poster || ''),
        episode: ref.season && ref.episode ? { season: ref.season, episode: ref.episode } : null,
        type: ref.type,
      };
    }

    /**
     * ARCHIVE.ORG no tiene página que leer: sus señales están en `/metadata/<id>`.
     *
     * Da título y AÑO —el de la obra, sacado del título o de la ficha de la descripción, nunca
     * `metadata.year`, que es el de la subida— y la clase que declara en `subject`. Lo que NO da
     * es `imageHint`: su miniatura es un fotograma del propio fichero y no identifica ninguna
     * ficha de TMDB. Se devuelve vacío a propósito: inventarlo sería peor que no tenerlo.
     */
    if (/archive\.org\/(details|metadata|download)\//i.test(url)) {
      const m = /archive\.org\/(?:details|metadata|download)\/([^/?#]+)/i.exec(url);
      if (!m) return null;
      try {
        const res = await httpClient.get(`${ARCHIVE_BASE}/metadata/${encodeURIComponent(decodeURIComponent(m[1]))}`,
          { timeout: 20000, validateStatus: () => true } as any);
        if (res.status >= 400) return null;
        const md = (res.data as any)?.metadata || {};
        const crudo = String(md.title || '').trim();
        if (!crudo) return null;
        return {
          title: tituloDeArchive(crudo),
          year: anioDeArchive(crudo, String(md.description || '')),
          originalTitle: '',
          imageHint: '',
          type: claseDeArchive(md.subject),
          episode: null,
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
   * LAS PÁGINAS DE LOS CAPÍTULOS DE UNA SERIE, ordenadas de la primera a la última.
   *
   * Una serie de FuegoCine no tiene página propia: cada capítulo es un post suelto y su url queda
   * guardada con él (`_fuegocine_url`). Sirven para dos cosas —resolver sus servidores y PROBAR
   * QUIÉN ES la serie— y esta función es el único sitio donde se sabe de dónde sacarlas.
   */
  static paginasDeCapitulos(seasons: any[] | undefined | null, excepto?: string | null): string[] {
    const urls: Array<{ orden: number; url: string }> = [];
    for (const t of (seasons || [])) {
      for (const e of ((t as any)?.episodes || [])) {
        const url = String((e as any)?._fuegocine_url || '');
        if (!url || url === excepto) continue;
        urls.push({ orden: Number(t?.season_number || 0) * 1000 + Number(e?.episode_number || 0), url });
      }
    }
    urls.sort((a, b) => a.orden - b.orden);
    return Array.from(new Set(urls.map(u => u.url)));
  }

  /**
   * ¿QUIÉN ES ESTA SERIE? PREGUNTÁNDOSELO A VARIOS DE SUS CAPÍTULOS.
   *
   * Las series de FuegoCine se identifican por el fotograma del capítulo: sus posts no publican ni
   * año ni título original, y ese hash es la única prueba dura que hay. Pero NO TODOS los
   * capítulos sirven — que el fotograma que publica la página esté registrado en TMDB para ese
   * capítulo depende de lo que haya subido la gente. Medido sobre «Stranger Things», capítulo a
   * capítulo: 35 de sus 42 páginas valen como prueba, y las 7 que no están repartidas por todas
   * las temporadas. Da la casualidad de que la que quedó como página de origen de la ficha —la
   * del último capítulo publicado, 5x8— es una de esas 7, y por eso la serie entraba sin ficha
   * de TMDB teniendo la prueba en las otras 35 páginas.
   *
   * Preguntar a UNA página y rendirse era, entonces, jugárselo a un 17 % de fallo por serie. Con
   * tres intentos ese fallo baja al 0,5 %, y solo se pagan cuando la primera no ha bastado: una
   * serie que se identifica a la primera no cuesta ni una petición más que antes.
   *
   * Solo se devuelve lo RESPALDADO. Si ninguna página confirma, se devuelve `null` y la serie se
   * queda con la metadata de su fuente, como manda la regla de la casa: sin respaldo no se adopta
   * la ficha de TMDB.
   */
  static async identidadPorFotograma(
    paginas: string[],
    intentos = 3
  ): Promise<{ signals: SourceSignals; match: TmdbMatch } | null> {
    for (const url of paginas.slice(0, Math.max(0, intentos))) {
      const signals = await this.fetchSourceSignals(url).catch(() => null);
      // Sin capítulo declarado o sin imagen de TMDB, esta página no puede probar nada: no se
      // gasta una consulta al matcher en ella.
      if (!signals?.title || !signals.episode || !tmdbImagePath(signals.imageHint)) continue;

      const match = await TmdbService.resolveTmdb(
        signals.title, 'tvseries', signals.year || undefined, `fc:${signals.title}`,
        {
          originalTitle: signals.originalTitle || null,
          imageHint: signals.imageHint,
          episodeHint: signals.episode,
        }
      ).catch(() => null);

      if (match?.matched && match.verified && match.type === 'tvseries') return { signals, match };
    }
    return null;
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
          overview: description || '',
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
          overview: '',
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
    // Moviedays no tiene página que scrapear: su ficha es una llamada a `api/embed.php`.
    if (esUrlDeMoviedays(tioplusUrl)) {
      return this.scrapeMoviedaysDetail(tioplusUrl);
    }

    if (tioplusUrl.includes('fuegocine.com')) {
      return this.scrapeFuegocineDetail(tioplusUrl);
    }

    // Internet Archive: no hay HTML que leer, su ficha es una llamada a `/metadata/<id>`.
    if (/archive\.org\/(details|metadata|download)\//i.test(tioplusUrl)) {
      return this.scrapeArchiveDetail(tioplusUrl);
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
                    overview: '',
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
        overview: overview || '',
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
    opts: { sourceUrls?: string[]; tmdbId?: number } = {}
  ) {
    /**
     * EL ID DE TMDB DE LA SERIE, que es lo único que moviedays entiende.
     *
     * Se busca en tres sitios y por este orden: el que pasa el catálogo (lo normal, porque la fila
     * ya lo tiene resuelto), el que lleve dentro una `_source_url` de moviedays, y el propio slug
     * cuando ES un número o un `md-<id>`. Si no aparece por ninguna vía, moviedays simplemente no
     * participa en este capítulo — no se inventa nada.
     */
    const tmdbSerie =
      Number(opts.tmdbId) ||
      (opts.sourceUrls || []).map(u => parseMoviedaysUrl(String(u))?.tmdbId).find(Boolean) ||
      Number(/^(?:md-)?(\d+)$/.exec(String(seriesSlug))?.[1]) ||
      0;

    /**
     * Y SE LE PREGUNTA YA, en paralelo con el scraping de las páginas.
     *
     * Es una llamada a una API por id, no un scraping: no hay ruta que adivinar ni rótulo que
     * comprobar, porque `embed.php` devuelve el capítulo que se le pide o un 404. Por eso entra
     * por su propia puerta y no como una candidata más — `esDelEpisodio` no tiene nada que
     * verificar aquí, la identidad viene en la petición.
     *
     * Arranca antes del bucle a propósito: su respuesta (2-4 s) se solapa con la primera tanda en
     * vez de sumarse a ella.
     */
    const promesaMoviedays: Promise<ServerOption[]> = tmdbSerie
      ? pedirMoviedays(tmdbSerie, 'tvseries', season, episode)
          .then(p => servidoresDeMoviedays(p, `srv_md_${season}x${episode}`))
          .catch(() => [] as ServerOption[])
      : Promise.resolve([] as ServerOption[]);

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

    desdeFuente.push(...deFuegocine);

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
     * los tres directos de la otra fuente no se miraban siquiera, porque su candidata iba
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

    const anotar = (sv: ServerOption) => {
      const clave = unwrapRedirector(sv.embed_url);
      if (!clave || clavesVistas.has(clave)) return;
      clavesVistas.add(clave);
      servidores.push(sv);
    };

    for (const [nTanda, tanda] of tandas.entries()) {
      const settled = await Promise.allSettled(tanda.map(c => this.scrapeDetail(c.url)));
      settled.forEach((r, i) => {
        const d = r.status === 'fulfilled' ? r.value : null;
        const cand = tanda[i];
        if (!d || !d.servers || d.servers.length === 0) return;
        if (!esDelEpisodio(d.title, season, episode, { exigeRotulo: cand.adivinada })) return;
        if (!detail) detail = d;   // la primera válida da nombre, imagen y sinopsis al capítulo
        for (const sv of d.servers) anotar(sv);
      });
      // Lo de moviedays se recoge junto a la primera tanda, que es con la que se lanzó.
      if (nTanda === 0) for (const sv of await promesaMoviedays) anotar(sv);
      // Solo se paga la siguiente tanda si esta no ha dejado nada que el cliente pueda reproducir.
      if (servidores.some(sv => sv.direct_stream)) break;
    }

    /**
     * QUE NO HAYA `detail` YA NO ES MOTIVO PARA IRSE CON LAS MANOS VACÍAS.
     *
     * `detail` es la página de un capítulo, y de ella salían el nombre, la imagen y —sobre todo— el
     * título con el que después se buscaba el `tmdb_id`. Moviedays no tiene página: contesta por
     * id, así que puede dar servidores de un capítulo del que ninguna web publique nada. Con la
     * condición antigua ese capítulo se devolvía como si no existiera, tirando unos servidores que
     * ya se habían resuelto y pagado.
     *
     * El nombre y la imagen no se pierden: el catálogo los rellena desde TMDB
     * (`deLaFicha` en `getEpisodeStreams`), que es de donde deberían salir de todas formas.
     */
    if (!detail && servidores.length === 0) return null;

    /**
     * El id ya resuelto MANDA sobre volver a buscarlo por título.
     *
     * `getTmdbId` es el emparejado a ciegas que FUENTES.md pide evitar siempre que haya algo mejor,
     * y aquí muy a menudo lo hay: el catálogo pasa el `tmdb_id` de la serie, que es un dato ya
     * confirmado. Preguntarlo otra vez por el título del capítulo era gastar una búsqueda para
     * arriesgarse a un homónimo. Solo se busca cuando no queda otra.
     */
    const tmdbId = tmdbSerie
      ? tmdbSerie
      : detail
      ? isNaN(Number(seriesSlug))
        ? await TmdbService.getTmdbId(detail.title || seriesSlug, 'tvseries',
            detail.release_date ? detail.release_date.substring(0, 4) : undefined,
            { originalTitle: detail.original_title, imageHint: detail.poster })
        : Number(seriesSlug)
      : 0;
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
            overview: '',
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
      } else if (src.id === 'archive') {
        finalResults.push(...await this.scrapeArchiveSearch(q, limit));
      } else if (src.id === 'moviedays') {
        finalResults.push(...await this.scrapeMoviedaysSearch(q).catch(() => [] as MediaItem[]));
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
   * MOVIEDAYS — la ficha de una obra, pedida por su id de TMDB.
   *
   * Es la única fuente cuya ficha llega con `tmdb_id` PUESTO en vez de con un 0 a la espera de que
   * el matcher adivine. No es un atajo: es que aquí no hay nada que adivinar, y por eso esta fuente
   * no puede cometer el fallo que FUENTES.md documenta —adoptar la ficha de un homónimo—, ni
   * siquiera si quisiera.
   *
   * De los dos proveedores que agrega moviedays solo se publica `vimeus`; el porqué de tirar el
   * otro está escrito en `PROVEEDORES_ALCANZABLES` (src/scrapers/moviedays.ts) y se resume en que
   * termina contra el muro de Cloudflare de zonaaps.com, que no deja pasar a ningún datacenter.
   */
  static async scrapeMoviedaysDetail(
    url: string,
    /**
     * `resolverServidores: false` es la SONDA del crawl, y existe porque en esta fuente descubrir
     * y leer la ficha son la misma petición.
     *
     * En las otras webs el descubrimiento es barato (una página de listado con veinte tarjetas) y
     * lo caro es el detalle, así que el crawl recorre listados y después baja a las fichas. Aquí no
     * hay listado: cada título se descubre preguntando por él. Si el descubrimiento resolviera
     * además todos los embeds, el crawl pagaría la extracción DOS VECES — una al descubrir y otra
     * en `quedarseConLoQueReproduce`, que vuelve a llamar a `scrapeDetail` sobre cada ficha.
     *
     * Con la sonda, el descubrimiento solo pregunta «¿tienes algún servidor alcanzable de esto?»,
     * que es una petición y ninguna extracción. Quien de verdad necesita el vídeo lo pide luego.
     */
    opts: { resolverServidores?: boolean } = {}
  ): Promise<MediaItem | null> {
    const ref = parseMoviedaysUrl(url);
    if (!ref) return null;

    const payload = await pedirMoviedays(ref.tmdbId, ref.type, ref.season, ref.episode);
    if (!payload) return null;

    const title = tituloDeMoviedays(payload);
    if (!title) return null;

    const servers = opts.resolverServidores === false
      ? sondaDeServidoresMoviedays(payload)
      : await servidoresDeMoviedays(payload);
    /**
     * SIN SERVIDORES NO HAY FICHA.
     *
     * Las otras fuentes devuelven la ficha aunque venga vacía porque su página existe y ya se ha
     * pagado el viaje. Aquí no: una ficha de moviedays sin servidores publicables es exactamente
     * una ficha fantasma —un título anunciado que no reproduce— y esta fuente puede dar de ALTA
     * títulos nuevos, así que es la que más daño haría. Se descarta en origen.
     */
    if (servers.length === 0) return null;

    /**
     * Y EN LAS SERIES, EL ÁRBOL HECHO DESDE AQUÍ.
     *
     * Los `servers` de arriba son los del capítulo con el que se sondeó la serie, y hay dos sitios
     * del código que los repartirían entre TODOS sus capítulos si la ficha llegara sin temporadas
     * (ver `temporadasDeMoviedays`). Traerlas puestas es lo que impide que el vídeo del 1x1 acabe
     * anunciado como el del 3x5.
     */
    const sondeo = { season: ref.season || 1, episode: ref.episode || 1 };
    const seasons =
      ref.type === 'tvseries'
        ? temporadasDeMoviedays(await pedirTemporadasMoviedays(ref.tmdbId), servers, sondeo)
        : [];

    return {
      // El id lleva el tmdb dentro porque es lo único estable que tiene esta fuente: no hay slug.
      // Cuando otra fuente ya tenga la misma obra, `mergeIntoExisting` las junta por `tmdb_id`.
      id: `md-${ref.tmdbId}`,
      tmdb_id: ref.tmdbId,
      imdb_id: payload.imdb_id || null,
      type: ref.type,
      title,
      original_title: String(payload.original_title || title),
      aliases: [],
      overview: String(payload.overview || ''),
      rating: Number(payload.vote_average) || 0,
      release_date: fechaDeMoviedays(payload),
      genres: generosDeMoviedays(payload),
      subcategories: ['MovieDays'],
      poster: payload.poster || null,
      backdrop: payload.backdrop || null,
      logo: null,
      trailer: null,
      cast: [],
      dubbing_cast: [],
      runtime: Number(payload.runtime) || undefined,
      servers,
      primary_stream: getPrimaryStream(servers),
      total_seasons: ref.type === 'tvseries' ? Number(payload.total_seasons) || undefined : undefined,
      total_episodes: ref.type === 'tvseries' ? Number(payload.total_episodes) || undefined : undefined,
      seasons: seasons.length ? seasons : undefined,
      // Sin capítulo: la url que se guarda apunta a la OBRA, y `pedirMoviedays` ya sabe sondear su
      // 1x1 cuando es una serie. Ver su comentario.
      _source_url: moviedaysSourceUrl(ref.tmdbId, ref.type),
    } as MediaItem;
  }

  /**
   * MOVIEDAYS — la búsqueda, que tampoco es una búsqueda en su sitio.
   *
   * Moviedays tiene un `api/search.php`, pero no busca en SU catálogo: es un proxy del buscador de
   * TMDB. O sea que preguntarle «¿tienes Matrix?» por ahí devuelve lo que TMDB sabe de Matrix, no
   * lo que moviedays puede reproducir. Usarlo sería añadir una dependencia a cambio de nada.
   *
   * Así que se busca con el TMDB de casa —que además ya sabe desambiguar— y a moviedays se le
   * pregunta lo único que sabe contestar: si tiene vídeo de estos ids concretos.
   *
   * SOLO LOS PRIMEROS CANDIDATOS, y esto es una decisión de latencia, no de cobertura: cada
   * candidato cuesta una petición de 2-4 s a un tercero, y esta función está en el camino de una
   * búsqueda que el usuario está esperando. Los cinco primeros de TMDB cubren de sobra lo que
   * alguien tecleó; ir a por los diez dobla la espera para ganar los resultados que nadie mira.
   */
  static async scrapeMoviedaysSearch(query: string, limit = 5): Promise<MediaItem[]> {
    const q = query.trim();
    if (!q) return [];
    const candidatos = await TmdbService.searchTmdbMulti(q).catch(() => []);
    if (candidatos.length === 0) return [];

    const vistos = await Promise.allSettled(
      candidatos.slice(0, limit).map(c =>
        this.scrapeMoviedaysDetail(moviedaysSourceUrl(c.tmdb_id, c.type))
      )
    );
    return vistos
      .map(r => (r.status === 'fulfilled' ? r.value : null))
      .filter((it): it is MediaItem => Boolean(it));
  }

  /**
   * MOVIEDAYS — el descubrimiento, que va AL REVÉS que el de todas las demás.
   *
   * Las otras fuentes se recorren: se pide su índice, se leen los títulos que publican y se
   * averigua después qué son. Moviedays no tiene índice —`api/search.php` es un proxy del buscador
   * de TMDB, no su catálogo—, así que la única forma de saber qué tiene es preguntárselo obra por
   * obra. El índice, por tanto, lo pone TMDB (`discoverIds`) y moviedays hace de oráculo.
   *
   * Suena caro y no lo es tanto: `embed.php` tarda 2-4 s y aguanta el paralelismo sin quejarse
   * (medido a 8 peticiones simultáneas sobre 247 ids, 49 s y ningún bloqueo). Y a cambio no hay una
   * sola línea de emparejado por título en todo el camino.
   *
   * El tope de concurrencia es deliberadamente bajo: esta fuente es de un tercero y no tiene por
   * qué pagar nuestras pasadas de fondo a ráfagas. Es la lección del crawl de GitHub — lo que hace
   * que te corten es la RÁFAGA, no el total.
   */
  static async scrapeMoviedaysLatest(
    tipo: ContentType,
    limit = 40,
    opts: { desdePagina?: number } = {}
  ): Promise<MediaItem[]> {
    // TMDB pagina de 20 en 20, así que se piden las páginas justas para cubrir el límite pedido.
    const paginas = Math.max(1, Math.ceil(limit / 20));
    const ids = await TmdbService.discoverIds(tipo, {
      pages: paginas,
      desde: opts.desdePagina || 1,
    }).catch(() => [] as number[]);
    if (ids.length === 0) return [];

    const items: MediaItem[] = [];
    const LOTE = 5;
    for (let i = 0; i < ids.length; i += LOTE) {
      const tanda = await Promise.allSettled(
        ids.slice(i, i + LOTE).map(id =>
          // Solo la sonda: el crawl vuelve a bajar a la ficha después, y extraer aquí sería
          // pagar la extracción dos veces por cada título. Ver el comentario de `opts`.
          this.scrapeMoviedaysDetail(moviedaysSourceUrl(id, tipo), { resolverServidores: false })
        )
      );
      for (const r of tanda) {
        if (r.status === 'fulfilled' && r.value) items.push(r.value);
      }
      if (items.length >= limit) break;
    }
    return items.slice(0, limit);
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
        /**
         * EL `2x8` NO ES PARTE DEL NOMBRE DE LA SERIE. `fetchSourceSignals` ya lo recortaba y
         * este camino —el de pedir una ficha EN VIVO por su slug— no, así que al matcher le
         * llegaba "Merlina 2x8" y ninguna serie de TMDB se llama así: la ficha salía con id
         * sintético y rotulada con el número del capítulo. El nombre del post queda en `aliases`.
         */
        title: titleRaw.replace(/\s\d{1,2}\s*x\s*\d{1,3}\s*$/i, '').trim() || titleRaw,
        // El título original de la página es una señal INDEPENDIENTE del nombre regional, y es lo
        // que permite confirmar el emparejado; repetir el título mostrado no aporta nada.
        original_title: d.originalTitle || titleRaw,
        aliases: [titleRaw],
        overview,
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
        _tioplus_url: fuegocineUrl,
        // "MERLINA 2x8" → la página es del capítulo 8 de la temporada 2. Mismo motivo que en el
        // crawl: en un post de episodio el fotograma es la única prueba de identidad, y sin saber
        // de qué capítulo es no se puede comparar. Sin esto, una serie pedida EN VIVO por su slug
        // se emparejaba con lo único que le quedaba —el parecido del título— y se llevaba al
        // homónimo antiguo.
        _episode_hint: (() => {
          const m = titleRaw.match(/\s(\d{1,2})\s*x\s*(\d{1,3})\s*$/i)
            || fuegocineUrl.match(/-(\d{1,2})x(\d{1,3})\.html?$/i);
          return m ? { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) } : null;
        })()
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
          overview: '',
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
            overview: '',
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
        overview: '',
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
        /**
         * …Y DE QUÉ CAPÍTULO ES ESA PÁGINA. Va con ella porque sin él no sirve para identificar
         * nada: el post de un episodio no publica año ni título original, y lo único que trae —el
         * fotograma— solo se puede comprobar contra TMDB sabiendo qué capítulo es. Es el mismo
         * episodio cuya url queda como `_source_url`, no otro. Lo consume `enrichMediaItem`.
         */
        _episode_hint: group.episodes[0]
          ? { season: group.episodes[0].season, episode: group.episodes[0].episode }
          : null,
        _fuegocine_blogger_id: bloggerIdCat,
      } as any);
    }

    /**
     * LAS SERIES, DELANTE. Si no, no les llega el turno nunca.
     *
     * Se construyen al final —hay que ver el feed entero para agrupar los capítulos— y se
     * quedaban al final del array. Pero el crawl por tandas recorta a los primeros 300 de lo que
     * aún no está guardado (`poblar.yml`), y FuegoCine publica más de 3.000 títulos: las 114
     * series quedaban detrás de ~2.900 películas, o sea a unas diez vueltas de media hora de
     * distancia. Cada tanda se llevaba solo películas, y de ahí las 263 películas y cero series.
     *
     * Poniéndolas primero entran en la siguiente tanda, y en cuanto están guardadas
     * `--saltar-guardados` las descarta y el recorrido sigue con las películas donde iba. Es un
     * orden de PRESENTACIÓN de la lista, no una preferencia: no se descarta ni se prioriza nada
     * dentro del catálogo.
     */
    const series = movieItems.filter(i => String(i.id).startsWith('fc-'));
    const resto = movieItems.filter(i => !String(i.id).startsWith('fc-'));
    return [...series, ...resto];
  }

  /**
   * Una tanda del buscador de archive.org, ya filtrada.
   *
   * Se usa su API `scrape`, que es la que pagina de verdad con cursor. La antigua
   * `advancedsearch.php` contesta hoy `QUERY_NOT_READY` sobre estas mismas consultas.
   *
   * AQUÍ SE DESCARTA BARATO, antes de pedirle nada a TMDB ni a `/metadata`: sin clase declarada,
   * sin año o con pinta de pack, el item no llega a costar una petición. De 1.000 items de
   * `subject:"Pelicula"` sobreviven unas decenas, y ese número es el precio de no inventar
   * identidades (ver el bloque de arriba).
   */
  private static parseArchiveItems(items: any[], tipoPedido: ContentType): MediaItem[] {
    const salida: MediaItem[] = [];
    const vistos = new Set<string>();

    for (const it of items || []) {
      const identifier = String(it?.identifier || '');
      const tituloCrudo = String(it?.title || '').trim();
      if (!identifier || !tituloCrudo || vistos.has(identifier)) continue;

      const clase = claseDeArchive(it?.subject);
      if (!clase || clase !== tipoPedido) continue;
      if (esPackArchive(tituloCrudo)) continue;
      if (!esEnEspanolLatino(it)) continue;

      /**
      /**
       * EL NOMBRE DE LA OBRA, EN LAS TRES FORMAS EN QUE ESTA FUENTE LO PUBLICA.
       *
       * El que se MUESTRA sale del título, que es el único con acentos y puntuación —«Corazón
       * africano», «Guapo, truhan y peligroso»—; el identificador viene en minúsculas y pelado, y
       * tomarlo como título (que fue el primer intento) salía peor: `tron-1982-doblaje-caratula-vhs`
       * da «Tron vhs» donde el mostrado da «Tron».
       *
       * Los otros dos nombres se quedan en `aliases`, que alimenta `title_normalized` y con eso la
       * búsqueda. NO van en `original_title`: ese campo no es un cajón de nombres alternativos,
       * es el título en el idioma original, y el matcher lo usa para VERIFICAR al candidato
       * (`bestOriginalMatch`). Metiendo ahí «Cuarenta pistolas», el candidato correcto —tmdb 14837,
       * original «Forty Guns»— salía sin respaldar y se perdía un match que por otro camino sí se
       * consigue. Los nombres alternativos se prueban de uno en uno y como título, que es lo que
       * hace la escalera de `repair:catalog --fuse`.
       *
       * El año sí se completa con el del identificador cuando el título y la descripción callan:
       * ahí no hay ambigüedad que valga, o es un año o no lo es.
       */
      const delIdentificador = identidadDeArchive(identifier);
      const year = anioDeArchive(tituloCrudo, String(it?.description || '')) || delIdentificador.year;
      if (!year) continue;

      const title = tituloDeArchive(tituloCrudo) || delIdentificador.titulo;
      if (!title) continue;

      const deLaDescripcion = nombreDeLaDescripcion(String(it?.description || ''));

      vistos.add(identifier);
      salida.push({
        id: `archive-${identifier}`,
        tmdb_id: 0,
        imdb_id: null,
        type: clase,
        title,
        original_title: title,
        aliases: Array.from(new Set([title, deLaDescripcion, delIdentificador.titulo].filter(Boolean))),
        overview: '',
        rating: 0,
        release_date: year,
        genres: [],
        subcategories: ['Internet Archive'],
        // Sin carátula: archive.org sirve una miniatura del propio fichero, que no identifica
        // nada. La buena la traerá TMDB al enriquecer, y si no hay match no habrá ficha.
        poster: null,
        backdrop: null,
        logo: null,
        trailer: null,
        cast: [],
        dubbing_cast: [],
        servers: [],
        _source_url: `${ARCHIVE_BASE}/details/${identifier}`,
        /**
         * CUÁNDO SE SUBIÓ, para poder ordenar por lo más nuevo. Interno: los campos con `_`
         * delante no se escriben en la tabla, igual que `_source_url`.
         */
        _archive_added: String(it?.addeddate || ''),
      } as MediaItem);
    }
    return salida;
  }

  /**
   * Recorre el archivo de una clase, LO MÁS NUEVO PRIMERO y sin paginar.
   *
   * Esta función iba de 100 en 100 con el cursor de la API y en el orden por defecto, y por eso
   * archive.org llevaba días sin aportar nada. Tres medidas del 2026-08-22 la cambiaron entera:
   *
   *   1. EL ORDEN POR DEFECTO ES LA CABECERA ALFABÉTICA DEL ARCHIVO, y esa cabecera ya estaba
   *      guardada. De 300 items mirados sobrevivían 24 al filtro, y los 24 eran los mismos de
   *      siempre —«007 Bond Street», «Fight Club», «Volver al Futuro»—. Pidiendo lo mismo por
   *      `addeddate desc` sobreviven 147 de cada 300, y son subidas de esta semana.
   *
   *   2. EL CURSOR IGNORA `sorts`. Pedir la segunda página con el cursor que devolvió la primera
   *      vuelve a dar la primera. Ordenar por fecha y paginar son incompatibles en esta API, así
   *      que había que elegir — y lo que hace falta es el orden.
   *
   *   3. NO HACE FALTA PAGINAR. Una etiqueta entera cabe en UNA petición: `subject:"Pelicula"`
   *      son 3.759 items en 6 s con `count` grande. Las trece páginas por minuto del cursor
   *      tardaban trece minutos en ver menos.
   *
   * Y las etiquetas también salen de esa medición, mirando cada una completa en vez de sus
   * primeros items: «Peliculas» (144 supervivientes) y «Telenovela» (45) no se preguntaban, y
   * «Pelis» —que sí— no aporta ni uno. Con las de ahora el filtro deja pasar 1.043 títulos, de
   * los que 1.040 no habían entrado nunca.
   *
   * El tope sale del `limit`, nunca de un número escrito aquí (FUENTES.md §6 ter): `count` se
   * pide holgado respecto a él porque la mayoría de lo que llega se descarta, y con el techo de
   * 10.000 que admite la API. Como se ordena por fecha, quedarse corto significa quedarse con lo
   * más reciente, que es justo lo que se quiere.
   */
  static async scrapeArchiveLatest(tipo: ContentType, limit = 200): Promise<MediaItem[]> {
    const etiquetas = ETIQUETAS_ARCHIVE[tipo];
    const items: MediaItem[] = [];
    const vistos = new Set<string>();
    // Sobrevive del orden de un 10 % a un 25 % según la etiqueta, así que se pide veinte veces el
    // cupo. Nunca menos de 100 —el mínimo de la API— ni más de 10.000, que es su techo.
    const cuantos = Math.min(10000, Math.max(100, limit * 20));
    const count = String(cuantos);
    /**
     * El plazo va con el tamaño de lo que se pide, no fijo. Una etiqueta entera son 4 MB y seis
     * segundos, pero esta misma función la llama el listado en vivo con cupos pequeños, y ahí un
     * plazo de dos minutos sería colgar la respuesta de la app si archive.org se atasca.
     */
    const timeout = cuantos > 1000 ? 120000 : 20000;

    const pedir = async (etiqueta: string, cuantosPedir: number, plazo: number): Promise<any[] | null> => {
      const params = new URLSearchParams({
        q: `mediatype:movies AND subject:"${etiqueta}"`,
        fields: 'identifier,title,subject,description,language,addeddate',
        count: String(cuantosPedir),
        sorts: 'addeddate desc',
      });
      try {
        const res = await httpClient.get(
          `${ARCHIVE_BASE}/services/search/v1/scrape?${params.toString()}`,
          { timeout: plazo, validateStatus: () => true } as any
        );
        if (res.status >= 400) return null;
        return ((res.data as any)?.items || []).filter(Boolean);
      } catch {
        return null;
      }
    };

    for (const etiqueta of etiquetas) {
      /**
       * Y SI LA ETIQUETA ENTERA NO LLEGA, SE PIDE UN TROZO. Una etiqueta son varios MB y la
       * petición puede caerse por lo que sea; sin este respaldo, esa etiqueta se pierde ENTERA en
       * esa corrida —«Pelicula» son 849 de los 1.043 títulos que pasan el filtro—. Mil items
       * ordenados por fecha son, como poco, lo nuevo, que es lo que la corrida viene a buscar.
       */
      const lote = (await pedir(etiqueta, cuantos, timeout))
        ?? (cuantos > 1000 ? await pedir(etiqueta, 1000, 30000) : null);
      if (!lote) continue;
      for (const m of this.parseArchiveItems(lote, tipo)) {
        if (vistos.has(m.id)) continue;
        vistos.add(m.id);
        items.push(m);
      }
    }

    // Las etiquetas se piden por separado y cada una viene ordenada por su cuenta: el orden
    // global hay que rehacerlo, o el cupo se lo comería la primera etiqueta en vez de lo más
    // nuevo de todas.
    items.sort((a, b) => String((b as any)._archive_added || '').localeCompare(String((a as any)._archive_added || '')));
    return items.slice(0, limit);
  }

  /** Búsqueda en vivo. Misma API y mismos filtros: lo que no entra en el crawl tampoco al buscar. */
  /**
   * BUSCA EN ARCHIVE.ORG PARTIENDO DE LO QUE LA GENTE CONOCE, no de lo que alguien acaba de subir.
   *
   * El descubrimiento de archive.org era `subject:"Pelicula"` ordenado por `addeddate desc`: o sea,
   * lo que se subió esta semana Y alguien se molestó en etiquetar en español. Eso explica la forma
   * del catálogo — entraba la cartelera semanal de un canal y no entraban los clásicos— y no se
   * arregla filtrando mejor: por ahí los títulos reconocidos NO PASAN, porque quien sube una obra
   * conocida rara vez le pone la etiqueta.
   *
   * Así que se le da la vuelta. El índice lo pone TMDB, ordenado por número de votos, y a
   * archive.org se le pregunta por cada título concreto. Es el mismo patrón que ya usa moviedays
   * —TMDB manda, la fuente hace de oráculo— y trae dos cosas gratis:
   *
   *   · Cada ficha nace con `tmdb_id` REAL, así que cumple sola la regla de que en la app solo
   *     salgan películas oficiales. Por el camino de las etiquetas nacían con id sintético.
   *   · Y el emparejado deja de ser un problema: no hay que adivinar qué obra es esto, se sabe
   *     antes de preguntar.
   *
   * LO QUE NO SE RELAJA ES LA IDENTIDAD. Buscar por título en archive.org devuelve la película, los
   * documentales sobre el tema y las grabaciones caseras del mismo nombre. El año lo decide todo
   * (ver la guarda en `scrapeArchiveDetail`), y sin subject que filtre, ese año es lo único que
   * separa la obra de su ruido. Ya sin él este proyecto se ha llevado el golpe varias veces.
   *
   * El tope de concurrencia es bajo a propósito: archive.org es lento y de un tercero, y lo que
   * hace que te corten es la RÁFAGA, no el total.
   */
  static async scrapeArchivePorTitulosConocidos(
    tipo: ContentType,
    limit = 40,
    opts: { desdePagina?: number } = {},
  ): Promise<MediaItem[]> {
    const paginas = Math.max(1, Math.ceil(limit / 20));
    const ids = await TmdbService.discoverIds(tipo, {
      pages: paginas,
      desde: opts.desdePagina || 1,
    }).catch(() => [] as number[]);
    if (!ids.length) return [];

    const salida: MediaItem[] = [];
    const vistos = new Set<string>();
    const LOTE = 3;

    for (let i = 0; i < ids.length && salida.length < limit; i += LOTE) {
      const tanda = await Promise.allSettled(
        ids.slice(i, i + LOTE).map(id => this.archiveParaTmdbId(id, tipo)),
      );
      for (const r of tanda) {
        if (r.status !== 'fulfilled' || !r.value) continue;
        if (vistos.has(r.value.id)) continue;
        vistos.add(r.value.id);
        salida.push(r.value);
        if (salida.length >= limit) break;
      }
    }
    return salida;
  }

  /** Le pregunta a archive.org por UNA obra de TMDB. `null` si no la tiene o no se puede probar. */
  private static async archiveParaTmdbId(tmdbId: number, tipo: ContentType): Promise<MediaItem | null> {
    const ficha = await TmdbService.getTmdbDetails(tmdbId, tipo).catch(() => null);
    if (!ficha) return null;

    const titulo = String(ficha.title || ficha.name || '').trim();
    const original = String(ficha.original_title || ficha.original_name || '').trim();
    const anio = String(ficha.release_date || ficha.first_air_date || '').slice(0, 4);
    if (!titulo || !/^(19|20)\d{2}$/.test(anio)) return null;

    /**
     * Se prueba el título en español y el original. En archive.org conviven las dos formas —«El
     * club de la lucha» y «Fight Club»— y quedarse con una sola deja fuera la mitad del archivo.
     */
    const consultas = Array.from(new Set([titulo, original].filter(Boolean)));

    for (const consulta of consultas) {
      // Se limpian comillas y barras para que el término no pueda cerrar la frase y añadir otra.
      // Solo las comillas: el término va DENTRO de una frase entrecomillada y es lo único
      // que podría cerrarla y colar otra cláusula.
      const termino = consulta.replace(/"/g, ' ').slice(0, 80).trim();
      if (!termino) continue;

      /**
       * `advancedsearch.php`, y NO el endpoint `scrape` que usa el resto del fichero.
       *
       * Medido, y es un hallazgo incómodo: `scrape` IGNORA la cláusula `title:`. Pedirle
       * `mediatype:movies AND title:(Titanic)` contesta 200 y devuelve los mismos cien items
       * genéricos que sin ella —«0011aa Nunc 4 Ap...», «00151»—, idénticos para cualquier título
       * que se le pregunte. Aquí no serviría de nada.
       *
       * `advancedsearch.php` sí busca: la misma consulta da `numFound: 1082` y resultados que
       * hablan del Titanic. Ordenado por descargas, lo primero que sale es la copia que la gente
       * ve de verdad, que es exactamente lo que interesa cuando se busca lo reconocido.
       *
       * El `year` que devuelve permite descartar BARATO: sin él habría que bajarse la metadata de
       * cada candidato para enterarse de que es de otra década.
       */
      /**
       * EL IDIOMA VA EN LA CONSULTA, y sin eso esto no encontraba nada.
       *
       * De archive.org lo que más se ha subido de un clásico es la copia en INGLÉS, así que
       * ordenando por descargas los primeros candidatos eran siempre esas — y las tumbaba
       * después `esEnEspanolLatino`, una por una, hasta agotar el cupo sin llegar nunca a la
       * copia en español que sí estaba. Medido: «Fight Club (1999)» pasa año, pack y fichero, y
       * cae en `language: "eng"`.
       *
       * Pidiéndolo de entrada, los candidatos ya son los que pueden servir:
       *
       *     El club de la lucha   → pelicula-el-club-de-la-lucha-1
       *     Volver al futuro      → 1985-volver-al-futuro-en-espan   (1985)
       *     Terminator            → terminator_202403               (1984)
       *     El resplandor         → el-resplandor-venta-1980-25fps  (1980)
       *
       * No sustituye a la guarda: `esEnEspanolLatino` mira la metadata completa al bajarla y
       * sigue siendo quien decide. Esto solo evita gastar el cupo en lo que va a caer seguro.
       */
      const params = new URLSearchParams({
        q: `mediatype:movies AND language:(spanish OR spa OR castilian) AND title:("${termino}")`,
        rows: '30',
        output: 'json',
      });
      params.append('fl[]', 'identifier');
      params.append('fl[]', 'year');
      params.append('sort[]', 'downloads desc');

      let candidatos: any[] = [];
      try {
        const res = await httpClient.get(
          `${ARCHIVE_BASE}/advancedsearch.php?${params.toString()}`,
          { timeout: 25000, validateStatus: () => true } as any,
        );
        if (res.status >= 400) continue;
        candidatos = ((res.data as any)?.response?.docs || []).filter(Boolean);
      } catch {
        continue;
      }

      /**
       * El año del índice descarta, pero su ausencia no. Muchos items no lo publican como campo y
       * sí lo llevan en el nombre, que es donde lo lee `anioDeArchive` al bajar la metadata.
       */
      const plausibles = candidatos.filter(c => {
        const y = String(c?.year || '').slice(0, 4);
        return !y || y === anio;
      });

      for (const c of plausibles.slice(0, 6)) {
        const identifier = String(c?.identifier || '');
        if (!identifier) continue;
        const item = await this.scrapeArchiveDetail(
          `${ARCHIVE_BASE}/details/${identifier}`,
          { tmdbId, tipo, titulo, anio },
        ).catch(() => null);
        // El primero que pasa TODAS las guardas —año, idioma, fichero de verdad— y ya está.
        if (item) return item;
      }
    }
    return null;
  }

  static async scrapeArchiveSearch(query: string, limit = 12): Promise<MediaItem[]> {
    const q = query.trim();
    if (!q) return [];
    // Se limpian comillas y barras para que el término no pueda cerrar la cláusula y añadir otra.
    const termino = q.replace(/["\\()]/g, ' ').slice(0, 80).trim();
    if (!termino) return [];
    const salida: MediaItem[] = [];

    // Las MISMAS etiquetas que el crawl, y por la misma razón que el crawl las tiene medidas:
    // buscar solo por «Pelicula» y «Serie» deja fuera a «Peliculas» y «Telenovela», que entre las
    // dos son 189 de los 1.043 títulos que el filtro deja pasar. Quien busque una telenovela
    // encontraría en la app lo que el buscador no le sabía decir.
    const pares: Array<[string, ContentType]> = [];
    for (const tipo of ['movie', 'tvseries'] as ContentType[]) {
      for (const etiqueta of ETIQUETAS_ARCHIVE[tipo]) pares.push([etiqueta, tipo]);
    }

    for (const par of pares) {
      if (salida.length >= limit) break;
      const params = new URLSearchParams({
        q: `mediatype:movies AND subject:"${par[0]}" AND title:(${termino})`,
        fields: 'identifier,title,subject,description,language,addeddate',
        count: '100',
      });
      try {
        const res = await httpClient.get(
          `${ARCHIVE_BASE}/services/search/v1/scrape?${params.toString()}`,
          { timeout: 20000, validateStatus: () => true } as any
        );
        if (res.status >= 400) continue;
        const lote = ((res.data as any)?.items || []).filter(Boolean);
        for (const m of this.parseArchiveItems(lote, par[1])) {
          if (salida.length >= limit) break;
          if (salida.some(x => x.id === m.id)) continue;
          salida.push(m);
        }
      } catch { /* la búsqueda en vivo nunca puede tumbar la respuesta */ }
    }
    return salida;
  }

  /**
   * La ficha de un item: sus ficheros convertidos en servidores.
   *
   * UNA llamada a `/metadata/<id>` trae la metadata y la lista de ficheros entera, así que aquí
   * no hay HTML que scrapear ni páginas que paginar.
   *
   * Los ficheros entran TODOS como servidores, el más grande primero: el mejor para reproducir y
   * los demás de respaldo, que es lo que le permite a la app recuperarse sola si uno falla. Con
   * `direct_mode: 'public'` porque la url no lleva firma — pero SIN `verified_at`: el sello lo
   * pone quien se haya descargado bytes de verdad (`urlsBuenasDe` en el crawl), no esta función.
   * Anunciar un sello que nadie ha comprobado es exactamente lo que llenó el catálogo de fichas
   * que no reproducían.
   *
   * En una serie los servidores NO cuelgan de la ficha sino de cada capítulo, y solo entran los
   * ficheros cuyo NOMBRE declara qué capítulo son. Ver `capituloDeArchive`.
   */
  /**
   * La identidad que YA se sabe cuando se llega a un item desde TMDB y no desde sus etiquetas.
   *
   * Sin esto, `scrapeArchiveDetail` exige que el item declare `subject:"Pelicula"` y deduce el
   * título y el año de su nombre. Eso vale cuando el item se encontró POR esas etiquetas; no vale
   * cuando se llegó preguntándole a archive.org por una película concreta de TMDB, que es
   * justamente el caso en que la sube alguien que no etiqueta nada.
   */
  static async scrapeArchiveDetail(
    url: string,
    identidad?: { tmdbId: number; tipo: ContentType; titulo: string; anio: string },
  ): Promise<MediaItem | null> {
    const m = /archive\.org\/(?:details|metadata|download)\/([^/?#]+)/i.exec(url || '');
    if (!m) return null;
    const identifier = decodeURIComponent(m[1]);

    let data: any;
    try {
      const res = await httpClient.get(`${ARCHIVE_BASE}/metadata/${encodeURIComponent(identifier)}`,
        { timeout: 30000, validateStatus: () => true } as any);
      if (res.status >= 400) return null;
      data = res.data;
    } catch {
      return null;
    }

    const md = data?.metadata || {};
    const tituloCrudo = String(md.title || '').trim();
    if (!tituloCrudo) return null;

    // La clase la pone TMDB cuando se llegó por ahí; si no, tienen que decirla las etiquetas.
    const clase = identidad?.tipo ?? claseDeArchive(md.subject);
    if (!clase) return null;
    // El descarte de packs se queda SIEMPRE: un item con veinte películas dentro sigue siendo
    // veinte películas aunque TMDB nos haya dicho el nombre de una de ellas.
    if (esPackArchive(tituloCrudo)) return null;
    // El detalle trae la metadata COMPLETA, así que aquí la comprobación de idioma es más fiable
    // que en el listado: se vuelve a hacer y no se da por buena la del listado.
    if (!esEnEspanolLatino(md)) return null;

    const year = anioDeArchive(tituloCrudo, String(md.description || ''));
    if (!year) return null;

    /**
     * Y SI SE VIENE DE TMDB, EL AÑO TIENE QUE COINCIDIR. Es toda la prueba de identidad.
     *
     * Buscar «Titanic» en archive.org devuelve la película, documentales sobre el barco, y
     * grabaciones caseras de una obra de teatro escolar. El título no distingue ninguna de esas
     * cosas —FUENTES.md §1 lo prohíbe explícitamente— y el año sí. Se exige que el item DECLARE
     * un año y que sea el mismo: sin declaración no se puede probar nada, y esto no adivina.
     */
    if (identidad && year !== identidad.anio) return null;

    // El año va porque el item puede llevar dentro varias películas; ver `declaraOtroAnio`.
    const ficheros = ficherosDeVideoArchive(data?.files || [], year);
    if (!ficheros.length) return null;

    // Sin identidad de TMDB manda el identificador, que es más limpio que el título mostrado.
    const title = identidad?.titulo || identidadDeArchive(identifier).titulo || tituloDeArchive(tituloCrudo);

    const servidorDe = (nombre: string, i: number): ServerOption => {
      const directo = urlDeFicheroArchive(identifier, nombre);
      return {
        id: `archive-${identifier}_${i}`,
        name: `Archive ${i + 1}`,
        embed_url: directo,
        direct_stream: directo,
        direct_mode: 'public',
        direct_kind: 'mp4',
        status: 'online',
        source_id: 'archive',
      } as ServerOption;
    };

    const base: any = {
      id: `archive-${identifier}`,
      tmdb_id: identidad?.tmdbId ?? 0,
      imdb_id: null,
      type: clase,
      title,
      original_title: title,
      aliases: [title],
      overview: '',
      rating: 0,
      release_date: year,
      genres: [],
      subcategories: ['Internet Archive'],
      poster: null,
      backdrop: null,
      logo: null,
      trailer: null,
      cast: [],
      dubbing_cast: [],
      servers: [],
      _source_url: `${ARCHIVE_BASE}/details/${identifier}`,
    };

    if (clase === 'movie') {
      base.servers = ficheros.map((f, i) => servidorDe(f.name, i));
      return base as MediaItem;
    }

    // Serie: fichero → capítulo por el NOMBRE, y lo que no lo declare se queda fuera.
    const porTemporada = new Map<number, Map<number, ServerOption[]>>();
    ficheros.forEach((f, i) => {
      const cap = capituloDeArchive(f.name);
      if (!cap) return;
      if (!porTemporada.has(cap.season)) porTemporada.set(cap.season, new Map());
      const temporada = porTemporada.get(cap.season) as Map<number, ServerOption[]>;
      if (!temporada.has(cap.episode)) temporada.set(cap.episode, []);
      (temporada.get(cap.episode) as ServerOption[]).push(servidorDe(f.name, i));
    });
    if (porTemporada.size === 0) return null;

    base.seasons = Array.from(porTemporada.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([season_number, caps]) => ({
        season_number,
        episodes: Array.from(caps.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([episode_number, servers]) => ({ season_number, episode_number, servers })),
      }));
    base.total_seasons = base.seasons.length;
    base.total_episodes = base.seasons.reduce((n: number, t: any) => n + t.episodes.length, 0);
    return base as MediaItem;
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
   *
   * `solo` recorta a UNA web. No es una comodidad de desarrollo: el crawl completo tarda horas
   * repartidas entre cuatro webs, y cuando una de ellas es la que de verdad aporta —FuegoCine da
   * 708 de las 961 urls permanentes que llegó a tener el catálogo, todas por su envoltorio
   * `?link=`— conviene poder dedicarle una pasada entera a ella sola. Lo que viene después
   * (TMDB, `quedarseConLoQueReproduce`, la escritura) es exactamente el mismo camino.
   */
  static async crawlFullCatalog(solo?: string): Promise<MediaItem[]> {
    const dedup = (listas: MediaItem[][]): MediaItem[] => {
      const seen = new Set<string>();
      return listas.flat().filter(it => {
        if (!it.id || seen.has(it.id)) return false;
        seen.add(it.id);
        return true;
      });
    };

    if (solo === 'fuegocine') {
      // El tope alto es a propósito: el de por defecto son 5.000 ENTRADAS del feed, y FuegoCine
      // publica cada capítulo de serie como su propia entrada, así que 3.215 títulos son muchas
      // más entradas que títulos. Con 5.000 se cortaba a mitad del archivo sin decirlo.
      return dedup([await this.scrapeAllFuegocine(40000).catch(() => [] as MediaItem[])]);
    }
    if (solo === 'archive') {
      /**
       * DOS FORMAS DE ENTRAR, y hacen falta las dos.
       *
       * `scrapeArchiveLatest` recorre el archivo por SUS etiquetas y ordenado por fecha de
       * subida. Eso trae lo que alguien subió hace poco y se molestó en etiquetar en español —
       * mucho, pero casi nada conocido, porque quien sube un clásico rara vez pone la etiqueta.
       *
       * `scrapeArchivePorTitulosConocidos` va al revés: el índice lo pone TMDB por número de
       * votos y a archive.org se le pregunta por cada título. Es de donde salen los títulos que
       * la gente busca, y además cada ficha nace con `tmdb_id` REAL en vez de con uno sintético.
       *
       * Van DELANTE por lo mismo que las series de FuegoCine: el tope por corrida corta la lista
       * por donde llegue, y detrás de veinte mil items de etiqueta no les llegaría el turno nunca.
       * Son pocas y en cuanto están guardadas `--saltar-guardados` las descarta.
       */
      const [conocidas, conocidasSerie, pelis, series] = await Promise.all([
        this.scrapeArchivePorTitulosConocidos('movie', 120).catch(() => [] as MediaItem[]),
        this.scrapeArchivePorTitulosConocidos('tvseries', 40).catch(() => [] as MediaItem[]),
        this.scrapeArchiveLatest('movie', 20000).catch(() => [] as MediaItem[]),
        this.scrapeArchiveLatest('tvseries', 20000).catch(() => [] as MediaItem[]),
      ]);
      /**
       * MEZCLADAS POR FECHA DE SUBIDA, no las películas primero y las series después.
       *
       * El tope por corrida corta esta lista por donde llegue —300 en las tandas de `poblar.yml`—
       * y las películas que pasan el filtro son 987 contra 150 series. Concatenando, ninguna
       * corrida llegaba nunca a la primera serie: se pasarían meses de tandas antes de rozarlas.
       * Ordenadas por fecha, cada tanda coge lo más nuevo de las dos clases.
       */
      const porEtiqueta = dedup([pelis, series])
        .sort((a, b) => String((b as any)._archive_added || '').localeCompare(String((a as any)._archive_added || '')));
      return dedup([conocidas, conocidasSerie, porEtiqueta]);
    }
    /**
     * MOVIEDAYS, cuya pasada a fondo no se parece a la de ninguna otra.
     *
     * No hay índice que recorrer: se baja por el catálogo de TMDB ordenado por número de votos y se
     * le pregunta a moviedays por cada obra. Por eso admite `--desde=N`: una pasada empieza donde
     * terminó la anterior en vez de repetir siempre las mismas primeras páginas, que es lo que
     * convierte una fuente sin índice en algo que de verdad crece.
     *
     * Películas y series a la vez y en la misma proporción, que es lo que el usuario pidió al
     * añadirla: la mitad del cupo para cada clase.
     */
    if (solo === 'moviedays') {
      const bandera = (nombre: string) =>
        Number((process.argv.find(a => a.startsWith(`--${nombre}=`)) || '').split('=')[1]) || 0;
      const desdePagina = bandera('desde') || 1;
      // `--titulos=` acota la pasada. Sin él, 500 de cada clase: lo que cabe en una corrida sin
      // que el runner se lleve por delante el trabajo, que es la lección de `--saltar-guardados`.
      const cuantos = bandera('titulos') || 500;
      const [pelis, series] = await Promise.all([
        this.scrapeMoviedaysLatest('movie', cuantos, { desdePagina }).catch(() => [] as MediaItem[]),
        this.scrapeMoviedaysLatest('tvseries', cuantos, { desdePagina }).catch(() => [] as MediaItem[]),
      ]);
      return dedup([pelis, series]);
    }

    if (solo === 'peliculas' || solo === 'series' || solo === 'animes') {
      return dedup([await this.scrapeAllOfType(solo).catch(() => [] as MediaItem[])]);
    }

    const [peliculas, series, animes, fuego] = await Promise.all([
      this.scrapeAllOfType('peliculas').catch(() => [] as MediaItem[]),
      this.scrapeAllOfType('series').catch(() => [] as MediaItem[]),
      this.scrapeAllOfType('animes').catch(() => [] as MediaItem[]),
      this.scrapeAllFuegocine().catch(() => [] as MediaItem[])
    ]);
    return dedup([peliculas, series, animes, fuego]);
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
     * ficha y nadie le pasa nunca una url. Es el punto 4 de FUENTES.md §6 ter.
     *
     * Se piden en paralelo y cada una tiene su cupo reservado más abajo. La deduplicación por id
     * la hace quien recibe (`unifyItems`).
     */
    /**
     * Y ARCHIVE.ORG, por la misma puerta y por la misma razón.
     *
     * Es el punto 4 de FUENTES.md §6 ter y el que más se olvida: una fuente que no se engancha
     * aquí queda escrita y muda — sabe leer una ficha y nadie le pasa nunca una url. Le pasó a
     * una fuente entera hasta que el usuario preguntó por qué no salía Breaking Bad.
     *
     * Los animes no se le piden: su archivo no distingue esa clase, y pedírselos devolvería
     * series etiquetadas como si fueran anime.
     */
    const deArchive = type === 'animes'
      ? Promise.resolve([] as MediaItem[])
      : this.scrapeArchiveLatest(
          type === 'peliculas' ? 'movie' : 'tvseries',
          Math.max(10, Math.floor(limit / 2))
        ).catch(() => [] as MediaItem[]);

    /**
     * Y MOVIEDAYS, por la misma puerta que las otras dos y por la misma razón: una fuente que no se
     * engancha aquí queda escrita y muda — sabe leer una ficha y nadie le pasa nunca una url. Es el
     * punto 4 de FUENTES.md §6 ter, el que se olvida siempre.
     *
     * Los animes se le piden como series, que es lo que son para TMDB. Las otras fuentes devuelven
     * lista vacía para esa clase porque su archivo no la distingue; aquí no hay archivo que
     * distinga nada, así que pedirla sería pedir las mismas series dos veces. Se deja fuera.
     */
    const deMoviedays = type === 'animes'
      ? Promise.resolve([] as MediaItem[])
      : this.scrapeMoviedaysLatest(
          type === 'peliculas' ? 'movie' : 'tvseries',
          /**
           * CON TECHO, y esta fuente es la única que lo necesita.
           *
           * Las demás se paginan solas: se les pide su índice y devuelven lo que tengan. Aquí cada
           * ficha cuesta una petición a un tercero, así que `limit` no es una cota de trabajo sino
           * un multiplicador — el crawl completo llega con 20.000 y eso serían 20.000 peticiones
           * en una sola pasada. Doscientas por pasada llenan el cupo reservado (limit/4) de sobra,
           * y para recorrerla a fondo está `crawlFullCatalog('moviedays')`, que pagina de verdad.
           */
          Math.min(200, Math.max(10, Math.floor(limit / 2)))
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
            overview: '',
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
     * CADA FUENTE CON SITIO RESERVADO, y no «lo que sobre».
     *
     * La primera versión las añadía solo si quedaba hueco bajo el `limit`, y como TioPlus llena el
     * cupo por sí solo, las demás aportaban CERO: quedaban enganchadas y seguían sin descubrirse
     * ni un título suyo. Una fuente que solo entra cuando la otra falla no es una fuente, es un
     * repuesto. Si alguna trae menos de su cupo, lo que sobre se reparte a las demás.
     */
    const [extraArchive, extraMoviedays] = await Promise.all([deArchive, deMoviedays]);
    const vistos = new Set(items.map(x => x.id));
    const nuevosArchive = extraArchive.filter(it => !vistos.has(it.id));
    const nuevosMoviedays = extraMoviedays.filter(it => !vistos.has(it.id));
    // Archive tiene su propio sitio reservado: si solo entrara con el hueco que dejen las otras,
    // TioPlus llenaría el cupo y esta fuente aportaría cero pasada tras pasada. Un cuarto, que es
    // lo que cabe sin ahogar a las demás.
    const reservadoArchive = Math.min(nuevosArchive.length, Math.max(1, Math.ceil(limit / 4)));
    // Y moviedays, otro cuarto, por lo mismo. Con una diferencia a su favor que conviene recordar:
    // lo que trae ya ha demostrado tener un servidor publicable —`scrapeMoviedaysDetail` descarta
    // la ficha que no lo tenga—, así que su cupo no se gasta nunca en títulos que no reproducen.
    const reservadoMoviedays = Math.min(nuevosMoviedays.length, Math.max(1, Math.ceil(limit / 4)));
    const cupoTioplus = Math.max(0, limit - reservadoArchive - reservadoMoviedays);
    return items.slice(0, cupoTioplus)
      .concat(nuevosArchive.slice(0, reservadoArchive))
      .concat(nuevosMoviedays.slice(0, reservadoMoviedays));
  }
}
