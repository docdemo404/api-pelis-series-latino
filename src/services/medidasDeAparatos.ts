import { getSupabaseAdmin } from './supabaseService';

/**
 * ───────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE MIDEN LOS APARATOS DE VERDAD, QUE MANDA SOBRE LO QUE MIDE ESTA API.
 *
 * `streamSorter` ordena, entre otras cosas, por `servers.kbps`: lo que el host dio cuando el crawl
 * lo comprobó. Es el mejor dato que había y no es bueno, porque mide **otra red en otro momento**.
 * Comprobado el 26/08/2026 sobre una ficha del catálogo:
 *
 *     el catálogo dice   kbps: 82    (para un fichero con kbps_necesarios: 520)
 *     un aparato midió   2,0 MB/s  = 16 000 kbps
 *
 * Y no es que el sondeo esté roto: el propio `streamSorter` ya lo dice en un comentario —
 * «archive.org daba 1,33 MB/s por la mañana y 35 KB/s por la tarde». Una foto de un host a rachas
 * no describe al host.
 *
 * Lo que sí lo describe es la mediana de lo que dio en reproducciones reales, desde las redes de
 * quien lo ve. Eso ya está llegando a `playback_events` (ver migración 013).
 *
 * ── POR QUE UNA COPIA EN MEMORIA Y NO UNA CONSULTA ─────────────────────────────────────────
 *
 * Quien pregunta es el comparador de `sortServersBySourcePriority`, que es SÍNCRONO y corre en
 * mitad de armar una respuesta. No puede esperar a la base. Es el mismo patrón que ya usan
 * `SourceManager` y `hostsConCache`: una copia que se refresca aparte, y mientras no esté, se
 * contesta que no se sabe — que es la respuesta que no cambia el comportamiento de nadie.
 * ───────────────────────────────────────────────────────────────────────────────────────────
 */

export interface MedidaDeHost {
  /** Mediana del caudal medido por los aparatos, en kbps. */
  kbps: number;
  /** Reproducciones que aportaron el dato. Por debajo de [MINIMO_MUESTRAS] no se publica. */
  muestras: number;
  /** Media de reconexiones por reproducción. Alto = este host estrangula. */
  reconexiones: number;
}

const enMemoria = new Map<string, MedidaDeHost>();
let leidoEn = 0;

/**
 * Cuánto vale la copia antes de volver a preguntar.
 *
 * Diez minutos. Esto no cambia deprisa —hacen falta muchas reproducciones para mover una mediana—
 * y cada refresco es una consulta que se paga en el camino de una respuesta.
 */
const VIGENCIA_MS = 10 * 60 * 1000;

/**
 * Cuántas reproducciones hacen falta antes de creerse la mediana de un host.
 *
 * Cinco. Con una sola, lo que se estaría publicando es la red de una persona un martes por la
 * tarde, y eso es exactamente el error que se le reprocha al sondeo del crawl. Por debajo del
 * mínimo la respuesta es «no se sabe» y decide el criterio de siempre.
 */
const MINIMO_MUESTRAS = 5;

/** Cuánto pasado se mira. Más allá, el host puede ser ya otro. */
const VENTANA_DIAS = 7;

/** Tope de filas por consulta. De sobra para el volumen de este catálogo. */
const TOPE_FILAS = 5000;

function mediana(valores: number[]): number {
  const orden = [...valores].sort((a, b) => a - b);
  const medio = Math.floor(orden.length / 2);
  return orden.length % 2 ? orden[medio] : Math.round((orden[medio - 1] + orden[medio]) / 2);
}

/**
 * Lo que los aparatos han medido de este host, o `undefined` si no hay suficiente.
 *
 * Síncrono a propósito. Ver la nota de arriba.
 */
export function medidaDeAparatos(host: string | undefined | null): MedidaDeHost | undefined {
  const limpio = String(host || '').trim().toLowerCase().replace(/^www\./, '');
  if (!limpio) return undefined;
  return enMemoria.get(limpio);
}

/**
 * Refresca la copia desde la base.
 *
 * **No propaga fallos.** Si la tabla no existe todavía —la migración 013 se pega a mano, como
 * todas— o la consulta falla, se deja lo que hubiera y el catálogo ordena como ordenaba antes.
 * Una mejora que puede tumbar el catálogo no es una mejora.
 */
export async function refrescarMedidasDeAparatos(): Promise<number> {
  const desde = new Date(Date.now() - VENTANA_DIAS * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await getSupabaseAdmin()
    .from('playback_events')
    .select('server_host, kbps_medidos, reconexiones')
    .gte('created_at', desde)
    .not('server_host', 'is', null)
    .not('kbps_medidos', 'is', null)
    .limit(TOPE_FILAS);

  if (error || !data) return enMemoria.size;

  const porHost = new Map<string, { kbps: number[]; reconexiones: number[] }>();
  for (const fila of data as Array<Record<string, unknown>>) {
    const host = String(fila.server_host || '').trim().toLowerCase().replace(/^www\./, '');
    const kbps = Number(fila.kbps_medidos);
    if (!host || !Number.isFinite(kbps) || kbps <= 0) continue;

    const acumulado = porHost.get(host) || { kbps: [], reconexiones: [] };
    acumulado.kbps.push(kbps);
    acumulado.reconexiones.push(Number(fila.reconexiones) || 0);
    porHost.set(host, acumulado);
  }

  enMemoria.clear();
  for (const [host, valores] of porHost) {
    if (valores.kbps.length < MINIMO_MUESTRAS) continue;
    enMemoria.set(host, {
      kbps: mediana(valores.kbps),
      muestras: valores.kbps.length,
      reconexiones:
        Math.round((valores.reconexiones.reduce((a, b) => a + b, 0) / valores.reconexiones.length) * 100) / 100,
    });
  }

  leidoEn = Date.now();
  return enMemoria.size;
}

/** Se asegura de tener la copia al día, una vez cada [VIGENCIA_MS] por proceso. */
export async function asegurarMedidasDeAparatos(): Promise<void> {
  if (leidoEn && Date.now() - leidoEn < VIGENCIA_MS) return;
  // Se marca ANTES de pedir: si la consulta falla, no se reintenta en cada petición.
  leidoEn = Date.now();
  await refrescarMedidasDeAparatos().catch(() => 0);
}
