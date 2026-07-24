import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';

async function count(apply: (q: any) => any): Promise<number> {
  const { count: n } = await apply(supabase.from('media_items').select('id', { count: 'exact', head: true }));
  return n ?? 0;
}

(async () => {
  const total = await count((q: any) => q);
  const movies = await count((q: any) => q.eq('type', 'movie'));
  const series = await count((q: any) => q.eq('type', 'tvseries'));
  const anime = await count((q: any) => q.contains('subcategories', ['Anime']));
  const withGenres = await count((q: any) => q.not('genres', 'eq', '{}'));
  const withPoster = await count((q: any) => q.not('poster', 'is', null));
  const fromTmdb = await count((q: any) => q.eq('metadata_source', 'tmdb'));
  const withTrailer = await count((q: any) => q.not('trailer', 'is', null));

  console.log(`Total          ${total}`);
  console.log(`  Películas    ${movies}`);
  console.log(`  Series       ${series}   (de ellas anime: ${anime})`);
  console.log(`Con póster     ${withPoster}  (${((withPoster / total) * 100).toFixed(1)}%)`);
  console.log(`Con géneros    ${withGenres}  (${((withGenres / total) * 100).toFixed(1)}%)  ← elegibles para el home`);
  console.log(`Ficha de TMDB  ${fromTmdb}  (${((fromTmdb / total) * 100).toFixed(1)}%)`);
  console.log(`Con tráiler    ${withTrailer}  (${((withTrailer / total) * 100).toFixed(1)}%)`);
})();
