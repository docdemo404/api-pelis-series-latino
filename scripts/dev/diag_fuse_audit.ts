import 'dotenv/config';
import axios from 'axios';
import { supabase } from '../../src/services/supabaseService';
import { canonicalTitle, normalizeTitle } from '../../src/utils/text';

const API_KEY = '99b8bc99e85e79fabd52b64513c9780d';

function similarity(a: string, b: string): number {
  const ca = canonicalTitle(a), cb = canonicalTitle(b);
  if (!ca || !cb) return 0;
  if (ca === cb) return 1;
  if (ca.startsWith(cb) || cb.startsWith(ca)) return 0.85;
  if (ca.includes(cb) || cb.includes(ca)) return 0.7;
  const tok = (s: string) => new Set(normalizeTitle(s).split(/[^a-z0-9]+/).filter(Boolean));
  const ta = tok(a), tb = tok(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0; ta.forEach(t => { if (tb.has(t)) inter++; });
  return (2 * inter) / (ta.size + tb.size);
}

const cache = new Map<number, string[]>();
async function knownTitles(id: number, type: string): Promise<string[]> {
  if (cache.has(id)) return cache.get(id)!;
  const ep = type === 'tvseries' ? 'tv' : 'movie';
  try {
    const res = await axios.get(`https://api.themoviedb.org/3/${ep}/${id}`, {
      params: { api_key: API_KEY, append_to_response: 'alternative_titles,translations' }, timeout: 5000
    });
    const d = res.data || {};
    const alt: any[] = d.alternative_titles?.titles || d.alternative_titles?.results || [];
    const tr: any[] = d.translations?.translations || [];
    const out = [d.title, d.name, d.original_title, d.original_name,
      ...alt.map(t => t?.title), ...tr.map(t => t?.data?.title || t?.data?.name)].filter(Boolean) as string[];
    cache.set(id, out);
    return out;
  } catch { cache.set(id, []); return []; }
}

(async () => {
  // Las fichas fusionadas son las que acabaron con más de una fuente o más de un alias.
  const { data } = await supabase
    .from('media_items')
    .select('id,tmdb_id,type,title,aliases,source_urls')
    .gt('tmdb_id', 0)
    .limit(20000);

  const merged = (data || []).filter((r: any) => (r.aliases || []).length > 1 || (r.source_urls || []).length > 1);
  console.log(`Fichas con señales de fusión: ${merged.length}\n`);

  const bad: any[] = [];
  const CONC = 5;
  for (let i = 0; i < merged.length; i += CONC) {
    const chunk = merged.slice(i, i + CONC);
    await Promise.all(chunk.map(async (r: any) => {
      const titles = await knownTitles(r.tmdb_id, r.type);
      if (titles.length === 0) return;
      // Un alias es legítimo si TMDB lo reconoce como nombre de esa ficha.
      const orphan = (r.aliases || []).filter((a: string) => {
        const vsTitle = similarity(a, r.title);
        const vsTmdb = Math.max(0, ...titles.map(t => similarity(a, t)));
        return vsTitle < 0.6 && vsTmdb < 0.6;
      });
      if (orphan.length > 0) bad.push({ ...r, orphan });
    }));
    if (i > 0 && i % 200 === 0) console.log(`   ...${i}/${merged.length}`);
  }

  console.log(`\n❌ Fichas con alias que TMDB NO reconoce: ${bad.length}`);
  for (const b of bad.slice(0, 40)) {
    console.log(`   ${b.tmdb_id} "${b.title}"  <-- ${JSON.stringify(b.orphan)}`);
  }
})();
