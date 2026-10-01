import { Router, Request, Response, NextFunction } from 'express';
import { resolverNuvePlus, elegirStream } from '../scrapers/nuveplus';
import { sendErrorResponse } from '../utils/apiHelpers';

/**
 * ADDONS DE STREMIO — la ruta ESTABLE que se entrega como `direct_stream` y resuelve al pulsar Play.
 *
 *   GET /api/v1/addon/nuveplus/:imdb                 → película
 *   GET /api/v1/addon/nuveplus/:imdb/:temporada/:cap → capítulo
 *
 * Contesta 302 a la url de `play` del addon, que a su vez hace 302 a su CDN (MKV con Range). Se pide
 * fresca en cada reproducción porque lleva un token que el addon acuña en cada consulta, y la lista
 * de servidores se cachea: entregar el token en la lista era entregar algo con fecha de caducidad
 * desconocida. Siempre 302, nunca proxy: reenviar un MKV de 1 GB por Vercel es lo que no escala.
 *
 * Addon Latam NO tiene ruta aquí: entrega `http://` de paneles IPTV, y la app Android ni permite
 * tráfico en claro ni sigue un 302 de https a http. Ver src/scrapers/addonlatam.ts.
 */
const router = Router();

router.get(['/api/v1/addon/nuveplus/:imdb', '/api/v1/addon/nuveplus/:imdb/:temporada/:capitulo'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const imdb = String(req.params.imdb || '');
      const temporada = Number(req.params.temporada) || undefined;
      const capitulo = Number(req.params.capitulo) || undefined;
      if (!/^tt\d+$/.test(imdb)) return sendErrorResponse(res, 400, 'BAD_REQUEST', 'IMDB id inválido.');

      const streams = await resolverNuvePlus(imdb, temporada && capitulo ? 'series' : 'movie', temporada, capitulo);
      const elegido = elegirStream(streams);
      if (!elegido) return sendErrorResponse(res, 404, 'NOT_FOUND', 'Nuve+ no tiene este título en latino.');

      res.setHeader('Cache-Control', 'no-store'); // el token es de esta reproducción
      res.setHeader('Referrer-Policy', 'unsafe-url');
      return res.redirect(302, elegido.url);
    } catch (err) { next(err); }
  });

export default router;
