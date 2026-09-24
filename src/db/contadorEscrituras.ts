/**
 * CUÁNTO LEE Y ESCRIBE CADA PROCESO. La cuota que se agota es de FILAS (escritas o leídas) al mes,
 * y en este proyecto trabajan muchas manos (Claude, Codex, Antigravity, personas) que meten crawlers
 * glotones. Este envoltorio del cliente libSQL es el ÚNICO punto por donde pasa todo el acceso a la
 * base, así que aquí se mide y se pone el freno, sin depender de la disciplina de cada quien.
 *
 * Escrituras (se cortó por esto el 2026-09-21): cuenta por tabla sentencias intentadas, filas
 * escritas (`rowsAffected`, lo que se factura) y las rechazadas por BLOCKED.
 *
 * Lecturas (se cortó por esto el 2026-09-24: 572M/500M): cuenta filas DEVUELTAS por tabla, avisa a
 * voz en grito de consultas que devuelven mucho o escanean tablas enteras (para cazar al glotón en
 * los logs de GitHub), y —en scripts— aborta el run si se supera el PRESUPUESTO DIARIO compartido,
 * de modo que ninguna combinación de crawlers pueda drenar la cuota. La API (Vercel) solo mide y
 * avisa: nunca se auto-corta.
 *
 * OJO: en lectura se cuentan las filas DEVUELTAS, no las escaneadas; un `COUNT(*)` escanea todo pero
 * devuelve 1. Por eso, además del número, se avisa por FORMA (SELECT sin WHERE ni LIMIT).
 */
import type { Client, InStatement } from '@libsql/client';
import { registrarLecturas, presupuestoAgotado, presupuestoDiario } from './presupuestoLecturas';

interface PorTabla { intentadas: number; filas: number; bloqueadas: number }
const porTabla = new Map<string, PorTabla>();
let total = 0;

const ESCRITURA = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?([A-Za-z_][A-Za-z0-9_]*)/i;
const LECTURA = /^\s*(?:SELECT|WITH)\b/i;
const DESDE = /\bFROM\s+["`]?([A-Za-z_][A-Za-z0-9_]*)/i;

const EN_SCRIPT = !process.env.VERCEL;
const UMBRAL_AVISO = Math.max(0, Number(process.env.UMBRAL_LECTURA_GRANDE) || 5000);

function sqlDe(stmt: InStatement): string { return typeof stmt === 'string' ? stmt : stmt.sql; }
function tablaDe(stmt: InStatement): string | null { const m = ESCRITURA.exec(sqlDe(stmt)); return m ? m[1] : null; }
function tablaLeidaDe(sql: string): string | null { if (!LECTURA.test(sql)) return null; const m = DESDE.exec(sql); return m ? m[1] : '(subconsulta)'; }

function apuntar(tabla: string, filas: number, bloqueada: boolean) {
  const t = porTabla.get(tabla) || { intentadas: 0, filas: 0, bloqueadas: 0 };
  t.intentadas++; t.filas += filas; if (bloqueada) t.bloqueadas++;
  porTabla.set(tabla, t); total += filas;
}

const esBloqueo = (e: any) => /BLOCKED|(?:writes|reads) are blocked/i.test(String(e?.message || e?.code || ''));

function quienSoy(): string {
  return (process.env.GITHUB_WORKFLOW ? `${process.env.GITHUB_WORKFLOW} · ` : '')
    + (process.argv[1] || '').replace(/\\/g, '/').split('/').slice(-2).join('/');
}

// ─── lecturas ────────────────────────────────────────────────────────────────
const porTablaLeida = new Map<string, { filas: number; consultas: number }>();
let totalLeidas = 0;
const scanAvisado = new Set<string>();
let presupuestoRoto = false;   // en scripts: se superó el presupuesto → abortar
let presupuestoPedido = false; // ya se lanzó la comprobación asíncrona
let sinRegistrar = 0;          // filas leídas aún no volcadas a Redis

export function filasLeidas(): number { return totalLeidas; }

export function resumenLecturas(): string {
  if (!porTablaLeida.size) return '';
  return [...porTablaLeida.entries()]
    .sort((a, b) => b[1].filas - a[1].filas)
    .map(([t, v]) => `${t}: ${v.filas} filas en ${v.consultas} consultas`)
    .join(' · ');
}

function volcarPresupuesto(filas: number) {
  if (!EN_SCRIPT) return; // la API nunca se auto-corta
  sinRegistrar += filas;
  if (sinRegistrar >= 20000) { const n = sinRegistrar; sinRegistrar = 0; registrarLecturas(n).catch(() => {}); }
  if (!presupuestoPedido) {
    presupuestoPedido = true;
    presupuestoAgotado().then(a => {
      if (a) { presupuestoRoto = true; console.warn(`[lecturas] presupuesto diario (${presupuestoDiario()}) agotado — abortando el run para no drenar la cuota`); }
    }).catch(() => {});
  }
}

function apuntarLectura(sql: string, filas: number) {
  const tabla = tablaLeidaDe(sql);
  if (!tabla) return;
  const t = porTablaLeida.get(tabla) || { filas: 0, consultas: 0 };
  t.filas += filas; t.consultas++; porTablaLeida.set(tabla, t);
  totalLeidas += filas;
  if (EN_SCRIPT && UMBRAL_AVISO > 0 && filas >= UMBRAL_AVISO) {
    console.warn(`[lectura-grande] ${tabla}: ${filas} filas en UNA consulta — ${quienSoy()} — ${sql.slice(0, 120).replace(/\s+/g, ' ')}`);
  }
  if (EN_SCRIPT && !scanAvisado.has(tabla) && !/\bWHERE\b/i.test(sql) && !/\bLIMIT\b/i.test(sql) && LECTURA.test(sql)) {
    scanAvisado.add(tabla);
    console.warn(`[scan-completo] ${tabla}: SELECT sin WHERE ni LIMIT (escanea toda la tabla) — ${quienSoy()} — ${sql.slice(0, 120).replace(/\s+/g, ' ')}`);
  }
  volcarPresupuesto(filas);
}

/** El mismo cliente, midiendo lecturas y escrituras y frenando runs que se pasan de presupuesto. */
export function conContador(cliente: Client): Client {
  return new Proxy(cliente, {
    get(obj, prop, recv) {
      if (prop === 'execute') {
        return async (stmt: InStatement, ...resto: any[]) => {
          const sql = sqlDe(stmt);
          const esLectura = LECTURA.test(sql);
          if (esLectura && presupuestoRoto) {
            throw new Error('[lecturas] presupuesto diario agotado — run abortado para no drenar la cuota de la base');
          }
          const tabla = tablaDe(stmt);
          try {
            const rs = await (obj.execute as any)(stmt, ...resto);
            if (tabla) apuntar(tabla, rs.rowsAffected || 0, false);
            if (esLectura) apuntarLectura(sql, rs.rows?.length || 0);
            return rs;
          } catch (e) {
            if (tabla) apuntar(tabla, 0, esBloqueo(e));
            throw e;
          }
        };
      }
      if (prop === 'batch') {
        return async (stmts: InStatement[], ...resto: any[]) => {
          if (presupuestoRoto && stmts.some(s => LECTURA.test(sqlDe(s)))) {
            throw new Error('[lecturas] presupuesto diario agotado — run abortado para no drenar la cuota de la base');
          }
          const tablas = stmts.map(tablaDe);
          try {
            const rss = await (obj.batch as any)(stmts, ...resto);
            rss.forEach((rs: any, i: number) => {
              if (tablas[i]) apuntar(tablas[i]!, rs.rowsAffected || 0, false);
              const sql = sqlDe(stmts[i]);
              if (LECTURA.test(sql)) apuntarLectura(sql, rs.rows?.length || 0);
            });
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

/** Filas escritas por este proceso hasta ahora. Para medir el delta de una petición. */
export function filasEscritas(): number { return total; }

export function resumenEscrituras(): string {
  if (!porTabla.size) return '';
  return [...porTabla.entries()]
    .sort((a, b) => b[1].filas - a[1].filas || b[1].intentadas - a[1].intentadas)
    .map(([t, v]) => `${t}: ${v.filas} filas en ${v.intentadas} sentencias${v.bloqueadas ? ` (${v.bloqueadas} BLOQUEADAS)` : ''}`)
    .join(' · ');
}

// En scripts (no en Vercel), una línea al salir con quién leyó y escribió cuánto.
if (EN_SCRIPT) {
  process.on('exit', () => {
    const quien = quienSoy();
    const e = resumenEscrituras();
    if (e) console.log(`\n[escrituras] ${quien} → ${total} filas escritas · ${e}`);
    const l = resumenLecturas();
    if (l) console.log(`[lecturas] ${quien} → ${totalLeidas} filas leídas · ${l}`);
  });
}
