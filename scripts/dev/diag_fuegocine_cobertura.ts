/**
 * ¿Se trae el crawl TODO lo que publica FuegoCine? Recorre su feed y compara con la base.
 */
import 'dotenv/config';
import { RealScraperService } from '../../src/services/realScraperService';
import { supabase } from '../../src/services/supabaseService';

(async () => {
  const t0 = Date.now();
  const items = await (RealScraperService as any).scrapeAllFuegocine().catch((e: any) => {
    console.log(`ERROR: ${e.message}`);
    return [];
  });
  console.log(`FuegoCine entrega ${items.length} títulos en ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  const porTipo: Record<string, number> = {};
  for (const it of items) porTipo[it.type] = (porTipo[it.type] || 0) + 1;
  console.log(`  por tipo: ${JSON.stringify(porTipo)}`);

  const { count } = await supabase.from('media_items').select('id', { count: 'exact', head: true })
    .or('id.like.fc-%,id.like.2%-%-%');
  console.log(`  en la base (ids de fuegocine): ~${count}`);

  // ¿Cuántos de los que entrega NO están?
  let faltan = 0;
  const ejemplos: string[] = [];
  const muestra = items.slice(0, 300);
  for (const it of muestra) {
    const { data } = await supabase.from('media_items').select('id').eq('id', it.id).maybeSingle();
    if (!data) { faltan++; if (ejemplos.length < 10) ejemplos.push(`${it.id}  «${it.title}»`); }
  }
  console.log(`\n  de ${muestra.length} muestreados, ${faltan} NO están en la base`);
  if (ejemplos.length) console.log(`     ${ejemplos.join('\n     ')}`);
})();
