/**
 * LA SINTAXIS DE supabase-js, SOBRE SQLITE (Turso / libSQL).
 *
 * Cuando el catálogo se mudó de Supabase a Turso había ~300 llamadas `db.from('media_items')...`
 * repartidas en 19 archivos, escritas con el constructor de consultas de PostgREST: `.select()`,
 * `.eq()`, `.ilike()`, `.or('a.eq.1,b.is.null')`, `.contains()`, `.order()`, `.range()`,
 * `.maybeSingle()`, `.upsert(..., { onConflict })`. Reescribirlas una a una era semanas y una
 * ocasión de equivocarse trescientas veces. Esto habla esa misma sintaxis y por debajo arma UN
 * SQL con parámetros y se lo manda a libSQL. Las llamadas se quedan como estaban.
 *
 * NO ES PostgREST ENTERO: es el subconsunto que este repositorio usa, y nada más. Lo que no está
 * aquí (recursos embebidos `tabla(*)`, `.textSearch()`, `.match()`, `.filter()`) lanza un error al
 * construir la consulta, no devuelve datos raros. Mejor romper fuerte que contestar mal.
 *
 * TIPOS POR COLUMNA. SQLite no tiene arrays, ni jsonb, ni booleanos: `text[]` y `jsonb` van como
 * TEXT con JSON dentro, y `boolean` como INTEGER 0/1. `COLUMNAS` dice qué es cada una para que al
 * escribir se serialice y al leer se devuelva lo mismo que devolvía Postgres (arrays, objetos,
 * true/false). Una columna que no esté en la tabla se trata como escalar.
 *
 * EL CONSTRUCTOR ES UN THENABLE, igual que en supabase-js: la consulta se ejecuta cuando alguien
 * hace `await`. Sigue valiendo la advertencia de siempre: no devolver un constructor a medias
 * desde una función async, porque se ejecuta tal cual esté.
 */
import type { Client, InStatement, InValue, ResultSet } from '@libsql/client';
import { asegurarEsquema, getDb } from './libsql';

type Tipo = 'json' | 'array' | 'bool' | 'scalar';

/** Qué columnas NO son escalares, por tabla o vista. Lo demás es texto/número/null. */
const COLUMNAS: Record<string, Record<string, Tipo>> = {
  media_items: {
    aliases: 'array', genres: 'array', subcategories: 'array', source_urls: 'array',
    metadata_fuentes: 'json', cast_data: 'json', dubbing_cast_data: 'json',
    servers: 'json', seasons: 'json', manual_servers: 'json',
    has_streams: 'bool', oculto_manual: 'bool', enlace_permanente: 'bool',
  },
  netmirror_cache: { disponible: 'bool', idiomas_audio: 'json' },
  embeds_publicados: { fichas: 'json' },
  capitulos_publicados: { has_streams: 'bool' },
  capitulos_por_comprobar: { has_streams: 'bool' },
};

/** Clave primaria de cada tabla: es a lo que `upsert` recurre si no le dicen `onConflict`. */
const CLAVES: Record<string, string> = {
  media_items: 'id',
  playback_events: 'id',
  subtitulos: 'id',
  subtitulos_cola: 'id',
  netmirror_cache: 'tmdb_id,temporada,episodio',
};

export interface PostgrestError { message: string; code: string; details: string; hint: string }
export interface Respuesta<T = any> {
  data: T;
  error: PostgrestError | null;
  count: number | null;
  status: number;
  statusText: string;
}

const tipoDe = (tabla: string, columna: string): Tipo => COLUMNAS[tabla]?.[columna] || 'scalar';

/** Comilla un identificador. Solo letras, dígitos y guion bajo: lo demás no es una columna. */
function ident(nombre: string): string {
  const limpio = nombre.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(limpio)) throw new Error(`identificador no válido: ${nombre}`);
  return `"${limpio}"`;
}

/** Lo que va en un parámetro de escritura o de comparación. */
function codificar(tabla: string, columna: string, valor: unknown): InValue {
  if (valor === undefined || valor === null) return null;
  const tipo = tipoDe(tabla, columna);
  if (tipo === 'bool') return valor ? 1 : 0;
  if (tipo === 'json' || tipo === 'array') {
    if (typeof valor === 'string') {
      // Literales de Postgres que el código viejo compara tal cual: '{}' es un array vacío.
      if (tipo === 'array' && valor === '{}') return '[]';
      return valor;
    }
    return JSON.stringify(valor);
  }
  if (typeof valor === 'boolean') return valor ? 1 : 0;
  if (valor instanceof Date) return valor.toISOString();
  if (typeof valor === 'object') return JSON.stringify(valor);
  return valor as InValue;
}

/** Lo que sale de una fila: JSON parseado, booleanos de verdad. */
function decodificar(tabla: string, columna: string, valor: unknown): unknown {
  if (valor === null || valor === undefined) return null;
  const tipo = tipoDe(tabla, columna);
  if (tipo === 'bool') return typeof valor === 'number' ? valor !== 0 : Boolean(valor);
  if (tipo === 'json' || tipo === 'array') {
    if (typeof valor !== 'string') return valor;
    try { return JSON.parse(valor); } catch { return tipo === 'array' ? [] : null; }
  }
  if (typeof valor === 'bigint') return Number(valor);
  return valor;
}

function filasDe(tabla: string, rs: ResultSet): any[] {
  return rs.rows.map(fila => {
    const obj: Record<string, unknown> = {};
    rs.columns.forEach((col, i) => { obj[col] = decodificar(tabla, col, fila[i]); });
    return obj;
  });
}

/** El error con la forma y los códigos que el código de arriba ya sabe leer. */
function comoErrorPostgrest(e: any): PostgrestError {
  const texto = String(e?.message || e || 'error');
  let code = String(e?.code || 'XX000');
  let message = texto;
  if (/UNIQUE constraint failed/i.test(texto)) {
    code = '23505';
    message = `duplicate key value violates unique constraint (${texto.replace(/^.*UNIQUE constraint failed:\s*/i, '')})`;
  } else if (/no such column/i.test(texto)) {
    code = '42703';
  } else if (/no such table/i.test(texto)) {
    code = '42P01';
  } else if (/CHECK constraint failed/i.test(texto)) {
    code = '23514';
  } else if (/FOREIGN KEY constraint failed/i.test(texto)) {
    code = '23503';
  }
  return { message, code, details: texto, hint: '' };
}

/* ─────────────────────────────── filtros ─────────────────────────────── */

interface Trozo { sql: string; args: InValue[] }

const OPERADORES: Record<string, string> = {
  eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=',
};

/**
 * Un filtro `columna operador valor` como SQL. Es el corazón: aquí se traducen los operadores de
 * PostgREST, incluidos los que en Postgres eran de arrays o de jsonb.
 */
function filtro(tabla: string, columna: string, op: string, valor: unknown, negado = false): Trozo {
  const col = ident(columna);
  const tipo = tipoDe(tabla, columna);
  const env = (t: Trozo): Trozo => (negado ? { sql: `NOT (${t.sql})`, args: t.args } : t);

  switch (op) {
    case 'eq': case 'neq': case 'gt': case 'gte': case 'lt': case 'lte':
      return env({ sql: `${col} ${OPERADORES[op]} ?`, args: [codificar(tabla, columna, valor)] });
    case 'like':
    case 'ilike':
      // LIKE en SQLite ya ignora mayúsculas ASCII; `like` estricto no se distingue y no hace falta.
      return env({ sql: `${col} LIKE ? ESCAPE '\\'`, args: [String(valor)] });
    case 'is': {
      if (valor === null || valor === 'null') return env({ sql: `${col} IS NULL`, args: [] });
      if (valor === true || valor === 'true') return env({ sql: `${col} IS 1`, args: [] });
      if (valor === false || valor === 'false') return env({ sql: `${col} IS 0`, args: [] });
      throw new Error(`is: valor no admitido ${String(valor)}`);
    }
    case 'in': {
      const lista = Array.isArray(valor) ? valor : String(valor).replace(/^\(|\)$/g, '').split(',');
      if (!lista.length) return env({ sql: '0', args: [] });
      return env({
        sql: `${col} IN (${lista.map(() => '?').join(',')})`,
        args: lista.map(v => codificar(tabla, columna, v)),
      });
    }
    case 'cs': case 'contains': {
      // `@>` de Postgres. Para arrays: todos los elementos están. Para jsonb: contención de
      // estructura, traducida de forma recursiva a json_each (ver `contencion`).
      const patron = typeof valor === 'string' ? parsearLiteral(valor) : valor;
      if (tipo === 'array' || (Array.isArray(patron) && patron.every(v => typeof v !== 'object'))) {
        const elementos = Array.isArray(patron) ? patron : [patron];
        if (!elementos.length) return env({ sql: '1', args: [] });
        const partes = elementos.map(() => `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value = ?)`);
        return env({ sql: `(${partes.join(' AND ')})`, args: elementos.map(v => v as InValue) });
      }
      return env(contencion(col, patron));
    }
    case 'ov': case 'overlaps': {
      const lista = Array.isArray(valor) ? valor : parsearLiteral(String(valor));
      if (!Array.isArray(lista) || !lista.length) return env({ sql: '0', args: [] });
      return env({
        sql: `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value IN (${lista.map(() => '?').join(',')}))`,
        args: lista.map(v => v as InValue),
      });
    }
    default:
      throw new Error(`operador no admitido: ${op}`);
  }
}

/** Un literal de PostgREST: `{a,b}` (array de Postgres) o JSON. */
function parsearLiteral(texto: string): unknown {
  const t = texto.trim();
  // JSON primero: un objeto jsonb también empieza por `{`. Lo que no sea JSON y vaya entre
  // llaves es un array de Postgres: `{a,b}`, con urls y dos puntos dentro si hace falta.
  try { return JSON.parse(t); } catch { /* no era JSON */ }
  if (t.startsWith('{') && t.endsWith('}')) {
    const dentro = t.slice(1, -1).trim();
    return dentro ? dentro.split(',').map(s => s.trim().replace(/^"|"$/g, '')) : [];
  }
  return t;
}

/**
 * Contención jsonb (`col @> patron`) para lo que este repositorio pregunta: un array con UN
 * objeto cuyas claves son escalares o, a su vez, arrays con un objeto dentro. Por ejemplo
 * `[{"episodes":[{"servers":[{"direct_mode":"public"}]}]}]` se vuelve tres json_each anidados.
 */
function contencion(expr: string, patron: unknown, nivel = 0): Trozo {
  if (Array.isArray(patron)) {
    if (!patron.length) return { sql: '1', args: [] };
    // Un alias por nivel: el json_each de dentro no puede llamarse igual que el de fuera.
    const alias = `e${nivel}`;
    const partes = patron.map(elemento => {
      const interno = contencion(`${alias}.value`, elemento, nivel + 1);
      return { sql: `EXISTS (SELECT 1 FROM json_each(${expr}) ${alias} WHERE ${interno.sql})`, args: interno.args };
    });
    return { sql: `(${partes.map(p => p.sql).join(' AND ')})`, args: partes.flatMap(p => p.args) };
  }
  if (patron && typeof patron === 'object') {
    const partes = Object.entries(patron as Record<string, unknown>).map(([clave, v]) => {
      const ruta = `json_extract(${expr}, '$.${clave.replace(/'/g, "''")}')`;
      if (v && typeof v === 'object') return contencion(ruta, v, nivel);
      if (v === null) return { sql: `${ruta} IS NULL`, args: [] as InValue[] };
      return { sql: `${ruta} = ?`, args: [v as InValue] };
    });
    if (!partes.length) return { sql: '1', args: [] };
    return { sql: `(${partes.map(p => p.sql).join(' AND ')})`, args: partes.flatMap(p => p.args) };
  }
  return { sql: `${expr} = ?`, args: [patron as InValue] };
}

/**
 * La cadena de `.or('a.eq.1,b.is.null,and(c.gt.2,d.ilike.%x%)')`, al estilo PostgREST: trozos
 * separados por comas al nivel superior, `and(...)`/`or(...)` anidados y `not.` como prefijo.
 */
function parsearOr(tabla: string, texto: string, union: 'AND' | 'OR' = 'OR'): Trozo {
  const trozos = partirNivelSuperior(texto);
  const partes = trozos.map(t => {
    const anidado = /^(and|or)\((.*)\)$/s.exec(t.trim());
    if (anidado) return parsearOr(tabla, anidado[2], anidado[1].toUpperCase() as 'AND' | 'OR');
    let resto = t.trim();
    let negado = false;
    const primerPunto = resto.indexOf('.');
    if (primerPunto < 0) throw new Error(`filtro or() no válido: ${t}`);
    const columna = resto.slice(0, primerPunto);
    resto = resto.slice(primerPunto + 1);
    if (resto.startsWith('not.')) { negado = true; resto = resto.slice(4); }
    const segundoPunto = resto.indexOf('.');
    if (segundoPunto < 0) throw new Error(`filtro or() no válido: ${t}`);
    const op = resto.slice(0, segundoPunto);
    const valor = resto.slice(segundoPunto + 1);
    return filtro(tabla, columna, op, op === 'is' ? valor : valor, negado);
  });
  if (!partes.length) return { sql: '1', args: [] };
  return { sql: `(${partes.map(p => p.sql).join(` ${union} `)})`, args: partes.flatMap(p => p.args) };
}

function partirNivelSuperior(texto: string): string[] {
  const salida: string[] = [];
  let nivel = 0, actual = '';
  for (const c of texto) {
    if (c === '(') nivel++;
    if (c === ')') nivel--;
    if (c === ',' && nivel === 0) { salida.push(actual); actual = ''; continue; }
    actual += c;
  }
  if (actual.trim()) salida.push(actual);
  return salida;
}

/**
 * El esquema se aplica solo desde los scripts y en local, que tienen el repo a mano. En Vercel no:
 * la API no hace DDL, y la base se prepara una vez con `npm run db:esquema` contra Turso.
 */
async function esquemaSiHaceFalta(): Promise<void> {
  if (process.env.VERCEL) return;
  await asegurarEsquema();
}

/**
 * NO SE ESCRIBE LO QUE NO CAMBIA.
 *
 * La cuota que se agota en Turso es de FILAS ESCRITAS, y un UPDATE que deja la fila igual cuenta
 * lo mismo que uno que la cambia. Muchos barridos guardan la ficha entera después de mirarla, cambie
 * o no. Así que todo UPDATE (y el DO UPDATE de un upsert) lleva además la condición «alguna de las
 * columnas que se ponen es distinta de la que hay»: si ninguna lo es, SQLite no toca la fila y no
 * se factura.
 *
 * `updated_at` NO cuenta como cambio: guardar la misma ficha solo para moverle la fecha era
 * justamente el gasto que se quiere quitar, y esa columna no es fiable para nada (ver memoria
 * «updated_at no es fiable»). El resto de fechas —`streams_checked_at`, sellos dentro de
 * `servers`— SÍ cuentan: hay barridos que eligen qué mirar por la fecha de la última vez, y si no
 * se moviera repetirían siempre las mismas fichas.
 */
const NO_CUENTA_COMO_CAMBIO = new Set(['updated_at']);

/* ─────────────────────────────── el constructor ─────────────────────────────── */

type Accion = 'select' | 'insert' | 'update' | 'upsert' | 'delete';

export class Consulta<T = any[]> implements PromiseLike<Respuesta<T>> {
  private accion: Accion = 'select';
  private columnas = '*';
  private contar = false;
  private soloCabecera = false;
  private filtros: Trozo[] = [];
  private ordenes: string[] = [];
  private tope: number | null = null;
  private desde: number | null = null;
  private forma: 'lista' | 'uno' | 'unoOpcional' = 'lista';
  private filas: Record<string, unknown>[] = [];
  private valores: Record<string, unknown> = {};
  private conflicto: string | null = null;
  private ignorarDuplicados = false;
  private devolver = false;

  constructor(private readonly tabla: string, private readonly cliente: () => Client) {}

  /* ── qué ── */
  select(columnas = '*', opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): this {
    if (this.accion !== 'select') { this.devolver = true; return this; }
    if (/[()!:]/.test(columnas)) throw new Error(`select con recursos embebidos no admitido: ${columnas}`);
    this.columnas = columnas;
    if (opts?.count) this.contar = true;
    if (opts?.head) this.soloCabecera = true;
    return this;
  }
  insert(fila: Record<string, unknown> | Record<string, unknown>[]): this {
    this.accion = 'insert';
    this.filas = Array.isArray(fila) ? fila : [fila];
    return this;
  }
  upsert(fila: Record<string, unknown> | Record<string, unknown>[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.accion = 'upsert';
    this.filas = Array.isArray(fila) ? fila : [fila];
    this.conflicto = opts?.onConflict || CLAVES[this.tabla] || 'id';
    this.ignorarDuplicados = Boolean(opts?.ignoreDuplicates);
    return this;
  }
  update(valores: Record<string, unknown>): this {
    this.accion = 'update';
    this.valores = valores;
    return this;
  }
  delete(): this {
    this.accion = 'delete';
    return this;
  }

  /* ── filtros ── */
  eq(c: string, v: unknown): this { return this.anadir(filtro(this.tabla, c, 'eq', v)); }
  neq(c: string, v: unknown): this { return this.anadir(filtro(this.tabla, c, 'neq', v)); }
  gt(c: string, v: unknown): this { return this.anadir(filtro(this.tabla, c, 'gt', v)); }
  gte(c: string, v: unknown): this { return this.anadir(filtro(this.tabla, c, 'gte', v)); }
  lt(c: string, v: unknown): this { return this.anadir(filtro(this.tabla, c, 'lt', v)); }
  lte(c: string, v: unknown): this { return this.anadir(filtro(this.tabla, c, 'lte', v)); }
  like(c: string, v: string): this { return this.anadir(filtro(this.tabla, c, 'like', v)); }
  ilike(c: string, v: string): this { return this.anadir(filtro(this.tabla, c, 'ilike', v)); }
  is(c: string, v: null | boolean): this { return this.anadir(filtro(this.tabla, c, 'is', v)); }
  in(c: string, v: unknown[]): this { return this.anadir(filtro(this.tabla, c, 'in', v)); }
  contains(c: string, v: unknown): this { return this.anadir(filtro(this.tabla, c, 'cs', v)); }
  overlaps(c: string, v: unknown[]): this { return this.anadir(filtro(this.tabla, c, 'ov', v)); }
  not(c: string, op: string, v: unknown): this { return this.anadir(filtro(this.tabla, c, op, v, true)); }
  or(texto: string): this { return this.anadir(parsearOr(this.tabla, texto)); }
  filter(): never { throw new Error('.filter(col, op, val) no está implementado en el adaptador'); }
  match(): never { throw new Error('.match({...}) no está implementado en el adaptador'); }
  textSearch(): never { throw new Error('.textSearch() no está implementado en el adaptador'); }

  /* ── forma ── */
  order(columna: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    const asc = opts?.ascending !== false;
    // Como Postgres: ASC deja los nulos al final, DESC al principio, salvo que se diga.
    const nulosPrimero = opts?.nullsFirst ?? !asc;
    this.ordenes.push(`${ident(columna)} ${asc ? 'ASC' : 'DESC'} NULLS ${nulosPrimero ? 'FIRST' : 'LAST'}`);
    return this;
  }
  limit(n: number): this { this.tope = n; return this; }
  range(a: number, b: number): this { this.desde = a; this.tope = b - a + 1; return this; }
  // Devuelven `Consulta<any>`: la fila es un objeto y no una lista, y así lo ve quien escribe `data?.id`.
  single(): Consulta<any> { this.forma = 'uno'; return this as Consulta<any>; }
  maybeSingle(): Consulta<any> { this.forma = 'unoOpcional'; return this as Consulta<any>; }

  private anadir(t: Trozo): this { this.filtros.push(t); return this; }

  /* ── SQL ── */
  private where(): Trozo {
    if (!this.filtros.length) return { sql: '', args: [] };
    return {
      sql: ` WHERE ${this.filtros.map(f => f.sql).join(' AND ')}`,
      args: this.filtros.flatMap(f => f.args),
    };
  }

  private columnasSql(): string {
    if (this.columnas.trim() === '*') return '*';
    return this.columnas.split(',').map(c => ident(c)).join(', ');
  }

  private sentenciasDeEscritura(): InStatement[] {
    const t = ident(this.tabla);
    const ret = this.devolver ? ' RETURNING *' : '';
    if (this.accion === 'insert' || this.accion === 'upsert') {
      return this.filas.map(fila => {
        const claves = Object.keys(fila).filter(k => fila[k] !== undefined);
        const cols = claves.map(ident).join(', ');
        const marcas = claves.map(() => '?').join(', ');
        const args = claves.map(k => codificar(this.tabla, k, fila[k]));
        if (this.accion === 'insert') return { sql: `INSERT INTO ${t} (${cols}) VALUES (${marcas})${ret}`, args };
        const enConflicto = this.conflicto!.split(',').map(c => c.trim());
        const set = claves
          .filter(k => !enConflicto.includes(k))
          .map(k => `${ident(k)} = excluded.${ident(k)}`);
        // Con RETURNING no se pone la guarda: una fila sin cambios no se devolvería. Nadie lo usa hoy.
        const distintas = claves
          .filter(k => !enConflicto.includes(k) && !NO_CUENTA_COMO_CAMBIO.has(k))
          .map(k => `${t}.${ident(k)} IS NOT excluded.${ident(k)}`);
        const guarda = !this.devolver && distintas.length ? ` WHERE ${distintas.join(' OR ')}` : '';
        const accion = this.ignorarDuplicados || !set.length ? 'DO NOTHING' : `DO UPDATE SET ${set.join(', ')}${guarda}`;
        return {
          sql: `INSERT INTO ${t} (${cols}) VALUES (${marcas}) ON CONFLICT (${enConflicto.map(ident).join(', ')}) ${accion}${ret}`,
          args,
        };
      });
    }
    const w = this.where();
    if (this.accion === 'update') {
      const claves = Object.keys(this.valores).filter(k => this.valores[k] !== undefined);
      if (!claves.length) return [];
      const set = claves.map(k => `${ident(k)} = ?`).join(', ');
      const args = claves.map(k => codificar(this.tabla, k, this.valores[k]));
      const comparables = claves.filter(k => !NO_CUENTA_COMO_CAMBIO.has(k));
      const guarda = comparables.length
        ? `${w.sql ? ' AND' : ' WHERE'} (${comparables.map(k => `${ident(k)} IS NOT ?`).join(' OR ')})`
        : '';
      const argsGuarda = comparables.map(k => codificar(this.tabla, k, this.valores[k]));
      // Sin RETURNING: las filas que ya estaban así no saldrían. Las devuelve `ejecutar` con un SELECT.
      return [{ sql: `UPDATE ${t} SET ${set}${w.sql}${guarda}`, args: [...args, ...w.args, ...argsGuarda] }];
    }
    if (this.accion === 'delete') {
      return [{ sql: `DELETE FROM ${t}${w.sql}${ret}`, args: w.args }];
    }
    return [];
  }

  private sentenciaDeLectura(): InStatement {
    const w = this.where();
    let sql = `SELECT ${this.columnasSql()} FROM ${ident(this.tabla)}${w.sql}`;
    if (this.ordenes.length) sql += ` ORDER BY ${this.ordenes.join(', ')}`;
    if (this.tope !== null) sql += ` LIMIT ${Math.max(0, Math.floor(this.tope))}`;
    if (this.desde !== null) sql += `${this.tope === null ? ' LIMIT -1' : ''} OFFSET ${Math.max(0, Math.floor(this.desde))}`;
    return { sql, args: w.args };
  }

  private sentenciaDeRecuento(): InStatement {
    const w = this.where();
    return { sql: `SELECT count(*) AS n FROM ${ident(this.tabla)}${w.sql}`, args: w.args };
  }

  /* ── ejecución ── */
  async ejecutar(): Promise<Respuesta<T>> {
    try {
      await esquemaSiHaceFalta();
      const db = this.cliente();
      if (this.accion !== 'select') {
        const sentencias = this.sentenciasDeEscritura();
        if (!sentencias.length) return { data: [] as any, error: null, count: 0, status: 204, statusText: 'No Content' };
        const resultados = sentencias.length === 1
          ? [await db.execute(sentencias[0])]
          : await db.batch(sentencias, 'write');
        const afectadas = resultados.reduce((n, r) => n + (r.rowsAffected || 0), 0);
        /*
         * `update(...).select()` devuelve las filas que CUMPLEN EL FILTRO, se hayan reescrito o ya
         * estuvieran así (ver NO_CUENTA_COMO_CAMBIO). Es lo que esperan `escribirFila` y
         * `puedeEscribirCatalogo`: «la fila está como pedí». Un bloqueo de escritura no se cuela
         * por aquí: Turso rechaza la sentencia UPDATE entera aunque no toque ninguna fila.
         */
        if (this.accion === 'update' && this.devolver) {
          const rs = await db.execute(this.sentenciaDeLectura());
          return this.darForma(filasDe(this.tabla, rs), afectadas, 200);
        }
        const data = this.devolver ? resultados.flatMap(r => filasDe(this.tabla, r)) : [];
        return this.darForma(data, afectadas, this.devolver ? 200 : 204);
      }

      let count: number | null = null;
      if (this.contar) {
        const rs = await db.execute(this.sentenciaDeRecuento());
        count = Number(rs.rows[0]?.[0] ?? 0);
      }
      if (this.soloCabecera) return { data: null as any, error: null, count, status: 200, statusText: 'OK' };
      const rs = await db.execute(this.sentenciaDeLectura());
      return this.darForma(filasDe(this.tabla, rs), count, 200);
    } catch (e) {
      return { data: null as any, error: comoErrorPostgrest(e), count: null, status: 500, statusText: 'Internal Server Error' };
    }
  }

  private darForma(filas: any[], count: number | null, status: number): Respuesta<T> {
    if (this.forma === 'lista') return { data: filas as any, error: null, count, status, statusText: 'OK' };
    if (filas.length > 1) {
      return {
        data: null as any,
        error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116', details: `${filas.length} rows`, hint: '' },
        count, status: 406, statusText: 'Not Acceptable',
      };
    }
    if (filas.length === 0) {
      if (this.forma === 'unoOpcional') return { data: null as any, error: null, count, status, statusText: 'OK' };
      return {
        data: null as any,
        error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116', details: '0 rows', hint: '' },
        count, status: 406, statusText: 'Not Acceptable',
      };
    }
    return { data: filas[0], error: null, count, status, statusText: 'OK' };
  }

  then<R1 = Respuesta<T>, R2 = never>(
    onfulfilled?: ((value: Respuesta<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null
  ): Promise<R1 | R2> {
    return this.ejecutar().then(onfulfilled, onrejected);
  }
}

/* ─────────────────────────────── el cliente ─────────────────────────────── */

export class ClienteCompat {
  constructor(private readonly cliente: () => Client = getDb) {}

  from<T = any[]>(tabla: string): Consulta<T> {
    return new Consulta<T>(tabla, this.cliente);
  }

  /**
   * Las funciones SQL que el código llamaba por RPC. Solo hay una: `search_media(q, lim, off)`
   * de la migración 013, que devolvía `{ item: <fila entera>, total }` por fila.
   */
  async rpc(nombre: string, params: Record<string, unknown> = {}): Promise<Respuesta<any>> {
    if (nombre !== 'search_media') {
      return { data: null, error: { message: `rpc no implementado: ${nombre}`, code: '42883', details: '', hint: '' }, count: null, status: 404, statusText: 'Not Found' };
    }
    try {
      await esquemaSiHaceFalta();
      const q = String(params.q || '');
      const lim = Math.max(1, Number(params.lim) || 20);
      const off = Math.max(0, Number(params.off) || 0);
      const rs = await this.cliente().execute({
        sql: `SELECT *, count(*) OVER () AS total FROM media_items
              WHERE title_normalized LIKE ? ESCAPE '\\' AND has_streams = 1
              ORDER BY (CASE WHEN title_normalized LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END),
                       metadata_score DESC NULLS LAST, rating DESC NULLS LAST, title_normalized
              LIMIT ? OFFSET ?`,
        args: [`%${q}%`, `${q}%`, lim, off],
      });
      const filas = filasDe('media_items', rs);
      const data = filas.map(({ total, ...item }) => ({ item, total }));
      return { data, error: null, count: null, status: 200, statusText: 'OK' };
    } catch (e) {
      return { data: null, error: comoErrorPostgrest(e), count: null, status: 500, statusText: 'Internal Server Error' };
    }
  }
}
