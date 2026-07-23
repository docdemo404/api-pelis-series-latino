import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';

/** Comprueba que la migración 005 está aplicada antes de lanzar reparaciones. */
(async () => {
  let ok = true;

  for (const col of ['source_urls', 'has_streams', 'streams_checked_at']) {
    const { error } = await supabase.from('media_items').select(col).limit(1);
    console.log(`   columna ${col.padEnd(20)} ${error ? 'FALTA — ' + error.message : 'OK'}`);
    if (error) ok = false;
  }

  // El RPC debe excluir ya las fichas fantasma (has_streams IS DISTINCT FROM false).
  const { error: rpcError } = await supabase.rpc('search_media', { q: 'shrek', lim: 3, off: 0 });
  console.log(`   RPC search_media${''.padEnd(9)} ${rpcError ? 'ERROR — ' + rpcError.message : 'OK'}`);
  if (rpcError) ok = false;

  // Backfill de source_urls desde source_url.
  const { count: withUrls } = await supabase
    .from('media_items').select('id', { count: 'exact', head: true }).not('source_urls', 'eq', '{}');
  const { count: withUrl } = await supabase
    .from('media_items').select('id', { count: 'exact', head: true }).not('source_url', 'is', null);
  console.log(`   backfill: source_urls poblado en ${withUrls} filas (source_url no nulo en ${withUrl})`);

  console.log(ok ? '\n✅ Migración 005 aplicada: se puede reparar.' : '\n❌ Falta la migración 005.');
  process.exitCode = ok ? 0 : 1;
})();
