/** ¿Los CAPÍTULOS guardados llevan nombre/sinopsis/fotograma de TMDB, o los de la web? */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';

(async () => {
  const filas: any[] = [];
  for (let desde = 0; ; desde += 500) {
    const { data, error } = await supabase.from('media_items')
      .select('id,tmdb_id,title,type,seasons,source_url,source_urls,metadata_source')
      .eq('type', 'tvseries').order('id', { ascending: true }).range(desde, desde + 499);
    if (error) { console.log('ERROR', error.message); break; }
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 500) break;
  }
  console.log(`series: ${filas.length}`);

  let epsTotal = 0, sinStill = 0, sinopsisWeb = 0, nombreSxE = 0;
  const culpables = new Map<string, number>();
  for (const s of filas) {
    for (const t of (s.seasons || [])) {
      for (const e of (t.episodes || [])) {
        epsTotal++;
        const ov = String(e.overview || '');
        const nm = String(e.name || '');
        if (!e.still_path) sinStill++;
        if (/FuegoCine|online gratis|TioPlus|Cinecalidad/i.test(ov)) { sinopsisWeb++; culpables.set(s.title, (culpables.get(s.title) || 0) + 1); }
        if (/\d{1,2}\s*x\s*\d{1,3}/i.test(nm) || /^Episodio \d+$/i.test(nm)) nombreSxE++;
      }
    }
  }
  console.log(`capítulos guardados: ${epsTotal}`);
  console.log(`  sin fotograma (still_path null): ${sinStill}  (${(sinStill/(epsTotal||1)*100).toFixed(1)}%)`);
  console.log(`  con sinopsis de la web:          ${sinopsisWeb}  (${(sinopsisWeb/(epsTotal||1)*100).toFixed(1)}%)`);
  console.log(`  con nombre "SxE"/"Episodio N":   ${nombreSxE}  (${(nombreSxE/(epsTotal||1)*100).toFixed(1)}%)`);
  console.log('\n  series con capítulos rotulados por la web:');
  for (const [t, n] of [...culpables.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 20)) console.log(`     ${n.toString().padStart(4)}  ${t}`);
})();
