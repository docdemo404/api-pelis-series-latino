import { Router, Request, Response, NextFunction } from 'express';
import { Transform, TransformCallback } from 'stream';
import { ResolverService } from '../services/resolverService';
import { BandwidthService } from '../services/bandwidthService';
import { mintDirect, MintedStream } from '../services/directResolver';
import { decodeEmbedParam, tokenExpirySeconds, hasVolatileToken } from '../scrapers/directStream';
import { bestMode, policyFor } from '../scrapers/hostPolicy';
import { DirectMode } from '../types';
import { sendErrorResponse } from '../utils/apiHelpers';
import { CacheStore } from '../cache/store';
import { CatalogService } from '../services/catalogService';
import { USER_AGENT, streamClient } from '../utils/httpClient';
import { inicioDelTs } from '../utils/segmentBytes';
import { destinoSirveCors } from '../services/manifestHealth';
import { comprobarDestino, anotarVeredicto } from '../services/playbackHealth';
import { externalProxyEnabled, proxyUrlFor } from '../utils/externalProxy';
import { getSupabaseAdmin } from '../services/supabaseService';

/**
 * Streaming: resolución de tokens dinámicos, proxy con soporte de Range
 * y reporte de enlaces rotos.
 */
const router = Router();

// Resolver Token Dinámico de Stream
router.get('/api/v1/stream/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = (req.query.id as string) || 'srv_default';
    const originalUrl = (req.query.url as string) || 'https://streamwish.to/hls/sample.m3u8';

    const resolved = await ResolverService.resolveStreamToken(id, originalUrl);
    res.json({ status: 'success', data: resolved });
  } catch (err) {
    next(err);
  }
});

/**
 * ───────────────────────────────────────────────────────────────────────────────────────────
 * VÍDEO DIRECTO — la fuente prioritaria; el embed solo si esto falla.
 *
 * `direct_stream` apunta aquí en vez de al CDN porque ningún host conocido entrega una URL
 * permanente: firman la query entera (alterar cualquier parámetro devuelve 403) y le ponen
 * caducidad. Esta ruta es lo que hace que, DE CARA AL CLIENTE, exista una URL estable y sin
 * token: por dentro se acuña una recién hecha en cada reproducción.
 *
 * Lo que hace con ella depende del host, y eso está MEDIDO (src/scrapers/hostPolicy.ts):
 *
 *   redirect → 302 a la URL del CDN. No pasa un solo byte de vídeo por aquí: reproduce a la
 *              velocidad del CDN y no gasta tránsito del plan. Lleva `Referrer-Policy:
 *              no-referrer` porque varios de estos CDN aceptan que no haya Referer pero rechazan
 *              uno ajeno — y un navegador que siguiera el 302 mandaría el de NUESTRA página.
 *   manifest → se sirven las PLAYLISTS desde aquí, con el Referer que espera el host, pero las
 *              URIs de segmento se dejan apuntando al CDN. Existe por la familia upns: sus
 *              playlists rechazan un Referer ajeno y sus segmentos —que viven en otro host—
 *              exigen uno cualquiera, y ningún navegador puede cumplir las dos cosas a la vez.
 *              Un m3u8 son unos KB, así que en tránsito cuesta lo mismo que un `redirect`.
 *   proxy    → se reenvían los bytes, como se hacía siempre. Para vidhideplus y ok.ru, que
 *              validan la IP que acuñó, y para los hosts que exigen su Referer también en los
 *              segmentos (dropload) cuando el cliente no puede ponerlo.
 *
 * Un cliente que sepa fijar cabeceras (ExoPlayer, AVPlayer, VLC) puede pedir `?mode=redirect` y
 * saltarse el proxy también en esos hosts, copiando el `headers` que viaja en el ServerOption.
 * ───────────────────────────────────────────────────────────────────────────────────────────
 */

const DIRECT_BASE = '/api/v1/stream/direct';

/**
 * Qué se envuelve al reescribir un manifiesto. Es el subconjunto de `DirectMode` que llega hasta
 * aquí: `public` y `redirect` no reescriben nada porque no pasan por esta API.
 */
type RewriteMode = 'manifest' | 'proxy';

function encodeParam(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * ¿La URL apunta a un manifiesto HLS?
 *
 * Solo vale como pista: ok.ru sirve su playlist de variante en una ruta acabada en `/video/`,
 * sin extensión ninguna. Por eso la detección DEFINITIVA es por Content-Type, ya con la
 * respuesta en la mano (ver `pipeUpstream`); fiarse de la extensión dejaba pasar la playlist
 * sin reescribir y el cliente acababa pidiendo `MEDIUM00000.ts` al CDN por su cuenta.
 */
function isManifest(url: string): boolean {
  try {
    return /\.m3u8$/i.test(new URL(url).pathname);
  } catch {
    return /\.m3u8(\?|$)/i.test(url);
  }
}

/** Content-Type con el que los CDN anuncian una playlist HLS. */
function isManifestContentType(contentType: string): boolean {
  return /mpegurl|vnd\.apple/i.test(contentType);
}

function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

/**
 * Reescribe un manifiesto HLS para que lo que referencia vuelva a pasar por esta API.
 *
 * En modo `proxy` se envuelve TODO: el cliente recibiría si no las rutas del CDN y pediría los
 * segmentos por su cuenta, llevando el mismo token atado a nuestra IP, y le responderían 403.
 *
 * En modo `manifest` se envuelven solo las PLAYLISTS y las claves; los segmentos se dejan
 * apuntando al CDN. Es lo que convierte a upns en reproducible sin gastar tránsito: sus
 * segmentos aceptan el Referer de la página del reproductor —cualquiera les vale— mientras que
 * sus playlists lo rechazan, así que cada uno va por donde puede.
 *
 * Absolutizar no es opcional en ninguno de los dos modos: el manifiesto se sirve desde NUESTRO
 * origen, y una URI relativa que se dejara tal cual resolvería contra la API en vez de contra
 * el CDN.
 */
function rewriteManifest(
  manifest: string,
  manifestUrl: string,
  embedParam: string,
  mode: RewriteMode = 'proxy'
): string {
  const absolutize = (uri: string): string | null => {
    try {
      return new URL(uri, manifestUrl).toString();
    } catch {
      return null;
    }
  };

  const through = (absolute: string): string =>
    `${DIRECT_BASE}/seg?u=${encodeParam(absolute)}&e=${embedParam}` +
    (mode === 'manifest' ? `&m=${mode}` : '');

  /** `alwaysWrap` es para las claves de cifrado: viven en el host que valida el Referer. */
  const rewrite = (uri: string, alwaysWrap = false): string => {
    const absolute = absolutize(uri);
    if (!absolute) return uri;
    if (mode === 'proxy' || alwaysWrap || isManifest(absolute)) return through(absolute);
    return absolute;
  };

  return manifest
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      // Las etiquetas llevan sus URIs en un atributo (#EXT-X-KEY, #EXT-X-MEDIA, #EXT-X-MAP).
      // La clave de #EXT-X-KEY se pide siempre por aquí; #EXT-X-MAP es el segmento de
      // inicialización y comparte host y reglas con los demás segmentos.
      if (trimmed.startsWith('#')) {
        const isKey = /^#EXT-X-KEY/i.test(trimmed);
        return line.replace(/URI="([^"]+)"/g, (_full, uri: string) => `URI="${rewrite(uri, isKey)}"`);
      }
      // Cualquier otra línea no vacía es un segmento o una variante.
      return rewrite(trimmed);
    })
    .join('\n');
}

/**
 * Caché de un segmento. Debe coincidir con la del middleware de `api/index.ts`, que fija las
 * variantes de borde: si divergen, mandan las de allí.
 *
 * El TTL es largo a propósito, y no es una apuesta: la URL FIRMADA ENTERA del CDN viaja dentro de
 * `?u=`, así que la clave de caché identifica el contenido. Dos espectadores de lo mismo comparten
 * respuesta, rebobinar no vuelve a golpear al CDN, y cuando la firma caduque el re-acuñado
 * producirá otra clave y la vieja envejecerá sola — nunca se sirve algo distinto bajo la misma
 * clave.
 *
 * Antes eran 10 minutos, y esa cifra es la que se notaba: pasado ese rato el MISMO segmento
 * volvía a ser un fallo de caché. Medido desde Chile, el fallo va a 482 KB/s y el acierto a
 * 1,98 MB/s — cuatro veces más rápido— con un vídeo 1080p que pide 3,55 Mbps sostenidos. O sea
 * que el fallo entrega 10 s de vídeo en 9,2 s y el acierto en 2,2 s: la diferencia entre que el
 * búfer se llene o se vacíe.
 */
const SEGMENT_CACHE = 'public, max-age=3600, s-maxage=604800, stale-while-revalidate=86400';

/**
 * Con `Range` de por medio NO se cachea: la respuesta es un tramo concreto y el borde no
 * distingue tramos, así que servirla a quien pida otro daría bytes equivocados.
 */
function cachePolicyFor(req: Request, isSegment: boolean): string {
  if (!isSegment || req.headers.range) return 'no-store';
  return SEGMENT_CACHE;
}

/**
 * Aplica la política en las TRES cabeceras a la vez.
 *
 * No basta con `Cache-Control`: el middleware global fija además `CDN-Cache-Control` y
 * `Vercel-CDN-Cache-Control` por la ruta, y en el borde de Vercel esas dos mandan sobre la
 * primera. Corregir solo una dejaba el borde cacheando respuestas parciales de Range, que es
 * justo lo que no puede cachearse: servirían el tramo equivocado a quien pidiera otro.
 */
function applyCachePolicy(res: Response, policy: string): void {
  res.setHeader('Cache-Control', policy);
  res.setHeader('CDN-Cache-Control', policy);
  res.setHeader('Vercel-CDN-Cache-Control', policy);
}

/**
 * Status con el que se representa un fallo de RED, que no trae ninguno.
 *
 * `validateStatus: () => true` solo neutraliza los códigos HTTP: si el CDN no resuelve, rechaza la
 * conexión o agota el timeout, axios LANZA. Sin este envoltorio esa excepción subía hasta el
 * manejador global y el cliente recibía un 500 genérico en vez del 502 `DIRECT_UNAVAILABLE` que
 * dice la documentación — y con él se saltaba tanto el reintento con token nuevo como la cascada
 * al `embed_url`, que es justo lo que salva la reproducción cuando un CDN se cae.
 */
const NETWORK_FAILURE = 504;

/** Ejecuta una petición al CDN traduciendo el fallo de red a un status, en vez de lanzarlo. */
async function attempt(run: () => Promise<number | null>): Promise<number | null> {
  try {
    return await run();
  } catch {
    return NETWORK_FAILURE;
  }
}

/** Sirve un manifiesto ya reescrito. Devuelve el status de fallo, o null si fue bien. */
async function serveManifest(
  res: Response,
  manifestUrl: string,
  referer: string,
  embedParam: string,
  cacheControl = 'no-store',
  mode: RewriteMode = 'proxy',
  /**
   * Maestro ya descargado por la comprobación de destino, con sus calidades muertas quitadas.
   * Sin esto se pediría el mismo manifiesto dos veces por reproducción — y se serviría el crudo,
   * tirando por la borda justo el filtrado que acababa de hacerse.
   */
  cuerpoPrevio?: string
): Promise<number | null> {
  let crudo = cuerpoPrevio;
  if (crudo === undefined) {
    /**
     * EL MANIFIESTO SE CACHEA, y es lo que más se nota al pulsar Play.
     *
     * Arrancar un vídeo son tres viajes encadenados: maestro, variante y primer segmento. Medido
     * en producción: 0,87 s + 0,41 s + 0,72 s ≈ dos segundos antes del primer fotograma, y de
     * esos, los dos primeros son ir al CDN a por un texto de unos KB que es IDÉNTICO para todo
     * el que vea lo mismo. Cada salto en la barra de tiempo vuelve a pagar la variante.
     *
     * El TTL sale de la propia URL: si su firma declara caducidad se respeta —nunca se sirve un
     * manifiesto cuyos enlaces ya no valen— y si no la declara se usa un margen corto. El tope
     * de cinco minutos es deliberado: un manifiesto es lo único que se guarda con URLs firmadas
     * dentro, así que conviene que la ventana sea estrecha aunque el token dure horas.
     */
    const clave = `m3u8:${manifestUrl}`;
    const guardado = await CacheStore.get<string>(clave);
    if (guardado) {
      crudo = guardado;
    } else {
      const upstream = await streamClient.get(manifestUrl, {
        headers: { Referer: referer },
        responseType: 'text',
        timeout: 15000,
        validateStatus: () => true
      });
      if (upstream.status >= 400) return upstream.status;
      crudo = String(upstream.data);
      const caduca = tokenExpirySeconds(manifestUrl);
      const vida = Math.max(30, Math.min(caduca === null ? 120 : caduca - 30, 300));
      void CacheStore.set(clave, crudo, vida);
    }
  }

  const body = rewriteManifest(crudo, manifestUrl, embedParam, mode);
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  applyCachePolicy(res, cacheControl);
  res.send(body);
  void BandwidthService.add(Buffer.byteLength(body));
  return null;
}

/**
 * Reenvía bytes con soporte de Range. Devuelve el status de fallo, o null si fue bien.
 *
 * Si resulta que lo pedido era otra playlist (lo dice el Content-Type, no la extensión), se
 * reescribe en vez de reenviarse: sus segmentos también tienen que pasar por aquí.
 */
/**
 * SEGMENTOS DISFRAZADOS DE IMAGEN.
 *
 * emturbovid guarda su vídeo en Google Drive, y Drive no sirve ficheros de vídeo a cualquiera —
 * pero sí sirve imágenes. Así que cada segmento sale de `lh3.googleusercontent.com` con
 * `Content-Type: image/png` y ESTO dentro:
 *
 *     [ PNG de verdad, 806 bytes ] [ "a - S01E01 - vip.hdlatino.us" + relleno 0xFF ] [ MPEG-TS ]
 *
 * El vídeo real empieza en el byte 941 del ejemplo medido: a partir de ahí hay 7.028 paquetes de
 * 188 bytes, el 100 % con su marca de sincronía y sin sobrar ninguno. O sea que el vídeo está
 * perfecto; lo que sobra es el disfraz, y quitarlo lo hace su reproductor por JavaScript.
 *
 * Nosotros no lo quitábamos, y encima a esta familia se le entregaba en modo `redirect`: el
 * cliente pedía los segmentos al CDN directamente y recibía imágenes. De ahí el síntoma que se
 * reportó — un servidor rotulado "Vídeo directo" que ningún reproductor arranca: `<video src>`
 * daba error 4 y hasta hls.js moría con `bufferAppendError`, que es exactamente lo que dice un
 * reproductor cuando le das bytes que no son vídeo.
 *
 * SE DECIDE POR LOS BYTES, NO POR EL HOST, y eso importa: un segmento de vídeo legítimo no
 * empieza nunca por la firma de un PNG, así que esto no puede estropear a nadie que ya funcione,
 * y cubre de paso a cualquier otro host que se invente el mismo truco.
 */
class QuitarDisfraz extends Transform {
  private cabecera: Buffer[] = [];
  private acumulado = 0;
  private yaDecidido = false;

  _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    if (this.yaDecidido) return done(null, chunk);

    this.cabecera.push(chunk);
    this.acumulado += chunk.length;
    // Con 64 KB basta de sobra: el disfraz medido ocupa menos de 1 KB. Esperar más sería
    // retrasar el arranque del vídeo por nada.
    if (this.acumulado < 65536) return done();

    const junto = Buffer.concat(this.cabecera);
    const inicio = inicioDelTs(junto);
    this.yaDecidido = true;
    this.cabecera = [];
    // Si no se reconoce dónde empieza, se entrega tal cual: es mejor que el reproductor lo
    // intente a que le llegue un segmento cortado por una corazonada nuestra.
    done(null, inicio >= 0 ? junto.subarray(inicio) : junto);
  }

  _flush(done: TransformCallback): void {
    if (this.yaDecidido || this.cabecera.length === 0) return done();
    const junto = Buffer.concat(this.cabecera);
    const inicio = inicioDelTs(junto);
    done(null, inicio >= 0 ? junto.subarray(inicio) : junto);
  }
}

async function pipeUpstream(
  req: Request,
  res: Response,
  target: string,
  referer: string,
  embedParam: string,
  cacheControl = 'no-store',
  mode: RewriteMode = 'proxy'
): Promise<number | null> {
  const range = req.headers.range;
  /**
   * PLAZO HASTA EL PRIMER BYTE.
   *
   * `streamClient` da 20 s, que es lo razonable para una descarga pero una eternidad para EMPEZAR:
   * sumados al acuñado y a la comprobación, un servidor caído tardaba 36 s en admitir que no
   * reproducía. Como esto es `responseType: 'stream'`, la promesa se resuelve en cuanto llegan las
   * CABECERAS, así que ponerle tope aquí acota el arranque sin tocar la descarga — una vez que los
   * bytes fluyen, pueden tardar lo que hagan falta.
   *
   * Si no llegan a tiempo se devuelve 504 y el reproductor pasa al servidor siguiente.
   */
  const upstream = await conPlazo(streamClient.get(target, {
    headers: {
      Referer: referer,
      // El CDN no debe comprimir: se reenvían sus Content-Length y Content-Range tal cual, y
      // cualquier recodificación por el camino los dejaría mintiendo.
      'Accept-Encoding': 'identity',
      ...(range ? { Range: range } : {})
    },
    responseType: 'stream',
    // El vídeo ya viene comprimido, y axios descomprime por defecto INCLUSO en modo stream: si
    // el CDN respondiera gzip, el cuerpo saldría inflado mientras abajo se reenvían su
    // Content-Length y su Content-Range tal cual, y el reproductor vería cabeceras que no
    // cuadran con los bytes que recibe.
    decompress: false,
    validateStatus: () => true
  }), PRIMER_BYTE_MAX_MS, null);

  // Ni cabeceras a tiempo: no hay vídeo que servir por aquí. 504 para que el cliente pruebe otro.
  if (!upstream) return 504;

  if (upstream.status >= 400) {
    upstream.data?.destroy?.();
    return upstream.status;
  }

  if (isManifestContentType(String(upstream.headers['content-type'] || ''))) {
    const body = rewriteManifest(await streamToString(upstream.data), target, embedParam, mode);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    applyCachePolicy(res, cacheControl);
    res.send(body);
    void BandwidthService.add(Buffer.byteLength(body));
    return null;
  }

  /**
   * Un segmento anunciado como imagen es el disfraz de `QuitarDisfraz`. Al quitarlo cambian los
   * bytes, así que NO pueden reenviarse `Content-Length` ni `Content-Range` —dirían un tamaño que
   * ya no es— ni ofrecerse Range: los desplazamientos se corren. Se sirve entero y troceado.
   */
  const disfrazado = /^image\//i.test(String(upstream.headers['content-type'] || ''));

  res.status(disfrazado ? 200 : upstream.status);
  const passthrough = disfrazado
    ? []
    : ['content-range', 'content-length', 'content-type', 'accept-ranges'];
  for (const header of passthrough) {
    const value = upstream.headers[header];
    if (value) res.setHeader(header, String(value));
  }
  if (disfrazado) {
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Accept-Ranges', 'none');
  } else if (!upstream.headers['accept-ranges']) {
    res.setHeader('Accept-Ranges', 'bytes');
  }
  if (!disfrazado && !upstream.headers['content-type']) {
    res.setHeader('Content-Type', target.includes('.m3u8') ? 'application/x-mpegURL' : 'video/mp4');
  }
  applyCachePolicy(res, cacheControl);

  // El contador de tránsito no debe estorbar: se suma al terminar, sin bloquear el pipe.
  let sent = 0;
  upstream.data.on('data', (chunk: Buffer) => { sent += chunk.length; });
  upstream.data.on('end', () => { void BandwidthService.add(sent); });

  // Si el CDN corta a mitad del envío ya no se puede cambiar el status —las cabeceras salieron
  // hace rato—, pero un `error` sin escuchador en un stream es una excepción no capturada que se
  // lleva por delante el proceso entero. Se cierra la respuesta y el reproductor lo trata como lo
  // que es: una descarga interrumpida, que reintenta por su cuenta.
  upstream.data.on('error', () => {
    void BandwidthService.add(sent);
    res.destroy();
  });

  if (disfrazado) {
    const limpiador = new QuitarDisfraz();
    limpiador.on('error', () => res.destroy());
    upstream.data.pipe(limpiador).pipe(res);
  } else {
    upstream.data.pipe(res);
  }
  return null;
}

/**
 * Vuelve a acuñar el token y lo aplica a una URL que acaba de dar 403.
 *
 * En Vercel cada segmento es una invocación distinta y puede salir por otra IP que la que
 * acuñó el token; el CDN entonces rechaza. La ruta del fichero no cambia, solo la firma, así
 * que basta con trasplantar la query nueva.
 */
async function refreshTarget(target: string, embedUrl: string): Promise<string | null> {
  const fresh = await mintDirect(embedUrl, { fresh: true });
  if (!fresh) return null;
  try {
    const freshQuery = new URL(fresh.url).search;
    if (!freshQuery) return null;
    const retried = new URL(target);
    retried.search = freshQuery;
    return retried.toString();
  } catch {
    return null;
  }
}

/**
 * ¿Este cliente mandará un `Referer` que el CDN vaya a ACEPTAR en las peticiones que haga por su
 * cuenta?
 *
 * Importa porque los segmentos de algunos hosts responden 403 sin él, y no los pedimos nosotros:
 * los pide el reproductor. No hay que adivinarlo ni pedirle que lo declare — la petición que
 * acaba de llegar y las de los segmentos salen de la MISMA página, con la MISMA política de
 * referrer. Si esta trae `Referer` u `Origin`, aquellas también lo llevarán; si la página está
 * en `no-referrer`, ninguna lo llevará y la decisión cae sola al proxy, que es lo correcto. Un
 * VLC o un curl pelado tampoco mandan nada, y también acaban donde deben.
 *
 * Tiene que ser `https`, y esto está medido: el CDN de la familia upns acepta
 * `https://loquesea/` y devuelve 403 con `http://loquesea/` — el mismo host, solo cambia el
 * esquema. Una página servida por http produciría un manifiesto cuyos segmentos no se pueden
 * descargar, así que se la trata como si no mandara Referer y baja a proxy, que sí funciona.
 */
function clientSendsReferer(req: Request): boolean {
  const source = req.headers.referer || req.headers.origin;
  return Boolean(source && /^https:\/\//i.test(source));
}

/**
 * Qué modo pide el cliente con `?mode=`.
 *
 * `auto` (por defecto) elige lo más rápido que funcione en CUALQUIER reproductor, así que un
 * navegador no tiene que declarar nada. `redirect` es la declaración de un cliente nativo:
 * "sé fijar Referer y User-Agent", lo que le abre el 302 también en los hosts que los exigen.
 * `manifest` y `proxy` fuerzan los caminos lentos y existen como escape: si un cliente descubre
 * que el 302 no le reproduce, puede bajar un escalón sin esperar a que cambiemos nada aquí.
 */
function resolveMode(
  requested: string,
  embedUrl: string,
  kind: MintedStream['kind'],
  sendsReferer: boolean
): DirectMode {
  if (requested === 'proxy') return 'proxy';
  // Pedir `manifest` sobre un mp4 no tiene sentido —no hay playlists que servir—, pero tampoco
  // puede degradar a `redirect` a ciegas: en un host que ata por IP eso es un 302 que no
  // reproduce. Se decide como si no lo hubiera pedido.
  if (requested === 'manifest' && kind === 'hls') return 'manifest';
  if (requested === 'redirect') return bestMode(embedUrl, kind, { setsHeaders: true });
  return bestMode(embedUrl, kind, { sendsReferer });
}

/**
 * Entrega la URL del CDN y se aparta.
 *
 * `Referrer-Policy: no-referrer` no es decorativo: la familia upns y varios más aceptan una
 * petición SIN Referer pero devuelven 403 con uno ajeno. Sin esta cabecera, el navegador que
 * siguiera la redirección mandaría el Referer de nuestra propia página y el CDN lo rechazaría.
 */
function sendRedirect(res: Response, url: string): void {
  /**
   * UN 302 A UNA URL SIN FIRMA SÍ SE PUEDE CACHEAR, y es lo que más se nota en los mp4.
   *
   * El `no-store` de siempre está puesto para el caso general: casi todos estos CDN firman la URL
   * y le ponen caducidad, así que compartir el 302 sería darle a otro un enlace que quizá ya no
   * vale. Pero los mp4 que FuegoCine sirve por `1a-1791.com`, `rumble.cloud` o `pixeldrain` NO
   * llevan query ninguna: son direcciones fijas de un fichero.
   *
   * Y ahí el `no-store` costaba caro. Medido en uno de ellos: 2,27 s antes de emitir el 302, casi
   * todos gastados en verificar el destino —una petición al CDN que tarda ~2,8 s en dar el primer
   * byte—, y después el cliente vuelve a pagar ese arranque por su cuenta. El espectador espera
   * dos veces lo mismo.
   *
   * Con la URL fija en el borde, la segunda persona que abre esa película se lleva el 302 en
   * milisegundos. Cinco minutos es margen de sobra para una sesión y poco para que un fichero
   * retirado siga anunciándose.
   */
  const fija = !hasVolatileToken(url);
  res.setHeader('Cache-Control', fija ? 'public, max-age=0, s-maxage=300' : 'no-store');
  if (fija) {
    res.setHeader('CDN-Cache-Control', 'public, s-maxage=300');
    res.setHeader('Vercel-CDN-Cache-Control', 'public, s-maxage=300');
  }
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.redirect(302, url);
}

/**
 * PLAZOS DEL CAMINO DE REPRODUCCIÓN.
 *
 * Los timeouts de dentro son POR PETICIÓN, y acuñar un vídeo son varias encadenadas: se midió un
 * 502 tardando 54 s. Para quien está mirando la pantalla, un "no" rápido vale mucho más que un
 * "no" exacto: con él el reproductor pasa al servidor siguiente en un segundo. Estos topes son
 * para el CAMINO DE FALLO — cuando todo va bien, la respuesta llega mucho antes.
 */
const ACUNADO_MAX_MS = 6000;
const COMPROBACION_MAX_MS = 4000;
const PRIMER_BYTE_MAX_MS = 6000;
/** Tope de TODA la ruta de vídeo directo: pasado esto, el cliente recibe un no y prueba otro. */
const RUTA_MAX_MS = 12000;

/** Tope para una promesa del camino de reproducción; al pasarse se sigue con el respaldo. */
function conPlazo<T>(promesa: Promise<T>, ms: number, respaldo: T): Promise<T> {
  return new Promise<T>(resolve => {
    const reloj = setTimeout(() => resolve(respaldo), ms);
    promesa.then(
      v => { clearTimeout(reloj); resolve(v); },
      () => { clearTimeout(reloj); resolve(respaldo); }
    );
  });
}

// Vídeo directo de un embed: acuña la URL real y la sirve. Es lo que apunta `direct_stream`.
/**
 * LA MISMA RUTA, TAMBIÉN CON EXTENSIÓN EN LA URL.
 *
 * `/api/v1/stream/direct?e=…` no dice en ninguna parte qué es lo que hay al otro lado, y hay
 * reproductores que eligen el descodificador POR LA EXTENSIÓN de la URI antes de pedir nada:
 * ExoPlayer y AVPlayer lo hacen de serie. Para ellos una url sin extensión y con query es un
 * formato desconocido, así que ni lo intentan — y desde fuera se ve como "dice vídeo directo y
 * no reproduce", que es exactamente lo que se reportó con el servidor de FuegoCine de "La
 * sociedad de los poetas muertos". Ese enlace estaba perfecto: comprobado en un navegador,
 * arranca en 3,3 s y da los 7.724 s de duración que dura la película.
 *
 * `/api/v1/stream/direct/v.mp4?e=…` y `/v.m3u8?e=…` hacen EXACTAMENTE lo mismo; el nombre del
 * fichero es decorativo y no se mira. La forma vieja sigue funcionando: nada de lo ya publicado
 * deja de valer.
 */
router.get([DIRECT_BASE, `${DIRECT_BASE}/v.mp4`, `${DIRECT_BASE}/v.m3u8`], async (req: Request, res: Response, next: NextFunction) => {
  /**
   * PLAZO PARA TODA LA RUTA — la red de seguridad que no depende de acertar con cada await.
   *
   * Dentro hay varios pasos con red (acuñar, comprobar el destino, mirar si sirve CORS, arrancar la
   * entrega) y cada uno lleva su propio tope, pero basta con que uno se escape para que el
   * espectador se coma la suma: medido, 54 s la primera vez y 36 s después de acotar dos de ellos.
   * Esto corta por lo sano: si en `RUTA_MAX_MS` no se ha empezado a responder, se contesta 502 y el
   * reproductor pasa al servidor siguiente. Un "no" en 12 s es infinitamente mejor que uno en 36.
   *
   * No aborta el trabajo de dentro —no se puede— pero sí libera al cliente, que es lo que importa;
   * y lo que ese trabajo aprenda queda anotado en el caché de salud para la próxima.
   */
  const plazoRuta = setTimeout(() => {
    if (!res.headersSent) {
      console.warn(`[direct] plazo agotado (${RUTA_MAX_MS} ms): ${String(req.query.e || '').slice(0, 40)}`);
      sendErrorResponse(res, 502, 'DIRECT_UNAVAILABLE', 'El servidor no respondió a tiempo. Prueba otro servidor.');

      /**
       * Y SE ANOTA, QUE ES LO QUE FALTABA. Aquí arriba pone que lo aprendido queda guardado «para
       * la próxima», y es verdad de todo menos del caso que más importa: cuando el host no
       * contesta EN ABSOLUTO no se aprende nada. Ninguna comprobación llega a concluir, el tope
       * de tiempo devuelve «no consta» —que a propósito no condena a nadie— y el servidor sale
       * de aquí exactamente igual de sano que entró. El siguiente espectador repite el fallo.
       *
       * Que un servidor tarde más de RUTA_MAX_MS en dar el primer byte NO es una opinión sobre
       * si el vídeo existe: es que desde aquí no se puede entregar, que es lo único que le
       * importa a quien está mirando una pantalla negra.
       *
       * ESTO ES ADEMÁS EL ÚNICO CONTRAPESO A UN DESAJUSTE DE FONDO: el verificador corre en
       * GitHub y la entrega en Vercel. Un host que sirve a uno y no al otro pasa la verificación
       * con nota y falla en el reproductor — «Borrón y Vida Nueva» estaba sellada hacía SEIS
       * MINUTOS, con un trozo de vídeo descargado de verdad, y su vidnest.io daba 502 aquí. Sin
       * esta anotación no hay forma de que el catálogo se entere nunca, porque quien lo comprueba
       * no es quien lo sirve.
       *
       * El veredicto vive una hora en el caché de salud compartido, así que `revisarServidores` lo
       * ve en la siguiente petición y retira ese servidor; si la ficha se queda sin ninguno, deja
       * de anunciarse. Y se cae solo: al expirar se vuelve a sondear, de modo que un mal rato del
       * host no entierra nada para siempre.
       */
      const embed = decodeEmbedParam(String(req.query.e || ''));
      if (embed) void anotarVeredicto(embed, 'muerto').catch(() => {});
    }
  }, RUTA_MAX_MS);

  try {
    const embedParam = String(req.query.e || '');
    const embedUrl = decodeEmbedParam(embedParam);
    if (!embedUrl) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'El parámetro ?e= (embed en base64url) es requerido');
    }

    // En paralelo: el presupuesto es un viaje a KV que no depende del acuñado, y encadenarlos
    // sumaba su latencia al tiempo hasta el primer fotograma sin ninguna razón.
    //
    // Y CON PLAZO. Acuñar el vídeo son varias peticiones al host y a su CDN, cada una con su
    // timeout (8 s la extracción, 15 s el manifiesto), y encadenadas llegaban a 54 SEGUNDOS
    // medidos antes de contestar un 502 — un minuto de pantalla negra para acabar diciendo que
    // no. Lo que le sirve al reproductor es enterarse RÁPIDO de que este servidor no va, para
    // pasar al siguiente: por eso el fallo tiene su propio tope, mucho más corto que la suma de
    // los timeouts de dentro.
    const [minted, overBudget] = await Promise.all([
      conPlazo(mintDirect(embedUrl), ACUNADO_MAX_MS, null),
      BandwidthService.isOverBudget(),
    ]);
    if (!minted) {
      return sendErrorResponse(res, 502, 'DIRECT_UNAVAILABLE', 'No se pudo extraer un vídeo directo de este servidor.');
    }

    let mode = resolveMode(
      String(req.query.mode || 'auto').toLowerCase(),
      embedUrl,
      minted.kind,
      clientSendsReferer(req)
    );

    // ¿Existe de verdad lo que vamos a entregar? Se pregunta SIEMPRE, sea cual sea el modo.
    //
    // Al principio esto solo cubría `redirect`, con el argumento de que un 302 es irrevocable y
    // los otros modos ya fallarían solos. Es verdad que fallan, pero fallan TARDE y MAL: en
    // `manifest` y `proxy` la API contesta 200 con el maestro y el cliente no descubre que no hay
    // vídeo hasta que pide un segmento, cuando ya ha dado la reproducción por empezada y la
    // cascada al embed no se dispara. Un 502 aquí es lo único que le deja probar otro servidor.
    //
    // Se le pasa el `embedUrl` para que lo que se descubra aquí no se quede aquí: un veredicto
    // que valga para cualquier cliente queda anotado bajo el embed, y la próxima vez que alguien
    // pida la ficha el catálogo ya sabrá que este servidor no puede ir el primero.
    //
    // `entregaLiteral` cambia lo que cuenta como muerto. Con un 302 la respuesta del CDN es
    // EXACTAMENTE lo que va a recibir el reproductor, así que un 403 ahí no admite indulto: verá
    // el mismo 403, y no hay cabecera que lo salve porque a `redirect` solo se llega cuando el
    // host no exige ninguna. En los demás modos se sigue perdonando — esas peticiones las hacemos
    // nosotros, con el Referer bueno, y un 403 aislado puede no repetirse.
    const veredicto = await conPlazo(
      comprobarDestino(minted, { entregaLiteral: mode === 'redirect', embedUrl }),
      COMPROBACION_MAX_MS,
      // Si la comprobación no llega a tiempo NO se condena el servidor: se entrega y que lo diga
      // el reproductor. Condenar por lentitud enterraría CDN lentos que sí sirven vídeo.
      { veredicto: 'desconocido' as const, universal: false }
    );
    if (veredicto.motivo) {
      console.warn(`[direct] ${veredicto.veredicto} (${veredicto.motivo}): ${minted.url.slice(0, 90)}`);
    }
    if (veredicto.veredicto === 'muerto') {
      return sendErrorResponse(res, 502, 'DIRECT_UNAVAILABLE', 'El vídeo ya no existe en este host. Prueba otro servidor directo.');
    }

    /**
     * Un navegador NO PUEDE leer una respuesta sin `Access-Control-Allow-Origin`, así que
     * redirigirle a un host que no la manda es entregarle un vídeo que su reproductor va a
     * bloquear. Pasa de verdad: archive.org sirve sus mp4 sin ninguna cabecera CORS.
     *
     * Se sabe quién es un navegador porque manda `Origin`, y se sabe si el destino trae CORS
     * porque la sonda de `comprobarDestino` acaba de verlo — ninguna de las dos cosas cuesta una
     * petición extra. Un cliente nativo (sin `Origin`) no pasa por CORS y conserva su 302.
     *
     * Solo se degrada con un `false` seguro; si el host no llegó a sondearse, se redirige como
     * siempre. Es el mismo sesgo de toda la verificación: no romper lo que no se ha medido.
     */
    const esNavegador = Boolean(req.headers.origin);
    const sinCors = destinoSirveCors(minted.url) === false;
    // Pedir `?mode=redirect` a mano gana siempre. Un `<video src>` reproduce un mp4 SIN pasar por
    // CORS —solo lo necesita quien lee por fetch/MSE o pone `crossorigin`—, así que un cliente que
    // sabe cómo reproduce puede quedarse el 302 y ahorrarnos el tránsito. Degradarle "por su bien"
    // era gastar ancho de banda del plan en un problema que ese cliente no tiene.
    const pidioRedirect = String(req.query.mode || '').toLowerCase() === 'redirect';
    if (mode === 'redirect' && esNavegador && sinCors && !pidioRedirect) {
      console.warn(`[direct] sin CORS y el cliente es navegador, se proxea: ${minted.url.slice(0, 80)}`);
      mode = 'proxy';
    }

    if (mode === 'redirect') {
      // Alguna calidad viva y otras no: se sirve el maestro filtrado desde aquí (unos KB) en vez
      // del original, que sigue envenenado. El vídeo sigue yendo del CDN al reproductor.
      if (veredicto.filtrado && veredicto.cuerpo) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Referrer-Policy', 'no-referrer');
        applyCachePolicy(res, 'no-store');
        res.send(veredicto.cuerpo);
        void BandwidthService.add(Buffer.byteLength(veredicto.cuerpo));
        return;
      }
      return sendRedirect(res, minted.url);
    }

    // Presupuesto de tránsito agotado: se entrega la URL acuñada y que el cliente lo intente
    // por su cuenta. Puede fallar por la atadura de IP, pero le queda el embed como respaldo.
    // En `manifest` no aplica: lo que se sirve son kilobytes de texto, no vídeo.
    /**
     * DELEGACIÓN AL PROXY EXTERNO. Es lo único que quita el techo de ancho de banda: el modo
     * `proxy` es el que reenvía la película entera, y aquí se le pasa a un Worker de Cloudflare,
     * que no cobra egreso.
     *
     * Se le manda el EMBED, no la URL del CDN, y esa diferencia lo es todo: 793 de las 797
     * reproducciones que obligan a proxear están atadas por IP, así que el proxy tiene que acuñar
     * y descargar él. Pasarle una URL acuñada aquí le habría dado 403 en todas.
     *
     * Va antes del presupuesto a propósito: si el vídeo sale por fuera, no hay presupuesto que
     * gastar.
     */
    if (mode === 'proxy' && externalProxyEnabled()) {
      const externa = proxyUrlFor(embedUrl);
      if (externa) return sendRedirect(res, externa);
    }

    /**
     * PRESUPUESTO AGOTADO. Antes se entregaba la URL acuñada con un 302 y que el cliente lo
     * intentara por su cuenta. Suena razonable y es justo lo que NO funciona, porque el único
     * modo que gasta ancho de banda de verdad es `proxy`, y a `proxy` solo se llega por dos
     * caminos: el CDN ata por IP, o exige cabeceras que el cliente no puede poner. En los dos
     * casos ese 302 es un enlace que el cliente NO va a poder abrir — y como es un 302 y no un
     * error, tampoco dispara la cascada al `embed_url`. O sea: el mecanismo que debía proteger el
     * plan dejaba al usuario sin nada, teniendo el embed al lado y costándonos cero.
     *
     * Ahora se redirige solo si el destino admite de verdad ser redirigido; si no, se devuelve
     * 502 y el cliente reproduce con el embed, que no gasta plan porque lo sirve el host.
     */
    if (overBudget && mode !== 'manifest') {
      if (!policyFor(embedUrl).ipBound) return sendRedirect(res, minted.url);
      return sendErrorResponse(res, 502, 'DIRECT_UNAVAILABLE', 'Presupuesto de tránsito agotado este mes. Prueba otro servidor directo.');
    }

    // En `manifest` solo viajan por aquí las playlists; los segmentos van del CDN al reproductor.
    const rewriteMode: RewriteMode = mode === 'manifest' ? 'manifest' : 'proxy';
    /**
     * El MANIFIESTO sí se puede cachear en el borde unos segundos; el 302 de `redirect` no.
     *
     * La diferencia es que un 302 lleva una URL acuñada para esta reproducción y compartirla
     * sería servirle a otro un enlace que quizá no le vale. El manifiesto reescrito, en cambio,
     * es idéntico para todo el que vea lo mismo: sus URIs apuntan a ESTA API, sin nada personal
     * dentro. Y si las URLs firmadas que lleva por debajo caducan, `/seg` las vuelve a acuñar.
     *
     * Treinta segundos, que es poco para el riesgo y mucho para el efecto: el arranque de un
     * vídeo pasa de ~0,5 s a lo que tarde el borde más cercano. Es lo que más se nota al pulsar
     * Play, porque es el primer viaje de los tres.
     */
    const MANIFIESTO_EN_BORDE = 'public, max-age=0, s-maxage=30, stale-while-revalidate=60';
    const serve = (m: MintedStream, cuerpo?: string) => attempt(() => m.kind === 'hls'
      ? serveManifest(res, m.url, m.referer, embedParam, MANIFIESTO_EN_BORDE, rewriteMode, cuerpo)
      : pipeUpstream(req, res, m.url, m.referer, embedParam, 'no-store', rewriteMode));

    const failed = await serve(minted, veredicto.cuerpo);
    if (failed === null) return;

    // El token cacheado ya no vale: se fuerza uno nuevo y se reintenta UNA vez.
    const retry = await mintDirect(embedUrl, { fresh: true });
    if (!retry || (await serve(retry)) !== null) {
      return sendErrorResponse(res, 502, 'DIRECT_UNAVAILABLE', 'El servidor de vídeo rechazó la petición. Prueba otro servidor directo.');
    }
  } catch (err) {
    next(err);
  } finally {
    clearTimeout(plazoRuta);
  }
});

// Segmentos y variantes del manifiesto reescrito. En modo `manifest` (`&m=manifest`) solo llegan
// aquí las variantes y las claves: los segmentos los pide el reproductor directamente al CDN.
router.get(`${DIRECT_BASE}/seg`, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const embedParam = String(req.query.e || '');
    const target = decodeEmbedParam(String(req.query.u || ''));
    const embedUrl = decodeEmbedParam(embedParam);
    if (!target) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'El parámetro ?u= (URL en base64url) es requerido');
    }

    let referer = '';
    try {
      referer = embedUrl ? `${new URL(embedUrl).origin}/` : `${new URL(target).origin}/`;
    } catch {}

    // El modo viaja en la URL que fabricó `rewriteManifest`: una variante que se pide por aquí
    // tiene que reescribir sus segmentos con el mismo criterio que su padre. Sin esto, el
    // manifiesto de segundo nivel volvería a envolverlo todo y se perdería el ahorro entero.
    const rewriteMode: RewriteMode = req.query.m === 'manifest' ? 'manifest' : 'proxy';

    const cacheControl = cachePolicyFor(req, true);
    const serve = (url: string) => attempt(() => isManifest(url)
      ? serveManifest(res, url, referer, embedParam, cacheControl, rewriteMode)
      : pipeUpstream(req, res, url, referer, embedParam, cacheControl, rewriteMode));

    const failed = await serve(target);
    if (failed === null) return;

    // 403/410 a mitad de reproducción = token caducado o cambio de IP entre invocaciones.
    if ((failed === 403 || failed === 410) && embedUrl) {
      const refreshed = await refreshTarget(target, embedUrl);
      if (refreshed && (await serve(refreshed)) === null) return;
    }
    return sendErrorResponse(res, 502, 'DIRECT_UNAVAILABLE', 'El servidor de vídeo rechazó el segmento. Prueba otro servidor directo.');
  } catch (err) {
    next(err);
  }
});

// Reportar Enlace Roto
router.post('/api/v1/links/report', (req: Request, res: Response) => {
  const { link_id } = req.body;
  res.json({
    status: 'success',
    message: `Enlace ${link_id || 'solicitado'} reportado con éxito. Se ha marcado para verificación.`
  });
});

/*
 * Telemetria de reproduccion.
 *
 * ESTE ENDPOINT NO EXISTIA. La app lleva tiempo llamando a `POST /api/v1/report` —lo hace
 * `PlaybackReporter` al agotar todas las fuentes de un titulo— y recibiendo un 404, que se traga
 * en silencio para no molestar a quien esta viendo la pelicula. O sea que el unico aviso
 * automatico del proyecto no llegaba a ninguna parte, y no habia forma de enterarse.
 *
 * Se acepta la forma vieja (`channel_id` + `reason`) y la nueva con las medidas, porque hay
 * versiones de la app instaladas que solo saben mandar la primera.
 *
 * Devuelve 200 pase lo que pase, incluida la tabla sin crear: esto es telemetria, y ningun fallo
 * al anotarla puede convertirse en un error que vea el espectador.
 */
router.post(['/api/v1/report', '/api/v1/playback/report'], async (req: Request, res: Response) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;

    const numero = (v: unknown): number | null => {
      const n = typeof v === 'string' ? Number(v) : v;
      return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null;
    };
    const texto = (v: unknown): string | null => {
      const t = typeof v === 'string' ? v.trim() : '';
      return t ? t.slice(0, 200) : null;
    };

    const evento = {
      item_id: texto(b.item_id) ?? texto(b.channel_id),
      episode_id: texto(b.episode_id),
      server_host: texto(b.server_host),
      delivery_mode: texto(b.mode),
      outcome: texto(b.outcome) ?? texto(b.reason) ?? 'unknown',
      ttff_ms: numero(b.ttff_ms),
      stalls: numero(b.stalls),
      stalled_ms: numero(b.stalled_ms),
      failovers: numero(b.failovers),
      avg_height: numero(b.avg_height),
      app_version: texto(b.app_version),
    };

    // Se registra siempre, tabla o no: en los registros de Vercel se puede buscar y agrupar, y
    // eso ya es infinitamente mas de lo que habia.
    console.log('[playback]', JSON.stringify(evento));

    /**
     * Y ADEMAS SE ACTUA. Esto era solo un archivo.
     *
     * `outcome: 'failed'` no es un fallo cualquiera: la app lo manda cuando ha agotado TODAS las
     * fuentes que le dimos —es el «Se probaron todas las fuentes de este contenido» que ve el
     * espectador—. O sea que un reproductor de verdad, en un aparato de verdad, acaba de demostrar
     * que lo que entregamos no se ve. No hay senal mas fiable que esa en todo el proyecto, y se
     * estaba guardando en una tabla para no volver a mirarla.
     *
     * Lo que se hace es RETIRAR LA FICHA DEL CACHE, no marcarla como muerta. La diferencia importa:
     * un aviso viene de un aparato, y una wifi que se cae no puede esconder una pelicula para todos.
     * Sin cache, la siguiente apertura no puede salir por el camino barato —que es justo el que
     * volveria a entregar la misma lista muerta, y por eso el error se repetia despues de haberla
     * visto bien— y tiene que resolver de cero: sondear, y con lo que mida, decidir. Si de verdad
     * no queda nada, ahi es donde se escribe el veredicto y el titulo sale de los listados; si era
     * cosa del aparato, la sonda lo demuestra y no se esconde nada.
     *
     * Sin `await`: esto es telemetria y no puede retrasar ni un milisegundo lo que ve nadie.
     */
    if (evento.outcome.startsWith('failed') || evento.outcome.startsWith('playback_failed')) {
      if (evento.item_id) {
        void CatalogService.invalidateItem({ id: evento.item_id }).catch(() => {});
      }
    }

    const { error } = await getSupabaseAdmin().from('playback_events').insert(evento);

    // 42P01 es «la tabla no existe». Se distingue a proposito: significa que falta pegar la
    // migracion, no que el aviso venga mal, y confundirlas mandaria a buscar el fallo en la app.
    if (error && error.code !== '42P01') {
      console.warn('[playback] no se pudo anotar:', error.message);
    }

    res.json({ status: 'success' });
  } catch (err) {
    console.warn('[playback] aviso descartado:', err instanceof Error ? err.message : err);
    res.json({ status: 'success' });
  }
});

export default router;
