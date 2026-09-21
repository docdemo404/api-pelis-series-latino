/**
 * LA CONEXIÓN A TURSO, y el esquema que la acompaña.
 *
 * Un solo cliente por proceso. libSQL por HTTP no mantiene conexión abierta, así que en Vercel
 * cada lambda lo crea al primer uso y no hay pool que agotar; en GitHub Actions ocho runners a la
 * vez son ocho clientes, y a Turso le da igual.
 *
 * DÓNDE APUNTA. `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` en producción y en los jobs. Sin ellas,
 * EN LOCAL se usa un archivo (`data/catalogo.db`) para poder desarrollar y probar sin tocar la
 * base de verdad; en Vercel o en Actions sin ellas se lanza un error al primer uso, a propósito:
 * la alternativa —escribir en un archivo efímero y contestar 200 vacío— es la «escritura
 * silenciosa» que este proyecto ya pagó con Supabase.
 *
 * EL ESQUEMA SE APLICA SOLO. `src/db/turso/esquema.sql` es idempotente y lleva un número de
 * versión; al primer uso de cada proceso se mira la tabla `esquema` (una ida y vuelta) y si no
 * coincide se ejecuta el archivo entero y se sube el número. Así una base recién creada en Turso
 * queda lista con la primera petición, y cambiar una vista es subir `VERSION_DEL_ESQUEMA`.
 */
import type { Client } from '@libsql/client';
import fs from 'fs';
import path from 'path';

/**
 * En Vercel se usa la variante `web` del cliente: solo HTTP, sin el binario nativo de SQLite
 * que la variante de Node arrastra para abrir archivos `file:`. Allí no hay archivos que abrir y
 * el binario solo engorda la función. En local y en Actions hace falta el completo.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createClient } = process.env.VERCEL ? require('@libsql/client/web') : require('@libsql/client');

/** Súbelo cada vez que cambie esquema.sql: es lo que hace que se vuelva a aplicar. */
export const VERSION_DEL_ESQUEMA = 4;

const ARCHIVO_LOCAL = 'file:data/catalogo.db';

let cliente: Client | null = null;
let esquemaListo: Promise<void> | null = null;

function enLaNube(): boolean {
  return Boolean(process.env.VERCEL || process.env.GITHUB_ACTIONS || process.env.CI);
}

export function urlDeLaBase(): string {
  const url = (process.env.TURSO_DATABASE_URL || '').trim();
  if (url) return url;
  if (enLaNube()) {
    throw new Error(
      'Falta TURSO_DATABASE_URL (y TURSO_AUTH_TOKEN). Sin ellas no hay base de datos: ' +
        'ponlas en las variables de entorno de Vercel y en los secrets de GitHub Actions.'
    );
  }
  return ARCHIVO_LOCAL;
}

/** El cliente crudo de libSQL. Para el adaptador y para quien necesite SQL a pelo. */
export function getDb(): Client {
  if (cliente) return cliente;
  const url = urlDeLaBase();
  if (url === ARCHIVO_LOCAL) {
    fs.mkdirSync(path.resolve('data'), { recursive: true });
    if (!process.env.SILENCIO_DB) console.log(`   ℹ base local: ${url} (sin TURSO_DATABASE_URL)`);
  }
  const nuevo: Client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
  cliente = nuevo;
  return nuevo;
}

/**
 * Qué versión del esquema tiene la base. Va en una tabla (`esquema`) y no en `PRAGMA
 * user_version` porque Turso no deja escribir pragmas. Sin tabla, es una base recién nacida: 0.
 */
export async function versionAplicada(): Promise<number> {
  try {
    const rs = await getDb().execute("SELECT valor FROM esquema WHERE clave = 'version'");
    return Number(rs.rows[0]?.[0] ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Deja la base con el esquema de `esquema.sql`. Idempotente y barata cuando ya está: una lectura
 * del `user_version`. Se llama sola desde el adaptador antes de la primera consulta del proceso.
 */
export function asegurarEsquema(): Promise<void> {
  if (!esquemaListo) {
    esquemaListo = (async () => {
      const db = getDb();
      const actual = await versionAplicada();
      if (actual === VERSION_DEL_ESQUEMA) return;
      const archivo = path.join(__dirname, 'turso', 'esquema.sql');
      await db.executeMultiple(fs.readFileSync(archivo, 'utf8'));
      await db.execute({
        sql: "INSERT INTO esquema (clave, valor) VALUES ('version', ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor",
        args: [VERSION_DEL_ESQUEMA],
      });
      console.log(`   ✅ esquema v${VERSION_DEL_ESQUEMA} aplicado (antes v${actual})`);
    })().catch(err => {
      esquemaListo = null; // que el siguiente lo vuelva a intentar en vez de quedarse roto
      throw err;
    });
  }
  return esquemaListo;
}
