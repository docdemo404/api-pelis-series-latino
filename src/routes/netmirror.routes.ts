import { Router, Request, Response, NextFunction } from 'express';
import { pelicula, episodio, FuenteNetmirror } from '../scrapers/netmirror';
import { sendErrorResponse } from '../utils/apiHelpers';

/**
 * NetMirror — endpoints por tmdb id.
 *
 *   GET /api/v1/netmirror/probe/:tmdbId[?type=tv&s=1&e=1]
 *     JSON con la URL mp4 firmada tal como la devuelve net27.cc, mas la cabecera
 *     Referer requerida. Util para depurar y para clientes que sepan mandar el
 *     Referer por su cuenta (Media3 con DefaultHttpDataSource.Factory).
 *
 *   GET /api/v1/netmirror/stream/:tmdbId[?type=tv&s=1&e=1]
 *     Proxy real: pide el mp4 a la CDN con el Referer inyectado y reenvia los
 *     bytes al cliente. Consume ancho de banda propio.  Existe porque un 302
 *     directo NO funciona: la CDN valida Referer y el cliente no puede ponerlo
 *     por si mismo (los navegadores no permiten forzar Referer arbitrario).
 *     Los clientes que si puedan (nuestra app Android) deberian usar /probe.
 */
const router = Router();

const REFERER_MP4 = 'https://videodownloader.site/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function resolver(req: Request): Promise<FuenteNetmirror | null> {
  const tmdbId = Number(req.params.tmdbId);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return null;
  const tipo = String(req.query.type || 'movie');
  if (tipo === 'tv') {
    const s = Number(req.query.s || 0);
    const e = Number(req.query.e || 0);
    if (!Number.isFinite(s) || !Number.isFinite(e) || s <= 0 || e <= 0) return null;
    return episodio(tmdbId, s, e);
  }
  return pelicula(tmdbId);
}

router.get('/api/v1/netmirror/probe/:tmdbId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await resolver(req);
    if (!r) return sendErrorResponse(res, 404, 'NOT_FOUND', 'NetMirror no tiene este titulo.');
    res.json({ status: 'success', data: r });
  } catch (err) { next(err); }
});

router.get('/api/v1/netmirror/stream/:tmdbId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await resolver(req);
    if (!r) return sendErrorResponse(res, 404, 'NOT_FOUND', 'NetMirror no tiene este titulo.');

    const upstream = await fetch(r.mp4, {
      headers: {
        'User-Agent': UA,
        'Referer': REFERER_MP4,
        // Pasar el Range del cliente para que el CDN devuelva 206 parcial.
        ...(req.headers.range ? { Range: String(req.headers.range) } : {}),
      },
    });

    // Reenviar cabeceras que le importan al reproductor.
    const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'last-modified', 'etag'];
    for (const h of passthrough) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.status(upstream.status);

    if (!upstream.body) { res.end(); return; }
    const nodeStream = require('stream').Readable.fromWeb(upstream.body as any);
    nodeStream.pipe(res);
  } catch (err) { next(err); }
});

export default router;
