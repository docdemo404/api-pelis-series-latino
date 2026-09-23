import { Router, Request, Response, NextFunction } from 'express';
import { sendErrorResponse } from '../utils/apiHelpers';
import { publicOrigin } from '../utils/publicUrl';
import { CatalogService } from '../services/catalogService';
import {
  listarCuentas, anadirCuenta, anadirCuentaGDrive, borrarCuenta, marcarCuenta, configurarCors,
  presignSubida, registrarObjeto, resolverSubidaGDrive, objeto, objetosDeFicha, borrarObjeto,
  urlDeReproduccion, Proveedor, CAP_POR_DEFECTO,
} from '../services/poolStore';
import * as gdrive from '../services/gdrive';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * CASILLEROS: cuentas de almacenamiento propio (R2/B2), subida directa y reproducción.
 *
 * El grueso vive en `services/poolStore.ts`. Aquí solo va el HTTP: el CRUD de cuentas del panel, el
 * baile de subida (presign → el navegador hace PUT directo al bucket → confirm), y el endpoint
 * PÚBLICO `/api/v1/pool/v/:id`, que en cada reproducción firma una URL fresca y hace 302 — el mismo
 * patrón de 302-al-CDN que ya usa el vídeo, y lo que resuelve que los enlaces del bucket caduquen.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */
const router = Router();

const gb = (bytes: number) => Number((bytes / 1024 ** 3).toFixed(2));

/* ─────────────────────────────── cuentas ─────────────────────────────── */

/** Lista los casilleros con su uso, para pintarlos en el panel. */
router.get('/api/v1/panel/pool/accounts', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const cuentas = await listarCuentas();
    res.json({
      status: 'success',
      accounts: cuentas.map(c => ({
        id: c.id, provider: c.provider, label: c.label, bucket: c.bucket, status: c.status,
        used_gb: gb(c.used_bytes), cap_gb: gb(c.cap_bytes), free_gb: gb(Math.max(0, c.cap_bytes - c.used_bytes)),
        used_pct: c.cap_bytes ? Math.round((c.used_bytes / c.cap_bytes) * 100) : 0,
      })),
      total_free_gb: gb(cuentas.filter(c => c.status === 'live').reduce((n, c) => n + Math.max(0, c.cap_bytes - c.used_bytes), 0)),
    });
  } catch (err) { next(err); }
});

/**
 * AÑADIR UN CASILLERO. Registra una cuenta que TÚ creaste a mano en R2/B2 (pegas sus credenciales);
 * no crea cuentas. Valida las llaves con una consulta de listado antes de guardar.
 *
 * Campos amigables por proveedor:
 *   · R2: `account_id` (de ahí sale el endpoint), `bucket`, `access_key_id`, `secret_access_key`.
 *   · B2: `region` o `endpoint`, `bucket`, `access_key_id`, `secret_access_key`.
 */
router.post('/api/v1/panel/pool/accounts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = (req.body ?? {}) as Record<string, any>;
    const provider = String(b.provider || '').toLowerCase() as Proveedor;
    if (provider !== 'r2' && provider !== 'b2') {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'provider debe ser "r2" o "b2"');
    }
    const bucket = String(b.bucket || '').trim();
    const accessKeyId = String(b.access_key_id || '').trim();
    const secretAccessKey = String(b.secret_access_key || '').trim();
    if (!bucket || !accessKeyId || !secretAccessKey) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'Faltan bucket, access_key_id o secret_access_key');
    }

    let endpoint = String(b.endpoint || '').trim().replace(/\/+$/, '');
    let region = String(b.region || '').trim();

    if (provider === 'r2') {
      const accountId = String(b.account_id || '').trim();
      if (!endpoint) {
        if (!accountId) return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'R2 necesita account_id o endpoint');
        endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
      }
      if (!region) region = 'auto';
    } else {
      // B2: del endpoint sale la región (s3.<region>.backblazeb2.com) o al revés.
      if (endpoint && !region) {
        const m = /s3\.([a-z0-9-]+)\.backblazeb2\.com/i.exec(endpoint);
        if (m) region = m[1];
      }
      if (!endpoint && region) endpoint = `https://s3.${region}.backblazeb2.com`;
      if (!endpoint || !region) {
        return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'B2 necesita region (ej. us-west-004) o endpoint completo');
      }
    }

    const capGb = Number(b.cap_gb);
    const capBytes = Number.isFinite(capGb) && capGb > 0 ? Math.round(capGb * 1024 ** 3) : CAP_POR_DEFECTO[provider];

    const r = await anadirCuenta({
      provider, label: b.label, endpoint, region, bucket, accessKeyId, secretAccessKey, capBytes,
    });
    if (!r.ok) return sendErrorResponse(res, 422, 'ACCOUNT_INVALID', r.error || 'No se pudo validar la cuenta');
    const c = r.cuenta!;
    res.json({ status: 'success', account: { id: c.id, provider: c.provider, label: c.label, bucket: c.bucket, cap_gb: gb(c.cap_bytes) } });
  } catch (err) { next(err); }
});

/** Marca una cuenta como caída o viva (sin borrar sus objetos). */
router.post('/api/v1/panel/pool/accounts/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = String((req.body || {}).status || '').toLowerCase();
    if (status !== 'live' && status !== 'dead') return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'status debe ser live o dead');
    const ok = await marcarCuenta(req.params.id, status as 'live' | 'dead');
    if (!ok) return sendErrorResponse(res, 500, 'WRITE_FAILED', 'No se pudo cambiar el estado');
    res.json({ status: 'success', id: req.params.id, cuenta_status: status });
  } catch (err) { next(err); }
});

/**
 * CONFIGURA EL CORS del bucket automáticamente (para subir desde el navegador, incluido el móvil,
 * sin comandos). Usa el origen desde el que se pide, para que valga sea cual sea el dominio del panel.
 */
router.post('/api/v1/panel/pool/accounts/:id/cors', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await configurarCors(req.params.id, [publicOrigin(req)]);
    if (!r.ok) return sendErrorResponse(res, 422, 'CORS_FAILED', r.error || 'No se pudo configurar el CORS');
    res.json({ status: 'success', id: req.params.id, origin: publicOrigin(req), nota: r.nota });
  } catch (err) { next(err); }
});

/** Borra el registro de la cuenta. Los objetos que apunten a ella quedan huérfanos: bórralos antes. */
router.delete('/api/v1/panel/pool/accounts/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ok = await borrarCuenta(req.params.id);
    if (!ok) return sendErrorResponse(res, 500, 'WRITE_FAILED', 'No se pudo borrar la cuenta');
    res.json({ status: 'success', id: req.params.id });
  } catch (err) { next(err); }
});

/* ─────────────────────────────── Google Drive (OAuth) ─────────────────────────────── */

const gdriveRedirectUri = (req: Request) => `${publicOrigin(req)}/api/v1/panel/pool/gdrive/callback`;

/** ¿Está configurado el cliente OAuth? Devuelve también el redirect_uri exacto a registrar en Google. */
router.get('/api/v1/panel/pool/gdrive/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cfg = await gdrive.leerConfig();
    res.json({ status: 'success', configured: !!cfg, redirect_uri: gdriveRedirectUri(req) });
  } catch (err) { next(err); }
});

/** Guarda el client_id/client_secret del cliente OAuth de la app (uno para todas las cuentas). */
router.post('/api/v1/panel/pool/gdrive/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = (req.body ?? {}) as Record<string, any>;
    const client_id = String(b.client_id || '').trim();
    const client_secret = String(b.client_secret || '').trim();
    if (!client_id || !client_secret) return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'Faltan client_id y client_secret');
    await gdrive.guardarConfig({ client_id, client_secret });
    res.json({ status: 'success', redirect_uri: gdriveRedirectUri(req) });
  } catch (err) { next(err); }
});

/** La URL de consentimiento de Google para conectar una cuenta nueva. El panel la abre en otra pestaña. */
router.get('/api/v1/panel/pool/gdrive/auth-url', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cfg = await gdrive.leerConfig();
    if (!cfg) return sendErrorResponse(res, 422, 'NOT_CONFIGURED', 'Configura primero el cliente OAuth de Google.');
    res.json({ status: 'success', url: gdrive.urlDeConsentimiento(cfg, gdriveRedirectUri(req)) });
  } catch (err) { next(err); }
});

/** Callback de OAuth: cambia el code por tokens y da de alta el casillero de Drive. Devuelve HTML. */
router.get('/api/v1/panel/pool/gdrive/callback', async (req: Request, res: Response) => {
  const pagina = (titulo: string, cuerpo: string) =>
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0b0f14;color:#e6e6e6;padding:40px;text-align:center">` +
    `<h2>${titulo}</h2><p>${cuerpo}</p><p style="color:#9aa">Puedes cerrar esta pestaña y volver al panel.</p>` +
    `<script>try{if(window.opener)window.opener.postMessage('gdrive-ok','*')}catch(e){}</script></body>`;
  try {
    const code = String(req.query.code || '').trim();
    const err = String(req.query.error || '').trim();
    if (err) return res.status(400).send(pagina('❌ Google devolvió un error', err));
    if (!code) return res.status(400).send(pagina('❌ Falta el código', 'No llegó el parámetro <code>code</code>.'));
    const cfg = await gdrive.leerConfig();
    if (!cfg) return res.status(422).send(pagina('❌ Sin configurar', 'Configura el cliente OAuth de Google en el panel primero.'));

    const tok = await gdrive.intercambiarCodigo(cfg, code, gdriveRedirectUri(req));
    const r = await anadirCuentaGDrive({ refreshToken: tok.refresh_token, email: tok.email });
    if (!r.ok) return res.status(500).send(pagina('❌ No se pudo guardar', r.error || ''));
    res.send(pagina('✅ Google Drive conectado', `Cuenta <b>${tok.email || ''}</b> añadida como casillero.`));
  } catch (e: any) {
    res.status(500).send(pagina('❌ Error al conectar', String(e?.message || e).slice(0, 300)));
  }
});

/* ─────────────────────────────── subida ─────────────────────────────── */

/**
 * PASO 1 de la subida: pide una URL PUT prefirmada. El navegador subirá el archivo DIRECTO al
 * bucket con esa URL (los bytes no pasan por Vercel). Elige el casillero con hueco.
 */
router.post('/api/v1/panel/pool/presign', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = (req.body ?? {}) as Record<string, any>;
    const tmdbId = Number(b.tmdb_id);
    const tipo = String(b.type) === 'tvseries' ? 'tvseries' : 'movie';
    const filename = String(b.filename || '').trim();
    const size = Number(b.size);
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'Se requiere tmdb_id');
    if (!filename) return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'Se requiere filename');
    if (!Number.isFinite(size) || size <= 0) return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'Se requiere size (bytes) válido');
    if (tipo === 'tvseries' && (!Number.isFinite(Number(b.season)) || !Number.isFinite(Number(b.episode)))) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'Una serie necesita season y episode');
    }

    const r = await presignSubida({
      tmdbId, tipo, season: Number(b.season), episode: Number(b.episode),
      filename, size, accountId: b.account_id ? String(b.account_id) : undefined,
      provider: b.provider ? (String(b.provider).toLowerCase() as Proveedor) : undefined,
    });
    if (!r.ok) return sendErrorResponse(res, 422, 'NO_SPACE', r.error || 'No se pudo preparar la subida');
    res.json({
      status: 'success',
      object_id: r.objectId, account_id: r.accountId, key: r.key,
      upload_url: r.url, content_type: r.contentType, provider: r.provider,
    });
  } catch (err) { next(err); }
});

/**
 * PASO 2 de la subida: el navegador confirma que el PUT terminó. Se registra el objeto y se da de
 * alta como SERVIDOR MANUAL del catálogo, con una URL estable (`/api/v1/pool/v/:id`) que la app
 * reproduce como cualquier otra fuente. La verificación de `anadirFichaManual` la comprueba de
 * verdad contra el bucket; si por lo que sea no pasa, se guarda igual (`forzar`) y el verificador la
 * mirará después.
 */
router.post('/api/v1/panel/pool/confirm', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = (req.body ?? {}) as Record<string, any>;
    const objectId = String(b.object_id || '').trim();
    const tmdbId = Number(b.tmdb_id);
    const tipo = String(b.type) === 'tvseries' ? 'tvseries' : 'movie';
    const accountId = String(b.account_id || '').trim();
    let key = String(b.key || '').trim();
    const filename = String(b.filename || '').trim();
    let size = Number(b.size) || 0;
    const season = Number(b.season) || 0;
    const episode = Number(b.episode) || 0;
    if (!objectId || !accountId || !Number.isFinite(tmdbId) || tmdbId <= 0) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'Faltan object_id, account_id o tmdb_id');
    }

    // Google Drive no conoce la `key` (id del archivo) hasta después de subir: se resuelve aquí,
    // buscándolo por el nombre (= object_id). En R2/B2 la `key` la manda el cliente.
    if (!key) {
      const rg = await resolverSubidaGDrive(accountId, objectId);
      if (!rg.ok || !rg.key) return sendErrorResponse(res, 502, 'GDRIVE_RESOLVE', rg.error || 'No se pudo resolver el archivo en Drive');
      key = rg.key;
      if (!size && rg.size) size = rg.size;
    }

    const reg = await registrarObjeto({ objectId, tmdbId, tipo, season, episode, accountId, key, size, filename });
    if (!reg.ok) return sendErrorResponse(res, 500, 'WRITE_FAILED', reg.error || 'No se pudo registrar el objeto');

    // URL estable de nuestra API. Absoluta para que la verificación pueda ir a buscarla.
    const poolUrl = `${publicOrigin(req)}/api/v1/pool/v/${objectId}`;
    const alta = tipo === 'tvseries'
      ? { tmdbId, tipo: 'tvseries' as const, urls: [], episodios: [{ season, episode, urls: [poolUrl] }] }
      : { tmdbId, tipo: 'movie' as const, urls: [poolUrl] };

    let r = await CatalogService.anadirFichaManual(alta);
    // Si la comprobación no la aceptó (un hipo de red contra nuestro propio 302), se guarda forzada:
    // el objeto ya está subido y es de fiar, y el verificador le pondrá el sello cuando la mire.
    if (!r.ok || !(r.aceptadas || []).includes(poolUrl)) {
      r = await CatalogService.anadirFichaManual({ ...alta, forzar: true } as any);
    }
    if (!r.ok) {
      // El objeto quedó subido y registrado, pero no se pudo enlazar a la ficha: se avisa para que
      // el panel no cante éxito en falso.
      return res.status(422).json({ status: 'error', message: r.error || 'No se pudo enlazar a la ficha', object_id: objectId });
    }
    res.json({ status: 'success', object_id: objectId, id: r.id, titulo: r.titulo, forzada: (r.forzadas || []).includes(poolUrl) });
  } catch (err) { next(err); }
});

/** Qué hay subido para una ficha (para el editor del panel). */
router.get('/api/v1/panel/pool/objects', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tmdbId = Number(req.query.tmdb_id);
    const tipo = String(req.query.type) === 'tvseries' ? 'tvseries' : 'movie';
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'Se requiere tmdb_id');
    const objetos = await objetosDeFicha(tmdbId, tipo);
    res.json({
      status: 'success',
      objects: objetos.map(o => ({
        id: o.id, season: o.season, episode: o.episode, size_gb: gb(o.size_bytes),
        filename: o.orig_filename, account_id: o.account_id, created_at: o.created_at,
      })),
    });
  } catch (err) { next(err); }
});

/** Borra un objeto del casillero (del bucket y de la tabla). */
router.delete('/api/v1/panel/pool/objects/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await borrarObjeto(req.params.id);
    if (!r.ok) return sendErrorResponse(res, r.error === 'No existe' ? 404 : 500, 'DELETE_FAILED', r.error || 'No se pudo borrar');
    res.json({ status: 'success', id: req.params.id });
  } catch (err) { next(err); }
});

/* ─────────────────────────────── reproducción (público) ─────────────────────────────── */

/**
 * EL ENDPOINT PÚBLICO. La app llega aquí por la URL estable guardada en el servidor manual; aquí se
 * firma una URL FRESCA del bucket y se hace 302. Nunca se cachea: cada reproducción acuña un enlace
 * nuevo, y el CDN sí soporta Range directamente contra el destino del 302.
 */
router.get('/api/v1/pool/v/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    const o = await objeto(req.params.id);
    if (!o) return sendErrorResponse(res, 404, 'NOT_FOUND', 'Objeto no encontrado');
    const url = await urlDeReproduccion(o);
    if (!url) return sendErrorResponse(res, 502, 'ACCOUNT_DOWN', 'El casillero de este objeto no está disponible');
    res.redirect(302, url);
  } catch (err) { next(err); }
});

export default router;
