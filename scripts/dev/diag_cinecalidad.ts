/** ¿Cuánto entrega Cinecalidad al crawl, y cuánto de eso está en la base? */
import 'dotenv/config';
import { RealScraperService } from '../../src/services/realScraperService';
import { supabase } from '../../src/services/supabaseService';

(async () => {
  for (const t of ['movie', 'tvseries'] as const) {
    const t0 = Date.now();
    const items = await (RealScraperService as any).scrapeCinecalidadLatest(t, 300)
      .catch((e: any) => { console.log(`  ERROR: ${e.message}`); return []; });
    console.log(`\n${t}: ${items.length} títulos en ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    let enDb = 0;
    for (const it of items.slice(0, 60)) {
      const { data } = await supabase.from('media_items').select('id').eq('id', it.id).maybeSingle();
      if (data) enDb++;
    }
    console.log(`  de los 60 primeros, ${enDb} están en la base`);
    console.log(`  ejemplos: ${items.slice(0, 5).map((i: any) => `${i.id}`).join(' · ')}`);
  }
  const { count } = await supabase.from('media_items')
    .select('id', { count: 'exact', head: true }).like('id', 'ver-%');
  console.log(`\nfilas con id de Cinecalidad en la base: ${count}`);
})();
