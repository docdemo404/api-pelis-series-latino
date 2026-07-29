import { Router, Request, Response, NextFunction } from 'express';
import { ResolverService } from '../services/resolverService';
import { BandwidthService } from '../services/bandwidthService';
import { mintDirect, MintedStream } from '../services/directResolver';
import { decodeEmbedParam } from '../scrapers/directStream';
import { bestMode, policyFor } from '../scrapers/hostPolicy';
import { DirectMode } from '../types';
import { sendErrorResponse } from '../utils/apiHelpers';
import { USER_AGENT, streamClient } from '../utils/httpClient';
import { bajarManifiesto, revisarManifiesto, hostAlcanzable, segmentoDescargable, destinoSirveCors } from '../services/manifestHealth';
import { CacheStore } from '../cache/store';
import { externalProxyEnabled, proxyUrlFor } from '../utils/externalProxy';

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
    const upstream = await streamClient.get(manifestUrl, {
      headers: { Referer: referer },
      responseType: 'text',
      timeout: 15000,
      validateStatus: () => true
    });
    if (upstream.status >= 400) return upstream.status;
    crudo = String(upstream.data);
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
  const upstream = await streamClient.get(target, {
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
  });

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

  res.status(upstream.status);
  const passthrough = ['content-range', 'content-length', 'content-type', 'accept-ranges'];
  for (const header of passthrough) {
    const value = upstream.headers[header];
    if (value) res.setHeader(header, String(value));
  }
  if (!upstream.headers['accept-ranges']) res.setHeader('Accept-Ranges', 'bytes');
  if (!upstream.headers['content-type']) {
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

  upstream.data.pipe(res);
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
 * Cuánto se recuerda el veredicto de un destino. La clave es la URL FIRMADA del CDN, así que
 * identifica un vídeo concreto; y lo que se comprueba —que el dominio exista— no cambia de un
 * minuto para otro.
 */
const VEREDICTO_TTL_SECONDS = 10 * 60;

type Veredicto =
  /**
   * `cuerpo` es el maestro YA DESCARGADO, para que quien lo sirva no vuelva a pedirlo. Viene
   * vacío cuando el veredicto salió del caché o cuando no había manifiesto que bajar (mp4).
   * `filtrado` avisa de que se le han quitado calidades muertas: entonces hay que servir ese
   * cuerpo y no se puede redirigir al original, que sigue envenenado.
   */
  | { kind: 'vivo'; cuerpo?: string; filtrado?: boolean }
  | { kind: 'muerto' };

/**
 * ¿Se puede entregar esta URL con un 302 y olvidarse?
 *
 * Existe porque un 302 es un billete sin vuelta: en cuanto sale, el reproductor queda a solas con
 * el CDN y ningún fallo suyo puede ya convertirse en el 502 que haría al cliente probar otro
 * servidor. Y lo que se ha medido es que el maestro RESPONDE aunque el vídeo no esté: emturbovid
 * reparte sus calidades entre dominios desechables que caducan (19 de 25 fichas no reproducían,
 * 16 por dominios en NXDOMAIN). Ver src/services/manifestHealth.ts.
 *
 * Para un mp4 basta con mirar su host: no hay manifiesto que abrir y la comprobación es DNS puro,
 * sin ninguna petición HTTP. Para HLS hay que bajar el maestro —unos KB— y mirar a dónde apunta.
 *
 * Ante cualquier duda se contesta `vivo`: si el maestro no se deja bajar puede ser un CDN lento o
 * una cabecera que solo el reproductor sabe poner, y en ese caso el 302 es justamente lo que hay
 * que intentar. Solo se corta con la certeza de un dominio que no existe.
 */
async function comprobarDestino(minted: MintedStream, mode: DirectMode): Promise<Veredicto> {
  const cacheKey = `verdict:${minted.url}`;
  const cacheado = await CacheStore.get<Veredicto>(cacheKey);
  if (cacheado) return cacheado;

  /**
   * PRESUPUESTO DE TIEMPO, y está aquí por un destrozo propio: al añadir la comprobación del
   * segmento, los hosts lentos (ok.ru, los blogspot con pixeldrain) dejaron de responder — la
   * petición a la PROPIA API se comía 45 s y expiraba. Se había cambiado "entrega vídeo roto" por
   * "no entrega nada", que es peor.
   *
   * Así que la verificación tiene un tope y falla A FAVOR del vídeo: si no le da tiempo a
   * demostrar que algo está muerto, se entrega igual. Comprobar es un extra, no un peaje —
   * ninguna reproducción puede morir esperando a que terminemos de comprobarla.
   */
  const limite = Date.now() + 3500;
  const hayTiempo = () => Date.now() < limite;

  // Se cachea el VEREDICTO, nunca el cuerpo: guardar manifiestos enteros en KV no compensa, y
  // además el cuerpo solo sirve para ahorrarse una descarga dentro de esta misma petición.
  const guardar = async (v: Veredicto): Promise<Veredicto> => {
    await CacheStore.set(cacheKey, v.kind === 'muerto' ? v : { kind: 'vivo' }, VEREDICTO_TTL_SECONDS);
    return v;
  };

  // El destino de primer nivel. Si ni siquiera se puede conectar con él, no hay nada que bajar
  // ni que redirigir. Para un mp4 esto es toda la comprobación: no hay manifiesto que abrir.
  //
  // `entregaLiteral` cambia lo que cuenta como muerto. Con un 302 la respuesta del CDN es
  // EXACTAMENTE lo que va a recibir el reproductor, así que un 403 ahí no admite indulto: verá el
  // mismo 403, y no hay cabecera que lo salve porque a `redirect` solo se llega cuando el host no
  // exige ninguna. En los demás modos se sigue perdonando — esas peticiones las hacemos nosotros,
  // con el Referer bueno, y un 403 aislado puede no repetirse.
  const entregaLiteral = mode === 'redirect';
  if (!(await hostAlcanzable(minted.url, minted.referer, false, entregaLiteral))) {
    return guardar({ kind: 'muerto' });
  }

  if (minted.kind !== 'hls') return guardar({ kind: 'vivo' });

  const manifiesto = await bajarManifiesto(minted.url, minted.referer);
  if (!manifiesto) return { kind: 'vivo' };

  // Un maestro sin una sola URI no es un vídeo: no hay nada que reproducir en él.
  if (!manifiesto.split(/\r?\n/).some(l => l.trim() && !l.trim().startsWith('#'))) {
    console.warn(`[direct] manifiesto sin contenido: ${minted.url.slice(0, 90)}`);
    return guardar({ kind: 'muerto' });
  }

  if (!hayTiempo()) return { kind: 'vivo', cuerpo: manifiesto };

  const estado = await revisarManifiesto(manifiesto, minted.url, minted.referer);
  if (estado.muerto) {
    console.warn(`[direct] destino muerto (${estado.muertos.join(', ')}): ${minted.url.slice(0, 90)}`);
    return guardar({ kind: 'muerto' });
  }
  // Y la prueba de fuego: que un segmento de verdad se deje descargar. Sin esto se cuela el
  // fallo más común —playlist impecable, segmentos en 404— que además es el que peor llega al
  // cliente: la API dice 200, el reproductor arranca y se cae cuando ya nadie prueba otra cosa.
  if (hayTiempo() && !(await segmentoDescargable(estado.cuerpo, minted.url, minted.referer))) {
    console.warn(`[direct] segmentos no descargables: ${minted.url.slice(0, 90)}`);
    return guardar({ kind: 'muerto' });
  }

  if (estado.parcial) {
    console.warn(`[direct] calidades caídas (${estado.muertos.join(', ')}): ${minted.url.slice(0, 90)}`);
    return { kind: 'vivo', cuerpo: estado.cuerpo, filtrado: true };
  }
  return guardar({ kind: 'vivo', cuerpo: manifiesto });
}

/**
 * Entrega la URL del CDN y se aparta.
 *
 * `Referrer-Policy: no-referrer` no es decorativo: la familia upns y varios más aceptan una
 * petición SIN Referer pero devuelven 403 con uno ajeno. Sin esta cabecera, el navegador que
 * siguiera la redirección mandaría el Referer de nuestra propia página y el CDN lo rechazaría.
 */
function sendRedirect(res: Response, url: string): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.redirect(302, url);
}

// Vídeo directo de un embed: acuña la URL real y la sirve. Es lo que apunta `direct_stream`.
router.get(DIRECT_BASE, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const embedParam = String(req.query.e || '');
    const embedUrl = decodeEmbedParam(embedParam);
    if (!embedUrl) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'El parámetro ?e= (embed en base64url) es requerido');
    }

    // En paralelo: el presupuesto es un viaje a KV que no depende del acuñado, y encadenarlos
    // sumaba su latencia al tiempo hasta el primer fotograma sin ninguna razón.
    const [minted, overBudget] = await Promise.all([
      mintDirect(embedUrl),
      BandwidthService.isOverBudget(),
    ]);
    if (!minted) {
      return sendErrorResponse(res, 502, 'DIRECT_UNAVAILABLE', 'No se pudo extraer el vídeo de este embed. Reproduce con embed_url.');
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
    const veredicto = await comprobarDestino(minted, mode);
    if (veredicto.kind === 'muerto') {
      return sendErrorResponse(res, 502, 'DIRECT_UNAVAILABLE', 'El vídeo ya no existe en este host. Reproduce con embed_url u otro servidor.');
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
      return sendErrorResponse(res, 502, 'DIRECT_UNAVAILABLE', 'Presupuesto de tránsito agotado este mes. Reproduce con embed_url.');
    }

    // En `manifest` solo viajan por aquí las playlists; los segmentos van del CDN al reproductor.
    const rewriteMode: RewriteMode = mode === 'manifest' ? 'manifest' : 'proxy';
    const serve = (m: MintedStream, cuerpo?: string) => attempt(() => m.kind === 'hls'
      ? serveManifest(res, m.url, m.referer, embedParam, 'no-store', rewriteMode, cuerpo)
      : pipeUpstream(req, res, m.url, m.referer, embedParam, 'no-store', rewriteMode));

    const failed = await serve(minted, veredicto.cuerpo);
    if (failed === null) return;

    // El token cacheado ya no vale: se fuerza uno nuevo y se reintenta UNA vez.
    const retry = await mintDirect(embedUrl, { fresh: true });
    if (!retry || (await serve(retry)) !== null) {
      return sendErrorResponse(res, 502, 'DIRECT_UNAVAILABLE', 'El servidor de vídeo rechazó la petición. Reproduce con embed_url.');
    }
  } catch (err) {
    next(err);
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
    return sendErrorResponse(res, 502, 'DIRECT_UNAVAILABLE', 'El servidor de vídeo rechazó el segmento. Reproduce con embed_url.');
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

export default router;
