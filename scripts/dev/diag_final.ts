import 'dotenv/config';
import { CatalogService } from '../../src/services/catalogService';
import { supabase } from '../../src/services/supabaseService';

/** Estado final de los casos concretos reportados. */
(async () => {
  console.log('=== 1. Duplicados: Minions ===');
  const { data: minions } = await supabase
    .from('media_items').select('id,tmdb_id,title,source_urls,aliases')
    .ilike('title_normalized', '%minions%');
  for (const r of minions || []) {
    console.log(`   ${r.tmdb_id}\t"${r.title}"\t| fuentes=${(r.source_urls || []).length} alias=${(r.aliases || []).length}`);
  }
  const gru = (minions || []).find((r: any) => r.tmdb_id === 438148);
  if (gru) {
    const streams = await CatalogService.getStreams(gru.id, 'movie', { deep: true });
    console.log(`   -> servidores unificados de "${streams?.title}": ${streams?.servers?.length ?? 0}`);
  }

  console.log('\n=== 2. Variantes regionales que citaste ===');
  for (const q of ['zootopia', 'zootropolis', 'solo en casa', 'mi pobre angelito']) {
    const { data } = await supabase
      .from('media_items').select('tmdb_id,title').ilike('title_normalized', `%${q}%`).limit(4);
    console.log(`   ${q.padEnd(20)} ${(data || []).map((r: any) => `${r.tmdb_id}:"${r.title}"`).join('  ') || '(ninguna)'}`);
  }

  console.log('\n=== 3. Fantasmas ===');
  const head = async (apply: (q: any) => any) => {
    const { count } = await apply(supabase.from('media_items').select('id', { count: 'exact', head: true }));
    return count ?? 0;
  };
  console.log(`   verificadas CON enlaces  ${await head((q: any) => q.eq('has_streams', true))}`);
  console.log(`   fantasmas (ocultas)      ${await head((q: any) => q.eq('has_streams', false))}`);
  console.log(`   aún sin comprobar        ${await head((q: any) => q.is('has_streams', null))}`);

  console.log('\n=== 4. Salud general ===');
  console.log(`   total                    ${await head((q: any) => q)}`);
  console.log(`   tmdb_id sintético        ${await head((q: any) => q.lt('tmdb_id', 0))}`);
  console.log(`   fichas multifuente       ${await head((q: any) => q.not('source_urls', 'eq', '{}'))}`);
})();
