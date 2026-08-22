import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
(async () => {
  const db = getSupabaseAdmin();
  const { data, error } = await db.from('media_items')
    .select('id,title,type,total_seasons,seasons,servers,has_streams,updated_at')
    .in('id', ['md-82856', 'md-1396', 'md-66732']);
  if (error) return console.log('ERROR', error.message);
  for (const r of (data as any[]) || []) {
    const ss = r.seasons || [];
    const caps = ss.reduce((n: number, t: any) => n + (t.episodes || []).length, 0);
    console.log(`${r.id} "${r.title}" tipo=${r.type} total_seasons=${r.total_seasons} | guardado: ${ss.length} temporadas / ${caps} caps | servers=${(r.servers || []).length} | has_streams=${r.has_streams} | ${r.updated_at}`);
  }
  const { count } = await db.from('media_items').select('id', { count: 'exact', head: true }).like('id', 'md-%');
  console.log('filas md-* en la base:', count);
  process.exit(0);
})();
