import { Router, Request, Response, NextFunction } from 'express';
import { CatalogService } from '../services/catalogService';
import { RealScraperService } from '../services/realScraperService';
import { sendErrorResponse } from '../utils/apiHelpers';
import { ContentType, MediaItem } from '../types';

/**
 * Rutas de detalle: episodio específico, serie por id y media por id/slug.
 * Se montan DESPUÉS de catalog.routes para que /media/batch no sea capturado por /media/:id.
 *
 * RENDIMIENTO — metadata primero, enlaces después:
 * la ficha (sinopsis, reparto, imágenes, temporadas) sale de la DB/caché en milisegundos,
 * mientras que resolver los servidores implica scraping en vivo. Por eso el detalle
 * responde de inmediato con un bloque `streams` que indica dónde pedir los enlaces, y la
 * app los solicita al pulsar Reproducir.
 *
 * Para clientes que prefieren una sola respuesta hay dos modos:
 *   ?streams=wait  → resolución COMPLETA (incluida la fusión multifuente). Lento pero total.
 *   ?streams=fast  → solo los caminos baratos (enlaces persistidos + un scrapeDetail contra
 *                    la URL de origen ya guardada). Cubre la práctica totalidad del catálogo
 *                    sin la latencia de la búsqueda por título.
 */
const router = Router();

/** Modo de resolución de enlaces pedido por el cliente para el DETALLE. */
function streamsMode(req: Request): 'none' | 'fast' | 'wait' {
  const streams = String(req.query.streams || '').toLowerCase();
  const include = String(req.query.include || '').toLowerCase();
  if (streams === 'wait' || streams === 'true' || streams === '1' || include === 'streams') return 'wait';
  if (streams === 'fast' || streams === 'cheap') return 'fast';
  return 'none';
}

/** Resuelve la ficha según el modo pedido: metadata sola, enlaces baratos o todo. */
async function resolveDetail(req: Request, typeHint?: ContentType): Promise<MediaItem | null> {
  const id = req.params.id;
  switch (streamsMode(req)) {
    case 'wait':
      return CatalogService.getStreams(id, typeHint);
    case 'fast':
      return CatalogService.getStreams(id, typeHint, { cheap: true });
    default:
      return CatalogService.getMetadata(id, typeHint);
  }
}

/** Adjunta el bloque `streams` y elimina los campos internos del ítem. */
function withStreamsBlock(item: MediaItem, basePath: 'media' | 'series') {
  const ready = Boolean(item.servers && item.servers.length > 0);
  return {
    ...CatalogService.toPublicItem(item),
    streams: {
      status: ready ? 'ready' : 'pending',
      url: `/api/v1/${basePath}/${item.id}/streams`,
      updated_at: item.streams_updated_at || null
    }
  };
}

/** Resuelve y devuelve únicamente los enlaces reproducibles de un título. */
async function respondWithStreams(req: Request, res: Response, typeHint?: ContentType) {
  const deep = String(req.query.deep || '') === '1' || String(req.query.deep || '') === 'true';
  const item = await CatalogService.getStreams(req.params.id, typeHint, { deep });

  if (!item) {
    return sendErrorResponse(res, 404, 'RESOURCE_NOT_FOUND', 'El contenido solicitado no existe o no está disponible.');
  }

  res.json({
    status: 'success',
    data: {
      id: item.id,
      tmdb_id: item.tmdb_id,
      type: item.type,
      title: item.title,
      primary_stream: item.primary_stream || null,
      servers: item.servers || [],
      seasons: item.seasons || undefined,
      updated_at: item.streams_updated_at || null
    }
  });
}

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

// Enlaces reproducibles (camino lento aislado). Se piden al pulsar Reproducir.
// ?deep=1 fuerza la fusión multifuente completa (TioPlus + FuegoCine).
router.get('/api/v1/media/:id/streams', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await respondWithStreams(req, res);
  } catch (err) {
    next(err);
  }
});

router.get('/api/v1/series/:id/streams', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await respondWithStreams(req, res, 'tvseries');
  } catch (err) {
    next(err);
  }
});

// Detalle específico para Series
router.get('/api/v1/series/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { season, episode } = req.query;
    if (season && episode) {
      const epDetail = await RealScraperService.scrapeEpisodeDetail(req.params.id, parseInt(season as string), parseInt(episode as string));
      if (epDetail) return res.json({ status: 'success', data: epDetail });
    }

    const item = await resolveDetail(req, 'tvseries');

    if (!item) {
      return sendErrorResponse(res, 404, 'RESOURCE_NOT_FOUND', 'La serie solicitada no existe o no está disponible.');
    }
    res.json({ status: 'success', data: withStreamsBlock(item, 'series') });
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

    const item = await resolveDetail(req);

    if (!item) {
      return sendErrorResponse(res, 404, 'RESOURCE_NOT_FOUND', 'El contenido solicitado no existe o no está disponible.');
    }

    const payload: Record<string, unknown> = withStreamsBlock(item, 'media');

    if (include === 'season_1' || include === 'first_season') {
      const firstEp = await RealScraperService.scrapeEpisodeDetail(item.id, 1, 1);
      if (firstEp) {
        payload.season_1_first_episode = firstEp;
      }
    }

    res.json({ status: 'success', data: payload });
  } catch (err) {
    next(err);
  }
});

export default router;
