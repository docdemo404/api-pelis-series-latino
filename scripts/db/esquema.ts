/**
 * APLICA EL ESQUEMA A LA BASE (Turso o el archivo local).
 *
 *   npm run db:esquema
 *
 * Es lo único que hay que hacer tras crear la base en Turso: con `TURSO_DATABASE_URL` y
 * `TURSO_AUTH_TOKEN` en `.env`, esto crea tablas, índices, disparadores y vistas de
 * `src/db/turso/esquema.sql`. Repetirlo no rompe nada (todo es IF NOT EXISTS, y las vistas se
 * rehacen). Los jobs de GitHub lo hacen solos al arrancar; la API en Vercel no hace DDL.
 */
import 'dotenv/config';
import { asegurarEsquema, getDb, urlDeLaBase, VERSION_DEL_ESQUEMA } from '../../src/db/libsql';

async function main() {
  const url = urlDeLaBase();
  console.log(`base: ${url.replace(/\/\/.*@/, '//***@')}`);
  const antes = Number((await getDb().execute('PRAGMA user_version')).rows[0]?.[0] ?? 0);
  if (antes === VERSION_DEL_ESQUEMA && process.argv.includes('--forzar')) {
    await getDb().execute('PRAGMA user_version = 0');
  }
  await asegurarEsquema();
  const tablas = await getDb().execute("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
  for (const fila of tablas.rows) console.log(`   ${fila[1]}  ${fila[0]}`);
  const n = await getDb().execute('SELECT count(*) AS n FROM media_items');
  console.log(`esquema v${VERSION_DEL_ESQUEMA} · ${n.rows[0][0]} fichas`);
}

main().catch(err => { console.error('✗', err.message); process.exit(1); });
