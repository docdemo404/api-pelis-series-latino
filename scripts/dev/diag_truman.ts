import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
(async () => {
  const { data } = await supabase.from('media_items')
    .select('id,title,type,tmdb_id,release_date,has_streams,poster,streams_checked_at,streams_updated_at,servers')
    .or('title.ilike.%truman%,title_normalized.ilike.%truman%').limit(6);
  for (const r of data ?? []) {
    console.log(`\n«${r.title}» (${String(r.release_date).slice(0,4)})  id=${r.id}  tmdb=${r.tmdb_id}`);
    console.log(`   has_streams=${r.has_streams}  sello=${String(r.streams_checked_at).slice(0,19)}  resuelta=${String(r.streams_updated_at).slice(0,19)}`);
    for (const s of (r.servers ?? [])) {
      let host = '—'; try { host = new URL(s.embed_url || '').hostname; } catch {}
      console.log(`   ${host.padEnd(26)} directo=${s.direct_stream ? 'SI' : 'no'} modo=${String(s.direct_mode ?? '—').padEnd(9)} estado=${String(s.status ?? '—').padEnd(8)} sello=${s.verified_at ? String(s.verified_at).slice(0,19) : 'NUNCA'}`);
    }
  }
})();
