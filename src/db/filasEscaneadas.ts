/**
 * FILAS ESCANEADAS, que es lo que de verdad factura Turso.
 *
 * Turso cobra las filas que la consulta TOCA (`rows_read`), no las que devuelve: un `count(*)`
 * devuelve 1 y escanea la tabla entera, y una vista sobre `media_items` + `json_each` escanea todo
 * aunque saque ocho filas. El servidor manda ese número en cada resultado (campo 5 del protobuf,
 * `rows_read` en JSON), pero `@libsql/client` 0.18 lo tira por el camino. Sin él el contador medía
 * filas devueltas: Actions «leyó» 3,6M en cinco días mientras la cuota de 500M se agotaba.
 *
 * Aquí se engancha el decodificador de `@libsql/hrana-client` para no perderlo: el número viaja
 * como propiedad NO enumerable del array `rows` (que `ResultSetImpl` guarda tal cual), y
 * `filasEscaneadasDe(rs)` lo lee. Si algo cambia en la librería, no rompe nada: se cae a
 * `rows.length` como antes.
 */
import path from 'path';

const CLAVE = '__filasEscaneadas';

function anotar(rows: unknown, n: unknown) {
  if (Array.isArray(rows) && typeof n === 'number' && Number.isFinite(n)) {
    Object.defineProperty(rows, CLAVE, { value: n, enumerable: false, configurable: true });
  }
}

let parcheado = false;
export function parchearFilasEscaneadas(): void {
  if (parcheado) return;
  parcheado = true;
  try {
    // El `exports` del paquete no deja pedir rutas internas, pero sí ficheros por ruta absoluta.
    const base = path.dirname(require.resolve('@libsql/hrana-client')); // .../lib-cjs
    const pb = require(path.join(base, 'shared', 'protobuf_decode.js'));
    if (pb?.StmtResult && !pb.StmtResult[5]) {
      pb.StmtResult[5] = (r: any, msg: any) => { msg.rowsRead = Number(r.uint64()); };
    }
    const json = require(path.join(base, 'shared', 'json_decode.js'));
    if (typeof json?.StmtResult === 'function' && !json.StmtResult[CLAVE]) {
      const orig = json.StmtResult;
      const envuelta = (obj: any) => { const res = orig(obj); res.rowsRead = obj?.rows_read; return res; };
      (envuelta as any)[CLAVE] = true;
      json.StmtResult = envuelta;
    }
    const result = require(path.join(base, 'result.js'));
    if (typeof result?.rowsResultFromProto === 'function' && !result.rowsResultFromProto[CLAVE]) {
      const orig = result.rowsResultFromProto;
      const envuelta = (proto: any, intMode: any) => { const res = orig(proto, intMode); anotar(res.rows, proto?.rowsRead); return res; };
      (envuelta as any)[CLAVE] = true;
      result.rowsResultFromProto = envuelta;
    }
  } catch { /* otra versión de la librería: se queda midiendo filas devueltas */ }
}

/** Filas que Turso cobró por este resultado; si no vino el dato, las devueltas. */
export function filasEscaneadasDe(rs: any): number {
  const n = rs?.rows?.[CLAVE];
  return typeof n === 'number' ? n : (rs?.rows?.length || 0);
}

/** ¿Llegó el dato real del servidor? (para el aviso de `[scan-completo]`). */
export function tieneFilasEscaneadas(rs: any): boolean {
  return typeof rs?.rows?.[CLAVE] === 'number';
}
