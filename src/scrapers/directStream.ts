import * as cheerio from 'cheerio';
import * as crypto from 'crypto';
import { DirectMode, ServerOption } from '../types';
import { httpClient } from '../utils/httpClient';

/**
 * Extracción del vídeo REAL que hay detrás de un embed (el .m3u8 o .mp4 que reproduce
 * el iframe), para poder ofrecerlo como fuente prioritaria y dejar el embed de último recurso.
 *
 * CÓMO ESTÁN PROTEGIDOS ESTOS HOSTS (medido, no supuesto):
 * ninguno entrega una URL permanente. La familia Earnvids/goodstream firma un HMAC que cubre
 * la query ENTERA —quitar o alterar cualquier parámetro devuelve 403, incluido el `e` de
 * caducidad— y ese HMAC lo calcula su servidor, así que no hay algoritmo que replicar: solo
 * se puede pedir. Además la firma va ligada a la red que lo pidió (`asn=` dentro de la propia
 * firma), ok.ru mete `srcIp=` en la URL y Netu la IP en base64 en la ruta (`/secip/`).
 *
 * Consecuencia de diseño: lo extraído NO se persiste. Aquí solo se averigua que la extracción
 * ES POSIBLE (y de qué tipo); la URL se acuña en el momento de reproducir, desde
 * /api/v1/stream/direct. Ver src/routes/stream.routes.ts.
 *
 * Cada host vive en su propio extractor y falla de forma aislada: si un sitio cambia, ese
 * servidor se queda con su embed y ningún otro se ve afectado.
 */

export type DirectKind = 'hls' | 'mp4';

export interface DirectStream {
  url: string;
  kind: DirectKind;
  /** Calidad que declara el propio host (solo ok.ru la da explícita). */
  quality?: ServerOption['quality'];
}

/** Hosts que atan el vídeo a la IP que lo pidió aunque la URL parezca limpia. */
const IP_BOUND_HOSTS = ['waaw.to', 'netu.tv', 'hqq.', 'okcdn.ru', 'ok.ru'];

/**
 * Hosts cuyo HTML contiene URLs SEÑUELO que el extractor genérico se tragaría.
 *
 * Netu/waaw deja a la vista un `…/secip/…/1606597200/…` con marca de tiempo de 2020, y encima
 * dentro de un bloque comentado: se extrae sin problema y luego no reproduce. Publicar un
 * `direct_stream` muerto es peor que no publicar ninguno, porque el cliente pierde el tiempo
 * antes de caer al embed.
 *
 * Su URL buena NO se va a extraer, y es una decisión, no una carencia: se obtiene con un POST
 * a `/ajax.php?mode=increment_video` que exige `adbact` (resultado de su detección de
 * bloqueadores), `adscore`, `popcount` de pop-unders realmente abiertos, coordenadas de clic y
 * un token que su código solo asigna tras un `mousemove` con `isTrusted`. Replicar eso es
 * fabricar prueba de interacción humana y falsear señales anti-adblock; queda fuera. Lo mismo
 * vale para listeamed.net, cuyo segundo salto es un muro de huella de canvas/WebGL.
 */
const DECOY_HOSTS = ['waaw.to', 'netu.tv', 'hqq.'];

/** Reproductores SPA de la familia upns: el id va en el hash y el vídeo lo sirve su API. */
const UPNS_HOSTS = ['upns.pro', 'upns.', 'rpmstream', '4meplayer', 'strp2p'];

/**
 * Marcas de URL efímera: firma, caducidad o IP embebida. Su presencia obliga a acuñar
 * la URL en cada reproducción (modo `proxy`) en vez de guardarla (modo `public`).
 */
const VOLATILE_PATTERNS: RegExp[] = [
  /[?&](t|s|e|k|kx|token|sig|signature|hash|md5|exp|expires?|policy|key|st|ip|srcip|secure)=/i,
  /[?&]X-Amz-(Signature|Credential)=/i,
  /[?&]Key-Pair-Id=/i,
  /\/secip\//i,
  /eyJ[A-Za-z0-9_-]{10,}\./,
  // Cualquier parámetro cuyo valor sea una marca de tiempo Unix reciente es una caducidad
  // con otro nombre. Sin esto, upns colaba su `kx=1784869872` como URL permanente y el
  // enlace se guardaba para servir un vídeo que dejaba de existir a las pocas horas.
  /[?&][\w-]+=1[6-9]\d{8}(&|$)/,
];

/** ¿La URL lleva firma, caducidad o IP dentro? */
export function hasVolatileToken(url: string): boolean {
  if (!url) return true;
  return VOLATILE_PATTERNS.some(re => re.test(url));
}

/** ¿El host ata el vídeo a la IP que lo pidió? */
export function isIpBound(url: string): boolean {
  const u = (url || '').toLowerCase();
  return IP_BOUND_HOSTS.some(h => u.includes(h));
}

/**
 * Una URL solo puede publicarse tal cual (modo `public`, persistible) si no lleva ninguna
 * marca efímera NI pertenece a un host que ate por IP. Hoy no lo cumple ningún host conocido,
 * pero la puerta queda abierta para los mp4 limpios que aparezcan.
 */
export function isPubliclyShareable(url: string): boolean {
  return Boolean(url) && !hasVolatileToken(url) && !isIpBound(url);
}

/** Normaliza URLs protocol-relative (`//host/…`) y barras escapadas de JSON (`\/`). */
function normalizeUrl(raw: string): string {
  const clean = raw.trim().replace(/\\\//g, '/').replace(/&amp;/g, '&');
  if (clean.startsWith('//')) return `https:${clean}`;
  return clean;
}

function kindOf(url: string): DirectKind {
  return /\.m3u8(\?|$)|\/hls|manifest/i.test(url) ? 'hls' : 'mp4';
}

/**
 * FuegoCine no enlaza el reproductor: enlaza un redirector de Blogger que lleva el destino
 * real en base64 (`blogfc13.blogspot.com/?m=1.html?r=<b64>`). Se decodifica en local, sin
 * gastar una petición, y así hasta el `embed_url` que se guarda deja de ser el redirector
 * con publicidad y pasa a ser el host de verdad.
 */
export function unwrapRedirector(url: string): string {
  if (!url) return url;
  const match = url.match(/[?&]r=([A-Za-z0-9+/=_-]{8,})/);
  if (!match) return url;
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    if (/^(https?:)?\/\/[^\s]+$/i.test(decoded)) return normalizeUrl(decoded);
  } catch {}
  return url;
}

/**
 * Algunos reproductores de FuegoCine llevan el vídeo EN LA PROPIA URL del embed, en un
 * parámetro `link=` (o `url=`/`file=`) con la dirección escapada:
 *
 *   repfuegocinefree.blogspot.com/?player=fluidplayer&format=video%2Fmp4&link=https%3A%2F%2F…mp4
 *
 * Es la extracción más barata que existe —cero peticiones— y encima suele dar mp4 limpios,
 * sin firma ni caducidad, que son los únicos que se pueden guardar y servir tal cual.
 *
 * No se toca el `embed_url`: esa página de Blogger es un fluidplayer que funciona como
 * iframe, así que sigue valiendo de último recurso.
 */
function extractFromUrlParam(embedUrl: string): DirectStream | null {
  let params: URLSearchParams;
  try {
    params = new URL(embedUrl).searchParams;
  } catch {
    return null;
  }

  for (const key of ['link', 'url', 'file', 'source', 'src']) {
    const value = params.get(key);
    if (!value || !/^https?:\/\//i.test(value)) continue;
    if (!/\.(m3u8|mp4|txt)(\?|$)/i.test(value)) continue;
    const url = normalizeUrl(value);
    // `format=video/mp4` es la pista que da el propio reproductor; el `.txt` de algunos CDN
    // es un manifiesto HLS con la extensión cambiada para esquivar filtros.
    const declared = params.get('format') || '';
    const kind: DirectKind = /mpegurl|m3u8/i.test(declared) || /\.(m3u8|txt)(\?|$)/i.test(value) ? 'hls' : 'mp4';
    return { url, kind };
  }
  return null;
}

/**
 * Desempaqueta el ofuscador P.A.C.K.E.R. (`eval(function(p,a,c,k,e,d){…}(…))`), que es lo que
 * usan vidhide/streamwish/filelions/lulustream y dropload para esconder el `sources:[{file:…}]`.
 */
export function unpackPacker(html: string): string | null {
  const match = html.match(/\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)/s);
  if (!match) return null;

  let payload = match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  const radix = parseInt(match[2], 10);
  const count = parseInt(match[3], 10);
  const words = match[4].split('|');
  if (!Number.isFinite(radix) || !Number.isFinite(count)) return null;

  const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const toBase = (n: number): string => {
    if (n === 0) return '0';
    let out = '';
    for (let x = n; x > 0; x = Math.floor(x / radix)) out = ALPHABET[x % radix] + out;
    return out;
  };

  for (let i = count - 1; i >= 0; i--) {
    if (!words[i]) continue;
    payload = payload.replace(new RegExp(`\\b${toBase(i)}\\b`, 'g'), words[i]);
  }
  return payload;
}

/**
 * Busca la URL de vídeo en un texto plano (HTML tal cual o ya desempaquetado).
 * Cubre `sources:[{file:"…"}]`, `"file":"…"` y URLs sueltas .m3u8/.mp4.
 */
function extractFromText(text: string): DirectStream | null {
  if (!text) return null;

  // 1. La clave `file:` de jwplayer y clones — es la fuente declarada por el reproductor.
  const fileMatch = text.match(/["']?file["']?\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i);
  if (fileMatch) {
    const url = normalizeUrl(fileMatch[1]);
    return { url, kind: kindOf(url) };
  }

  // 2. Cualquier URL de manifiesto suelta. Se prefiere HLS: reproduce mejor y, al proxearlo,
  //    cada segmento es una petición corta en vez de un fichero gigante de una sola pieza.
  const urls = text.match(/https?:(?:\\\/\\\/|\/\/)[^\s"'<>\\)]+/g) || [];
  const normalized = urls.map(normalizeUrl);
  const hls = normalized.find(u => /\.m3u8(\?|$)/i.test(u));
  if (hls) return { url: hls, kind: 'hls' };
  const mp4 = normalized.find(u => /\.mp4(\?|$)/i.test(u));
  if (mp4) return { url: mp4, kind: 'mp4' };

  return null;
}

/** ok.ru ordena sus calidades de peor a mejor con estos nombres. */
const OKRU_QUALITY_ORDER = ['mobile', 'lowest', 'low', 'sd', 'hd', 'full', 'quad', 'ultra'];

const OKRU_QUALITY_MAP: Record<string, ServerOption['quality']> = {
  ultra: '4K',
  quad: '4K',
  full: '1080p',
  hd: '720p',
  sd: '480p',
  low: '480p',
  lowest: '480p',
  mobile: '480p',
};

/**
 * ok.ru (Odnoklassniki) publica su ficha completa en el atributo `data-options` del reproductor:
 * `flashvars.metadata` es un JSON con `videos[]` (mp4 por calidad) y a veces un manifiesto HLS.
 * Es la extracción más limpia de todas y la única que declara la calidad real, así que de paso
 * corrige el `quality` que el scraper escribe a fuego.
 */
function extractOkru(html: string): DirectStream | null {
  const $ = cheerio.load(html);
  const raw = $('[data-options]').first().attr('data-options');
  if (!raw) return null;

  try {
    const options = JSON.parse(raw);
    const metadataRaw = options?.flashvars?.metadata;
    if (!metadataRaw) return null;
    const metadata = typeof metadataRaw === 'string' ? JSON.parse(metadataRaw) : metadataRaw;

    const hls = metadata.hlsManifestUrl || metadata.ondemandHls;
    if (hls) return { url: normalizeUrl(hls), kind: 'hls' };

    const videos: Array<{ name?: string; url?: string }> = metadata.videos || [];
    const best = videos
      .filter(v => v?.url)
      .sort((a, b) => OKRU_QUALITY_ORDER.indexOf(a.name || '') - OKRU_QUALITY_ORDER.indexOf(b.name || ''))
      .pop();
    if (!best?.url) return null;

    return {
      url: normalizeUrl(best.url),
      kind: 'mp4',
      quality: OKRU_QUALITY_MAP[best.name || ''] || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * upns.pro / UPFAST — clave e IV de su cifrado de respuestas.
 *
 * Su reproductor es una SPA que no deja NADA en el HTML: pide la ficha a `/api/v1/video` y
 * recibe un blob hexadecimal cifrado con AES-128-CBC. Clave e IV se derivan dentro del bundle
 * a partir de valores que en la práctica son constantes:
 *
 *   clave = "kiem" + protocol[1] + "ie" + "nmu" + "a9" + "11" + "ca"   → con protocol "https:"
 *   iv    = "123456789" + fromCodePoint(48,"111",105,117,121,116,114)  → depende solo de que
 *                                                                        el hash empiece por "#"
 *
 * Es decir: mientras el embed se sirva por HTTPS y el id venga en el hash, no varían. Si algún
 * día rotan el esquema, este extractor devolverá null y el servidor se quedará con su embed,
 * que es exactamente la degradación prevista.
 */
const UPNS_KEY = Buffer.from('kiemtienmua911ca', 'utf8');
const UPNS_IV = Buffer.from('1234567890oiuytr', 'utf8');

function decryptUpns(hex: string): string | null {
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', UPNS_KEY, UPNS_IV);
    return Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * upns.pro y clones (`https://…/#<videoId>`): el id viaja en el hash y el vídeo se pide a
 * `/api/v1/video`, que responde cifrado. Requiere una petición extra, la única de todos los
 * extractores.
 */
async function extractUpns(embedUrl: string): Promise<DirectStream | null> {
  const videoId = embedUrl.split('#')[1];
  if (!videoId) return null;

  let origin: string;
  try {
    origin = new URL(embedUrl).origin;
  } catch {
    return null;
  }

  // `w`/`h` son el tamaño de pantalla y `r` el dominio que incrusta: el backend los exige,
  // pero no valida sus valores.
  const api = `${origin}/api/v1/video?id=${encodeURIComponent(videoId)}&w=1920&h=1080&r=tioplus.app`;
  const res = await httpClient.get(api, {
    headers: { Referer: embedUrl },
    timeout: 8000,
    responseType: 'text',
    transformResponse: [(d: unknown) => d],
    validateStatus: () => true,
  });
  if (res.status !== 200) return null;

  const hex = String(res.data || '').trim();
  if (!/^[0-9a-f]+$/i.test(hex)) return null;

  const plain = decryptUpns(hex);
  if (!plain) return null;

  try {
    const payload = JSON.parse(plain);
    // `cfNative` es el manifiesto que usa su propio reproductor; `source` es el origen directo.
    const url = payload.cfNative || payload.source;
    if (typeof url !== 'string' || !url) return null;
    return { url: normalizeUrl(url), kind: kindOf(url) };
  } catch {
    return null;
  }
}

/**
 * Extrae el vídeo directo de un embed ya descargado.
 *
 * `html` es el cuerpo que `inspectEmbed` ya trajo para comprobar la salud del embed, así que
 * en el camino de scraping esto NO añade ni una petición HTTP.
 *
 * Devuelve null cuando el host no es extraíble; el llamador se queda con el embed y ya está.
 * listeamed.net entra siempre por esa vía: su segundo salto es un muro anti-bot con huella de
 * canvas/WebGL, y saltárselo no es algo que este proyecto vaya a hacer.
 */
export async function extractDirect(
  embedUrl: string,
  html: string,
  opts: { allowNetwork?: boolean } = {}
): Promise<DirectStream | null> {
  if (!embedUrl) return null;
  const host = (() => {
    try {
      return new URL(embedUrl).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();

  try {
    // Lo primero y más barato: puede que el vídeo venga ya en la propia URL del embed.
    const fromParam = extractFromUrlParam(embedUrl);
    if (fromParam) return fromParam;

    // upns.pro no deja nada en el HTML: hay que preguntarle a su API. Solo se hace al
    // REPRODUCIR (`allowNetwork`), nunca al scrapear: su API responde 429 en cuanto se la
    // llama en lote, y un 429 durante el crawl quedaría persistido como "este servidor no
    // tiene vídeo directo", que es mentira. Ver `deferredDirectFields`.
    if (isDeferredDirectHost(embedUrl)) {
      return opts.allowNetwork ? await extractUpns(embedUrl) : null;
    }

    if (!html) return null;

    if (host.includes('ok.ru') || host.includes('odnoklassniki')) {
      return extractOkru(html);
    }

    if (DECOY_HOSTS.some(h => host.includes(h))) return null;

    // Familia Earnvids (vidhide/streamwish/filelions/lulustream) y dropload: todo va empaquetado.
    const unpacked = unpackPacker(html);
    if (unpacked) {
      const fromPacked = extractFromText(unpacked);
      if (fromPacked) return fromPacked;
    }

    // goodstream/gscdn y compañía dejan el `sources:[{file:…}]` a la vista en el HTML plano.
    return extractFromText(html);
  } catch {
    return null;
  }
}

/** URL permanente de esta API que acuña y sirve el vídeo de un embed al reproducir. */
export function directEndpointUrl(embedUrl: string): string {
  return `/api/v1/stream/direct?e=${Buffer.from(embedUrl, 'utf8').toString('base64url')}`;
}

/** Inversa de `directEndpointUrl`: recupera el embed del parámetro `?e=`. */
export function decodeEmbedParam(param: string): string | null {
  try {
    const url = Buffer.from(param, 'base64url').toString('utf8');
    return /^https?:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

/**
 * ¿De este embed se puede sacar el vídeo SIN pedir nada por red?
 *
 * Cierto cuando la URL lleva el vídeo dentro (`link=`) o cuando el host se resuelve al
 * reproducir. Lo usa el job de catálogo para saber qué fichas merece la pena repasar cuando
 * se añade un extractor nuevo, sin tener que duplicar allí la lista de hosts.
 */
export function canExtractWithoutFetch(embedUrl: string): boolean {
  if (!embedUrl) return false;
  // Un redirector guardado tal cual es señal de que la ficha se resolvió antes de que
  // existiera el decodificador: al repasarla, su embed pasa a ser el host real y ese sí
  // suele dar vídeo.
  if (unwrapRedirector(embedUrl) !== embedUrl) return true;
  return Boolean(extractFromUrlParam(embedUrl)) || isDeferredDirectHost(embedUrl);
}

/** ¿Este host solo se puede resolver llamando a su API, y por tanto al reproducir? */
export function isDeferredDirectHost(embedUrl: string): boolean {
  if (!embedUrl || !embedUrl.includes('#')) return false;
  try {
    const host = new URL(embedUrl).hostname.toLowerCase();
    return UPNS_HOSTS.some(h => host.includes(h));
  } catch {
    return false;
  }
}

export type DirectFields = Pick<ServerOption, 'direct_stream' | 'direct_kind' | 'direct_mode' | 'direct_host'>;

/**
 * Campos de vídeo directo para los hosts que NO se resuelven al scrapear.
 *
 * Se anuncia el `direct_stream` aunque todavía no se haya resuelto: la URL apunta a esta API,
 * que hará la llamada real al reproducir. Si entonces falla, responde 502 y el cliente cae al
 * embed — la misma cascada de siempre. Anunciarlo es correcto porque el extractor está
 * probado para estos hosts; lo que no se puede es comprobarlo mil veces durante un crawl.
 */
export function deferredDirectFields(embedUrl: string): DirectFields {
  if (!isDeferredDirectHost(embedUrl)) return {};
  let host = '';
  try {
    host = new URL(embedUrl).hostname;
  } catch {}
  return {
    direct_stream: directEndpointUrl(embedUrl),
    direct_kind: 'hls',
    direct_mode: 'proxy',
    direct_host: host || undefined,
  };
}

/**
 * Traduce una extracción a los campos que viajan en el `ServerOption`.
 *
 * Cuando la URL es efímera (todos los hosts conocidos hoy) se publica la URL de ESTA API en
 * vez de la del CDN: así el cliente guarda un enlace estable y la caducidad se resuelve por
 * dentro. La URL cruda no se propaga nunca hacia la base de datos.
 */
export function describeDirect(embedUrl: string, direct: DirectStream): DirectFields {
  // Solo un MP4 sin firma se entrega crudo. Un HLS siempre va por el proxy aunque su URL
  // parezca limpia: el manifiesto hay que reescribirlo para que los segmentos vuelvan por
  // aquí, y además esos CDN suelen exigir el Referer del embed, que el cliente no puede
  // poner. Publicar el manifiesto crudo era regalarle al cliente un 403 seguro.
  const shareable = direct.kind === 'mp4' && isPubliclyShareable(direct.url);
  const mode: DirectMode = shareable ? 'public' : 'proxy';
  let host = '';
  try {
    host = new URL(direct.url).hostname;
  } catch {}

  return {
    direct_stream: shareable ? direct.url : directEndpointUrl(embedUrl),
    direct_kind: direct.kind,
    direct_mode: mode,
    direct_host: host || undefined,
  };
}
