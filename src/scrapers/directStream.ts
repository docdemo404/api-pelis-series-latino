import * as cheerio from 'cheerio';
import * as crypto from 'crypto';
import { DirectMode, ServerOption } from '../types';
import { httpClient, USER_AGENT } from '../utils/httpClient';
import { bestMode, policyFor, requiredHeaders } from './hostPolicy';

/**
 * Extracción del vídeo REAL que hay detrás de un embed (el .m3u8 o .mp4 que reproduce
 * el iframe), para poder ofrecerlo como fuente prioritaria y dejar el embed de último recurso.
 *
 * CÓMO ESTÁN PROTEGIDOS ESTOS HOSTS (medido, no supuesto):
 * ninguno entrega una URL permanente. La familia Earnvids/goodstream firma un HMAC que cubre
 * la query ENTERA —quitar o alterar cualquier parámetro devuelve 403, incluido el `e` de
 * caducidad— y ese HMAC lo calcula su servidor, así que no hay algoritmo que replicar: solo
 * se puede pedir.
 *
 * Consecuencia de diseño: lo extraído NO se persiste. Aquí solo se averigua que la extracción
 * ES POSIBLE (y de qué tipo); la URL se acuña en el momento de reproducir, desde
 * /api/v1/stream/direct. Ver src/routes/stream.routes.ts.
 *
 * LO QUE CADUCA NO ES LO QUE ATA. Durante mucho tiempo aquí se afirmó que además la firma iba
 * ligada a la red que la pidió, y de ahí que TODO se reenviara byte a byte desde la API. Se
 * midió (scripts/dev/probe_hosts.ts, 2026-07-25) y solo es cierto en vidhideplus: las otras 13
 * familias sirven sin rechistar una URL acuñada desde otra IP. Que una URL caduque en 4 h no
 * impide entregarla al cliente — se acuña en el momento de reproducir y se entrega recién
 * hecha. Quién puede recibirla directamente lo dice src/scrapers/hostPolicy.ts.
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
const IP_BOUND_HOSTS = ['waaw.to', 'netu.tv', 'hqq.', 'okcdn.ru', 'ok.ru', 'drive.google', 'googleusercontent'];

/**
 * Hosts cuya URL ES YA el fichero, aunque no acabe en `.mp4`.
 *
 * `extractFromUrlParam` exigía una extensión conocida, y con eso se le escapaba el caso más
 * numeroso del catálogo: 940 embeds de FuegoCine llevan en su `link=` una dirección de
 * `pixeldrain.com/api/file/<id>`, que sirve el fichero tal cual —con `Access-Control-Allow-Origin:
 * *` incluido— pero termina en un id, no en una extensión. Se rechazaban por la forma de la URL
 * teniendo el vídeo delante.
 */
const HOSTS_DE_FICHERO_DIRECTO = [
  /pixeldrain\.com\/api\/file\//i,
  /drive\.google\.com\/uc\?/i,
  /\/videoplayback\?/i,
  // `remux` es el reensamblador propio de unlimplay: responde `Content-Type: video/mp4` y CORS
  // abierto. Ver `extraerUnlimplay`.
  /remux\.unlimplay\.com\/remux\?/i,
];

/**
 * ¿Esta URL es un FICHERO que se puede guardar para siempre?
 *
 * Vive aquí y no en el crawl porque hacen falta dos respuestas idénticas en dos sitios: el
 * crawl la usa para decidir qué ENTRA, y el barrido de permanentes para decidir qué SE QUEDA.
 * Cuando estaban por separado pasó exactamente lo que tenía que pasar — se quitó
 * `remux.unlimplay.com` de la lista del crawl y el barrido siguió tratando como buenos los que
 * ya estaban guardados, así que se seguían entregando.
 *
 * Lo que hay aquí son hosts cuya URL ES el fichero y no caduca. `remux.unlimplay.com` estuvo y
 * no debía: es un remuxer que reensambla el vídeo al vuelo por cada petición —atado a sesión— y
 * hoy contesta 403 con una página HTML. Guardar eso es guardar una promesa, no una dirección.
 */
export function esUrlDeFicheroPermanente(url: string): boolean {
  if (!url) return false;
  // Los hosts cuya url ES el fichero aunque no acabe en extensión, por su patrón.
  if (FICHEROS_PERMANENTES.some(re => re.test(url))) return true;
  /**
   * Y la extensión, EN LA RUTA. Mismo motivo que en `esFicheroDirecto`: el envoltorio de
   * FuegoCine (`blogspot.com/?…&link=https://…/video.mp4`) acaba en `.mp4` sin ser un fichero, y
   * por aquí se colaba en la base como si fuera una url permanente. No lo es: es una página.
   */
  try {
    return /\.(mp4|mkv|webm)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

const FICHEROS_PERMANENTES: RegExp[] = [
  /pixeldrain\.com\/api\/file\//i,
  /archive\.org\/download\//i,
  /1a-\d+\.com\/video\//i,
  /cdn\.rumble\.cloud\/video\//i,
  // OJO: la extensión `.mp4`/`.mkv`/`.webm` ya NO va aquí. Estaba, y como estos patrones se
  // prueban contra la url entera, colaba el envoltorio de FuegoCine —que lleva el fichero en un
  // parámetro `link=` y por eso termina en `.mp4`— como si fuera una url permanente. Ahora la
  // extensión se comprueba contra la RUTA, abajo.
];

/**
 * La forma ESTABLE de una URL de archive.org.
 *
 * archive.org reparte cada fichero entre nodos y publica el enlace del nodo que le toca en ese
 * momento: `https://dn711505.ca.archive.org/0/items/<id>/<fichero>`. Ese hostname NO es
 * permanente —el fichero se mueve, el nodo se cae o se rebalancea— y guardarlo es guardar algo
 * que se pudre, que es exactamente lo que este catálogo dejó de hacer.
 *
 * La forma canónica `https://archive.org/download/<id>/<fichero>` redirige al nodo que esté sano
 * en cada petición. Medido el 2026-08-19 sobre el mismo fichero de 1,78 GB:
 *
 *   nodo dn711505…   httpClient 206 en 10,9 s · streamClient **500**
 *   /download/…      httpClient 206 en 2,3 s  · streamClient 206 en 2,1 s
 *
 * O sea que el nodo no solo caduca: ya falla hoy con el cliente que usa el verificador del crawl
 * (`entregaVideo`), y el fallo se leería como «este fichero no reproduce» cuando reproduce.
 *
 * Lo que no sea de archive.org sale tal cual.
 */
export function canonicalArchiveOrg(url: string): string {
  const m = /^https?:\/\/[a-z0-9-]+\.(?:[a-z]{2}\.)?archive\.org\/\d+\/items\/([^/]+)\/(.+)$/i.exec(url || '');
  return m ? `https://archive.org/download/${m[1]}/${m[2]}` : url;
}

/** ¿Esta URL apunta al fichero de vídeo, por extensión o por ser un host de fichero directo? */
export function esFicheroDirecto(url: string): boolean {
  if (HOSTS_DE_FICHERO_DIRECTO.some(re => re.test(url))) return true;

  /**
   * LA EXTENSIÓN SE MIRA EN LA RUTA, NO EN TODA LA URL.
   *
   * Miraba la url entera, y eso daba por fichero cosas que son páginas. El caso que lo destapó:
   *
   *   https://repfuegocinefree.blogspot.com/?player=fluidplayer&…&link=https://…/video.mp4
   *
   * Es el ENVOLTORIO de FuegoCine —una página con un reproductor dentro— y acaba en `.mp4`
   * porque el fichero de verdad viaja en el parámetro `link=`. Con la comprobación vieja pasaba
   * como fichero, así que se le entregaba esa página al reproductor: HTML donde tenía que haber
   * vídeo. Es una de las formas de «no reproduce» que quedaban sin explicar.
   *
   * En la ruta no hay ambigüedad: `/algo.mp4` es un fichero y `/?link=algo.mp4` no lo es.
   */
  try {
    return /\.(m3u8|mp4|txt|mkv|webm)$/i.test(new URL(url).pathname);
  } catch {
    // Sin url válida no se puede afirmar nada, y afirmar de más es lo que se acaba de arreglar.
    return false;
  }
}

/**
 * Hosts de los que NO se extrae, y por qué. Aquí no se publica `direct_stream` ni se intenta.
 *
 * Publicar un `direct_stream` muerto es peor que no publicar ninguno: el cliente lo elige PRIMERO
 * por estar mejor rotulado, pierde el tiempo y solo entonces cae al embed.
 *
 * ── INVENTARIO MEDIDO EL 2026-08-19 (scripts/dev/probe_inventario_hosts.ts, muestras reales) ──
 *
 * Todos estos guardan el vídeo detrás de una comprobación de que hay una PERSONA al otro lado.
 * Saltárselas es fabricar prueba de interacción humana, y eso queda fuera de este proyecto: no es
 * una carencia del extractor, es una decisión, y conviene que esté escrita para no volver a
 * gastar una tarde en ella.
 *
 *   waaw.to / netu.tv / hqq   23.381 servidores. Su cadena es /f/ → /watch_video.php → /e/<token>
 *                             → /player/embed_player.php, y ahí sirve hCaptcha o reCAPTCHA.
 *                             Sobre 40 embeds del catálogo: 30 acaban en captcha (75 %) y 10 dan
 *                             "We can't find the file you are looking for" (25 %). CERO
 *                             alcanzables. Medir esto es lo que da `probe_waaw_vivos.ts`.
 *   listeamed.net              6.894. Salta a `?ch=1&js=<JWT>` y de ahí a una capa de consentimiento;
 *                             su siguiente muro es huella de canvas/WebGL.
 *   vudeo.co                   9.089. Cada petición devuelve una página de 1 KB que carga
 *                             `/js/fingerprint/iife.min.js` y se redirige a sí misma con un
 *                             `tr_uuid` nuevo. Sin ejecutar su huella, el bucle no termina.
 *   filemoon.to / .sx          1.074. SPA de React; su `/api/videos/stream/<code>` contesta
 *                             `{"error":"invalid or expired token"}`, y el token sale de un
 *                             *proof-of-work* (`pow_nonce`/`pow_difficulty`) más una limpieza de
 *                             captcha guardada como `byse:captcha-clearance:`.
 *   doodstream.com                26. Reto de Cloudflare ("Just a moment…") antes de la página.
 *
 * OJO AL COMENTARIO VIEJO, por si vuelve la tentación de fiarse de uno: aquí ponía que waaw dejaba
 * a la vista un señuelo `…/secip/…` y que su URL buena salía de un POST a
 * `/ajax.php?mode=increment_video` con `adbact`, `popcount` y un `mousemove` con `isTrusted`. Nada
 * de eso aparece hoy en sus páginas. La conclusión seguía siendo la correcta y el mecanismo
 * descrito ya no existía: un comentario que explica un CÓMO caduca; el QUÉ y el POR QUÉ duran.
 */
const DECOY_HOSTS = ['waaw.to', 'netu.tv', 'hqq.', 'vudeo.co', 'filemoon.', 'doodstream'];

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

/**
 * Segundos que le quedan de vida a la firma de una URL, leídos de la propia URL.
 *
 * Estos CDN no publican la caducidad en ninguna cabecera: la meten como un parámetro más con
 * marca de tiempo Unix (`e=` en la familia Earnvids, `kx=` en upns). Se coge la mayor que esté
 * en el futuro, que es la que manda. Sirve para no re-acuñar una URL que aún vale horas.
 *
 * Devuelve null cuando la URL no declara ninguna: entonces no se puede saber y toca asumir poco.
 */
export function tokenExpirySeconds(url: string): number | null {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  let best: number | null = null;
  for (const [, raw] of params) {
    if (!/^1[6-9]\d{8}$/.test(raw)) continue;
    const remaining = Number(raw) - now;
    if (remaining > 0 && (best === null || remaining > best)) best = remaining;
  }
  return best;
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

  // unlimplay cambió de rutas y su fuente sigue publicando las viejas: `/play.php/embed/…`
  // devuelve HTTP 200 con su PÁGINA DE BIENVENIDA, no con el reproductor. Un 200 con 116 KB de
  // HTML no lo detecta ningún control de salud —parece una página perfectamente viva—, así que
  // 461 servidores quedaron marcados como "hace falta un extractor" cuando lo que hacía falta
  // era una ruta que existiera. Se corrige aquí y no en el scraper porque el molde viejo lo
  // emite la fuente: si solo se arreglara al scrapear, cada crawl volvería a meterlo.
  const modernizado = url.replace('/play.php/embed/', '/play/embed/');
  if (modernizado !== url) return modernizado;

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
  const dentro = urlEnvueltaEnParametro(embedUrl);
  if (!dentro || !esFicheroDirecto(dentro.url)) return null;

  // `format=video/mp4` es la pista que da el propio reproductor; el `.txt` de algunos CDN
  // es un manifiesto HLS con la extensión cambiada para esquivar filtros.
  const kind: DirectKind =
    /mpegurl|m3u8/i.test(dentro.formatoDeclarado) || /\.(m3u8|txt)(\?|$)/i.test(dentro.url) ? 'hls' : 'mp4';
  return { url: dentro.url, kind };
}

/**
 * EL FICHERO PERMANENTE QUE UN EMBED LLEVA DENTRO, sin gastar una sola petición.
 *
 * Es `extractFromUrlParam` mirado desde otro lado, y existe para una decisión que se toma ANTES
 * de acuñar nada: si la dirección del vídeo viaja escrita en la propia URL del embed, no hay
 * ninguna razón para salir a la red a averiguarla.
 *
 * De ahí salió: `mode=proxy` acuñaba primero y con un tope de 6 s, y acuñar el envoltorio de
 * FuegoCine en frío tarda más — así que la PRIMERA vez que alguien abría «Misión Rescate» se
 * llevaba un 502 tras catorce segundos, y a la segunda ya iba porque el acuñado había quedado en
 * caché. Otro fallo que se cura solo, que es la peor clase.
 *
 * Se exige que sea PERMANENTE, no solo que sea un fichero: lo que se devuelve aquí acaba en la
 * caché por trozos del Worker, y guardar una url firmada sería llenarla de trozos que caducan.
 */
export function ficheroPermanenteDentroDelEmbed(embedUrl: string): string | null {
  const dentro = urlEnvueltaEnParametro(embedUrl);
  if (!dentro) return null;
  return esUrlDeFicheroPermanente(dentro.url) ? dentro.url : null;
}

/**
 * La URL que un reproductor-envoltorio lleva en un parámetro, sea el fichero o OTRO embed.
 *
 * Se separó de `extractFromUrlParam` porque son dos preguntas distintas y confundirlas costaba
 * servidores: 35 embeds de FuegoCine llevan en su `link=` no un fichero sino otro host de embed
 * (`firestream.to`, `turbovidhls.com`, `//gscdn.cam/…`), y varios de esos hosts SÍ los sabemos
 * extraer. Al exigir que el parámetro fuera un fichero, se tiraba la pista y el servidor se
 * quedaba en embed teniendo un extractor bueno a un salto de distancia.
 */
function urlEnvueltaEnParametro(embedUrl: string): { url: string; formatoDeclarado: string } | null {
  let params: URLSearchParams;
  try {
    params = new URL(embedUrl).searchParams;
  } catch {
    return null;
  }

  for (const key of ['link', 'url', 'file', 'source', 'src']) {
    const value = params.get(key);
    // `//host/…` sin esquema es una URL válida para un navegador y hay que normalizarla ANTES de
    // juzgarla: 5 embeds la usan (`//gscdn.cam/video/embed/…`) y se descartaban por no empezar
    // por `http`, aunque gscdn es uno de los hosts que mejor se extraen.
    if (!value || !/^(https?:)?\/\//i.test(value)) continue;
    return { url: normalizeUrl(value), formatoDeclarado: params.get('format') || '' };
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
 * Los cuatro CDN entre los que reparte upns, con el campo del payload donde viaja cada uno.
 * El nombre de la izquierda es el que usan ellos en `streamingConfig.order`.
 */
const UPNS_CDN: Record<string, string[]> = {
  Cloudflare: ['cf', 'cfNative'],
  Tiktok: ['hlsVideoTiktok'],
  Google: ['hlsVideoGoogle'],
  'In-House': ['source'],
};

/** Orden por defecto del reproductor cuando `streamingConfig` no trae uno válido. */
const UPNS_ORDEN_POR_DEFECTO = ['Cloudflare', 'In-House'];

interface UpnsAjuste {
  disabled?: boolean;
  domain?: string;
  params?: Record<string, string>;
}

/**
 * Aplica a una URL el mismo ajuste que el reproductor, que son tres cosas y en este orden:
 * saltarse el CDN si viene `disabled`, escribir los `params` en la query, y —si la ruta pasa
 * por `/hls/`— desviarla al proxy `/hlsmod/<dominio>/` que ellos anteponen.
 */
function ajustarUpns(url: string, ajuste: UpnsAjuste | undefined): string | null {
  if (ajuste?.disabled || !url) return null;
  let u: URL;
  try {
    u = new URL(url.trim().startsWith('//') ? `https:${url.trim()}` : url.trim());
  } catch {
    return null;
  }
  if (ajuste?.params && typeof ajuste.params === 'object') {
    for (const [k, v] of Object.entries(ajuste.params)) u.searchParams.set(k, String(v));
  }
  if (ajuste?.domain && u.pathname.includes('/hls/')) {
    u.pathname = u.pathname.replace('/hls/', `/hlsmod/${ajuste.domain}/`);
  }
  return u.toString();
}

/**
 * El token de reproducción: su loader de hls.js añade `k`/`kx` a TODA url que pase por `/v4/`,
 * y sin él esas rutas contestan 403. Va aquí y no en el proxy porque `hasVolatileToken` ya
 * reconoce `kx=<marca de tiempo>` y obliga a acuñar la URL en cada reproducción.
 */
function firmarUpns(url: string, pk: { k?: string; kx?: number } | undefined): string {
  if (!pk?.k || !url.includes('/v4/') || url.includes(`k=${pk.k}`)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}k=${pk.k}&kx=${pk.kx}`;
}

/**
 * upns.pro y clones (`https://…/#<videoId>`): el id viaja en el hash y el vídeo se pide a
 * `/api/v1/video`, que responde cifrado. Requiere una petición extra, la única de todos los
 * extractores.
 *
 * El payload NO trae una url y ya está: trae hasta cuatro, una por CDN, y un `streamingConfig`
 * que dice en qué orden probarlas y cómo retocar cada una. Leer solo `cfNative || source` —lo
 * que se hacía antes— era quedarse con dos campos de cinco, y encima con el de Safari primero:
 * `cfNative` es el manifiesto para navegadores con HLS nativo, no el principal.
 *
 * Y un aviso para quien venga a depurar esto: que devuelva null NO significa que el extractor
 * esté roto. Cuando el vídeo no está listo, su API responde 200 con el payload completo —título,
 * póster, `player`, `pk`— y SIN ninguno de los cinco campos de stream; su propio reproductor
 * enseña entonces "Video is not ready yet". Es la misma señal que da el sitio, no un fallo
 * nuestro. Medido en agosto de 2026: de 25 embeds del catálogo repartidos por los cinco dominios
 * de la familia, los que contestaban 200 traían todos `campos=[]`, y el resto daba 404
 * «Video not found or deleted». Antes de tocar este código, comprueba con
 * `scripts/dev/probe_extraccion.ts` si lo que falta es el extractor o el vídeo.
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

    // `streamingConfig` viaja como CADENA JSON dentro del payload ya descifrado.
    let orden: string[] = UPNS_ORDEN_POR_DEFECTO;
    let ajustes: Record<string, UpnsAjuste> = {};
    try {
      const sc = typeof payload.streamingConfig === 'string'
        ? JSON.parse(payload.streamingConfig)
        : payload.streamingConfig;
      if (Array.isArray(sc?.order) && sc.order.length) orden = sc.order;
      if (sc?.adjust && typeof sc.adjust === 'object') ajustes = sc.adjust;
    } catch { /* con el orden por defecto se sigue igual */ }

    for (const cdn of orden) {
      for (const campo of UPNS_CDN[cdn] || []) {
        const bruto = payload[campo];
        if (typeof bruto !== 'string' || !bruto) continue;
        const ajustada = ajustarUpns(bruto, ajustes[cdn]);
        if (!ajustada) continue;
        const url = firmarUpns(ajustada, payload.pk);
        return { url: normalizeUrl(url), kind: kindOf(url) };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * vidsonic.net — la url va en el HTML, escrita del revés y en hexadecimal.
 *
 * Su página no llama a ninguna API y no pide nada a nadie: trae la dirección delante, ofuscada
 * con tres pasos que su propio `_decode` deja a la vista:
 *
 *     const _0x1 = '3939343665|6461363138|…';        // trozos hexadecimales separados por '|'
 *     const _decode = function(s) {
 *         const clean = s.split('|').join('');       // 1. juntar los trozos
 *         …parseInt(clean.substr(i, 2), 16)…         // 2. cada par de dígitos, un carácter
 *         return out.split('').reverse().join('');   // 3. y la cadena entera, al revés
 *     };
 *     let _videoUrl = _decode(_0x1);
 *
 * De ahí sale, por ejemplo:
 *
 *     https://sfy-01-fr.vidsonic.net/secure/uploads/364/1nkfw3bugfho4il.mp4/index.m3u8
 *         ?server_id=3&expires=1787149324&file_id=ael6kkkue7zp&md5=d5f3…
 *
 * Fíjate en que el `.mp4` es un DIRECTORIO y el fichero es `index.m3u8`: es HLS, no un mp4, y
 * `kindOf` acierta porque mira la extensión final. La url lleva `expires` y `md5`, así que es
 * efímera y se acuña al reproducir como todas las demás.
 *
 * El reproductor la borra a los cinco segundos (`setTimeout(… _videoUrl = '' …, 5000)`), cosa que
 * a un scraper le da igual: el valor ya está en el HTML servido.
 *
 * Medido el 2026-08-19 sobre los 10 embeds del catálogo: se descifra en 5 y 3 entregan vídeo de
 * verdad (358–630 KB/s); el resto son páginas sin `_0x1`, que son ficheros que ya no están. Son
 * 31 servidores —poco—, pero es de los pocos hosts que quedaban sin muro anti-bot, y el coste es
 * esta función.
 */
function extraerVidsonic(html: string): DirectStream | null {
  const crudo = html.match(/const\s+_0x1\s*=\s*'([0-9a-f|]+)'/i)?.[1];
  if (!crudo) return null;

  const limpio = crudo.split('|').join('');
  // Un hexadecimal impar no es hexadecimal: mejor no extraer que extraer basura.
  if (limpio.length % 2 !== 0) return null;

  let texto = '';
  for (let i = 0; i < limpio.length; i += 2) {
    const codigo = parseInt(limpio.substr(i, 2), 16);
    if (!Number.isFinite(codigo)) return null;
    texto += String.fromCharCode(codigo);
  }
  const url = texto.split('').reverse().join('');

  // Que el descifrado haya salido bien se comprueba mirando el resultado, no confiando en el
  // molde: si el sitio cambia el orden de los pasos, esto devuelve null en vez de una url falsa.
  if (!/^https?:\/\/[\w.-]+\//.test(url)) return null;
  return { url: normalizeUrl(url), kind: kindOf(url) };
}

/**
 * unlimplay NO es un host de vídeo: es un agregador, como esta propia API.
 *
 * Su página `/play/embed/<tipo>/<id>` trae, escrito por su PHP y sin ninguna llamada extra, un
 * objeto con los hosts reales donde está el vídeo:
 *
 *   const EMBEDS = {"latino":{"remux":"https://remux.unlimplay.com/remux?id=972232",
 *                            "streamwish":"https://streamwish.to/e/…", "vidhide":"…", …}}
 *
 * De todos ellos `remux` es el suyo propio y el mejor con diferencia: responde
 * `Content-Type: video/mp4` con `Access-Control-Allow-Origin: *`, sin firma ni caducidad en la
 * URL. Los demás son hosts que ya cubren otros extractores, así que se devuelven como candidatos
 * para el salto anidado.
 *
 * Por qué importa: 590 servidores estaban clasificados como "hace falta un extractor" cuando lo
 * único que hacía falta era leer un objeto que venía en el HTML. Y el diagnóstico previo apuntaba
 * al sitio equivocado —la primera muestra cayó en su página de bienvenida— porque en la base de
 * datos convivían dos moldes de URL: el bueno `/play/embed/…` y un `/play.php/embed/…` heredado
 * que su servidor ya no reconoce y contesta con la portada.
 */
function extraerUnlimplay(html: string): { directo: DirectStream | null; candidatos: string[] } {
  const match = html.match(/const\s+EMBEDS\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (!match) return { directo: null, candidatos: [] };

  let porIdioma: Record<string, Record<string, string>>;
  try {
    porIdioma = JSON.parse(match[1]);
  } catch {
    return { directo: null, candidatos: [] };
  }

  const candidatos: string[] = [];
  let remux = '';
  for (const servidores of Object.values(porIdioma || {})) {
    for (const [nombre, url] of Object.entries(servidores || {})) {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
      if (nombre === 'remux' || /remux\.unlimplay\.com/i.test(url)) {
        if (!remux) remux = url;
      } else {
        candidatos.push(url);
      }
    }
  }

  return { directo: remux ? { url: normalizeUrl(remux), kind: 'mp4' } : null, candidatos };
}

/** Calidades de Google Drive, de mejor a peor. El itag lo dice todo: no hay que adivinar nada. */
const ITAG_DRIVE: Array<{ itag: string; quality: ServerOption['quality'] }> = [
  { itag: '37', quality: '1080p' },
  { itag: '22', quality: '720p' },
  { itag: '59', quality: '480p' },
  { itag: '78', quality: '480p' },
  // itag 18 son 360p de verdad, pero el catálogo solo tiene etiquetas hasta 480p: se declara la
  // más baja que existe en vez de inventar una nueva, que obligaría a tocar el tipo y el orden.
  { itag: '18', quality: '480p' },
];

/**
 * Google Drive (`/file/d/<id>/preview`): el vídeo se pide a `get_video_info`, no está en el HTML.
 *
 * Devuelve un cuerpo tipo formulario donde `fmt_stream_map` es `itag|url,itag|url,…`. Se coge la
 * mejor calidad disponible según `ITAG_DRIVE`.
 *
 * Su URL va ATADA A LA IP —la lleva escrita dentro, `…&ip=2803:c600:…`— y caduca en un par de
 * horas (`expire=`), así que solo puede servirse reenviando bytes. Por eso `drive.google` está en
 * `IP_BOUND_HOSTS` y tiene su entrada en hostPolicy: entregarle al cliente un 302 con esa URL
 * daría 403 en cuanto la pidiera desde su propia red.
 */
async function extraerDrive(embedUrl: string): Promise<DirectStream | null> {
  const id = embedUrl.match(/\/file\/d\/([\w-]+)/)?.[1] || new URL(embedUrl).searchParams.get('id');
  if (!id) return null;

  const res = await httpClient.get(`https://drive.google.com/get_video_info?docid=${encodeURIComponent(id)}`, {
    headers: { Referer: `https://drive.google.com/file/d/${id}/preview` },
    timeout: 10000,
    responseType: 'text',
    transformResponse: [(d: unknown) => d],
    validateStatus: () => true,
  });
  if (res.status !== 200) return null;

  const campos = new URLSearchParams(String(res.data || ''));
  // `status=fail` acompaña a los ficheros borrados o sin permiso de lectura.
  if (campos.get('status') !== 'ok') return null;
  const mapa = campos.get('fmt_stream_map');
  if (!mapa) return null;

  const porItag = new Map<string, string>();
  for (const par of mapa.split(',')) {
    const [itag, url] = par.split('|');
    if (itag && url) porItag.set(itag.trim(), url);
  }

  for (const { itag, quality } of ITAG_DRIVE) {
    const url = porItag.get(itag);
    if (url) return { url: normalizeUrl(url), kind: 'mp4', quality };
  }
  // Un itag que no conocemos sigue siendo vídeo: mejor servirlo que descartarlo por no estar en
  // la tabla. Lo único que se pierde es saber su calidad.
  const primera = porItag.values().next();
  return primera.done ? null : { url: normalizeUrl(primera.value), kind: 'mp4' };
}

/**
 * Página que solo redirige por JavaScript, con el destino ya escrito dentro.
 *
 * Dos formas, las dos vistas en el catálogo:
 *   - `window.location.replace('…?ch=1&js=<jwt>&sid=…')` — listeamed.net, que nos ENTREGA su
 *     propio token en la página anterior;
 *   - `<noscript><meta http-equiv="refresh" content="0; URL=…&fp=-5">` — vudeo.co, que ofrece esa
 *     salida a propósito para clientes sin JavaScript.
 *
 * Seguirla no es saltarse nada: es hacer lo mismo que haría el navegador con lo que el propio
 * sitio pone a la vista. Y hace falta para poder siquiera JUZGAR el embed — sin el salto, ambos
 * hosts se quedaban en "no sabemos qué hay detrás", que es como los tenía clasificados el
 * diagnóstico. Con el salto resulta que detrás hay un 410 y un dominio aparcado.
 */
export function destinoDeRedireccionJs(html: string, base: string): string | null {
  if (!html) return null;
  const patrones = [
    /(?:window|self|document)\.location\.(?:replace\(|href\s*=\s*)['"]([^'"]+)['"]/i,
    /<noscript>[\s\S]{0,300}?url=([^"'>\s]+)/i,
    // vudeo entrega la base y el sufijo por separado; `fp` es su huella y `-5` es el valor que
    // su propio `<noscript>` usa cuando no hay JavaScript que la calcule.
    /var\s+redirect_link\s*=\s*['"]([^'"]+)['"]/i,
  ];
  for (const re of patrones) {
    const m = html.match(re);
    if (!m) continue;
    let destino = m[1].replace(/&amp;/g, '&');
    if (re.source.includes('redirect_link')) destino += 'fp=-5';
    try {
      return new URL(destino, base).toString();
    } catch {
      continue;
    }
  }
  return null;
}

export interface FastExtraction {
  /** El vídeo, si se pudo resolver sin descargar el embed. */
  direct: DirectStream | null;
  /**
   * `true` = este host se resuelve por aquí y no hay nada más que probar, haya salido vídeo o
   * no. Descargar el HTML del embed sería tirar una petición a la basura.
   */
  conclusive: boolean;
}

/**
 * Extracción que NO necesita el HTML del embed.
 *
 * Existe por una razón concreta de latencia: al reproducir, `mintDirect` se descargaba SIEMPRE
 * el embed antes de intentar nada, y para los hosts que caen aquí ese cuerpo no se llegaba a
 * mirar. Eran hasta dos viajes completos (el chequeo de salud y el HTML) metidos en el camino
 * crítico entre pulsar Play y el primer fotograma, para no usarlos.
 *
 * Cubre los tres casos que se deciden solo con la URL:
 *   - el vídeo viaja en la propia URL del embed (`link=` de FuegoCine);
 *   - hosts de la familia upns, que no dejan nada en el HTML y hay que preguntar a su API;
 *   - hosts señuelo, cuyo HTML solo contiene URLs muertas y por eso se descarta a propósito.
 */
export async function extractDirectFast(
  embedUrl: string,
  opts: { allowNetwork?: boolean } = {}
): Promise<FastExtraction> {
  if (!embedUrl) return { direct: null, conclusive: true };

  try {
    /**
     * LO PRIMERO: PUEDE QUE LA URL YA SEA EL FICHERO.
     *
     * Faltaba, y dejaba a la API sin poder servir su propio catálogo. Un `direct_stream` en modo
     * `public` ES un mp4; al pedírselo a `/api/v1/stream/direct` se intentaba extraer un
     * reproductor de dentro de un vídeo, no se encontraba ninguno —claro— y contestaba
     * `DIRECT_UNAVAILABLE`.
     *
     * Importa por un caso muy concreto y muy real: un DNS privado que bloquea el host del CDN.
     * El fichero está, la API lo alcanza, y el aparato no puede resolver el nombre. Con esta
     * rama, la app puede pedir ese mismo vídeo por NUESTRO dominio —que sí resuelve— y verlo.
     * Sin ella no había salida que no fuera apagar el DNS.
     */
    if (esFicheroDirecto(embedUrl)) {
      return { direct: { url: embedUrl, kind: kindOf(embedUrl) }, conclusive: true };
    }

    // Y si no, puede que el vídeo venga dentro de un parámetro de la propia URL del embed.
    const fromParam = extractFromUrlParam(embedUrl);
    if (fromParam) return { direct: fromParam, conclusive: true };

    // upns.pro y Drive no dejan nada en el HTML: hay que preguntarle a su API. Solo se hace al
    // REPRODUCIR (`allowNetwork`), nunca al scrapear: la de upns responde 429 en cuanto se la
    // llama en lote, y un 429 durante el crawl quedaría persistido como "este servidor no
    // tiene vídeo directo", que es mentira. Ver `deferredDirectFields`.
    const diferido = hostDiferido(embedUrl);
    if (diferido) {
      if (!opts.allowNetwork) return { direct: null, conclusive: true };
      const direct = diferido === 'drive' ? await extraerDrive(embedUrl) : await extractUpns(embedUrl);
      return { direct, conclusive: true };
    }

    const host = new URL(embedUrl).hostname.toLowerCase();
    if (DECOY_HOSTS.some(h => host.includes(h))) return { direct: null, conclusive: true };

    return { direct: null, conclusive: false };
  } catch {
    return { direct: null, conclusive: false };
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
  return extraer(embedUrl, html, opts, 0);
}

/**
 * Cuántos envoltorios se atraviesan como máximo.
 *
 * Uno basta para todo lo medido (FuegoCine → host real, unlimplay → host real) y es el tope que
 * evita que una cadena de redirectores publicitarios convierta una reproducción en una ráfaga de
 * peticiones. Si algún día hace falta más, se sube aquí y no en cinco sitios.
 */
const SALTOS_MAXIMOS = 1;

async function extraer(
  embedUrl: string,
  html: string,
  opts: { allowNetwork?: boolean },
  profundidad: number
): Promise<DirectStream | null> {
  if (!embedUrl) return null;

  try {
    const fast = await extractDirectFast(embedUrl, opts);
    if (fast.direct) return fast.direct;

    const host = new URL(embedUrl).hostname.toLowerCase();

    // Los hosts que solo se resuelven por su API (upns, Drive) ya se han intentado en `fast`.
    // Los señuelo también terminan ahí: su HTML solo contiene URLs muertas.
    if (fast.conclusive) {
      // Salvo que el envoltorio traiga OTRO embed dentro, que sí se puede seguir. Es el caso de
      // FuegoCine: `link=` con un `firestream.to` o un `//gscdn.cam/…` en vez de un fichero.
      const dentro = urlEnvueltaEnParametro(embedUrl);
      if (dentro && !esFicheroDirecto(dentro.url)) {
        return seguirAnidado(dentro.url, opts, profundidad);
      }
      return null;
    }

    if (!html) return null;

    if (host.includes('ok.ru') || host.includes('odnoklassniki')) {
      return extractOkru(html);
    }

    // vidsonic escribe la url del revés y en hexadecimal; el genérico no la vería.
    if (host.includes('vidsonic')) {
      return extraerVidsonic(html);
    }

    // unlimplay es un agregador: su HTML lista los hosts reales. Se mira ANTES del desempaquetado
    // porque su página no lleva vídeo propio y el genérico no encontraría nada.
    if (host.includes('unlimplay')) {
      const { directo, candidatos } = extraerUnlimplay(html);
      if (directo) return directo;
      // Como mucho dos candidatos: esto corre entre pulsar Play y el primer fotograma, y su lista
      // trae seis hosts. Probarlos todos serían seis viajes de ida y vuelta encadenados por un
      // vídeo que, cuando `remux` no está, lo más probable es que tampoco tengan los demás.
      for (const candidato of candidatos.slice(0, 2)) {
        const anidado = await seguirAnidado(candidato, opts, profundidad);
        if (anidado) return anidado;
      }
      return null;
    }

    // Familia Earnvids (vidhide/streamwish/filelions/lulustream) y dropload: todo va empaquetado.
    const unpacked = unpackPacker(html);
    if (unpacked) {
      const fromPacked = extractFromText(unpacked);
      if (fromPacked) return fromPacked;
    }

    // goodstream/gscdn y compañía dejan el `sources:[{file:…}]` a la vista en el HTML plano.
    const enTexto = extractFromText(html);
    if (enTexto) return enTexto;

    // Un envoltorio con otro embed dentro (`link=`), o una página que solo redirige por JS.
    const dentro = urlEnvueltaEnParametro(embedUrl);
    if (dentro && !esFicheroDirecto(dentro.url)) {
      const anidado = await seguirAnidado(dentro.url, opts, profundidad);
      if (anidado) return anidado;
    }
    const redirigido = destinoDeRedireccionJs(html, embedUrl);
    if (redirigido && redirigido !== embedUrl) {
      return seguirAnidado(redirigido, opts, profundidad);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Descarga un embed anidado y le aplica el mismo extractor, un nivel más abajo.
 *
 * Solo con `allowNetwork`, o sea al REPRODUCIR y nunca durante el crawl: son peticiones extra por
 * servidor, y multiplicarlas por 30 000 servidores convertiría el refresco de catálogo en horas.
 * Lo que sí se guarda durante el crawl es que este embed es candidato (`mereceSaltoAnidado`), para
 * que la ficha se anuncie con vídeo directo y la URL se acuñe al pulsar Play.
 */
async function seguirAnidado(
  url: string,
  opts: { allowNetwork?: boolean },
  profundidad: number
): Promise<DirectStream | null> {
  if (!opts.allowNetwork || profundidad >= SALTOS_MAXIMOS) return null;

  const destino = unwrapRedirector(url);
  try {
    const res = await httpClient.get(destino, {
      headers: { Referer: new URL(destino).origin + '/' },
      timeout: 8000,
      responseType: 'text',
      transformResponse: [(d: unknown) => d],
      validateStatus: () => true,
    });
    if (res.status !== 200) return null;
    return extraer(destino, String(res.data || ''), opts, profundidad + 1);
  } catch {
    return null;
  }
}

/** URL permanente de esta API que acuña y sirve el vídeo de un embed al reproducir. */
export function directEndpointUrl(embedUrl: string, kind?: DirectKind): string {
  // La extensión va en la RUTA porque hay reproductores que eligen el descodificador por ella
  // antes de pedir nada (ExoPlayer, AVPlayer). Sin ella, una url con query es un formato
  // desconocido y ni lo intentan. El nombre del fichero es decorativo: la ruta lo ignora.
  const nombre = kind === 'mp4' ? '/v.mp4' : kind === 'hls' ? '/v.m3u8' : '';
  return `/api/v1/stream/direct${nombre}?e=${Buffer.from(embedUrl, 'utf8').toString('base64url')}`;
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

/**
 * ¿Merece la pena volver a pasar por esta ficha porque HOY sabemos extraer su host?
 *
 * Distinto de `canExtractWithoutFetch`, que responde si el vídeo sale sin pedir nada. Aquí la
 * pregunta es la del mantenimiento: cada extractor nuevo deja atrás un montón de servidores
 * guardados como "solo embed" que ya no lo son, y sin una lista así hay que adivinar cuáles
 * repasar. Lo usa scripts/refreshCatalog.ts --direct-only.
 *
 * Hay que AÑADIR aquí cualquier host cuyo extractor se escriba en el futuro. Es la diferencia
 * entre que el arreglo alcance a las 14 000 fichas viejas o solo a las nuevas.
 *
 * Y HAY QUE DESCONTAR LOS QUE LA POLÍTICA NO DEJA PUBLICAR, que es la mitad que faltaba.
 *
 * Tener extractor escrito no es lo mismo que poder entregar el vídeo. La familia upns está en la
 * lista de abajo —su descifrado AES sigue funcionando— y a la vez marcada `noSePuedeServirDirecto`
 * desde que dejó de servir vídeo, así que `deferredDirectFields` no le pone `direct_stream` por
 * mucho que se la vuelva a mirar. Resultado: esas fichas nunca dejaban de ser candidatas y volvían
 * a la cabeza de la cola en cada corrida, para siempre.
 *
 * Lo que costaba, medido el 2026-08-19 sobre las 40 primeras de la cola por el camino de
 * producción: 1 acierto. El registro era una lista de `pelisplus.upns.pro embed caído`. Con 900
 * fichas por corrida y tres corridas al día, ese hueco es todo el caudal de extracción que tiene
 * el catálogo, y se estaba yendo en repasar hosts apagados.
 *
 * Un host solo desaparece de aquí mientras esté apagado: el día que vuelva a servir vídeo se le
 * quita la marca en hostPolicy y sus fichas vuelven a entrar solas, sin tocar esta función.
 */
export function mereceRepasoDeExtraccion(embedUrl: string): boolean {
  if (!embedUrl) return false;
  // Si no se puede servir, extraerlo no cambia nada: la ficha saldría igual de muda.
  if (policyFor(embedUrl).noSePuedeServirDirecto) return false;
  if (canExtractWithoutFetch(embedUrl)) return true;

  // Envoltorio con otro embed dentro: el salto anidado puede resolverlo.
  const dentro = urlEnvueltaEnParametro(embedUrl);
  if (dentro) return true;

  try {
    const host = new URL(embedUrl).hostname.toLowerCase();
    return HOSTS_CON_EXTRACTOR.some(h => host.includes(h));
  } catch {
    return false;
  }
}

/**
 * TODOS los hosts de los que hoy se sabe sacar el vídeo. Es la lista que decide qué fichas vale
 * la pena volver a mirar cuando se añade o se arregla un extractor.
 *
 * Estaba incompleta y costaba caro: solo nombraba unlimplay, ahvsh y streamlare, así que el
 * repaso saltaba las fichas de emturbovid, de la familia upns, de gscdn… — los hosts MÁS
 * numerosos del catálogo. El resultado es que 2.343 servidores seguían guardados como simple
 * embed teniendo su extractor escrito y funcionando, y el repaso contestaba "todas resueltas"
 * porque ni las miraba.
 *
 * Al escribir un extractor nuevo hay que añadirlo AQUÍ. Es lo que separa arreglar el futuro de
 * arreglar también las 14.000 fichas que ya están guardadas.
 */
const HOSTS_CON_EXTRACTOR = [
  // El más numeroso del catálogo. Estuvo vetado en hostPolicy por estrangular a las IP de
  // datacenter y no hacía falta nombrarlo aquí; al levantarse el veto el 2026-08-19 (entrega
  // 8/8 desde Vercel, 233 KB/s) hay 33.195 servidores guardados como simple embed que SÍ se
  // saben extraer —su `eval(function(p,a,c,k,e,d))` trae `var links={"hls2":"…master.m3u8"}`—
  // y que sin esta línea nadie volvería a mirar.
  'vidhideplus', 'vidhide',
  'emturbovid', 'turbovidhls',                       // HLS con segmentos disfrazados de PNG
  'upns.', 'strp2p', '4meplayer', 'rpmstream',       // familia upns (API cifrada)
  'blogspot', 'blogfc',                              // envoltorio de FuegoCine (`link=`)
  'gscdn', 'goodstream',                             // `sources:[{file:…}]` a la vista
  'dropload', 'streamwish', 'filelions', 'lulustream', // P.A.C.K.E.R.
  'ok.ru', 'odnoklassniki',                          // `data-options` con la ficha entera
  'unlimplay', 'vimeos',                             // agregador con `remux` propio
  'drive.google',                                    // `get_video_info`
  'ahvsh', 'streamlare',                             // alcanzables desde que se arregló el TLS
  'vidsonic',                                        // url del revés y en hexadecimal en su HTML
];

/** ¿Este host solo se puede resolver llamando a su API, y por tanto al reproducir? */
export function isDeferredDirectHost(embedUrl: string): boolean {
  return hostDiferido(embedUrl) !== null;
}

/** Cuál de las familias que se resuelven por API es, si es alguna. */
function hostDiferido(embedUrl: string): 'upns' | 'drive' | null {
  if (!embedUrl) return null;
  try {
    const host = new URL(embedUrl).hostname.toLowerCase();
    if (host.includes('drive.google') && /\/file\/d\/[\w-]+|[?&]id=/.test(embedUrl)) return 'drive';
    // El id de la familia upns viaja en el hash; sin él no hay nada que pedirle a su API.
    if (embedUrl.includes('#') && UPNS_HOSTS.some(h => host.includes(h))) return 'upns';
    return null;
  } catch {
    return null;
  }
}

export type DirectFields = Pick<ServerOption, 'direct_stream' | 'direct_kind' | 'direct_mode' | 'direct_host' | 'headers'>;

/**
 * Campos de vídeo directo para los hosts que NO se resuelven al scrapear.
 *
 * Se anuncia el `direct_stream` aunque todavía no se haya resuelto: la URL apunta a esta API,
 * que hará la llamada real al reproducir. Si entonces falla, responde 502 y el cliente cae al
 * embed — la misma cascada de siempre. Anunciarlo es correcto porque el extractor está
 * probado para estos hosts; lo que no se puede es comprobarlo mil veces durante un crawl.
 */
export function deferredDirectFields(embedUrl: string): DirectFields {
  const familia = hostDiferido(embedUrl);
  if (!familia) return {};
  if (policyFor(embedUrl).noSePuedeServirDirecto) return {};
  let host = '';
  try {
    host = new URL(embedUrl).hostname;
  } catch {}
  // Drive sirve mp4 por itag; la familia upns, HLS. Anunciar el tipo equivocado no rompe la
  // reproducción (el endpoint decide de nuevo al acuñar) pero sí engaña al ordenador de servidores.
  const kind: DirectKind = familia === 'drive' ? 'mp4' : 'hls';
  return {
    direct_stream: directEndpointUrl(embedUrl, kind),
    direct_kind: kind,
    direct_mode: bestMode(embedUrl, kind),
    direct_host: host || undefined,
    headers: requiredHeaders(embedUrl, USER_AGENT),
  };
}

/**
 * Traduce una extracción a los campos que viajan en el `ServerOption`.
 *
 * Cuando la URL es efímera —la inmensa mayoría— se publica la URL de ESTA API en vez de la del
 * CDN: así el cliente guarda un enlace estable y la caducidad se resuelve por dentro.
 *
 * PERO SI LA URL NO LLEVA NINGUNA MARCA EFÍMERA, se entrega tal cual (modo `public`). Este caso
 * existía, se quitó y vuelve; los tres motivos por los que se quitó y qué ha pasado con cada uno
 * están explicados enteros en `enlaceDirecto` (services/streamSorter.ts) — resumen: el de CORS
 * solo afecta a un reproductor web y el cliente real es ExoPlayer; la verificación se movió a la
 * entrada; y el grave —turboviplay firmando URLs que se guardaban como permanentes— lo ataja
 * `isPubliclyShareable`, que ve la firma y no la deja pasar.
 *
 * Aquí importa porque esta función corre AL ACUÑAR: `playbackHealth` la usa para rehacer los
 * campos de un servidor que resucita, y sin esta rama un servidor `public` que se cayera un rato
 * volvía convertido en `proxy` para siempre.
 *
 * `direct_mode` dice qué HARÁ esa URL al pedirla: `public` la sirve el CDN directamente, y en el
 * resto casi siempre un 302 (`redirect`), con reenvío de bytes (`proxy`) solo en los hosts que
 * atan por IP o exigen cabeceras que un navegador no puede poner. Es un anuncio, no una orden: la
 * decisión real la vuelve a tomar /api/v1/stream/direct al reproducir, así que un valor guardado
 * que se quede viejo no rompe nada — como mucho desactualiza lo que se muestra.
 */
export function describeDirect(embedUrl: string, direct: DirectStream): DirectFields {
  // Hay hosts cuyo vídeo no se puede servir desde aquí por ninguna vía (ver
  // `noSePuedeServirDirecto`). Extraerlo salió bien, pero entregarlo no, así que no se anuncia:
  // el servidor se queda con su embed, que es lo que de verdad reproduce.
  if (policyFor(embedUrl).noSePuedeServirDirecto) return {};

  let host = '';
  try {
    host = new URL(direct.url).hostname;
  } catch {}

  /**
   * La URL permanente se entrega tal cual, sin envolverla.
   *
   * Se mira `direct.url` —la URL extraída— y no el embed: son cosas distintas y solo la primera
   * es la que va a pedir el reproductor. El envoltorio `?link=…` de FuegoCine, por ejemplo, lleva
   * parámetros que `hasVolatileToken` marcaría como firma cuando el fichero de dentro no la tiene.
   */
  if (isPubliclyShareable(direct.url)) {
    return {
      direct_stream: direct.url,
      direct_kind: direct.kind,
      direct_mode: 'public',
      direct_host: host || undefined,
      headers: requiredHeaders(embedUrl, USER_AGENT),
    };
  }

  return {
    direct_stream: directEndpointUrl(embedUrl, direct.kind),
    direct_kind: direct.kind,
    direct_mode: bestMode(embedUrl, direct.kind),
    direct_host: host || undefined,
    headers: requiredHeaders(embedUrl, USER_AGENT),
  };
}
