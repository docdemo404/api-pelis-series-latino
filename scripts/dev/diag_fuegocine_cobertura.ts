/**
 * ¿Se trae el crawl TODO lo que publica FuegoCine?
 *
 * BUSCAR POR ID NO BASTA, y creérselo cuesta un diagnóstico entero. Cuando un título está en las
 * dos webs, el catálogo NO guarda dos filas: la segunda fuente se funde en la ficha que ya existe
 * y su página queda apuntada en `source_urls`. Preguntar por el id de FuegoCine da «no está» para
 * todo lo que TioPlus ya traía —el 26 % de la muestra— cuando en realidad estaba, fusionado y con
 * sus servidores dentro.
 *
 * Por título tampoco vale: «Los Simpson: La Pelicula» de FuegoCine es «Los Simpson: La película»
 * en el catálogo, y un `ilike` exacto no casa por el acento.
 *
 * La pregunta correcta es si SU PÁGINA figura como fuente de alguna ficha.
 */
import 'dotenv/config';
import { RealScraperService } from '../../src/services/realScraperService';
import { supabase } from '../../src/services/supabaseService';

const MUESTRA = Number((process.argv.find(a => a.startsWith('--n=')) || '').split('=')[1] || 300);

/** La url de la página a partir del id que fabrica el scraper: `2026-08-toy-story-5-2026-html`. */
function paginaDe(item: any): string {
  if (item.source_url) return item.source_url;
  const m = String(item.id || '').match(/^(\d{4})-(\d{2})-(.+)-html$/);
  return m ? `https://www.fuegocine.com/${m[1]}/${m[2]}/${m[3]}.html` : '';
}

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

  let propios = 0, fusionados = 0, faltan = 0, sinPagina = 0;
  const ejemplos: string[] = [];
  const muestra = items.slice(0, MUESTRA);

  for (const it of muestra) {
    const { data: porId } = await supabase.from('media_items').select('id').eq('id', it.id).maybeSingle();
    if (porId) { propios++; continue; }

    const pagina = paginaDe(it);
    if (!pagina) { sinPagina++; continue; }

    const { data: porFuente } = await supabase.from('media_items')
      .select('id,title').contains('source_urls', [pagina]).limit(1);
    if (porFuente?.length) { fusionados++; continue; }

    faltan++;
    if (ejemplos.length < 12) ejemplos.push(`${it.id}  «${it.title}»`);
  }

  const p = (a: number) => `${((a / muestra.length) * 100).toFixed(1)}%`;
  console.log(`\n  de ${muestra.length} muestreados:`);
  console.log(`     con ficha propia de FuegoCine   ${propios}  (${p(propios)})`);
  console.log(`     fusionados en la ficha de otro  ${fusionados}  (${p(fusionados)})`);
  console.log(`     NO están de ninguna forma       ${faltan}  (${p(faltan)})`);
  if (sinPagina) console.log(`     (sin poder deducir su página: ${sinPagina})`);
  if (ejemplos.length) console.log(`\n     ${ejemplos.join('\n     ')}`);
})();
