/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * GOOGLE DRIVE COMO CASILLERO. La tercera pata de la fuente propia, por OAuth.
 *
 * Drive NO habla S3, así que no hay URL prefirmada como en R2/B2. Se usa OAuth:
 *
 *   · SUBIR: el servidor abre una "sesión de subida reanudable" (con un access token fresco) y le
 *     pasa al navegador la URL de sesión. El navegador hace PUT del archivo DIRECTO a esa URL —los
 *     bytes no pasan por Vercel—, y NO necesita cabecera de auth (la URL de sesión ya autoriza).
 *   · REPRODUCIR: en cada reproducción se acuña un access token fresco y se hace 302 a
 *     `…/files/{id}?alt=media&access_token=…`, que soporta Range. El scope es `drive.file`, así que
 *     ese token SOLO puede tocar los archivos que subió esta app — si se filtra, no expone nada
 *     personal del Drive del usuario.
 *
 * El `client_id`/`client_secret` son de la app (uno para todas las cuentas): env var si está, o la
 * tabla `app_settings` (editable desde el panel). El `refresh_token` es por cuenta y vive en
 * `pool_accounts.secret_access_key`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */
import { httpClient } from '../utils/httpClient';
import { getSupabaseAdmin } from './supabaseService';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// `drive.file`: la app solo ve y toca los archivos que ella misma crea. Es el permiso mínimo, y lo
// que hace seguro poner el token en la URL del 302.
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

export interface GDriveConfig { client_id: string; client_secret: string; }

/** El cliente OAuth de la app: env var primero, luego la tabla de ajustes. */
export async function leerConfig(): Promise<GDriveConfig | null> {
  const id = process.env.GDRIVE_CLIENT_ID, secret = process.env.GDRIVE_CLIENT_SECRET;
  if (id && secret) return { client_id: id, client_secret: secret };
  try {
    // Vía el cliente compat: aplica el esquema si hace falta (en local) y se salta bien en Vercel.
    const { data } = await getSupabaseAdmin().from('app_settings').select('valor').eq('clave', 'gdrive_oauth').maybeSingle();
    const raw = (data as any)?.valor;
    if (!raw) return null;
    const j = JSON.parse(String(raw));
    return j.client_id && j.client_secret ? { client_id: j.client_id, client_secret: j.client_secret } : null;
  } catch { return null; }
}

export async function guardarConfig(cfg: GDriveConfig): Promise<void> {
  const { error } = await getSupabaseAdmin().from('app_settings').upsert(
    { clave: 'gdrive_oauth', valor: JSON.stringify({ client_id: cfg.client_id, client_secret: cfg.client_secret }) },
    { onConflict: 'clave' },
  );
  if (error) throw new Error(error.message);
}

/**
 * La URL de consentimiento de Google. `access_type=offline` + `prompt=consent` para que dé
 * refresh_token. `state` marca de dónde vino (p.ej. 'app'), para que el callback sepa si al terminar
 * debe volver a la app por deep-link o cerrar la pestaña del panel web.
 */
export function urlDeConsentimiento(cfg: GDriveConfig, redirectUri: string, state?: string): string {
  const p = new URLSearchParams({
    client_id: cfg.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  if (state) p.set('state', state);
  return `${AUTH_URL}?${p.toString()}`;
}

/** Cambia el `code` del callback por tokens; de paso lee el email de la cuenta. */
export async function intercambiarCodigo(cfg: GDriveConfig, code: string, redirectUri: string): Promise<{ refresh_token: string; access_token: string; email: string }> {
  const r = await httpClient.post(TOKEN_URL, new URLSearchParams({
    code, client_id: cfg.client_id, client_secret: cfg.client_secret,
    redirect_uri: redirectUri, grant_type: 'authorization_code',
  }).toString(), { headers: FORM, timeout: 15000, validateStatus: () => true } as any);
  if (r.status !== 200 || !r.data?.refresh_token) {
    throw new Error('Google no devolvió refresh_token (¿faltó "acceso sin conexión" o ya estaba autorizada?): ' + JSON.stringify(r.data || {}).slice(0, 200));
  }
  const access = r.data.access_token as string;
  let email = '';
  try {
    const ab = await httpClient.get('https://www.googleapis.com/drive/v3/about?fields=user', {
      headers: { Authorization: `Bearer ${access}` }, timeout: 10000, validateStatus: () => true,
    } as any);
    email = ab.data?.user?.emailAddress || '';
  } catch { /* el email es cosmético */ }
  return { refresh_token: r.data.refresh_token, access_token: access, email };
}

// Access tokens en memoria del proceso (~1 h de vida). Evita renovar en cada reproducción.
const cacheToken = new Map<string, { token: string; exp: number }>();

/** Un access token fresco a partir del refresh token, cacheado. */
export async function accessToken(cfg: GDriveConfig, refreshToken: string): Promise<string> {
  const guardado = cacheToken.get(refreshToken);
  if (guardado && guardado.exp > Date.now() + 60_000) return guardado.token;
  const r = await httpClient.post(TOKEN_URL, new URLSearchParams({
    client_id: cfg.client_id, client_secret: cfg.client_secret,
    refresh_token: refreshToken, grant_type: 'refresh_token',
  }).toString(), { headers: FORM, timeout: 15000, validateStatus: () => true } as any);
  if (r.status !== 200 || !r.data?.access_token) {
    throw new Error('No se pudo renovar el token de Google (¿cuenta desconectada?): ' + JSON.stringify(r.data || {}).slice(0, 200));
  }
  const token = r.data.access_token as string;
  cacheToken.set(refreshToken, { token, exp: Date.now() + (Number(r.data.expires_in || 3600) * 1000) });
  return token;
}

/**
 * Abre una sesión de subida reanudable y devuelve su URL. El archivo se sube con `nombre` = nuestro
 * objectId, para poder resolver el id de Drive después SIN depender de leer la respuesta del PUT
 * (que el navegador podría no poder leer por CORS).
 */
export async function crearSesionSubida(token: string, nombre: string, mime: string): Promise<string> {
  const r = await httpClient.post(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id',
    { name: nombre },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mime || 'application/octet-stream',
      },
      timeout: 15000, validateStatus: () => true,
    } as any,
  );
  const loc = (r.headers?.location || r.headers?.Location) as string | undefined;
  if (r.status !== 200 || !loc) throw new Error('Google no abrió la sesión de subida (HTTP ' + r.status + ')');
  return loc;
}

/** Resuelve el id de Drive del archivo subido, buscándolo por el nombre (= objectId). */
export async function buscarPorNombre(token: string, nombre: string): Promise<{ id: string; size: number } | null> {
  const r = await httpClient.get('https://www.googleapis.com/drive/v3/files', {
    params: { q: `name = '${nombre.replace(/'/g, "\\'")}' and trashed = false`, fields: 'files(id,size)', spaces: 'drive', pageSize: 1 },
    headers: { Authorization: `Bearer ${token}` }, timeout: 10000, validateStatus: () => true,
  } as any);
  const f = r.data?.files?.[0];
  return f?.id ? { id: f.id, size: Number(f.size) || 0 } : null;
}

/** La URL de reproducción: media de Drive con token en la query (scope drive.file → seguro). */
export function urlMedia(fileId: string, token: string): string {
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&access_token=${encodeURIComponent(token)}`;
}

export async function borrarArchivo(token: string, fileId: string): Promise<void> {
  await httpClient.delete(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    headers: { Authorization: `Bearer ${token}` }, timeout: 15000, validateStatus: () => true,
  } as any);
}
