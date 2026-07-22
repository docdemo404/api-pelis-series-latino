import { Router, Request, Response, NextFunction } from 'express';
import { CatalogService } from '../services/catalogService';
import { RealScraperService } from '../services/realScraperService';
import { sendErrorResponse } from '../utils/apiHelpers';

/**
 * Rutas de detalle: episodio específico, serie por id y media por id/slug.
 * Se montan DESPUÉS de catalog.routes para que /media/batch no sea capturado por /media/:id.
 */
const router = Router();

// Detalle de Episodio específico (/series/... y /media/...)
router.get(
  ['/api/v1/series/:id/season/:season/episode/:episode', '/api/v1/media/:id/season/:season/episode/:episode'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, season, episode } = req.params;
      const sNum = parseInt(season);
      const epNum = parseInt(episode);

      let epDetail = await RealScraperService.scrapeEpisodeDetail(id, sNum, epNum);

      // Fallback inteligente: Buscar la serie por ID/Slug en el catálogo y resolver el episodio solicitado
      if (!epDetail) {
        const seriesItem = await CatalogService.getById(id);
        if (seriesItem && seriesItem.seasons) {
          const targetSeason = seriesItem.seasons.find((s: any) => s.season_number === sNum);
          if (targetSeason) {
            const targetEp = targetSeason.episodes.find((e: any) => e.episode_number === epNum);
            if (targetEp) {
              epDetail = {
                ...targetEp,
                series_id: seriesItem.id,
                series_title: seriesItem.title,
                season_number: sNum,
                poster: targetEp.still_path || seriesItem.poster,
                backdrop: seriesItem.backdrop,
                servers: targetEp.servers?.length > 0 ? targetEp.servers : seriesItem.servers
              } as any;
            }
          }
        }
      }

      if (!epDetail) {
        return sendErrorResponse(res, 404, 'RESOURCE_NOT_FOUND', 'El episodio solicitado no existe o no está disponible.');
      }
      res.json({ status: 'success', data: epDetail });
    } catch (err) {
      next(err);
    }
  }
);

// Detalle específico para Series
router.get('/api/v1/series/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { season, episode } = req.query;
    if (season && episode) {
      const epDetail = await RealScraperService.scrapeEpisodeDetail(req.params.id, parseInt(season as string), parseInt(episode as string));
      if (epDetail) return res.json({ status: 'success', data: epDetail });
    }
    const item = await CatalogService.getById(req.params.id, 'tvseries');
    if (!item) {
      return sendErrorResponse(res, 404, 'RESOURCE_NOT_FOUND', 'La serie solicitada no existe o no está disponible.');
    }
    res.json({ status: 'success', data: item });
  } catch (err) {
    next(err);
  }
});

// Detalle por ID o Slug (Películas o Series)
router.get('/api/v1/media/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { season, episode, include } = req.query;
    if (season && episode) {
      const epDetail = await RealScraperService.scrapeEpisodeDetail(req.params.id, parseInt(season as string), parseInt(episode as string));
      if (epDetail) return res.json({ status: 'success', data: epDetail });
    }
    const item = await CatalogService.getById(req.params.id);
    if (!item) {
      return sendErrorResponse(res, 404, 'RESOURCE_NOT_FOUND', 'El contenido solicitado no existe o no está disponible.');
    }

    if (include === 'season_1' || include === 'first_season') {
      const firstEp = await RealScraperService.scrapeEpisodeDetail(item.id, 1, 1);
      if (firstEp) {
        (item as any).season_1_first_episode = firstEp;
      }
    }

    res.json({ status: 'success', data: item });
  } catch (err) {
    next(err);
  }
});

export default router;
