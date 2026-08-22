import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';

const MARCA = 'https://prueba-crawl-no-borrar.invalid/';
const esMarca = (sv: any) => String(sv?.direct_stream || '').startsWith(MARCA);

(async () => {
  const db = getSupabaseAdmin();
  const filas: any[] = [];
  let d = 0;
  for (;;) {
    const { data } = await db.from('media_items').select('id,type,seasons').order('id').range(d, d + 199);
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 200) break;
    d += 200;
  }
  for (const r of filas.filter(r => r.type === 'tvseries' && (r.seasons || []).length)) {
    const caps = (r.seasons || []).flatMap((t: any) =>
      (t.episodes || []).map((e: any) => ({
        k: `${t.season_number}x${e.episode_number}`,
        m: (e.servers || []).some(esMarca),
      })));
    const conMarca = caps.filter((c: any) => c.m).map((c: any) => c.k);
    console.log(
      r.id.padEnd(14),
      'temporadas:' + (r.seasons || []).length,
      'primerEp:' + (caps[0] ? caps[0].k : '-'),
      'marcas:' + (conMarca.join(',') || 'NINGUNA'));
  }
  process.exit(0);
})();
