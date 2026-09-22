import { Router, Request, Response, NextFunction } from 'express';
import {
  pelicula,
  episodio,
  consultarPelicula,
  FuenteNetmirror,
  buscarNetmirrorId,
  masterHls,
  normalizarNetmirrorOtt,
} from '../scrapers/netmirror';
import { sendErrorResponse } from '../utils/apiHelpers';
import { puedeAbrirse } from '../services/arranqueMp4';
import {
  asignarTareasNetmirror,
  estadoNetmirrorDistribuido,
  recibirInformeNetmirror,
} from '../services/netmirrorDistribuido';
import { getDb } from '../db/libsql';
import { createHash } from 'crypto';

/**
 * NetMirror — endpoints por tmdb id.
 *
 *   GET /api/v1/netmirror/probe/:tmdbId[?type=tv&s=1&e=1]
 *     JSON con la URL mp4 firmada tal como la devuelve net27.cc, mas la cabecera
 *     Referer requerida. Util para depurar y para clientes que sepan mandar el
 *     Referer por su cuenta (Media3 con DefaultHttpDataSource.Factory).
 *
 *   GET /api/v1/netmirror/stream/:tmdbId[?type=tv&s=1&e=1]
 *     Proxy real: pide el mp4 a la CDN con el Referer inyectado y reenvia los
 *     bytes al cliente. Consume ancho de banda propio.  Existe porque un 302
 *     directo NO funciona: la CDN valida Referer y el cliente no puede ponerlo
 *     por si mismo (los navegadores no permiten forzar Referer arbitrario).
 *     Los clientes que si puedan (nuestra app Android) deberian usar /probe.
 */
const router = Router();

const REFERER_MP4 = 'https://videodownloader.site/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NEWTV_API = 'https://tv.imgcdn.kim';

/**
 * Cola residencial de comprobacion. La IP nunca forma parte de la respuesta ni se guarda en
 * claro: el servicio conserva solo una huella de red para impedir que dos aparatos de la misma
 * casa formen quorum. Los clientes no eligen URLs ni IDs; solo resuelven la tarea asignada.
 */
router.get('/api/v1/netmirror/tasks', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deviceId = String(req.query.device_id || '');
    const tareas = await asignarTareasNetmirror(req, deviceId, Number(req.query.limit || 3));
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.json({ status: 'success', data: tareas });
  } catch (err: any) {
    if (err?.message === 'DEVICE_ID_INVALID') {
      return sendErrorResponse(res, 400, 'INVALID_DEVICE', 'Identificador de instalacion invalido.');
    }
    next(err);
  }
});

router.post('/api/v1/netmirror/tasks/report', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resultado = await recibirInformeNetmirror(req, req.body || {});
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.json({ status: 'success', data: resultado });
  } catch (err: any) {
    const codigo = String(err?.message || '');
    if (codigo === 'REPORT_INVALID') return sendErrorResponse(res, 400, codigo, 'Informe invalido.');
    if (codigo === 'ASSIGNMENT_INVALID' || codigo === 'ASSIGNMENT_EXPIRED') {
      return sendErrorResponse(res, 409, codigo, 'La tarea no existe, vencio o pertenece a otra instalacion.');
    }
    next(err);
  }
});

router.get('/api/v1/netmirror/tasks/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    return res.json({ status: 'success', data: await estadoNetmirrorDistribuido() });
  } catch (err) { next(err); }
});

/**
 * Sesion oficial de NewTV para el cliente Android.
 *
 * El `usertoken` no es el token efimero de una URL HLS: NewTV lo usa para emitir, desde la IP
 * del propio televisor, el master completo y firmado de cada titulo. Mantenerlo en una variable
 * de produccion permite renovarlo sin publicar otro APK. Nunca se cachea en navegador ni CDN.
 */
/**
 * SESIÓN DE NETMIRROR: LA PIDE UN TELÉFONO QUE NO PUDO RENOVAR EN LOCAL.
 *
 * Prioridad:
 *   1. Un token del POOL (los que subieron otros teléfonos) que no lleve muchos fallos y que no
 *      sea el que YA rechazó esta red. `ip_hash` es un hash corto de la IP del cliente que
 *      obtuvo el token; si coincide con la de quien lo pide se prefiere, porque NetMirror ata
 *      la sesión a la IP creadora. Si no hay coincidencia, se ofrece el más reciente y ya lo
 *      probará: si funciona, `POST /session/uso {ok:true}`; si no, `POST /session/uso {ok:false}`.
 *   2. El fallback histórico: `NETMIRROR_USER_TOKEN` del entorno.
 *
 * Este endpoint jamás se cachea: cada teléfono debe recibir la respuesta del momento.
 */
router.get('/api/v1/netmirror/session', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');

    const ip = hashIp(req);
    const r = await getDb().execute({
      sql: `SELECT user_token, api_url, ott, ip_hash, aciertos, fallos FROM netmirror_sesiones
              WHERE fallos < 5
              ORDER BY (ip_hash = ?) DESC, aciertos DESC, obtenido_at DESC
              LIMIT 1`,
      args: [ip],
    });
    const fila: any = r.rows[0];
    if (fila) {
      return res.json({
        status: 'success',
        data: {
          user_token: String(fila.user_token),
          api_url: String(fila.api_url || NEWTV_API),
          ott: String(fila.ott || 'nf'),
          fuente: 'pool',
          creada_en_su_red: String(fila.ip_hash || '') === ip,
        },
      });
    }
    const userToken = String(process.env.NETMIRROR_USER_TOKEN || '').trim();
    if (!userToken) return sendErrorResponse(res, 503, 'NETMIRROR_SESSION_UNAVAILABLE', 'La sesion de NetMirror no esta configurada.');
    return res.json({ status: 'success', data: { api_url: NEWTV_API, ott: 'nf', user_token: userToken, fuente: 'env' } });
  } catch (err) { next(err); }
});

/**
 * La app SUBE su `usertoken` cuando lo consigue con éxito.
 *
 * Cuerpo: `{user_token, api_url, ott}`. Se guarda el hash corto de la IP del cliente para poder
 * preferir el mismo token en la misma red la próxima vez. Es fire-and-forget: el 200 solo dice
 * «recibido», nada de la reproducción depende de esto.
 */
router.post('/api/v1/netmirror/session', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body || {}) as { user_token?: string; api_url?: string; ott?: string };
    const token = String(body.user_token || '').trim();
    if (token.length < 20 || token.length > 512) return sendErrorResponse(res, 400, 'INVALID_PARAMETER', 'user_token con longitud entre 20 y 512.');
    const api = String(body.api_url || NEWTV_API).trim();
    if (!/^https:\/\/[a-z0-9.-]+/i.test(api)) return sendErrorResponse(res, 400, 'INVALID_PARAMETER', 'api_url no es https.');
    const ott = normalizarNetmirrorOtt(body.ott);
    await getDb().execute({
      sql: `INSERT INTO netmirror_sesiones (user_token, api_url, ott, ip_hash) VALUES (?, ?, ?, ?)
              ON CONFLICT(user_token) DO UPDATE SET obtenido_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), api_url = excluded.api_url, ott = excluded.ott, ip_hash = excluded.ip_hash`,
      args: [token, api, ott, hashIp(req)],
    });
    res.json({ status: 'success' });
  } catch (err) { next(err); }
});

/**
 * La app AVISA si el token que le dieron funcionó o no. Sirve para retirar tokens muertos y
 * para saber si la atadura por IP es tan estricta como decía la documentación.
 * Cuerpo: `{user_token, ok:boolean}`.
 */
router.post('/api/v1/netmirror/session/uso', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body || {}) as { user_token?: string; ok?: boolean };
    const token = String(body.user_token || '').trim();
    if (!token) return sendErrorResponse(res, 400, 'INVALID_PARAMETER', 'user_token requerido.');
    const columna = body.ok === false ? 'fallos' : 'aciertos';
    await getDb().execute({
      sql: `UPDATE netmirror_sesiones SET ${columna} = ${columna} + 1,
              ultimo_uso_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_token = ?`,
      args: [token],
    });
    res.json({ status: 'success' });
  } catch (err) { next(err); }
});

/** Hash corto de la IP del cliente, para preferir el mismo token en la misma red sin guardar la IP. */
function hashIp(req: Request): string {
  const salt = String(process.env.IP_SALT || 'nm-pool');
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!ip) return '';
  return createHash('sha256').update(salt + ':' + ip).digest('hex').slice(0, 16);
}

/**
 * Puente de inventario para los barridos. NetMirror bloquea las IP de GitHub Actions, pero sí
 * atiende a producción; sólo se devuelven ids y metadata pública del master, nunca credenciales.
 */
router.get('/api/v1/netmirror/newtv/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const titulo = String(req.query.title || '').trim();
    if (!titulo) return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'Falta `title`.');
    const id = await buscarNetmirrorId(
      titulo,
      String(req.query.year || ''),
      String(req.query.original || ''),
      String(req.query.english || ''),
      normalizarNetmirrorOtt(req.query.ott),
    );
    if (!id) return sendErrorResponse(res, 404, 'NOT_FOUND', 'Sin coincidencia en esta plataforma.');
    return res.json({ status: 'success', data: { id } });
  } catch (err) { next(err); }
});

router.get('/api/v1/netmirror/newtv/master', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!/^[A-Za-z0-9_-]{5,}$/.test(id)) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'Falta `id` válido.');
    }
    const master = await masterHls(id, '', normalizarNetmirrorOtt(req.query.ott));
    if (!master) return sendErrorResponse(res, 404, 'NOT_FOUND', 'Master multipista no disponible.');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.json({ status: 'success', data: master });
  } catch (err) { next(err); }
});

async function resolver(req: Request): Promise<FuenteNetmirror | null> {
  const tmdbId = Number(req.params.tmdbId);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return null;
  const tipo = String(req.query.type || 'movie');
  if (tipo === 'tv') {
    const s = Number(req.query.s || 0);
    const e = Number(req.query.e || 0);
    if (!Number.isFinite(s) || !Number.isFinite(e) || s <= 0 || e <= 0) return null;
    return episodio(tmdbId, s, e);
  }
  return pelicula(tmdbId);
}

/**
 * La sonda dice TRES cosas, no dos: 200 con la fuente, 404 si NetMirror contestó que no la tiene,
 * y 502 si NetMirror no contestó. `scripts/importarNetmirror.ts` la usa desde GitHub —cuya IP
 * NetMirror no atiende— y apunta los 404 como «no» durante dos semanas; un 502 no se apunta.
 * Solo para películas: la de capítulos sigue por `resolver`, que colapsa las dos cosas.
 */
router.get('/api/v1/netmirror/probe/:tmdbId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tmdbId = Number(req.params.tmdbId);
    if (String(req.query.type || 'movie') === 'movie' && Number.isFinite(tmdbId) && tmdbId > 0) {
      const c = await consultarPelicula(tmdbId);
      if (c.estado === 'sin-respuesta') return sendErrorResponse(res, 502, 'UPSTREAM_ERROR', `NetMirror no contesta: ${c.detalle}`);
      if (c.estado === 'no') return sendErrorResponse(res, 404, 'NOT_FOUND', 'NetMirror no tiene este titulo.');
      /**
       * Con `?arranque=1` se comprueba ADEMÁS que el mp4 abre —la misma prueba del verificador,
       * con la cabecera Referer de la CDN— y se devuelve el veredicto junto a la fuente. Hace
       * falta porque la CDN tampoco atiende a los runners de GitHub: el importador no puede
       * probarlo desde allí, y desde aquí sí. Presupuesto corto para no rozar el techo de la
       * función; agotarlo da `sinVeredicto`, que el importador no apunta.
       */
      if (req.query.arranque === '1') {
        const t0 = Date.now();
        const arranque = await puedeAbrirse(c.fuente.mp4, { Referer: c.fuente.referer, 'User-Agent': UA }, 7_000);
        return res.json({ status: 'success', data: c.fuente, arranque: { ...arranque, ms: Date.now() - t0 } });
      }
      return res.json({ status: 'success', data: c.fuente });
    }
    const r = await resolver(req);
    if (!r) return sendErrorResponse(res, 404, 'NOT_FOUND', 'NetMirror no tiene este titulo.');
    res.json({ status: 'success', data: r });
  } catch (err) { next(err); }
});

router.get('/api/v1/netmirror/stream/:tmdbId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await resolver(req);
    if (!r) return sendErrorResponse(res, 404, 'NOT_FOUND', 'NetMirror no tiene este titulo.');

    // Modo redirect: 302 al mp4. Pensado para clientes que pueden fijar Referer y lo propagan
    // al seguir la redireccion (Android Media3 con DefaultHttpDataSource, VLC, curl con -L).
    // Sin este modo el proxy bombea todos los bytes por el Worker, que en gru1 esta lejos del
    // CDN de hakunaymatata; medido: Spider-Man y Kung Fu Panda tardaban 5-10s en cargar.
    if (req.query.mode === 'redirect') {
      res.setHeader('Referrer-Policy', 'unsafe-url'); // que el cliente vea el destino
      return res.redirect(302, r.mp4);
    }

    // Modo proxy (defecto): el Worker inyecta Referer, para navegadores y clientes sin headers.
    const upstream = await fetch(r.mp4, {
      headers: {
        'User-Agent': UA,
        'Referer': REFERER_MP4,
        // Pasar el Range del cliente para que el CDN devuelva 206 parcial.
        ...(req.headers.range ? { Range: String(req.headers.range) } : {}),
      },
    });

    // Reenviar cabeceras que le importan al reproductor.
    const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'last-modified', 'etag'];
    for (const h of passthrough) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.status(upstream.status);

    if (!upstream.body) { res.end(); return; }
    const nodeStream = require('stream').Readable.fromWeb(upstream.body as any);
    nodeStream.pipe(res);
  } catch (err) { next(err); }
});

export default router;
