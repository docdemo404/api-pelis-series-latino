/**
 * Aplica las migraciones de `src/db/migrations/` contra Postgres, llevando la cuenta.
 *
 *   npm run migrar                 # dice cuáles faltan, no toca nada
 *   npm run migrar -- --apply      # aplica las pendientes, en orden
 *   npm run migrar -- --apply --solo=012_metadata_fuentes.sql
 *   npm run migrar -- --baseline=011_subtitulos.sql
 *                                  # da por aplicadas esa y todas las anteriores SIN ejecutarlas
 *
 * LO PRIMERO EN UNA BASE QUE YA EXISTE ES EL BASELINE, y no es una formalidad.
 *
 * Las 011 migraciones anteriores se pegaron a mano en el SQL Editor, así que la tabla de control
 * nace vacía y este comando las daría todas por pendientes. Casi todas son inofensivas de repetir
 * —IF NOT EXISTS por todas partes—, pero DOS no lo son:
 *
 *   · 001 hace `DROP TABLE IF EXISTS video_servers`.
 *   · 007 RECALCULA `has_streams` de todo el catálogo a partir de los enlaces guardados. Ese
 *     campo lo fija después la verificación de verdad (`refresh:catalog --verify`), que comprueba
 *     que el vídeo se descarga. Repetir la 007 borraría el resultado de esas comprobaciones y
 *     devolvería al catálogo fichas que se sabe que no reproducen.
 *
 * Por eso el baseline existe y por eso se pasa una sola vez, antes que nada.
 *
 * POR QUÉ HACE FALTA UNA CONEXIÓN DISTINTA A LA DE LA API.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` habla con PostgREST, que es un traductor de HTTP a consultas sobre
 * las tablas QUE YA EXISTEN: sabe leer, insertar y actualizar filas, y no sabe nada más. Un
 * `ALTER TABLE` no es una fila: es cambiar la forma de la tabla, y eso solo entra por una conexión
 * de Postgres de verdad. De ahí `SUPABASE_DB_URL`, que sale del botón «Connect» del panel de
 * Supabase (pestaña Session pooler) y vive en `.env`, nunca en el repositorio.
 *
 * Hasta ahora cada migración se pegaba a mano en el SQL Editor, y el precio se vio en la 012: el
 * barrido de relleno quedó escrito, probado y sin poder correr, esperando a que alguien abriera el
 * navegador. Peor todavía es lo que pasó con la 003 y la 004, que acabaron copiadas a mano en
 * `EJECUTAR_EN_SUPABASE.sql` porque nadie sabía cuáles estaban puestas y cuáles no.
 *
 * ESO ES LO QUE ARREGLA LA TABLA DE CONTROL. `_migraciones` guarda el nombre de cada fichero
 * aplicado, así que la pregunta «¿esta base está al día?» tiene respuesta en vez de conjetura, y
 * volver a lanzar el comando no repite nada. Las migraciones del repo ya son idempotentes (todas
 * usan IF NOT EXISTS), pero no repetirlas es más rápido y, sobre todo, deja el registro que se
 * puede consultar.
 *
 * CADA FICHERO VA EN SU TRANSACCIÓN, y el apunte en `_migraciones` va DENTRO de ella. Si el SQL
 * falla a la mitad, se deshace entero y no queda apuntado: la base no se queda a medias diciendo
 * que está migrada. Postgres sabe hacer DDL transaccional, cosa que no todas las bases permiten.
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

const DIR = join(__dirname, '..', 'src', 'db', 'migrations');

/**
 * Un refrito histórico de las migraciones 003 y 004 para pegar a mano, no una migración más.
 * Aplicarlo como si lo fuera no rompe nada (es idempotente), pero lo dejaría apuntado en
 * `_migraciones` como si fuera un paso propio, y no lo es.
 */
const NO_ES_MIGRACION = new Set(['EJECUTAR_EN_SUPABASE.sql']);

const args = process.argv.slice(2);
const APLICAR = args.includes('--apply');
const SOLO = (args.find(a => a.startsWith('--solo=')) || '').split('=')[1] || '';
const BASELINE = (args.find(a => a.startsWith('--baseline=')) || '').split('=')[1] || '';

function ficheros(): string[] {
  return readdirSync(DIR)
    .filter(f => f.endsWith('.sql') && !NO_ES_MIGRACION.has(f))
    .sort();  // el prefijo numérico (001_, 002_…) es lo que define el orden
}

(async () => {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error('✖ Falta SUPABASE_DB_URL en el entorno (.env).');
    console.error('  Sale del panel de Supabase → botón «Connect» → Session pooler, y es la cadena');
    console.error('  postgresql://postgres:CONTRASEÑA@db.<proyecto>.supabase.co:5432/postgres');
    process.exit(1);
  }

  // Supabase exige TLS y firma con su propia autoridad. `rejectUnauthorized: false` acepta ese
  // certificado; el tráfico sigue yendo cifrado. Para verificarlo de verdad haría falta el
  // certificado que se descarga en Database Settings, y para un comando de migración es más
  // ceremonia que provecho.
  const cliente = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

  try {
    await cliente.connect();
  } catch (err: any) {
    console.error(`✖ No se pudo conectar: ${err.message}`);
    if (/password authentication failed/i.test(err.message)) {
      console.error('  La contraseña de la cadena no es la de la base. Se restablece en');
      console.error('  Supabase → Project Settings → Database → Reset database password.');
    }
    process.exit(1);
  }

  await cliente.query(`
    CREATE TABLE IF NOT EXISTS _migraciones (
      nombre TEXT PRIMARY KEY,
      aplicada_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const todas = ficheros();

  if (BASELINE) {
    if (!todas.includes(BASELINE)) {
      console.error(`✖ No existe ${BASELINE} en src/db/migrations/.`);
      await cliente.end();
      process.exit(1);
    }
    const hasta = todas.slice(0, todas.indexOf(BASELINE) + 1);
    for (const f of hasta) {
      await cliente.query('INSERT INTO _migraciones (nombre) VALUES ($1) ON CONFLICT DO NOTHING', [f]);
    }
    console.log(`📌 ${hasta.length} migración(es) dadas por aplicadas SIN ejecutarlas:`);
    for (const f of hasta) console.log(`   ✓ ${f}`);
    console.log('');
  }

  const { rows } = await cliente.query('SELECT nombre FROM _migraciones');
  const yaEstan = new Set(rows.map(r => r.nombre));
  const pendientes = todas.filter(f => !yaEstan.has(f) && (!SOLO || f === SOLO));

  console.log(`🗂  ${todas.length} migraciones en el repo · ${yaEstan.size} aplicadas · ${pendientes.length} pendientes\n`);
  for (const f of todas) {
    const marca = yaEstan.has(f) ? '✓' : (pendientes.includes(f) ? '→' : '·');
    console.log(`   ${marca} ${f}`);
  }

  if (pendientes.length === 0) {
    console.log('\n✅ La base está al día.');
    await cliente.end();
    return;
  }

  if (!APLICAR) {
    console.log('\n(dry-run: no se ha ejecutado nada. Repite con --apply.)');
    await cliente.end();
    return;
  }

  console.log('');
  let aplicadas = 0;
  for (const fichero of pendientes) {
    const sql = readFileSync(join(DIR, fichero), 'utf8');
    process.stdout.write(`   ▶ ${fichero} ... `);
    try {
      await cliente.query('BEGIN');
      await cliente.query(sql);
      await cliente.query('INSERT INTO _migraciones (nombre) VALUES ($1)', [fichero]);
      await cliente.query('COMMIT');
      console.log('ok');
      aplicadas++;
    } catch (err: any) {
      await cliente.query('ROLLBACK').catch(() => {});
      console.log('FALLÓ');
      console.error(`     ${err.message}`);
      // Se para aquí: las migraciones se apoyan unas en otras, y seguir con la siguiente sobre una
      // base que no tiene lo que la anterior debía dejar puesto es cómo se rompen de verdad.
      console.error('\n✖ Detenido. Las anteriores quedan aplicadas; esta no ha tocado nada.');
      await cliente.end();
      process.exit(1);
    }
  }

  console.log(`\n✅ ${aplicadas} migración(es) aplicada(s).`);
  await cliente.end();
})();
