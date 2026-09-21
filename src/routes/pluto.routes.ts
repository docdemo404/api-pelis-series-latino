import { Router, Request, Response, NextFunction } from 'express';
import { sendErrorResponse } from '../utils/apiHelpers';
import { InformePlutoInvalido, estadoPluto, recibirAudiosPluto, recibirCatalogoPluto } from '../services/plutoMovil';

/**
 * Pluto TV — lo que el móvil ve desde su red. Ver src/scrapers/pluto.ts.
 *
 *   POST /api/v1/pluto/catalogo   { device_id, pais, items: [{id,nombre,anio,minutos,directores}] }
 *     Un lote (≤400) del catálogo de películas. Devuelve `audios_pendientes`: los ids del lote a
 *     los que el móvil tiene que mirarles el audio. Lotes porque `express.json` corta en 100 kB.
 *
 *   POST /api/v1/pluto/audios     { device_id, items: [{id, audios: ['es','en']}] }
 *
 *   GET  /api/v1/pluto/estado
 */
const router = Router();

const invalido = (res: Response) => sendErrorResponse(res, 400, 'REPORT_INVALID', 'Informe invalido.');

router.post('/api/v1/pluto/catalogo', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.json({ status: 'success', data: await recibirCatalogoPluto(req.body || {}) });
  } catch (err) {
    if (err instanceof InformePlutoInvalido) return invalido(res);
    next(err);
  }
});

router.post('/api/v1/pluto/audios', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.json({ status: 'success', data: await recibirAudiosPluto(req.body || {}) });
  } catch (err) {
    if (err instanceof InformePlutoInvalido) return invalido(res);
    next(err);
  }
});

router.get('/api/v1/pluto/estado', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.json({ status: 'success', data: await estadoPluto() });
  } catch (err) { next(err); }
});

export default router;
