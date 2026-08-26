import { Router, Request, Response, NextFunction } from 'express';
import { getSupabaseAdmin } from '../services/supabaseService';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SERVIR LOS SUBTÍTULOS QUE NOS HEMOS FABRICADO
 *
 * Tres rutas y ninguna sorpresa:
 *
 *   GET  /api/v1/subtitles/:id            → qué pistas hay para esta ficha o capítulo
 *   GET  /api/v1/subtitles/:id/:idioma.vtt → el fichero, listo para el reproductor
 *   POST /api/v1/subtitles/:id/pedir       → «no hay ninguno; ponlo el primero de la cola»
 *
 * VA APARTE DE `/streams` A PROPÓSITO. Los enlaces caducan en horas y se resuelven en vivo; un
 * subtítulo, una vez escrito, no cambia nunca. Mezclarlos obligaría a servir lo permanente con
 * la caché de lo perecedero — o sea, a volver a pedir medio mega de texto cada vez que alguien
 * pulsa Reproducir.
 *
 * ── LA RUTA DE PEDIR ES LO QUE HACE ÚTIL TODO ESTO ─────────────────────────────────────────
 *
 * Escuchar una película entera cuesta decenas de minutos de máquina y el catálogo tiene miles.
 * Ir en orden de base de datos significa que lo que alguien quiere ver esta noche le toca dentro
 * de año y medio. Con esta ruta, abrir algo sin subtítulos lo pone el primero: lo que se está
 * viendo manda sobre lo que duerme.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const router = Router();

/** El capítulo, o cadena vacía en las películas. Ver la nota de la migración 011. */
const episodioDe = (req: Request): string =>
  String(req.query.episodio || req.query.episode || '').trim();

/**
 * Un subtítulo escrito no cambia jamás, así que se cachea largo y agresivo.
 *
 * `immutable` es literal aquí: si algún día se rehace con un modelo mejor, se rehace bajo otra
 * URL —el idioma no basta— o se purga a mano. No se va a editar en su sitio.
 */
const CACHE_DEL_FICHERO = 'public, max-age=86400, s-maxage=604800, immutable';

/** La lista sí cambia: hoy no hay nada y mañana hay dos pistas. */
const CACHE_DE_LA_LISTA = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';

router.get('/api/v1/subtitles/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const episodio = episodioDe(req);
    const { data, error } = await getSupabaseAdmin()
      .from('subtitulos')
      .select('idioma, etiqueta, origen, desfase_ms, parecido, creado_en')
      .eq('media_id', req.params.id)
      .eq('episodio_id', episodio);

    if (error) throw new Error(error.message);

    const consulta = episodio ? `?episodio=${encodeURIComponent(episodio)}` : '';
    res.setHeader('Cache-Control', CACHE_DE_LA_LISTA);
    // `{ status, data }` como el resto de la API: un cliente no tiene por qué aprenderse dos
    // formas de leer la misma cosa según la ruta.
    res.json({
      status: 'success',
      data: {
        pistas: (data || []).map(fila => ({
          idioma: fila.idioma,
          etiqueta: fila.etiqueta,
          /*
           * DE DÓNDE SALIÓ, y esto se entrega al cliente a propósito.
           *
           * 'transcrito' es lo que se habla, palabra por palabra. 'publico' es un fichero escrito
           * por una persona y comprobado contra este audio: mejor redactado, pero condensado. No
           * son la misma promesa y quien lee tiene derecho a saber cuál está leyendo.
           */
          origen: fila.origen,
          url: `/api/v1/subtitles/${encodeURIComponent(req.params.id)}/${fila.idioma}.vtt${consulta}`,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get(
  '/api/v1/subtitles/:id/:idioma.vtt',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { data, error } = await getSupabaseAdmin()
        .from('subtitulos')
        .select('contenido')
        .eq('media_id', req.params.id)
        .eq('episodio_id', episodioDe(req))
        .eq('idioma', req.params.idioma)
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (!data) {
        res.status(404).json({ error: 'no hay subtítulo para esa ficha en ese idioma' });
        return;
      }

      // `charset=utf-8` no es opcional: sin él, un reproductor que asuma latin-1 pinta los acentos
      // como basura, y en español eso es una de cada tres líneas.
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', CACHE_DEL_FICHERO);
      res.send(data.contenido);
    } catch (err) {
      next(err);
    }
  },
);

router.post('/api/v1/subtitles/:id/pedir', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const episodio = episodioDe(req) || String(req.body?.episodio || '').trim();

    /*
     * PRIORIDAD 10 CONTRA EL 0 DEL RELLENO, y se SUMA en cada petición.
     *
     * Que se sume importa: si tres personas distintas abren la misma película sin subtítulos,
     * esa película tiene que adelantar a la que pidió una sola. Es la única señal de demanda real
     * que hay en todo el sistema y sale gratis.
     */
    const supabase = getSupabaseAdmin();
    const { data: yaEsta } = await supabase
      .from('subtitulos_cola')
      .select('id, prioridad, hecho_en')
      .eq('media_id', req.params.id)
      .eq('episodio_id', episodio)
      .maybeSingle();

    if (yaEsta?.hecho_en) {
      // Ya se hizo. Si el cliente pregunta es que no encontró pistas, así que no se reabre solo:
      // reabrirlo cada vez convertiría un título imposible en un bucle que se come el runner.
      res.json({ status: 'success', data: { estado: 'hecho' } });
      return;
    }

    if (yaEsta) {
      await supabase
        .from('subtitulos_cola')
        .update({ prioridad: (yaEsta.prioridad || 0) + 10 })
        .eq('id', yaEsta.id);
    } else {
      await supabase.from('subtitulos_cola').insert({
        media_id: req.params.id,
        episodio_id: episodio,
        prioridad: 10,
      });
    }

    res.json({ status: 'success', data: { estado: 'en cola' } });
  } catch (err) {
    next(err);
  }
});

export default router;
