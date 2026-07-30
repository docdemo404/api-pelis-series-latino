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
   * Suma sobre un contador de forma ATÓMICA.
   *
   * No es lo mismo que leer, sumar y escribir con `set`: con varias instancias serverless
   * escribiendo a la vez, las dos leen el mismo valor y la última sobrescribe a la primera, así
   * que el contador se queda corto justo cuando más tráfico hay. Redis lo resuelve de un golpe
   * con INCRBY. Sin Redis no hay concurrencia real entre procesos, así que el Map basta.
   */
  static async incrBy(key: string, amount: number, ttlSeconds: number): Promise<void> {
    const k = NAMESPACE + key;
    if (!this.isShared()) {
      memorySet(k, (memoryGet<number>(k) || 0) + amount, ttlSeconds);
      return;
    }
    try {
      await kvCommand(['INCRBY', k, String(amount)]);
      await kvCommand(['EXPIRE', k, String(ttlSeconds)]);
    } catch {}
  }

  /**
   * BORRA claves concretas, en Redis y en memoria.
   *
   * Hace falta porque el caché de metadata vive 6 h: sin esto, arreglar una ficha en la base de
   * datos no se nota hasta que caduque su entrada, y la API sigue sirviendo el póster, la sinopsis
   * o los alias viejos durante horas. Con Redis compartido no basta ni con redesplegar —las claves
   * sobreviven a los despliegues—, así que quien repara una ficha tiene que retirarla del caché.
   *
   * Nunca lanza: fallar al invalidar no puede tumbar una reparación.
   */
  static async del(...keys: string[]): Promise<void> {
    const full = keys.filter(Boolean).map(k => NAMESPACE + k);
    if (full.length === 0) return;

    for (const k of full) memoryCache.delete(k);
    if (!this.isShared()) return;
    try {
      await kvCommand(['DEL', ...full]);
    } catch {}
  }

  /**
   * Lista las claves guardadas que casan con un patrón (sin el prefijo del proyecto).
   *
   * Sirve para encontrar entradas HUÉRFANAS: cuando una reparación funde un duplicado borra su
   * fila, pero su entrada de caché sigue viva y ese id responde 200 con la metadata de la obra
   * equivocada. Al no estar en la tabla, ninguna consulta a la base la encuentra — hay que
   * preguntarle al caché qué tiene guardado.
   *
   * Recorre con SCAN, no con KEYS, para no bloquear el servidor. Devuelve [] sin Redis.
   */
  static async keys(pattern: string): Promise<string[]> {
    if (!this.isShared()) {
      return Array.from(memoryCache.keys())
        .filter(k => k.startsWith(NAMESPACE))
        .map(k => k.slice(NAMESPACE.length));
    }

    const encontradas: string[] = [];
    let cursor = '0';
    do {
      const res = await kvCommand<[string, string[]]>(['SCAN', cursor, 'MATCH', NAMESPACE + pattern, 'COUNT', '500']);
      if (!res || !Array.isArray(res)) break;
      cursor = String(res[0]);
      for (const k of res[1] || []) encontradas.push(String(k).slice(NAMESPACE.length));
    } while (cursor !== '0');

    return encontradas;
  }

  /**
   * Limpia el caché en memoria del proceso. En Redis las claves expiran por TTL;
   * no se hace FLUSH global para no arrasar claves ajenas al proyecto (para borrar las de una
   * ficha concreta, `del`).
   */
  static clear(): void {
    memoryCache.clear();
  }
}
