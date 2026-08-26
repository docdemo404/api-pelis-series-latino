/**
 * ¿Cuántas fichas se muestran con nombre en inglés teniendo TMDB uno en español?
 *   npx ts-node scripts/dev/diag_titulo_ingles.ts
 */
import 'dotenv/config';
import axios from 'axios';
import { supabase } from '../../src/services/supabaseService';
const KEY = '99b8bc99e85e79fabd52b64513c9780d';

(async () => {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase.from('media_items').select('id,tmdb_id,type,title,original_title').range(from, from + 999);
    if (!data?.length) break; rows.push(...data); if (data.length < 1000) break;
  }
  const iguales = rows.filter(r => r.tmdb_id > 0 && r.title?.trim().toLowerCase() === r.original_title?.trim().toLowerCase());
  let noEspanol = 0, conTraduccion = 0, sinTraduccion = 0;
  const recuperables: string[] = [];
  for (const r of iguales) {
    const ep = r.type === 'tvseries' ? 'tv' : 'movie';
    const d = (await axios.get(`https://api.themoviedb.org/3/${ep}/${r.tmdb_id}`, {
      params: { api_key: KEY, append_to_response: 'translations' }, timeout: 8000, validateStatus: () => true })).data;
    if (d?.original_language === 'es') continue;
    noEspanol++;
    const es = (d?.translations?.translations || [])
      .filter((t: any) => t?.iso_639_1 === 'es')
      .map((t: any) => (t?.data?.title || t?.data?.name || '').trim())
      .filter((t: string) => t && t.toLowerCase() !== r.title.trim().toLowerCase());
    if (es.length) { conTraduccion++; if (recuperables.length < 25) recuperables.push(`${r.title}  →  ${es[0]}`); }
    else sinTraduccion++;
  }
  console.log(`title === original_title              ${iguales.length}`);
  console.log(`   …y el idioma original NO es español ${noEspanol}`);
  console.log(`      TMDB tiene nombre en español      ${conTraduccion}   ← recuperable`);
  console.log(`      TMDB no lo tiene                  ${sinTraduccion}`);
  for (const l of recuperables) console.log(`      · ${l}`);
})();
