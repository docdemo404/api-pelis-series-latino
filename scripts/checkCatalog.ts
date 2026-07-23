/**
 * Diagnóstico del estado real del catálogo en Supabase.
 *
 *   npm run check:catalog
 *
 * Responde de un vistazo a "¿se aplicaron las migraciones?" y "¿llegó a correr el crawl?",
 * que son las dos cosas de las que depende que la ficha emergente abra al instante.
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../src/services/supabaseService';

const db = getSupabaseAdmin();

const NEW_COLUMNS = ['metadata_source', 'servers', 'seasons', 'source_url', 'runtime', 'director', 'streams_updated_at'];

/** ¿Existe la columna? (una consulta que falla con 42703 si no) */
async function columnExists(column: string): Promise<boolean> {
  const { error } = await db.from('media_items').select(column).limit(1);
  return !error;
}

/** Nº de filas que cumplen un filtro, sin traerse los datos. */
async function countWhere(apply: (q: any) => any): Promise<number> {
  const { count, error } = await apply(db.from('media_items').select('id', { count: 'exact', head: true }));
  if (error) return -1;
  return count ?? 0;
}

function bar(done: number, total: number): string {
  if (total <= 0) return '';
  const pct = Math.round((done / total) * 100);
  const filled = Math.round(pct / 5);
  return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${pct}%`;
}

async function main() {
  console.log('\n══ Estado del catálogo ══\n');

  // ── Paso 1: migraciones ────────────────────────────────────────────────────
  const present = await Promise.all(NEW_COLUMNS.map(async c => [c, await columnExists(c)] as const));
  const missing = present.filter(([, ok]) => !ok).map(([c]) => c);

  console.log('PASO 1 · Migraciones (columnas nuevas)');
  for (const [column, ok] of present) console.log(`   ${ok ? '✅' : '❌'} ${column}`);
  if (missing.length > 0) {
    console.log(`\n   ⚠ Faltan ${missing.length} columnas → ejecuta src/db/migrations/EJECUTAR_EN_SUPABASE.sql`);
    console.log('     en el SQL Editor de Supabase. Sin ellas el paso 2 no puede guardar nada.\n');
    return;
  }
  console.log('   → El SQL se aplicó correctamente.\n');

  // ── Paso 2: crawl ──────────────────────────────────────────────────────────
  const total = await countWhere(q => q);
  const withSourceUrl = await countWhere(q => q.not('source_url', 'is', null));
  const withRuntime = await countWhere(q => q.not('runtime', 'is', null));
  const withLogo = await countWhere(q => q.not('logo', 'is', null));
  const withStreams = await countWhere(q => q.not('streams_updated_at', 'is', null));
  const anime = await countWhere(q => q.contains('subcategories', ['Anime']));

  const { data: newest } = await db.from('media_items').select('updated_at').order('updated_at', { ascending: false }).limit(1);
  const lastUpdate = newest && newest[0] ? new Date(newest[0].updated_at) : null;
  const hoursAgo = lastUpdate ? (Date.now() - lastUpdate.getTime()) / 3600000 : Infinity;

  console.log('PASO 2 · Crawl (npm run refresh:catalog -- --streams=300)');
  console.log(`   Fichas en el catálogo:      ${total}`);
  console.log(`   Última actualización:       ${lastUpdate ? `${lastUpdate.toLocaleString()} (hace ${hoursAgo.toFixed(1)} h)` : 'nunca'}`);
  console.log(`   Con URL de la fuente:       ${withSourceUrl}/${total}  ${bar(withSourceUrl, total)}`);
  console.log(`   Con enlaces ya resueltos:   ${withStreams}/${total}  ${bar(withStreams, total)}`);
  console.log(`   Con duración (runtime):     ${withRuntime}/${total}  ${bar(withRuntime, total)}`);
  console.log(`   Con logo para el hero:      ${withLogo}/${total}  ${bar(withLogo, total)}`);
  console.log(`   Etiquetadas como anime:     ${anime}`);

  console.log('\n══ Veredicto ══\n');
  if (withSourceUrl === 0) {
    console.log('   ❌ El crawl NO ha corrido (o corrió antes de aplicar el SQL).');
    console.log('      Ninguna ficha tiene source_url, así que abrir una y darle a Reproducir');
    console.log('      sigue costando segundos de scraping.\n');
    console.log('      Ejecuta:  npm run refresh:catalog -- --streams=300');
    console.log('      (o lanza el workflow "Catalog Refresh" desde la pestaña Actions de GitHub)\n');
  } else if (withSourceUrl < total * 0.5) {
    console.log(`   ⚠ El crawl corrió a medias: solo ${Math.round((withSourceUrl / total) * 100)}% de las fichas tienen source_url.`);
    console.log('      Probablemente se interrumpió. Vuelve a lanzarlo para completarlo.\n');
  } else {
    console.log('   ✅ El crawl corrió y guardó los datos nuevos.');
    if (withStreams === 0) {
      console.log('      Nota: ninguna ficha tiene enlaces pre-resueltos → lanzaste el crawl SIN');
      console.log('      el flag --streams=300. No es grave (la primera apertura los resuelve y');
      console.log('      los guarda), pero con el flag la primera vez ya sale instantánea.\n');
    } else {
      console.log(`      ${withStreams} fichas abren ya con los enlaces listos.\n`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ checkCatalog:', err.message || err);
    process.exit(1);
  });
