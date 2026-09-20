import { Router, Request, Response, NextFunction } from 'express';
import {
  pelicula,
  episodio,
  consultarPelicula,
  FuenteNetmirror,
  buscarNetmirrorId,
  masterHls,
  normalizarNetmirrorOtt,
} from '../scrapers/netmirror';
import { sendErrorResponse } from '../utils/apiHelpers';
import { puedeAbrirse } from '../services/arranqueMp4';

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
const NEWTV_API = 'https://tv.imgcdn.kim';

/**
 * Sesion oficial de NewTV para el cliente Android.
 *
 * El `usertoken` no es el token efimero de una URL HLS: NewTV lo usa para emitir, desde la IP
 * del propio televisor, el master completo y firmado de cada titulo. Mantenerlo en una variable
 * de produccion permite renovarlo sin publicar otro APK. Nunca se cachea en navegador ni CDN.
 */
router.get('/api/v1/netmirror/session', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  const userToken = String(process.env.NETMIRROR_USER_TOKEN || '').trim();
  if (!userToken) {
    return sendErrorResponse(res, 503, 'NETMIRROR_SESSION_UNAVAILABLE', 'La sesion de NetMirror no esta configurada.');
  }
  return res.json({
    status: 'success',
    data: { api_url: NEWTV_API, ott: 'nf', user_token: userToken },
  });
});

/**
 * Puente de inventario para los barridos. NetMirror bloquea las IP de GitHub Actions, pero sí
 * atiende a producción; sólo se devuelven ids y metadata pública del master, nunca credenciales.
 */
router.get('/api/v1/netmirror/newtv/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const titulo = String(req.query.title || '').trim();
    if (!titulo) return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'Falta `title`.');
    const id = await buscarNetmirrorId(
      titulo,
      String(req.query.year || ''),
      String(req.query.original || ''),
      String(req.query.english || ''),
      normalizarNetmirrorOtt(req.query.ott),
    );
    if (!id) return sendErrorResponse(res, 404, 'NOT_FOUND', 'Sin coincidencia en esta plataforma.');
    return res.json({ status: 'success', data: { id } });
  } catch (err) { next(err); }
});

router.get('/api/v1/netmirror/newtv/master', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!/^[A-Za-z0-9_-]{5,}$/.test(id)) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'Falta `id` válido.');
    }
    const master = await masterHls(id, '', normalizarNetmirrorOtt(req.query.ott));
    if (!master) return sendErrorResponse(res, 404, 'NOT_FOUND', 'Master multipista no disponible.');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.json({ status: 'success', data: master });
  } catch (err) { next(err); }
});

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

/**
 * La sonda dice TRES cosas, no dos: 200 con la fuente, 404 si NetMirror contestó que no la tiene,
 * y 502 si NetMirror no contestó. `scripts/importarNetmirror.ts` la usa desde GitHub —cuya IP
 * NetMirror no atiende— y apunta los 404 como «no» durante dos semanas; un 502 no se apunta.
 * Solo para películas: la de capítulos sigue por `resolver`, que colapsa las dos cosas.
 */
router.get('/api/v1/netmirror/probe/:tmdbId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tmdbId = Number(req.params.tmdbId);
    if (String(req.query.type || 'movie') === 'movie' && Number.isFinite(tmdbId) && tmdbId > 0) {
      const c = await consultarPelicula(tmdbId);
      if (c.estado === 'sin-respuesta') return sendErrorResponse(res, 502, 'UPSTREAM_ERROR', `NetMirror no contesta: ${c.detalle}`);
      if (c.estado === 'no') return sendErrorResponse(res, 404, 'NOT_FOUND', 'NetMirror no tiene este titulo.');
      /**
       * Con `?arranque=1` se comprueba ADEMÁS que el mp4 abre —la misma prueba del verificador,
       * con la cabecera Referer de la CDN— y se devuelve el veredicto junto a la fuente. Hace
       * falta porque la CDN tampoco atiende a los runners de GitHub: el importador no puede
       * probarlo desde allí, y desde aquí sí. Presupuesto corto para no rozar el techo de la
       * función; agotarlo da `sinVeredicto`, que el importador no apunta.
       */
      if (req.query.arranque === '1') {
        const t0 = Date.now();
        const arranque = await puedeAbrirse(c.fuente.mp4, { Referer: c.fuente.referer, 'User-Agent': UA }, 7_000);
        return res.json({ status: 'success', data: c.fuente, arranque: { ...arranque, ms: Date.now() - t0 } });
      }
      return res.json({ status: 'success', data: c.fuente });
    }
    const r = await resolver(req);
    if (!r) return sendErrorResponse(res, 404, 'NOT_FOUND', 'NetMirror no tiene este titulo.');
    res.json({ status: 'success', data: r });
  } catch (err) { next(err); }
});

router.get('/api/v1/netmirror/stream/:tmdbId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await resolver(req);
    if (!r) return sendErrorResponse(res, 404, 'NOT_FOUND', 'NetMirror no tiene este titulo.');

    // Modo redirect: 302 al mp4. Pensado para clientes que pueden fijar Referer y lo propagan
    // al seguir la redireccion (Android Media3 con DefaultHttpDataSource, VLC, curl con -L).
    // Sin este modo el proxy bombea todos los bytes por el Worker, que en gru1 esta lejos del
    // CDN de hakunaymatata; medido: Spider-Man y Kung Fu Panda tardaban 5-10s en cargar.
    if (req.query.mode === 'redirect') {
      res.setHeader('Referrer-Policy', 'unsafe-url'); // que el cliente vea el destino
      return res.redirect(302, r.mp4);
    }

    // Modo proxy (defecto): el Worker inyecta Referer, para navegadores y clientes sin headers.
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
