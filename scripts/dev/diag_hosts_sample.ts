import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';

/** Vuelca embeds completos de un host del catálogo, para inspeccionar su forma. */
async function main() {
  const needle = process.argv[2] || 'blogspot';
  const { data } = await getSupabaseAdmin()
    .from('media_items').select('servers').not('servers', 'is', null).neq('servers', '[]').limit(400);
  const seen = new Set<string>();
  for (const row of data || []) {
    for (const s of (row.servers || []) as any[]) {
      if (!s?.embed_url || !s.embed_url.includes(needle) || seen.has(s.embed_url)) continue;
      seen.add(s.embed_url);
      console.log('\n' + s.embed_url);
      if (seen.size >= 3) return;
    }
  }
  if (seen.size === 0) console.log('sin embeds de', needle);
}
main().then(() => setTimeout(() => process.exit(0), 400).unref());
