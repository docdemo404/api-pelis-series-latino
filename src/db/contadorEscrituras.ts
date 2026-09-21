/**
 * CUÁNTO ESCRIBE CADA PROCESO, porque la cuota que se agota es de FILAS ESCRITAS AL MES.
 *
 * Pasó dos veces con dos proveedores: Supabase se cortó por transferencia (2026-09) y Turso por
 * filas escritas (2026-09-21), y las dos veces sin saber qué job se había comido la cuota. Esto
 * envuelve el cliente de libSQL y cuenta, por tabla:
 *
 *   · sentencias de escritura intentadas (también las que fallan: con la cuota agotada es lo
 *     único que se ve, y dice quién lo intentaría);
 *   · filas escritas de verdad (`rowsAffected`, lo que Turso factura);
 *   · sentencias rechazadas por BLOCKED.
 *
 * Los scripts imprimen el resumen al salir; la API apunta lo que escribe cada petición (api/index.ts).
 *
 * OJO: `rowsAffected` no incluye lo que escriben los disparadores. El de `enlace_permanente` escribía
 * una segunda vez en cada guardado de servers/seasons; desde el esquema v5 solo si el valor cambia.
 */
import type { Client, InStatement } from '@libsql/client';

interface PorTabla { intentadas: number; filas: number; bloqueadas: number }
const porTabla = new Map<string, PorTabla>();
let total = 0;

const ESCRITURA = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?([A-Za-z_][A-Za-z0-9_]*)/i;

function tablaDe(stmt: InStatement): string | null {
  const sql = typeof stmt === 'string' ? stmt : stmt.sql;
  const m = ESCRITURA.exec(sql);
  return m ? m[1] : null;
}

function apuntar(tabla: string, filas: number, bloqueada: boolean) {
  const t = porTabla.get(tabla) || { intentadas: 0, filas: 0, bloqueadas: 0 };
  t.intentadas++;
  t.filas += filas;
  if (bloqueada) t.bloqueadas++;
  porTabla.set(tabla, t);
  total += filas;
}

const esBloqueo = (e: any) => /BLOCKED|writes are blocked/i.test(String(e?.message || e?.code || ''));

/** Filas escritas por este proceso hasta ahora. Para medir el delta de una petición. */
export function filasEscritas(): number {
  return total;
}

export function resumenEscrituras(): string {
  if (!porTabla.size) return '';
  return [...porTabla.entries()]
    .sort((a, b) => b[1].filas - a[1].filas || b[1].intentadas - a[1].intentadas)
    .map(([t, v]) => `${t}: ${v.filas} filas en ${v.intentadas} sentencias${v.bloqueadas ? ` (${v.bloqueadas} BLOQUEADAS)` : ''}`)
    .join(' · ');
}

/** El mismo cliente, contando. Lo que no es execute/batch pasa tal cual. */
export function conContador(cliente: Client): Client {
  return new Proxy(cliente, {
    get(obj, prop, recv) {
      if (prop === 'execute') {
        return async (stmt: InStatement, ...resto: any[]) => {
          const tabla = tablaDe(stmt);
          try {
            const rs = await (obj.execute as any)(stmt, ...resto);
            if (tabla) apuntar(tabla, rs.rowsAffected || 0, false);
            return rs;
          } catch (e) {
            if (tabla) apuntar(tabla, 0, esBloqueo(e));
            throw e;
          }
        };
      }
      if (prop === 'batch') {
        return async (stmts: InStatement[], ...resto: any[]) => {
          const tablas = stmts.map(tablaDe);
          try {
            const rss = await (obj.batch as any)(stmts, ...resto);
            rss.forEach((rs: any, i: number) => { if (tablas[i]) apuntar(tablas[i]!, rs.rowsAffected || 0, false); });
            return rss;
          } catch (e) {
            const b = esBloqueo(e);
            tablas.forEach((t) => { if (t) apuntar(t, 0, b); });
            throw e;
          }
        };
      }
      const v = Reflect.get(obj, prop, recv);
      return typeof v === 'function' ? v.bind(obj) : v;
    },
  });
}

/** En scripts (no en Vercel), una línea al salir con quién escribió qué. */
if (!process.env.VERCEL) {
  process.on('exit', () => {
    const r = resumenEscrituras();
    if (!r) return;
    const quien = (process.env.GITHUB_WORKFLOW ? `${process.env.GITHUB_WORKFLOW} · ` : '')
      + (process.argv[1] || '').replace(/\\/g, '/').split('/').slice(-2).join('/');
    console.log(`\n[escrituras] ${quien} → ${total} filas escritas · ${r}`);
  });
}
