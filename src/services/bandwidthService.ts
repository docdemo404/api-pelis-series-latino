import { CacheStore } from '../cache/store';

/**
 * Contador de tránsito del proxy de vídeo.
 *
 * Servir el vídeo desde la API es lo único que reproduce en el dispositivo del usuario cuando
 * el CDN ata la URL a la IP que la pidió, pero cuesta ancho de banda de verdad: una película
 * son 1-3 GB y el plan Hobby de Vercel ronda los 100 GB al mes. Cuando se agota el presupuesto,
 * /api/v1/stream/direct deja de proxear y pasa a redirigir a la URL recién acuñada: puede que
 * no reproduzca por la atadura de IP, pero el cliente aún tiene el embed como último recurso.
 *
 * El contador vive en CacheStore: con Vercel KV configurado se comparte entre instancias
 * serverless; sin él degrada a memoria por proceso y solo cuenta lo de esa instancia. Es
 * deliberado: un contador impreciso no debe impedir reproducir.
 */

const DEFAULT_BUDGET_GB = 80;
const BYTES_PER_GB = 1024 * 1024 * 1024;

/**
 * Cuánto vale el veredicto de presupuesto sin volver a preguntar a KV.
 *
 * Corto para que un cambio de estado se note enseguida, pero suficiente para que una ráfaga de
 * reproducciones —que es cuando importa la latencia— no se convierta en una petición de red por
 * cada una.
 */
const OVER_BUDGET_TTL_MS = 60 * 1000;

/** Clave mensual: el presupuesto se renueva solo al cambiar de mes. */
function currentKey(): string {
  return `bw:${new Date().toISOString().slice(0, 7)}`;
}

function budgetBytes(): number {
  const configured = Number(process.env.PROXY_MONTHLY_BUDGET_GB);
  const gb = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_BUDGET_GB;
  return gb * BYTES_PER_GB;
}

export class BandwidthService {
  /** Bytes proxeados en lo que va de mes. */
  static async used(): Promise<number> {
    const value = await CacheStore.get<number>(currentKey());
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  /**
   * ¿Se agotó el presupuesto del mes? Ante la duda, NO: nunca debe bloquear por un fallo de caché.
   *
   * La respuesta se recuerda en memoria del proceso unos segundos porque esto se consulta en el
   * camino crítico de CADA reproducción (`/api/v1/stream/direct`), y por debajo es una petición
   * HTTP a KV con dos segundos de timeout. Aunque va en paralelo al acuñado, sigue siendo
   * bloqueante: con KV lento, eran hasta dos segundos añadidos al tiempo hasta el primer
   * fotograma para decidir algo que cambia una vez al mes.
   *
   * Mientras el valor recordado siga fresco no se toca la red; cuando caduca, se devuelve el
   * último conocido y el refresco se lanza APARTE, sin que nadie lo espere. Un presupuesto
   * desactualizado durante un minuto no tiene ninguna consecuencia: se proxean unos megabytes de
   * más en el peor caso, y este contador nunca debió impedir reproducir.
   */
  private static cached: { value: boolean; at: number } | null = null;
  private static refreshing = false;

  static async isOverBudget(): Promise<boolean> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < OVER_BUDGET_TTL_MS) return this.cached.value;

    // Ya hay un valor, aunque viejo: se sirve y se refresca por detrás.
    if (this.cached) {
      void this.refreshOverBudget();
      return this.cached.value;
    }

    // Primera vez en este proceso: no hay nada que servir, toca esperar.
    return this.refreshOverBudget();
  }

  private static async refreshOverBudget(): Promise<boolean> {
    if (this.refreshing) return this.cached?.value ?? false;
    this.refreshing = true;
    try {
      const over = (await this.used()) >= budgetBytes();
      this.cached = { value: over, at: Date.now() };
      return over;
    } catch {
      return this.cached?.value ?? false;
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Suma lo servido. Se llama al terminar de enviar cada respuesta, en fire-and-forget:
   * contar nunca debe retrasar ni tumbar una reproducción.
   *
   * Va por INCRBY y no por leer-sumar-escribir: con varias lambdas sirviendo segmentos a la
   * vez, la segunda leía el mismo valor que la primera y la pisaba al escribir, de modo que el
   * contador subestimaba el consumo justo cuando más tráfico había — o sea, dejaba de proteger
   * precisamente cuando hacía falta.
   *
   * TTL de 40 días para que la clave del mes sobreviva al mes entero y se limpie sola.
   */
  static async add(bytes: number): Promise<void> {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    try {
      await CacheStore.incrBy(currentKey(), bytes, 40 * 24 * 60 * 60);
    } catch {}
  }

  /** Estado legible para el panel y el diagnóstico. */
  static async status(): Promise<{ used_bytes: number; budget_bytes: number; over_budget: boolean; shared_counter: boolean }> {
    const used = await this.used();
    const budget = budgetBytes();
    return {
      used_bytes: used,
      budget_bytes: budget,
      over_budget: used >= budget,
      shared_counter: CacheStore.isShared(),
    };
  }
}
