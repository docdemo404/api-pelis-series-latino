import { Router, Request, Response, NextFunction } from 'express';
import { CatalogService } from '../services/catalogService';
import { sendErrorResponse, getPaginationParams } from '../utils/apiHelpers';

/**
 * Búsqueda general con paginación y proyección compacta.
 * El ranking prioriza títulos que EMPIEZAN con el término (ver scoreAndSortResults).
 */
const router = Router();

router.get(['/api/v1/search', '/api/v1/movies/search'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = req.query.q as string;
    if (!q) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'El parámetro ?q= es requerido');
    }

    const { page, limit } = getPaginationParams(req, 25, 100);
    const compact = req.query.compact === 'true';

    // Tope de candidatos a unificar/puntuar por búsqueda. 150 cubre 6 páginas de 25
    // manteniendo total_results correcto; escanear 1000 multiplicaba el trabajo de
    // unificación (re-scrapes + TMDB) sin valor real para el usuario.
    const searchScanLimit = 150;
    const results = await CatalogService.search(q, searchScanLimit);
    const startIndex = (page - 1) * limit;
    const paginated = results.slice(startIndex, startIndex + limit);
    const finalItems = compact ? paginated.map(CatalogService.toCompactItem) : paginated;

    res.json({
      status: 'success',
      query: q,
      page,
      limit,
      total_results: results.length,
      count: finalItems.length,
      has_more: startIndex + finalItems.length < results.length,
      results: finalItems
    });
  } catch (err) {
    next(err);
  }
});

export default router;
