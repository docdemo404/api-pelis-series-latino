/** Vacía media_items. Pedido explícitamente: la base se reconstruye solo con lo que reproduce. */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
const db = getSupabaseAdmin();
(async () => {
  const { count: antes } = await db.from('media_items').select('id', { count: 'exact', head: true });
  console.log(`filas antes: ${antes}`);
  let borradas = 0;
  for (;;) {
    const { data } = await db.from('media_items').select('id').limit(500);
    if (!data?.length) break;
    const ids = data.map((r: any) => r.id);
    const { error } = await db.from('media_items').delete().in('id', ids);
    if (error) { console.error(error.message); break; }
    borradas += ids.length;
    process.stderr.write(`  …${borradas}\r`);
  }
  const { count: despues } = await db.from('media_items').select('id', { count: 'exact', head: true });
  console.log(`\nborradas ${borradas} · quedan ${despues}`);
})();
