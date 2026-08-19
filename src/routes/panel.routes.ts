import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import { SourceManager } from '../services/sourceManager';
import { TmdbService } from '../services/tmdbService';
import { OverrideService } from '../services/overrideService';
import { sendErrorResponse } from '../utils/apiHelpers';
import { BandwidthService } from '../services/bandwidthService';
import { externalProxyEnabled } from '../utils/externalProxy';
import { CatalogService } from '../services/catalogService';

/**
 * Panel de administración: página estática + API de fuentes y overrides.
 * La UI vive en public/panel.html (en Vercel la sirve el builder estático;
 * esta ruta cubre el desarrollo local).
 */
const router = Router();

router.get('/panel', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../../public/panel.html'));
});

/**
 * Estado del panel: fuentes activas y consumo de tránsito.
 *
 * El bloque `bandwidth` no es adorno. El contador vive en `CacheStore`, que solo se comparte
 * entre instancias si hay Redis configurado; sin él, cada lambda de Vercel cuenta únicamente sus
 * propios bytes y el tope del mes NO SALTA NUNCA. Eso estuvo pasando sin que nada lo dijera, y
 * la única forma de detectarlo era leer el código. Ahora `shared_counter` lo canta:
 *
 *   true  → contador real, el presupuesto protege de verdad.
 *   false → falta UPSTASH_REDIS_REST_URL / _TOKEN y el presupuesto es decorativo.
 */
router.get('/api/v1/panel', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [sources, bandwidth, escritura] = await Promise.all([
      SourceManager.getSourcesAsync(),
      BandwidthService.status(),
      CatalogService.puedeEscribirCatalogo(),
    ]);
    const gb = (bytes: number) => Number((bytes / 1024 ** 3).toFixed(2));
    res.json({
      status: 'success',
      sources,
      bandwidth: {
        ...bandwidth,
        used_gb: gb(bandwidth.used_bytes),
        budget_gb: gb(bandwidth.budget_bytes),
        // Cuánto del vídeo sale por fuera del plan. Con el proxy externo activo, el modo `proxy`
        // —el único que reenvía la película entera— se delega y deja de contar aquí.
        external_proxy: externalProxyEnabled(),
      },
      /**
       * ¿PUEDE LA API CORREGIR EL CATÁLOGO? Por el mismo motivo que `shared_counter`.
       *
       * Un UPDATE que RLS no deja pasar NO da error: contesta 204 y cero filas. Así que la API
       * puede llevar meses creyendo que escribe —enlaces resueltos, sellos de capítulos,
       * veredictos de disponibilidad— sin que nada lo diga y sin forma de detectarlo salvo
       * comparando a mano una fila antes y después. Pasó, y costó media tarde encontrarlo.
       *
       *   true  → el camino de petición puede retirar lo que demuestre que no se ve.
       *   false → falta SUPABASE_SERVICE_ROLE_KEY en el entorno; todo lo que la API aprende al
       *           servir se pierde, y el catálogo solo se corrige desde los trabajos de GitHub.
       */
      catalog_writable: escritura,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * ESTADO DEL CATÁLOGO — los números que hasta ahora había que sacar corriendo scripts a mano.
 *
 * Va en su propio endpoint y no dentro de `/api/v1/panel` a propósito: son ~17 consultas de
 * conteo (unos 3 s en frío, cacheadas un minuto), y el panel pinta las fuentes al instante
 * mientras esto llega. Meterlo en el mismo payload haría lento lo que hoy es inmediato.
 */
router.get('/api/v1/panel/estado', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ status: 'success', ...(await CatalogService.estadoDelCatalogo()) });
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
