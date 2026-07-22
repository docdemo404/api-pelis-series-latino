import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import { SourceManager } from '../services/sourceManager';
import { TmdbService } from '../services/tmdbService';
import { OverrideService } from '../services/overrideService';
import { sendErrorResponse } from '../utils/apiHelpers';

/**
 * Panel de administración: página estática + API de fuentes y overrides.
 * La UI vive en public/panel.html (en Vercel la sirve el builder estático;
 * esta ruta cubre el desarrollo local).
 */
const router = Router();

router.get('/panel', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../../public/panel.html'));
});

// Estado del panel y fuentes activas
router.get('/api/v1/panel', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const sources = await SourceManager.getSourcesAsync();
    res.json({ status: 'success', sources });
  } catch (err) {
    next(err);
  }
});

// Actualizar fuentes y su orden de prioridad
router.post('/api/v1/panel/sources', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sources } = req.body;
    if (!Array.isArray(sources)) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'Se requiere un arreglo "sources"');
    }
    const updated = await SourceManager.updateSourcesAsync(sources);
    res.json({
      status: 'success',
      message: 'Fuentes de catálogo y orden de prioridad actualizados con éxito',
      sources: updated
    });
  } catch (err) {
    next(err);
  }
});

// Buscar películas o series en TMDB para editar en el panel
router.get('/api/v1/panel/media/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'Se requiere parámetro "q"');
    }
    const results = await TmdbService.searchTmdbMulti(q);
    res.json({ status: 'success', count: results.length, results });
  } catch (err) {
    next(err);
  }
});

// Portadas y backdrops alternativos de TMDB para un tmdb_id
router.get('/api/v1/panel/media/:tmdb_id/images', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tmdbId = Number(req.params.tmdb_id);
    const type = (req.query.type as any) === 'tvseries' ? 'tvseries' : 'movie';
    if (isNaN(tmdbId) || tmdbId <= 0) {
      return sendErrorResponse(res, 400, 'INVALID_PARAMETER', 'tmdb_id inválido');
    }
    const images = await TmdbService.getTmdbImages(tmdbId, type);
    const currentOverride = OverrideService.getOverride(tmdbId);
    res.json({ status: 'success', tmdb_id: tmdbId, override: currentOverride, images });
  } catch (err) {
    next(err);
  }
});

// Guardar portada/backdrop personalizada (Override)
router.post('/api/v1/panel/media/:tmdb_id/override', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tmdbId = req.params.tmdb_id;
    const { custom_poster, custom_backdrop, custom_title } = req.body;
    const updated = OverrideService.setOverride(tmdbId, { custom_poster, custom_backdrop, custom_title });
    res.json({ status: 'success', message: 'Portada/backdrop personalizada guardada con éxito', data: updated });
  } catch (err) {
    next(err);
  }
});

// Eliminar portada/backdrop personalizada
router.delete('/api/v1/panel/media/:tmdb_id/override', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tmdbId = req.params.tmdb_id;
    const removed = OverrideService.removeOverride(tmdbId);
    res.json({ status: 'success', message: removed ? 'Override eliminado con éxito' : 'No había override para este ID' });
  } catch (err) {
    next(err);
  }
});

// Listar todos los overrides activos
router.get('/api/v1/panel/overrides', (_req: Request, res: Response) => {
  res.json({ status: 'success', overrides: OverrideService.getAllOverrides() });
});

export default router;
