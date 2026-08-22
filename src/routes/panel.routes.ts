import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import { SourceManager } from '../services/sourceManager';
import { TmdbService } from '../services/tmdbService';
import { OverrideService } from '../services/overrideService';
import { sendErrorResponse } from '../utils/apiHelpers';
import { BandwidthService } from '../services/bandwidthService';
import { externalProxyEnabled } from '../utils/externalProxy';
import { CatalogService } from '../services/catalogService';
import { refrescarHostsConCache, ponerHostConCache, hostsConCache } from '../services/hostsConCache';
import { leerAjuste } from '../utils/ajustesRemotos';
import { hostsDelCatalogo } from '../services/catalogService';

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
 * QUÉ HAY YA GUARDADO A MANO PARA UN TÍTULO — lo que convierte el formulario en un editor.
 *
 * Sin esto, «añadir contenido» solo sabía añadir: no se veía lo que uno mismo había pegado antes,
 * así que no se podía corregir una errata ni retirar una url que resultó mala. Se pregunta por
 * `tmdb_id`, que es la identidad, y no por el id de la fila — quien está delante del formulario
 * acaba de elegir un título de TMDB y no tiene por qué saber con qué id se guardó.
 */
router.get('/api/v1/panel/manual/guardado', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tmdbId = Number(req.query.tmdb_id);
    const tipo = String(req.query.type) === 'tvseries' ? 'tvseries' : 'movie';
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'Se requiere tmdb_id');
    }
    const r = await CatalogService.manualesDeLaFicha(tmdbId, tipo as any);
    res.json({ status: 'success', ...r });
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
    /**
     * `reemplazar` solo lo manda el panel cuando ANTES ha cargado lo guardado. Es lo que
     * distingue una caja vacía que dice «quítalo» de una que dice «aún no lo he escrito», y por
     * eso no se deduce aquí: si alguien llama a este endpoint a pelo sin la bandera, lo suyo se
     * suma a lo que hubiera, como siempre.
     */
    const reemplazar = b.reemplazar === true;
    const r = await CatalogService.anadirFichaManual({ tmdbId, tipo: tipo as any, urls, episodios, reemplazar });
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

/**
 * LOS DOMINIOS QUE SIRVEN VÍDEO, Y SI PASAN POR LA CACHÉ.
 *
 * La lista sale del catálogo, no de una constante: los hosts aparecen y desaparecen solos según lo
 * que devuelvan los scrapers, y una lista escrita a mano nace desfasada.
 */
router.get('/api/v1/panel/hosts', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [hosts, encendidos] = await Promise.all([
      hostsDelCatalogo(),
      refrescarHostsConCache(),
    ]);
    res.json({
      status: 'success',
      hosts: hosts.map((h: { host: string; servidores: number; titulos: number }) => ({ ...h, worker: encendidos.includes(h.host) })),
    });
  } catch (err) {
    next(err);
  }
});

/** Enciende o apaga la caché para UN dominio. */
router.post('/api/v1/panel/hosts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const host = String(b.host || '').trim();
    if (!host) return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'Se requiere el host');

    const encendido = b.worker === true || String(b.worker) === 'true';
    const r = await ponerHostConCache(host, encendido);
    if (!r.guardado) {
      // 502 y no 200: el panel tiene que poder devolver el interruptor a su sitio.
      return sendErrorResponse(res, 502, 'SETTING_NOT_SAVED', 'No se pudo guardar el ajuste.');
    }
    res.json({ status: 'success', host, worker: encendido, encendidos: r.encendidos });
  } catch (err) {
    next(err);
  }
});

/**
 * QUÉ VE EXACTAMENTE ESTE PROCESO, para poder distinguir «no se guardó» de «no se leyó».
 *
 * Sin esto los dos fallos se parecen demasiado: el panel enseña un dominio encendido y el vídeo
 * sale sin caché, y desde fuera no hay forma de saber si el ajuste no llegó a guardarse, si no se
 * está leyendo, o si se lee y no se aplica. Se perdió un buen rato por no poder mirar.
 */
router.get('/api/v1/panel/hosts/estado', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const enMemoriaAntes = hostsConCache();
    const leidoAhora = await leerAjuste<string[]>('hosts-cache');
    await refrescarHostsConCache();
    res.json({
      status: 'success',
      proxy_configurado: Boolean(process.env.VIDEO_PROXY_URL && process.env.VIDEO_PROXY_KEY),
      en_memoria_antes: enMemoriaAntes,
      lo_que_hay_guardado: leidoAhora,
      en_memoria_ahora: hostsConCache(),
    });
  } catch (err) {
    next(err);
  }
});
