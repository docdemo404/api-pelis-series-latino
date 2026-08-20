import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
(async () => {
  const { data } = await supabase.from('media_items').select('id,title,servers').limit(3000);
  for (const f of (data || []) as any[]) {
    const r = (f.servers || []).filter((s: any) => /remux\.unlimplay/i.test(String(s.direct_stream || s.embed_url || '')));
    if (r.length) console.log(`${f.id} | ${f.title} | ${r.length} servidor(es) remux | sello=${r.map((x:any)=>x.verified_at ? 'SI' : 'no').join(',')}`);
  }
})();
