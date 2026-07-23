/**
 * Regresión de recall/precisión del resolutor de alias sobre una muestra real del catálogo.
 *
 * Para cada fila muestreada prueba las tres formas con las que un cliente puede pedirla:
 *   1. el id tal cual (lo que devuelve la búsqueda DB-first)
 *   2. el slug del título (lo que devuelve la búsqueda en vivo de TioPlus)
 *   3. el slug corto del id de FuegoCine, sin fecha ni año
 *
 *   npx ts-node --transpile-only scripts/dev/diag_alias_regress.ts [muestra]
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { CatalogService } from '../../src/services/catalogService';
import { slugify } from '../../src/utils/text';

const SAMPLE = Number(process.argv[2]) || 150;

function shortSlug(id: string): string | null {
  const m = String(id || '').match(/^\d{4}-\d{2}-(.+)-html$/);
  return m ? m[1].replace(/-\d{4}$/, '') : null;
}

(async () => {
  const { data, error } = await supabase
    .from('media_items')
    .select('id,title,type')
    .order('updated_at', { ascending: false })
    .limit(SAMPLE);

  if (error || !data) {
    console.log('No se pudo leer el catálogo:', error?.message);
    process.exit(1);
  }

  const stats = {
    byId: { hit: 0, wrong: 0, miss: 0 },
    byTitleSlug: { hit: 0, wrong: 0, miss: 0 },
    byShortSlug: { hit: 0, wrong: 0, miss: 0, n: 0 }
  };
  const wrongExamples: string[] = [];

  const check = async (query: string, expectedId: string, bucket: { hit: number; wrong: number; miss: number }) => {
    const match = await (CatalogService as any).findDbRowScored(query);
    if (!match) {
      bucket.miss++;
      return;
    }
    if (match.row.id === expectedId) {
      bucket.hit++;
    } else {
      // Ambiguo por diseño (dos fichas comparten título/slug): solo cuenta como error real
      // si la puntuación es de confianza y apunta a otra ficha.
      bucket.wrong++;
      if (wrongExamples.length < 15) {
        wrongExamples.push(`  "${query}" → ${match.row.id} ("${match.row.title}", score ${match.score}) ≠ ${expectedId}`);
      }
    }
  };

  for (const row of data) {
    await check(row.id, row.id, stats.byId);
    await check(slugify(row.title), row.id, stats.byTitleSlug);
    const short = shortSlug(row.id);
    if (short) {
      stats.byShortSlug.n++;
      await check(short, row.id, stats.byShortSlug);
    }
  }

  const pct = (n: number, total: number) => (total > 0 ? ((n / total) * 100).toFixed(1) : '0.0');
  console.log(`Muestra: ${data.length} fichas\n`);
  console.log(`por id exacto     : ${stats.byId.hit} ok / ${stats.byId.wrong} cruzadas / ${stats.byId.miss} sin match  (${pct(stats.byId.hit, data.length)}%)`);
  console.log(`por slug de título: ${stats.byTitleSlug.hit} ok / ${stats.byTitleSlug.wrong} cruzadas / ${stats.byTitleSlug.miss} sin match  (${pct(stats.byTitleSlug.hit, data.length)}%)`);
  console.log(`por slug corto    : ${stats.byShortSlug.hit} ok / ${stats.byShortSlug.wrong} cruzadas / ${stats.byShortSlug.miss} sin match  (${pct(stats.byShortSlug.hit, stats.byShortSlug.n)}% de ${stats.byShortSlug.n})`);

  if (wrongExamples.length > 0) {
    console.log('\nCoincidencias que apuntan a otra ficha (revisar si son títulos duplicados):');
    console.log(wrongExamples.join('\n'));
  }
})();
