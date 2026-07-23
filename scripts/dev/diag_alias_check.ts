import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';

(async () => {
  const { data } = await supabase
    .from('media_items')
    .select('id,tmdb_id,title,original_title,aliases,title_normalized,source_urls')
    .eq('tmdb_id', 12536).limit(1);
  const r: any = (data || [])[0];
  if (!r) { console.log('no encontrada'); return; }

  console.log(`id=${r.id}\ntitle="${r.title}"\noriginal="${r.original_title}"`);
  console.log(`aliases (${(r.aliases || []).length}):`);
  for (const a of r.aliases || []) console.log(`   · "${a}"`);
  console.log(`fuentes (${(r.source_urls || []).length}):`);
  for (const u of r.source_urls || []) console.log(`   · ${u}`);
  console.log(`title_normalized = "${r.title_normalized}"`);

  // ¿Cuántas fichas tienen más alias de los que cabría esperar? Señal de contaminación.
  const { data: many } = await supabase
    .from('media_items').select('id,tmdb_id,title,aliases')
    .limit(2000);
  const suspicious = (many || []).filter((x: any) => (x.aliases || []).length > 3);
  console.log(`\nfichas con >3 alias en una muestra de ${(many || []).length}: ${suspicious.length}`);
  for (const s of suspicious.slice(0, 8)) {
    console.log(`   ${s.tmdb_id} "${s.title}" -> ${JSON.stringify(s.aliases)}`);
  }

  const { count: synth } = await supabase
    .from('media_items').select('id', { count: 'exact', head: true }).lt('tmdb_id', 0);
  console.log(`\nfichas con id sintetico restantes: ${synth}`);
})();
