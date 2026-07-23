import { Router, Request, Response, NextFunction } from 'express';
import { CatalogService } from '../services/catalogService';
import { sendErrorResponse, getPaginationParams } from '../utils/apiHelpers';

/**
 * Búsqueda general paginada (DB-first) con proyección LEAN por defecto.
 *  - total_results / has_more / next_page se calculan sobre el TOTAL real del catálogo
 *    (RPC search_media), habilitando scroll infinito.
 *  - El payload por defecto es lean (sin cast/servers/seasons). Usa ?full=true para el
 *    objeto completo, o ?compact=true para la proyección compacta clásica.
 *  - El ranking prioriza títulos que EMPIEZAN con el término (ver scoreAndSortResults / RPC).
 */
const router = Router();

router.get(['/api/v1/search', '/api/v1/movies/search'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = req.query.q as string;
    if (!q) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'El parámetro ?q= es requerido');
    }

    const { page, limit } = getPaginationParams(req, 25, 100);
    const full = req.query.full === 'true';
    const compact = req.query.compact === 'true';

    const { items, total } = await CatalogService.searchPaged(q, page, limit);

    const results = full
      ? items
      : items.map(compact ? CatalogService.toCompactItem : CatalogService.toSearchItem);

    const startIndex = (page - 1) * limit;
    const hasMore = startIndex + results.length < total;

    res.json({
      status: 'success',
      query: q,
      page,
      limit,
      total_results: total,
      count: results.length,
      has_more: hasMore,
      next_page: hasMore ? page + 1 : null,
      results
    });
  } catch (err) {
    next(err);
  }
});

export default router;
