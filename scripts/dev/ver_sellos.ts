import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';

/** Cuándo se tocó por última vez cada fila que se le pase, para saber QUIÉN la reescribió. */
(async () => {
  const db = getSupabaseAdmin();
  const ids = process.argv.slice(2);
  const { data, error } = await db
    .from('media_items')
    .select('id,updated_at,streams_updated_at,streams_checked_at,has_streams')
    .in('id', ids);
  if (error) { console.error(error.message); process.exit(1); }
  for (const r of (data as any[]) || []) {
    console.log(`${r.id.padEnd(14)} updated=${r.updated_at} streams_updated=${r.streams_updated_at} checked=${r.streams_checked_at} has_streams=${r.has_streams}`);
  }
  console.log('ahora           =', new Date().toISOString());
  process.exit(0);
})();
