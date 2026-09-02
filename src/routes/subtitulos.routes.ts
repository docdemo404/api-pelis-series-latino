import { Router, Request, Response, NextFunction } from 'express';
import { getSupabaseAdmin } from '../services/supabaseService';
import { pelicula as netmirrorPelicula, episodio as netmirrorEpisodio, CaptionNetmirror } from '../scrapers/netmirror';

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

/**
 * LA LISTA CAMBIA, Y CUANDO CAMBIA HAY QUE ENTERARSE YA.
 *
 * Estaba en `s-maxage=300, stale-while-revalidate=600`: hasta cinco minutos servida desde el borde
 * y diez más sirviéndola caducada mientras se refresca. O sea que un subtítulo recién generado
 * podía tardar un cuarto de hora en aparecer en la app.
 *
 * Eso se cargaba lo único que hace útil todo esto — que lo que pides se atienda primero. Medido
 * en vivo: la app seguía viendo una sola pista cuando en la base ya había dos, con `Age: 266` y
 * `X-Vercel-Cache: HIT`.
 *
 * Treinta segundos en el borde son suficientes para que cien reproductores no se conviertan en
 * cien consultas, y bastante poco para que nadie note la espera. El FICHERO en cambio sigue
 * cacheado para siempre: ese no cambia nunca.
 */
const CACHE_DE_LA_LISTA = 'public, max-age=0, s-maxage=30, stale-while-revalidate=60';

/**
 * Trae las pistas que ofrece NetMirror para esta ficha/episodio, si tiene tmdb_id.
 * El catalogo guarda tmdb_id en `media_items`; consultamos la API por el id y devolvemos las
 * captions ya con la URL que sirve nuestro endpoint (`nm-<lang>.vtt`, que hace proxy y convierte).
 */
async function pistasDeNetmirror(mediaId: string, epQuery: string): Promise<CaptionNetmirror[]> {
  try {
    const { data } = await getSupabaseAdmin()
      .from('media_items')
      .select('tmdb_id, type')
      .eq('id', mediaId).maybeSingle();
    if (!data?.tmdb_id) return [];
    const tmdb = Number(data.tmdb_id);
    if (data.type === 'movie') {
      const r = await netmirrorPelicula(tmdb);
      return r?.subtitulosEs ? await todosLosCaptionsNetmirror(tmdb, 0, 0) : [];
    }
    // Serie: episodio N-M viene en `epQuery` como 'N-M' o '1-3' segun formato.
    const m = /^(\d+)[-x](\d+)$/.exec(epQuery);
    if (!m) return [];
    const s = Number(m[1]), e = Number(m[2]);
    const r = await netmirrorEpisodio(tmdb, s, e);
    return r?.subtitulosEs ? await todosLosCaptionsNetmirror(tmdb, s, e) : [];
  } catch { return []; }
}

/**
 * Devuelve TODOS los captions (no solo espanol) que NetMirror publica para la ficha.
 * Los reproductores del cliente aceptan multiples pistas — el usuario elige la que quiera.
 */
async function todosLosCaptionsNetmirror(tmdb: number, s: number, e: number): Promise<CaptionNetmirror[]> {
  const url = s === 0
    ? `https://net27.cc/api/embed-tmdb/${tmdb}`
    : `https://net27.cc/api/embed-tmdb/${tmdb}?type=tv&s=${s}&e=${e}`;
  const r = await fetch(url, { headers: { Referer: 'https://videodownloader.site/', 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  const raw: CaptionNetmirror[] = Array.isArray(j?.captions) ? j.captions : [];
  // Absolutizar y quedarse con lang/name/url/source
  return raw.map(c => ({
    lang: String(c.lang || ''),
    name: String(c.name || ''),
    url: c.url?.startsWith('http') ? c.url : `https://net27.cc${c.url}`,
    source: c.source,
  })).filter(c => c.url);
}

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
    const propias = (data || []).map(fila => ({
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
    }));

    // NetMirror: si la API tiene la ficha, sus captions se sirven via proxy /nm-<lang>.vtt para
    // que el reproductor las vea junto a las de nuestra BD. Sin esto, la pista de audio ingles del
    // mp4 salia sola, sin ninguna traduccion.
    const captions = await pistasDeNetmirror(req.params.id, episodio);
    const netmirror = captions.map(c => ({
      idioma: c.lang,
      etiqueta: c.name || c.lang,
      origen: 'netmirror',
      url: `/api/v1/subtitles/${encodeURIComponent(req.params.id)}/nm-${encodeURIComponent(c.lang)}.vtt${consulta}`,
    }));

    // `{ status, data }` como el resto de la API: un cliente no tiene por qué aprenderse dos
    // formas de leer la misma cosa según la ruta.
    res.json({
      status: 'success',
      data: { pistas: [...propias, ...netmirror] },
    });
  } catch (err) {
    next(err);
  }
});

/** Convierte SRT a WebVTT: cabecera y `,` -> `.` en timestamps. */
function srtAVtt(srt: string): string {
  const cuerpo = srt
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return 'WEBVTT\n\n' + cuerpo;
}

router.get(
  '/api/v1/subtitles/:id/:idioma.vtt',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Pistas de NetMirror: se identifican con prefijo `nm-` y se sirven via proxy al CDN.
      // Convertimos SRT -> VTT porque el reproductor solo entiende VTT nativamente.
      if (req.params.idioma.startsWith('nm-')) {
        const lang = req.params.idioma.slice(3);
        const captions = await pistasDeNetmirror(req.params.id, episodioDe(req));
        const c = captions.find(x => x.lang === lang);
        if (!c) return res.status(404).json({ error: 'NetMirror ya no ofrece este idioma' });
        const upstream = await fetch(c.url, { headers: { Referer: 'https://videodownloader.site/', 'User-Agent': 'Mozilla/5.0' } });
        if (!upstream.ok) return res.status(502).json({ error: `subtitulo netmirror ${upstream.status}` });
        const srt = await upstream.text();
        const vtt = /^WEBVTT/.test(srt) ? srt : srtAVtt(srt);
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        // Los captions del CDN llevan Policy/Signature con caducidad de dias, no persiste; cache
        // corto por si el URL rota.
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.send(vtt);
      }

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

    /*
     * SE MIRA SI LA ESCRITURA FUNCIONO, y esto dejo de ser opcional al encender RLS.
     *
     * La cola solo acepta a la *service role*. Si el entorno que sirve la API se quedara sin
     * `SUPABASE_SERVICE_ROLE_KEY`, `getSupabaseAdmin()` degrada al cliente anon —lo dice su propio
     * comentario— y la fila no entraria. Sin comprobar el error, esta ruta contestaria «en cola»
     * sobre una cola en la que no hay nada, y el fallo no apareceria por ningun lado: ni en la
     * app, que no espera nada, ni en el barrido, que simplemente no encuentra trabajo.
     *
     * Un «no se pudo» es incomodo; un «hecho» que no hizo nada es indepurable.
     */
    const escritura = yaEsta
      ? await supabase
          .from('subtitulos_cola')
          .update({ prioridad: (yaEsta.prioridad || 0) + 10 })
          .eq('id', yaEsta.id)
      : await supabase.from('subtitulos_cola').insert({
          media_id: req.params.id,
          episodio_id: episodio,
          prioridad: 10,
        });

    if (escritura.error) throw new Error(escritura.error.message);

    res.json({ status: 'success', data: { estado: 'en cola' } });
  } catch (err) {
    next(err);
  }
});

export default router;
