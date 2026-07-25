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

  /** ¿Se agotó el presupuesto del mes? Ante la duda, NO: nunca debe bloquear por un fallo de caché. */
  static async isOverBudget(): Promise<boolean> {
    try {
      return (await this.used()) >= budgetBytes();
    } catch {
      return false;
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
