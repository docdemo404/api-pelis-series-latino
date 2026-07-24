/**
 * Repara fichas donde el TÍTULO casi cuadra pero el VÍDEO es otra película.
 * Compara el og:image (TMDB) de la página de origen con el de la ficha guardada; si difiere,
 * resuelve la página por su imagen y SOLO actúa si la imagen del candidato nuevo coincide
 * EXACTAMENTE con la de la página (prueba definitiva de que es esa película).
 *   - id correcto libre  → re-etiqueta la ficha (UPDATE).
 *   - id correcto ocupado → funde la fuente en la ficha buena y borra el duplicado (sin pérdidas).
 *
 *   ts-node -T scripts/dev/diag_image_mismatch.ts [--limit=N]            # dry-run
 *   ts-node -T scripts/dev/diag_image_mismatch.ts [--limit=N] --apply    # escribe
 */
import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { TmdbService } from '../../src/services/tmdbService';
import { searchIndexKey } from '../../src/utils/text';
import { USER_AGENT } from '../../src/utils/httpClient';
const db = getSupabaseAdmin();
const APPLY = process.argv.includes('--apply');
const LIMIT = parseInt((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '600', 10);

function imgHash(u?: string | null): string | null {
  if (!u) return null;
  const m = String(u).match(/([\w-]+\.(?:jpg|jpeg|png|webp))/i);
  return m ? m[1] : null;
}

(async () => {
  const { data } = await db.from('media_items').select('*')
    .eq('metadata_source', 'tmdb').eq('type', 'movie')
    .ilike('source_url', '%tioplus%').limit(LIMIT);

  let checked = 0, relabel = 0, collision = 0, skip = 0, errs = 0;
  for (const r of data || []) {
    if (!r.source_url) continue;
    let og: string | undefined, h1 = '', year: string | undefined;
    try {
      const res = await axios.get(r.source_url, { headers: { 'User-Agent': USER_AGENT }, timeout: 7000 });
      const $ = cheerio.load(res.data);
      og = $('meta[property="og:image"]').attr('content') || undefined;
      const h1raw = $('h1.slugh1, h1').first().text();
      h1 = h1raw.replace(/\s*\(\d{4}\)\s*$/, '').trim();
      const ym = h1raw.match(/\((\d{4})\)/); year = ym ? ym[1] : undefined;
    } catch { errs++; continue; }

    const ogh = imgHash(og);
    if (!ogh) continue;
    checked++;
    if ([imgHash(r.poster), imgHash(r.backdrop)].filter(Boolean).includes(ogh)) continue; // imagen ya coincide → ok

    const m = await TmdbService.resolveTmdb(h1, 'movie', year, r.id, { imageHint: og });
    if (!m.matched || m.id <= 0 || m.id === r.tmdb_id) { skip++; continue; }
    const nd = await TmdbService.getTmdbDetails(m.id, 'movie').catch(() => null);
    const ndImgs = [imgHash(nd?.poster_path), imgHash(nd?.backdrop_path)].filter(Boolean) as string[];
    if (!ndImgs.includes(ogh)) { skip++; continue; } // el candidato NO está confirmado por imagen → no tocar

    const { data: clash } = await db.from('media_items').select('id,title,source_url,source_urls').eq('tmdb_id', m.id).neq('id', r.id);
    const twin = clash && clash[0];

    if (!twin) {
      relabel++;
      console.log(`RE-ETIQUETAR ${r.id}: "${r.title}" (${r.tmdb_id}) → "${nd?.title}" (${m.id})`);
      if (APPLY) {
        const en = await TmdbService.enrichMediaItem({ ...r, tmdb_id: m.id } as any, { skipSeasons: true });
        const upd: Record<string, unknown> = {
          tmdb_id: en.tmdb_id, title: en.title, original_title: en.original_title || en.title,
          title_normalized: searchIndexKey(en.title, en.original_title, en.aliases), aliases: en.aliases || [],
          overview: en.overview || '', rating: en.rating || 0, release_date: en.release_date || '',
          genres: en.genres || [], poster: en.poster, backdrop: en.backdrop,
          metadata_source: 'tmdb', updated_at: new Date().toISOString()
        };
        const { error } = await db.from('media_items').update(upd).eq('id', r.id);
        if (error) console.log('   ERROR update:', error.message);
      }
    } else {
      collision++;
      console.log(`COLISIÓN  ${r.id}: "${r.title}" es en realidad "${nd?.title}" (${m.id}); ya la tiene ${twin.id} → fundir+borrar`);
      if (APPLY) {
        const badUrls = [r.source_url, ...(r.source_urls || [])].filter(Boolean);
        const curr = [twin.source_url, ...(twin.source_urls || [])].filter(Boolean) as string[];
        const merged = Array.from(new Set([...curr, ...badUrls]));
        if (merged.length > curr.length) {
          const { error } = await db.from('media_items').update({ source_urls: merged, updated_at: new Date().toISOString() }).eq('id', twin.id);
          if (error) { console.log('   ERROR merge:', error.message); continue; }
        }
        const { error: de } = await db.from('media_items').delete().eq('id', r.id);
        if (de) console.log('   ERROR delete:', de.message);
      }
    }
  }
  console.log(`\n${checked} revisadas · ${relabel} re-etiquetar (id libre) · ${collision} colisiones (fundir+borrar) · ${skip} no confirmadas por imagen (intactas) · ${errs} errores fetch`);
})().then(() => setTimeout(() => process.exit(0), 300));
