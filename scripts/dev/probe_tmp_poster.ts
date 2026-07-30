/** ¿Hay fichas distintas compartiendo la misma carátula de TMDB? Una de las dos la tiene ajena. */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';

const db = getSupabaseAdmin();

const hash = (u: string | null): string | null => {
  const m = String(u || '').match(/([\w-]+\.(?:jpg|jpeg|png|webp))$/i);
  return m ? m[1] : null;
};

(async () => {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('media_items').select('id,tmdb_id,type,title,release_date,poster').range(from, from + 999);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  console.log(`${rows.length} filas`);

  const porPoster = new Map<string, any[]>();
  for (const r of rows) {
    const h = hash(r.poster);
    if (!h) continue;
    porPoster.set(h, [...(porPoster.get(h) || []), r]);
  }

  let choques = 0;
  const ejemplos: string[] = [];
  for (const [h, grupo] of porPoster) {
    const ids = new Set(grupo.filter(r => r.tmdb_id > 0).map(r => r.tmdb_id));
    if (ids.size < 2) continue;
    choques++;
    if (ejemplos.length < 12) {
      ejemplos.push(`${h}\n      ` + grupo.map(r => `${r.id} = "${r.title}" (${String(r.release_date).slice(0, 4)}) tmdb=${r.tmdb_id}`).join('\n      '));
    }
  }
  console.log(`\ncarátulas compartidas por fichas con tmdb_id distinto: ${choques}`);
  for (const e of ejemplos) console.log(`   · ${e}`);
})();
