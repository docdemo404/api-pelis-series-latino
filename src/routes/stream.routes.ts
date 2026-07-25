import { Router, Request, Response, NextFunction } from 'express';
import { ResolverService } from '../services/resolverService';
import { BandwidthService } from '../services/bandwidthService';
import { mintDirect, MintedStream } from '../services/directResolver';
import { decodeEmbedParam } from '../scrapers/directStream';
import { bestMode } from '../scrapers/hostPolicy';
import { DirectMode } from '../types';
import { sendErrorResponse } from '../utils/apiHelpers';
import { USER_AGENT, streamClient } from '../utils/httpClient';

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
 * Qué caché merece esta respuesta.
 *
 * Un segmento es contenido inmutable: su URL firmada va entera dentro de `?u=`, así que dos
 * espectadores de lo mismo comparten respuesta y rebobinar deja de golpear al CDN. Con Range de
 * por medio NO se cachea: la respuesta es un tramo concreto y servirla a quien pida otro daría
 * bytes equivocados.
 */
function cachePolicyFor(req: Request, isSegment: boolean): string {
  if (!isSegment || req.headers.range) return 'no-store';
  return 'public, max-age=300, s-maxage=600';
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

/** Sirve un manifiesto ya reescrito. Devuelve el status de fallo, o null si fue bien. */
async function serveManifest(
  res: Response,
  manifestUrl: string,
  referer: string,
  embedParam: string,
  cacheControl = 'no-store',
  mode: RewriteMode = 'proxy'
): Promise<number | null> {
  const upstream = await streamClient.get(manifestUrl, {
    headers: { Referer: referer },
    responseType: 'text',
    timeout: 15000,
    validateStatus: () => true
  });
  if (upstream.status >= 400) return upstream.status;

  const body = rewriteManifest(String(upstream.data), manifestUrl, embedParam, mode);
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
  if (requested === 'manifest') return kind === 'hls' ? 'manifest' : 'redirect';
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

    const mode = resolveMode(
      String(req.query.mode || 'auto').toLowerCase(),
      embedUrl,
      minted.kind,
      clientSendsReferer(req)
    );

    // El camino normal: el CDN del host sirve el vídeo y nosotros no tocamos un byte.
    if (mode === 'redirect') return sendRedirect(res, minted.url);

    // Presupuesto de tránsito agotado: se entrega la URL acuñada y que el cliente lo intente
    // por su cuenta. Puede fallar por la atadura de IP, pero le queda el embed como respaldo.
    // En `manifest` no aplica: lo que se sirve son kilobytes de texto, no vídeo.
    if (overBudget && mode !== 'manifest') return sendRedirect(res, minted.url);

    // En `manifest` solo viajan por aquí las playlists; los segmentos van del CDN al reproductor.
    const rewriteMode: RewriteMode = mode === 'manifest' ? 'manifest' : 'proxy';
    const serve = (m: MintedStream) => m.kind === 'hls'
      ? serveManifest(res, m.url, m.referer, embedParam, 'no-store', rewriteMode)
      : pipeUpstream(req, res, m.url, m.referer, embedParam, 'no-store', rewriteMode);

    const failed = await serve(minted);
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
    const serve = (url: string) => isManifest(url)
      ? serveManifest(res, url, referer, embedParam, cacheControl, rewriteMode)
      : pipeUpstream(req, res, url, referer, embedParam, cacheControl, rewriteMode);

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
