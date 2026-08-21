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

/**
 * EL CATÁLOGO EN FORMA DE TABLA, para verlo como una hoja de cálculo desde el panel.
 * Filtra por tipo, busca por título y pagina en Postgres.
 */
router.get('/api/v1/panel/contenido', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tipoCrudo = String(req.query.tipo || '').toLowerCase();
    const tipo = tipoCrudo === 'movie' || tipoCrudo === 'tvseries' ? tipoCrudo : undefined;
    res.json({
      status: 'success',
      ...(await CatalogService.contenidoParaPanel({
        tipo,
        q: String(req.query.q || '').trim() || undefined,
        fuente: String(req.query.fuente || '').trim().toLowerCase() || undefined,
        visible: (['si', 'no'] as const).find(v => v === String(req.query.visible || '').toLowerCase()),
        pagina: Number(req.query.page) || 1,
        porPagina: Number(req.query.limit) || 50,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Los capítulos de una serie, según TMDB, para que el panel pueda pedir una url POR CAPÍTULO.
 * Sin esto, la fuente propia solo servía para películas: en una serie el vídeo vive en cada
 * episodio, y una lista suelta de urls no dice a cuál pertenece cada una.
 */
router.get('/api/v1/panel/manual/episodios', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tmdbId = Number(req.query.tmdb_id);
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'Se requiere tmdb_id');
    }
    const detalle = await TmdbService.getTmdbDetails(tmdbId, 'tvseries');
    const cuantas = Number(detalle?.number_of_seasons) || 0;
    if (!cuantas) return res.json({ status: 'success', temporadas: [] });

    const seasons = await TmdbService.getTmdbSeasons(tmdbId, cuantas, null, []);
    res.json({
      status: 'success',
      titulo: detalle?.name || detalle?.title || '',
      temporadas: (seasons || []).map((t: any) => ({
        season_number: t.season_number,
        episodes: (t.episodes || []).map((e: any) => ({
          episode_number: e.episode_number,
          name: e.name || '',
        })),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * AÑADIR UNA FICHA A MANO — la fuente propia.
 *
 * Se elige un título de TMDB (con `/panel/media/search`) y se pegan una o varias urls directas.
 * La metadata la pone TMDB entera, así que la identidad está resuelta antes de empezar; las urls
 * se COMPRUEBAN una a una antes de guardarlas y se contesta cuáles pasaron y cuáles no.
 */
router.post('/api/v1/panel/manual', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const tmdbId = Number(b.tmdb_id);
    const tipo = String(b.type) === 'tvseries' ? 'tvseries' : 'movie';
    const urls = Array.isArray(b.urls)
      ? (b.urls as unknown[]).map(u => String(u))
      : String(b.urls || '').split(/[\s,;]+/);
    const episodios = Array.isArray(b.episodios)
      ? (b.episodios as any[]).map(e => ({
          season: Number(e?.season) || 1,
          episode: Number(e?.episode) || 1,
          urls: Array.isArray(e?.urls) ? e.urls.map((u: unknown) => String(u)) : [],
        }))
      : [];

    if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'Se requiere un tmdb_id válido');
    }
    const r = await CatalogService.anadirFichaManual({ tmdbId, tipo: tipo as any, urls, episodios });
    if (!r.ok) {
      return res.status(422).json({ status: 'error', message: r.error, aceptadas: r.aceptadas, rechazadas: r.rechazadas });
    }
    res.json({ status: 'success', ...r });
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
