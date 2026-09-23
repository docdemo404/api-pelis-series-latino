/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * LOS CASILLEROS. La fuente propia con almacenamiento propio (R2 / Backblaze B2).
 *
 * Un "casillero" es una cuenta de R2 o B2 (S3-compatible). Aquí se subimos NUESTRAS películas y
 * series y las servimos a la app como una fuente más. Encaja con lo que ya existe: cada objeto
 * subido se registra como un SERVIDOR MANUAL (`source_id = manual`), así hereda toda la tubería ya
 * probada —resolución, protección de `manual_servers`, verificación— sin reinventar nada.
 *
 * DOS DECISIONES QUE VIENEN DE LA INFRA DE ESTE PROYECTO:
 *
 *   1. El archivo NO pasa por Vercel. Una película de 2 GB no cabe en el cuerpo de una función
 *      serverless ni en su tiempo. Por eso el navegador sube DIRECTO al bucket con una URL PUT
 *      prefirmada (ver `presignSubida`), y los bytes no tocan esta API.
 *
 *   2. Los enlaces del bucket CADUCAN. Una URL prefirmada dura horas. Por eso NO se guarda la URL:
 *      se guarda "qué objeto en qué cuenta", y el endpoint `/api/v1/pool/v/:id` firma una URL
 *      fresca y hace 302 en cada reproducción — el mismo patrón de 302-al-CDN que ya usa el vídeo.
 *
 * Este módulo es SOLO almacenamiento (cuentas + objetos + firma). Quien registra el servidor manual
 * en el catálogo es la ruta (`pool.routes.ts`), que orquesta subida → confirmación → alta.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */
import crypto from 'crypto';
import { getSupabaseAdmin } from './supabaseService';
import { getDb } from '../db/libsql';
import { httpClient } from '../utils/httpClient';
import { CredencialesS3, getPrefirmado, putPrefirmado, deletePrefirmado, listarPrefirmado } from '../utils/s3sign';

export type Proveedor = 'r2' | 'b2';

export interface CuentaCasillero {
  id: string;
  provider: Proveedor;
  label: string;
  endpoint: string;
  region: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
  used_bytes: number;
  cap_bytes: number;
  status: 'live' | 'dead';
  created_at?: string;
}

export interface ObjetoCasillero {
  id: string;
  tmdb_id: number;
  type: 'movie' | 'tvseries';
  season: number;
  episode: number;
  account_id: string;
  key: string;
  size_bytes: number;
  content_type: string;
  orig_filename: string;
  created_at?: string;
}

/** Tope gratis por proveedor, para no pasarse del free tier (lo que dispara la atención). */
export const CAP_POR_DEFECTO: Record<Proveedor, number> = {
  r2: 10 * 1024 ** 3, // 10 GB
  b2: 10 * 1024 ** 3, // 10 GB
};

const db = () => getSupabaseAdmin();

/** Las credenciales de firma de una cuenta. */
export function credDe(c: CuentaCasillero): CredencialesS3 {
  return {
    endpoint: c.endpoint.replace(/\/+$/, ''),
    region: c.region,
    bucket: c.bucket,
    accessKeyId: c.access_key_id,
    secretAccessKey: c.secret_access_key,
  };
}

/** El tipo de contenido a partir de la extensión, para servir el vídeo con su mime correcto. */
export function tipoContenido(nombre: string): string {
  const ext = (nombre.split('.').pop() || '').toLowerCase();
  const mapa: Record<string, string> = {
    mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm',
    avi: 'video/x-msvideo', mov: 'video/quicktime', ts: 'video/mp2t', m2ts: 'video/mp2t',
    flv: 'video/x-flv', wmv: 'video/x-ms-wmv', mpg: 'video/mpeg', mpeg: 'video/mpeg',
    ogv: 'video/ogg', '3gp': 'video/3gpp', m3u8: 'application/vnd.apple.mpegurl',
  };
  return mapa[ext] || 'application/octet-stream';
}

const extDe = (nombre: string): string => {
  const m = /\.[A-Za-z0-9]{1,5}$/.exec(nombre.trim());
  return m ? m[0].toLowerCase() : '';
};

/* ─────────────────────────────── cuentas ─────────────────────────────── */

export async function listarCuentas(): Promise<CuentaCasillero[]> {
  const { data } = await db().from<CuentaCasillero[]>('pool_accounts').select('*').order('created_at', { ascending: true });
  return (data as CuentaCasillero[]) || [];
}

export async function cuenta(id: string): Promise<CuentaCasillero | null> {
  const { data } = await db().from('pool_accounts').select('*').eq('id', id).maybeSingle();
  return (data as CuentaCasillero) || null;
}

/**
 * VALIDA las credenciales antes de guardar la cuenta: una consulta de LISTADO firmada. Si no
 * contesta 200, las llaves o el bucket están mal, y una cuenta muerta que envenena el reparto es
 * justo lo que hay que evitar. Es de solo lectura: no escribe nada en el casillero.
 */
export async function validarCredenciales(cred: CredencialesS3): Promise<{ ok: boolean; status: number; detalle?: string }> {
  try {
    const url = listarPrefirmado(cred);
    const r = await httpClient.get(url, { validateStatus: () => true, timeout: 15000, responseType: 'text' } as any);
    if (r.status === 200) return { ok: true, status: 200 };
    const cuerpo = String(r.data || '').slice(0, 300);
    return { ok: false, status: r.status, detalle: cuerpo || `HTTP ${r.status}` };
  } catch (e: any) {
    return { ok: false, status: 0, detalle: String(e?.message || e) };
  }
}

/** Da de alta un casillero. Valida credenciales primero; si fallan, no guarda. */
export async function anadirCuenta(input: {
  provider: Proveedor; label?: string; endpoint: string; region: string; bucket: string;
  accessKeyId: string; secretAccessKey: string; capBytes?: number;
}): Promise<{ ok: boolean; cuenta?: CuentaCasillero; error?: string; status?: number }> {
  const cred: CredencialesS3 = {
    endpoint: input.endpoint.replace(/\/+$/, ''),
    region: input.region,
    bucket: input.bucket,
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
  };
  const prueba = await validarCredenciales(cred);
  if (!prueba.ok) {
    return { ok: false, status: prueba.status, error: `Las credenciales no validaron (${prueba.status}): ${prueba.detalle || ''}`.trim() };
  }
  const fila: CuentaCasillero = {
    id: crypto.randomBytes(8).toString('hex'),
    provider: input.provider,
    label: (input.label || `${input.provider.toUpperCase()} ${input.bucket}`).slice(0, 80),
    endpoint: cred.endpoint,
    region: cred.region,
    bucket: cred.bucket,
    access_key_id: cred.accessKeyId,
    secret_access_key: cred.secretAccessKey,
    used_bytes: 0,
    cap_bytes: input.capBytes || CAP_POR_DEFECTO[input.provider],
    status: 'live',
    created_at: new Date().toISOString(),
  };
  const { error } = await db().from('pool_accounts').insert(fila as unknown as Record<string, unknown>);
  if (error) return { ok: false, error: error.message };
  return { ok: true, cuenta: fila };
}

export async function marcarCuenta(id: string, status: 'live' | 'dead'): Promise<boolean> {
  const { error } = await db().from('pool_accounts').update({ status }).eq('id', id);
  return !error;
}

export async function borrarCuenta(id: string): Promise<boolean> {
  const { error } = await db().from('pool_accounts').delete().eq('id', id);
  return !error;
}

/** Ajusta el uso de una cuenta en `delta` bytes (positivo al subir, negativo al borrar). */
async function ajustarUso(accountId: string, delta: number): Promise<void> {
  // `col = col + ?` no lo cubre el adaptador; va por SQL a pelo, acotado a >= 0.
  await getDb().execute({
    sql: 'UPDATE pool_accounts SET used_bytes = MAX(0, used_bytes + ?) WHERE id = ?',
    args: [Math.round(delta), accountId],
  });
}

/**
 * ELIGE UN CASILLERO CON HUECO para un archivo de `size` bytes: cuenta `live` con más espacio
 * libre, respetando el tope. Si se pide un `provider`, solo de ese. Null si no cabe en ninguno.
 */
export async function elegirCuenta(size: number, provider?: Proveedor): Promise<CuentaCasillero | null> {
  const cuentas = (await listarCuentas())
    .filter(c => c.status === 'live')
    .filter(c => !provider || c.provider === provider)
    .filter(c => (c.cap_bytes - c.used_bytes) >= size)
    .sort((a, b) => (b.cap_bytes - b.used_bytes) - (a.cap_bytes - a.used_bytes));
  return cuentas[0] || null;
}

/* ─────────────────────────────── objetos ─────────────────────────────── */

/**
 * Prepara una SUBIDA: elige cuenta, arma la clave y devuelve una URL PUT prefirmada. NO inserta el
 * objeto todavía —eso lo hace `registrarObjeto` cuando el navegador confirma que el PUT terminó—,
 * así una subida que se cancela no deja una fila fantasma.
 */
export async function presignSubida(input: {
  tmdbId: number; tipo: 'movie' | 'tvseries'; season?: number; episode?: number;
  filename: string; size: number; accountId?: string; provider?: Proveedor;
}): Promise<{ ok: boolean; error?: string; objectId?: string; accountId?: string; key?: string; url?: string; contentType?: string }> {
  const size = Math.max(0, Math.round(input.size || 0));
  let c: CuentaCasillero | null = null;
  if (input.accountId) {
    c = await cuenta(input.accountId);
    if (!c) return { ok: false, error: 'La cuenta indicada no existe' };
    if (c.status !== 'live') return { ok: false, error: 'La cuenta está marcada como caída' };
    if ((c.cap_bytes - c.used_bytes) < size) return { ok: false, error: 'La cuenta no tiene hueco para este archivo' };
  } else {
    c = await elegirCuenta(size, input.provider);
    if (!c) return { ok: false, error: 'Ningún casillero tiene hueco para este archivo. Añade una cuenta o sube algo más pequeño.' };
  }

  const objectId = crypto.randomBytes(12).toString('hex');
  const s = Math.max(0, Number(input.season) || 0);
  const e = Math.max(0, Number(input.episode) || 0);
  const key = `${input.tmdbId}/${s}x${e}/${objectId}${extDe(input.filename)}`;
  const url = putPrefirmado(credDe(c), key, 3600);
  return { ok: true, objectId, accountId: c.id, key, url, contentType: tipoContenido(input.filename) };
}

/** Registra el objeto ya subido y descuenta su tamaño del casillero. */
export async function registrarObjeto(input: {
  objectId: string; tmdbId: number; tipo: 'movie' | 'tvseries'; season?: number; episode?: number;
  accountId: string; key: string; size: number; filename: string;
}): Promise<{ ok: boolean; objeto?: ObjetoCasillero; error?: string }> {
  const c = await cuenta(input.accountId);
  if (!c) return { ok: false, error: 'La cuenta no existe' };
  const fila: ObjetoCasillero = {
    id: input.objectId,
    tmdb_id: input.tmdbId,
    type: input.tipo,
    season: Math.max(0, Number(input.season) || 0),
    episode: Math.max(0, Number(input.episode) || 0),
    account_id: input.accountId,
    key: input.key,
    size_bytes: Math.max(0, Math.round(input.size || 0)),
    content_type: tipoContenido(input.filename),
    orig_filename: String(input.filename || '').slice(0, 255),
    created_at: new Date().toISOString(),
  };
  const { error } = await db().from('pool_objects').insert(fila as unknown as Record<string, unknown>);
  if (error) return { ok: false, error: error.message };
  await ajustarUso(input.accountId, fila.size_bytes);
  return { ok: true, objeto: fila };
}

export async function objeto(id: string): Promise<ObjetoCasillero | null> {
  const { data } = await db().from('pool_objects').select('*').eq('id', id).maybeSingle();
  return (data as ObjetoCasillero) || null;
}

export async function objetosDeFicha(tmdbId: number, tipo: 'movie' | 'tvseries'): Promise<ObjetoCasillero[]> {
  const { data } = await db().from<ObjetoCasillero[]>('pool_objects')
    .select('*').eq('tmdb_id', tmdbId).eq('type', tipo).order('created_at', { ascending: true });
  return (data as ObjetoCasillero[]) || [];
}

/**
 * La URL FRESCA de reproducción de un objeto: GET prefirmado con `response-content-type` forzado a
 * su mime, para que un .mkv se sirva como vídeo y no como descarga. Es a donde hace 302 el endpoint
 * público en cada reproducción.
 */
export async function urlDeReproduccion(o: ObjetoCasillero, expiraEn = 6 * 3600): Promise<string | null> {
  const c = await cuenta(o.account_id);
  if (!c || c.status !== 'live') return null;
  return getPrefirmado(credDe(c), o.key, expiraEn, o.content_type || tipoContenido(o.key));
}

/** Borra el objeto: del bucket, de la tabla, y devuelve su tamaño al casillero. */
export async function borrarObjeto(id: string): Promise<{ ok: boolean; error?: string }> {
  const o = await objeto(id);
  if (!o) return { ok: false, error: 'No existe' };
  const c = await cuenta(o.account_id);
  if (c) {
    try {
      await httpClient.delete(deletePrefirmado(credDe(c), o.key), { validateStatus: () => true, timeout: 15000 } as any);
    } catch { /* el objeto puede haberse borrado ya; se sigue limpiando la fila */ }
  }
  const { error } = await db().from('pool_objects').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  if (c) await ajustarUso(o.account_id, -o.size_bytes);
  return { ok: true };
}
