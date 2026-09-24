/**
 * PRESUPUESTO DIARIO DE LECTURAS, compartido entre TODOS los procesos vía Redis (CacheStore).
 *
 * El problema real de este proyecto no es un crawler concreto: es que muchas manos (Claude, Codex,
 * Antigravity, personas) meten automatizaciones glotonas que bajan tablas enteras, y entre todas
 * agotan la cuota de lecturas del plan y tumban la base (pasó el 2026-09-24: 572M/500M → bloqueada).
 *
 * Este contador vive en Redis (INCRBY atómico), así que lo comparten todos los runners de GitHub
 * Actions. Cada crawler suma lo que lee; cuando el día supera el presupuesto, los siguientes runs se
 * saltan solos. Así NINGUNA combinación de crawlers puede drenar la cuota, venga de quien venga.
 *
 * Vive en Redis, no en Turso, a propósito: sigue funcionando aunque Turso esté bloqueada.
 */
import { CacheStore } from '../cache/store';

/** 15M/día × 30 ≈ 450M/mes, por debajo de los 500M del plan gratis de Turso. Ajustable por entorno. */
const PRESUPUESTO = Math.max(0, Number(process.env.PRESUPUESTO_LECTURAS_DIARIO) || 15_000_000);
const TTL = 2 * 24 * 3600; // dos días, por si el reloj del reset no cuadra al minuto

function claveDeHoy(): string {
  return `presupuesto:lecturas:${new Date().toISOString().slice(0, 10)}`; // YYYY-MM-DD (UTC)
}

export function presupuestoDiario(): number { return PRESUPUESTO; }

/** ¿Se gastó ya el presupuesto de hoy (sumando TODOS los procesos)? */
export async function presupuestoAgotado(): Promise<boolean> {
  if (PRESUPUESTO <= 0) return false;
  try {
    const n = await CacheStore.get<number>(claveDeHoy());
    return typeof n === 'number' && n >= PRESUPUESTO;
  } catch { return false; }
}

/** Suma lecturas al contador diario compartido (atómico). */
export async function registrarLecturas(n: number): Promise<void> {
  if (n <= 0 || PRESUPUESTO <= 0) return;
  try { await CacheStore.incrBy(claveDeHoy(), n, TTL); } catch { /* Redis caído: mejor no romper */ }
}

/** Cuánto se ha leído hoy, para logs. */
export async function leidasHoy(): Promise<number> {
  try { return (await CacheStore.get<number>(claveDeHoy())) || 0; } catch { return 0; }
}
