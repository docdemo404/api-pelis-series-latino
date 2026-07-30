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

/**
 * SEGUNDO NIVEL, EN MEMORIA, PARA EL CAMINO DEL VÍDEO.
 *
 * Redis es compartido —esa es su gracia— pero se habla con él por HTTP, y una reproducción
 * encadena tres lecturas antes del primer fotograma: el acuñado, el veredicto de destino y el
 * manifiesto. Medido en producción, arrancar un vídeo costaba ~0,95 s y cada salto en la barra
 * ~0,4 s, y ahí dentro no había ni scraping ni CDN: eran esos viajes, uno detrás de otro.
 *
 * Una misma instancia atiende muchas peticiones del mismo vídeo (segmentos, cambios de calidad,
 * saltos), así que recordar la respuesta unos segundos EN EL PROCESO convierte esas lecturas en
 * cero. Redis sigue siendo la fuente compartida; esto solo evita repetirle la misma pregunta
 * varias veces por segundo.
 *
 * SOLO PARA ESTOS PREFIJOS, y la lista es corta a propósito: son datos de reproducción, que se
 * regeneran solos y cuyo peor caso es un acuñado de más. El catálogo NO entra —sus claves se
 * purgan a mano cuando se repara una ficha, y un recuerdo en memoria haría que la reparación
 * tardara en verse justo en la instancia que la sirve, que es el fallo que se acaba de arreglar
 * con las claves de episodio.
 */
const PREFIJOS_MEMORIZABLES = ['mint:', 'verdict:', 'm3u8:', 'salud:'];

/** Cuánto se recuerda en el proceso. Corto: es un atajo, no una segunda verdad. */
const MEMORIA_MS = 20_000;

const memoriaCorta = new Map<string, { value: unknown; expira: number }>();

function memorizable(key: string): boolean {
  return PREFIJOS_MEMORIZABLES.some(p => key.startsWith(p));
}

function recordar(clave: string, valor: unknown): void {
  memoriaCorta.set(clave, { value: valor, expira: Date.now() + MEMORIA_MS });
  // Tope duro: una instancia de Vercel es efímera, pero un vídeo largo son cientos de claves.
  if (memoriaCorta.size > 500) {
    const primera = memoriaCorta.keys().next();
    if (!primera.done) memoriaCorta.delete(primera.value);
  }
}

export class CacheStore {
  static isShared(): boolean {
    return Boolean(KV_URL() && KV_TOKEN());
  }

  static async get<T>(key: string): Promise<T | null> {
    const k = NAMESPACE + key;
    if (!this.isShared()) return memoryGet<T>(k);

    const corto = memorizable(key) ? memoriaCorta.get(k) : undefined;
    if (corto && Date.now() < corto.expira) return corto.value as T;

    const raw = await kvCommand<string>(['GET', k]);
    if (raw === null || raw === undefined) return null;
    try {
      const valor = JSON.parse(raw) as T;
      if (memorizable(key)) recordar(k, valor);
      return valor;
    } catch {
      return null;
    }
  }

  /** Nunca lanza: un fallo de caché no debe afectar la respuesta. */
  static async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const k = NAMESPACE + key;
    memorySet(k, value, ttlSeconds); // siempre poblar la copia local (lecturas calientes gratis)
    // Lo que se acaba de escribir también vale para las lecturas inmediatas de esta instancia.
    if (memorizable(key)) recordar(k, value);
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

    // También el recuerdo corto del camino de vídeo: si no, borrar un veredicto no serviría de
    // nada en la instancia que acaba de leerlo.
    for (const k of full) { memoryCache.delete(k); memoriaCorta.delete(k); }
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
