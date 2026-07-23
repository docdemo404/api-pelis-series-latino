import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';

function fileOf(url: string | null): string | null {
  if (!url) return null;
  const m = String(url).match(/\/([^/]+\.(?:jpg|png|webp|svg))$/i);
  return m ? m[1] : null;
}
function sizeOf(url: string | null): string {
  const m = String(url || '').match(/\/t\/p\/([^/]+)\//);
  return m ? m[1] : '-';
}

(async () => {
  const rows: any[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('media_items')
      .select('id,tmdb_id,title,poster,backdrop,genres,metadata_source')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  const conflated = rows.filter(r => {
    const p = fileOf(r.poster), b = fileOf(r.backdrop);
    return p && b && p === b;
  });

  // Distinguir los DOS vectores por el tamaño con el que se guardó cada campo:
  //  · vector "slider": el backdrop se copió al poster reescalando w1280 -> w342,
  //    así que los tamaños DIFIEREN (poster w342 / backdrop w1280).
  //  · vector "article": el poster vertical real se copió tal cual al backdrop,
  //    así que ambos campos comparten tamaño.
  const sliderVector = conflated.filter(r => sizeOf(r.poster) !== sizeOf(r.backdrop));
  const articleVector = conflated.filter(r => sizeOf(r.poster) === sizeOf(r.backdrop));

  console.log(`total                                   ${rows.length}`);
  console.log(`poster y backdrop = mismo fichero        ${conflated.length}`);
  console.log(`   backdrop copiado al POSTER (tamaños distintos)  ${sliderVector.length}`);
  console.log(`   poster copiado al BACKDROP (mismo tamaño)       ${articleVector.length}`);

  const tally = new Map<string, number>();
  for (const r of conflated) {
    const k = `poster=${sizeOf(r.poster)} backdrop=${sizeOf(r.backdrop)}`;
    tally.set(k, (tally.get(k) || 0) + 1);
  }
  console.log('\nCombinaciones de tamaño:');
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${k}\t${v}`);

  console.log('\nEjemplos del vector "backdrop en poster":');
  for (const r of sliderVector.slice(0, 5)) {
    console.log(`   ${r.title} | ${r.id}\n      poster  =${r.poster}\n      backdrop=${r.backdrop}`);
  }
})();
