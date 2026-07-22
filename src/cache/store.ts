import axios from 'axios';

/**
 * Caché compartido con TTL para la API.
 *
 * Backend:
 *  - Si hay credenciales de Vercel KV / Upstash Redis (REST) en el entorno, usa Redis:
 *    las entradas SOBREVIVEN cold starts y se COMPARTEN entre instancias serverless.
 *  - Si no, degrada a un Map en memoria por proceso (comportamiento previo del proyecto).
 *
 * Variables soportadas (cualquiera de los dos pares):
 *  - KV_REST_API_URL / KV_REST_API_TOKEN                 (Vercel KV)
 *  - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (Upstash directo)
 */

const KV_URL = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const NAMESPACE = 'apipelis:';

// ─── Fallback en memoria (por instancia) ─────────────────────────────────────
const memoryCache = new Map<string, { value: unknown; expiresAt: number }>();

function memoryGet<T>(key: string): T | null {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return entry.value as T;
}

function memorySet(key: string, value: unknown, ttlSeconds: number): void {
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

// ─── Backend Redis vía REST (Upstash / Vercel KV) ────────────────────────────
async function kvCommand<T>(command: unknown[]): Promise<T | null> {
  try {
    const res = await axios.post(KV_URL(), command, {
      headers: { Authorization: `Bearer ${KV_TOKEN()}` },
      timeout: 2000
    });
    return (res.data && res.data.result !== undefined ? res.data.result : null) as T | null;
  } catch {
    return null; // el caché nunca debe tumbar una request
  }
}

export class CacheStore {
  static isShared(): boolean {
    return Boolean(KV_URL() && KV_TOKEN());
  }

  static async get<T>(key: string): Promise<T | null> {
    const k = NAMESPACE + key;
    if (!this.isShared()) return memoryGet<T>(k);

    const raw = await kvCommand<string>(['GET', k]);
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** Nunca lanza: un fallo de caché no debe afectar la respuesta. */
  static async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const k = NAMESPACE + key;
    memorySet(k, value, ttlSeconds); // siempre poblar la copia local (lecturas calientes gratis)
    if (!this.isShared()) return;
    try {
      await kvCommand(['SET', k, JSON.stringify(value), 'EX', String(ttlSeconds)]);
    } catch {}
  }

  /**
   * Limpia el caché en memoria del proceso. En Redis las claves expiran por TTL;
   * no se hace FLUSH global para no arrasar claves ajenas al proyecto.
   */
  static clear(): void {
    memoryCache.clear();
  }
}
