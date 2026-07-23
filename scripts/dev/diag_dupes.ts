import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';

(async () => {
  console.log('=== MINIONS ===');
  const { data: minions } = await supabase
    .from('media_items')
    .select('id,tmdb_id,type,title,original_title,release_date,source_url,servers,metadata_source')
    .ilike('title_normalized', '%minions%');
  for (const r of minions || []) {
    console.log(
      `${r.tmdb_id}\t${r.type}\t${r.title} | ${r.id} | servers=${(r.servers || []).length} | src=${r.source_url ? 'si' : 'NO'} | meta=${r.metadata_source}`
    );
  }

  console.log('\n=== PACTO DE SILENCIO ===');
  const { data: pacto } = await supabase
    .from('media_items')
    .select('id,tmdb_id,type,title,release_date,source_url,servers,seasons')
    .ilike('title_normalized', '%pacto de silencio%');
  for (const r of pacto || []) {
    const eps = (r.seasons || []).reduce((n: number, s: any) => n + (s.episodes?.length || 0), 0);
    const epsWith = (r.seasons || []).reduce(
      (n: number, s: any) => n + (s.episodes || []).filter((e: any) => (e.servers || []).length > 0).length, 0);
    console.log(
      `${r.tmdb_id}\t${r.type}\t${r.title} | ${r.id} | servers=${(r.servers || []).length} | eps=${epsWith}/${eps} | src=${r.source_url ? 'si' : 'NO'}`
    );
  }

  console.log('\n=== ESCALA GLOBAL ===');
  const head = async (apply: (q: any) => any) => {
    const { count } = await apply(supabase.from('media_items').select('id', { count: 'exact', head: true }));
    return count ?? 0;
  };
  const total = await head((q: any) => q);
  const synthetic = await head((q: any) => q.lt('tmdb_id', 0));
  const noSource = await head((q: any) => q.is('source_url', null));
  const noStreams = await head((q: any) => q.is('streams_updated_at', null));
  console.log(`total=${total} | tmdb_id sintetico=${synthetic} | sin source_url=${noSource} | sin streams_updated_at=${noStreams}`);
})();
