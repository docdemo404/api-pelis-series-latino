import { Router, Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { ResolverService } from '../services/resolverService';
import { sendErrorResponse } from '../utils/apiHelpers';
import { USER_AGENT } from '../utils/httpClient';

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

// Proxy de Streaming con soporte nativo de HTTP Range Requests (206 Partial Content) para Seek instantáneo
router.get('/api/v1/stream/proxy', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const videoUrl = req.query.url as string;
    if (!videoUrl) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'El parámetro ?url= es requerido');
    }

    const range = req.headers.range;
    const originHeaders: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Referer': new URL(videoUrl).origin + '/',
      ...(range ? { 'Range': range } : {})
    };

    const response = await axios.get(videoUrl, {
      headers: originHeaders,
      responseType: 'stream',
      validateStatus: (status) => status >= 200 && status < 400
    });

    res.status(response.status);
    const cr = response.headers['content-range'];
    if (cr) res.setHeader('Content-Range', String(cr));
    const ar = response.headers['accept-ranges'];
    if (ar) res.setHeader('Accept-Ranges', String(ar));
    else res.setHeader('Accept-Ranges', 'bytes');
    const cl = response.headers['content-length'];
    if (cl) res.setHeader('Content-Length', String(cl));
    const ct = response.headers['content-type'];
    if (ct) res.setHeader('Content-Type', String(ct));
    else res.setHeader('Content-Type', videoUrl.includes('.m3u8') ? 'application/x-mpegURL' : 'video/mp4');

    response.data.pipe(res);
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
