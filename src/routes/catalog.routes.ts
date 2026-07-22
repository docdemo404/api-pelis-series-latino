import { Router, Request, Response, NextFunction } from 'express';
import { CatalogService } from '../services/catalogService';
import { FeedService } from '../services/feedService';
import { SourceManager } from '../services/sourceManager';
import { sendErrorResponse, getPaginationParams } from '../utils/apiHelpers';

/**
 * Catálogo y listados: root self-describing, feeds home, movies/series/media,
 * discover y consultas en lote. Las rutas de detalle (/media/:id, /series/:id)
 * viven en media.routes.ts y se montan DESPUÉS para que /media/batch tenga prioridad.
 */
const router = Router();

// Root Endpoint (Self-describing for Machine Reading)
router.get('/api/v1', (_req: Request, res: Response) => {
  res.json({
    status: 'online',
    name: 'API Películas & Series Latino',
    version: '1.0.0',
    documentation: '/docs',
    control_panel: '/panel',
    openapi_spec: '/api/v1/openapi.json',
    machine_readable: true,
    active_sources: SourceManager.getSources(),
    endpoints: [
      '/api/v1/search?q=spiderman',
      '/api/v1/panel',
      '/api/v1/openapi.json',
      '/api/v1/feeds/home?country=CL',
      '/api/v1/media/scary-movie-6',
      '/api/v1/series/naruto/season/1/episode/1',
      '/api/v1/stream/resolve?id=srv_101'
    ]
  });
});

// Invalidación y Revalidación de Caché en Borde / Memoria
router.all(['/api/v1/revalidate', '/api/v1/cache/clear'], (_req: Request, res: Response) => {
  CatalogService.clearCache();
  res.json({
    status: 'success',
    success: true,
    message: 'Caché de borde y memoria invalidado con éxito.'
  });
});

// Alias Estándar para Feed Home (/home y /feeds/home)
router.get(['/api/v1/home', '/api/v1/feeds/home'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const country = (req.query.country as string) || 'CL';
    const feed = await FeedService.getHomeFeed(country);
    res.json({ status: 'success', data: feed });
  } catch (err) {
    next(err);
  }
});

// Endpoint Estándar para Películas (/movies)
router.get('/api/v1/movies', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = getPaginationParams(req);
    const genre = req.query.genre as string;
    const result = await FeedService.getDiscover(page, limit, 'movie', genre);
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

// Endpoint Estándar para Series (/series)
router.get('/api/v1/series', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = getPaginationParams(req);
    const genre = req.query.genre as string;
    const result = await FeedService.getDiscover(page, limit, 'tvseries', genre);
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

// Endpoint Estándar Catálogo General (/media)
router.get('/api/v1/media', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = getPaginationParams(req);
    const type = req.query.type as string;
    const genre = req.query.genre as string;
    const result = await FeedService.getDiscover(page, limit, type, genre);
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

// Descubrimiento Infinito
router.get('/api/v1/discover', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = getPaginationParams(req);
    const type = req.query.type as string;
    const genre = req.query.genre as string;

    const result = await FeedService.getDiscover(page, limit, type, genre);
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

// Consulta en Lote (Batching Request) — debe registrarse antes que /media/:id
router.get('/api/v1/media/batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawIds = (req.query.ids as string) || '';
    const ids = rawIds.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'El parámetro ?ids=id1,id2 es requerido');
    }
    const results = await CatalogService.getBatch(ids);
    const compact = req.query.compact === 'true';
    const finalItems = compact ? results.map(CatalogService.toCompactItem) : results;
    res.json({ status: 'success', count: finalItems.length, data: finalItems });
  } catch (err) {
    next(err);
  }
});

export default router;
