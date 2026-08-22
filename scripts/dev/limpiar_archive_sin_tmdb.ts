/**
 * RETIRAR LAS FICHAS DE ARCHIVE.ORG QUE NUNCA TUVIERON IDENTIDAD EN TMDB.
 *
 * En archive.org no hay título: hay el nombre que le puso quien subió el fichero. Cuando el
 * matcher no daba con la obra, el crawl guardaba la ficha igual con la metadata de la fuente y un
 * `tmdb_id` sintético NEGATIVO — y así entraron en el catálogo «Bob Esponja Parodia La Película
 * Luisjefe1», «CINESAURIO - 2025 10 23 - CARTELERA DE ESTRENOS» o «Видео Violeta Se Fue A Los
 * Cielos OK. RU 2», todas sin carátula.
 *
 * El crawl ya no las crea (`refreshCatalog.ts`: en archive.org, sin TMDB no hay ficha), pero una
 * regla nueva no limpia el pasado. Esto retira lo que hoy no entraría.
 *
 * Solo toca `archive-*` con `tmdb_id <= 0`. Una ficha con match real no se toca aunque le falte
 * el póster, y las demás fuentes no entran aquí: ellas sí publican títulos de verdad y su
 * fallback de metadata sigue siendo bueno.
 *
 *   npx ts-node -T scripts/dev/limpiar_archive_sin_tmdb.ts [--apply]
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { CatalogService } from '../../src/services/catalogService';

const db = getSupabaseAdmin();
const apply = process.argv.includes('--apply');

(async () => {
  const { data, error } = await db
    .from('media_items').select('id,title,type,tmdb_id,poster').like('id', 'archive-%');
  if (error) { console.error('no se pudo leer:', error.message); return; }

  const filas = (data || []) as any[];
  const fuera = filas.filter(f => Number(f.tmdb_id) <= 0);

  console.log(`${filas.length} fichas de archive.org · ${fuera.length} sin identidad en TMDB${apply ? '' : ' (ENSAYO)'}\n`);
  for (const f of fuera) {
    console.log(`   ✗ tmdb:${String(f.tmdb_id).padStart(12)}  poster:${f.poster ? 'sí' : 'NO'}  «${String(f.title).slice(0, 60)}»`);
  }
  if (!fuera.length) return;
  if (!apply) { console.log('\n   (ensayo — con --apply se borran)'); return; }

  let borradas = 0;
  for (const f of fuera) {
    const { error: e } = await db.from('media_items').delete().eq('id', f.id);
    if (e) { console.warn(`   ⚠ ${f.id}: ${e.message}`); continue; }
    borradas++;
    await CatalogService.invalidateItem({ id: f.id, type: f.type } as any).catch(() => {});
  }
  await CatalogService.invalidateListings().catch(() => {});
  console.log(`\n   ${borradas} borradas y caché purgado.`);
})();
