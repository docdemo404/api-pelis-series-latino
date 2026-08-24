/**
 * ¿Reconocería el crawl que estas series ya están en el catálogo, aunque no las identifique?
 *
 * Es la pregunta que responde la guarda de `refreshCatalog` (`duenosDeLasPaginas`): antes de
 * escribir una ficha SIN identidad en TMDB, mira si alguna de sus páginas ya figura como fuente
 * de una ficha. Si figura, es la misma obra y no se crea una segunda fila.
 *
 * Esto comprueba la condición de la que depende: que las páginas de FuegoCine de estas series
 * estén registradas en `source_urls` de la ficha buena. Sin eso la guarda no puede saltar.
 *
 *   npx tsx scripts/dev/diag_guarda_pagina_duena.ts
 *   npx tsx scripts/dev/diag_guarda_pagina_duena.ts --serie=merlina
 */
import 'dotenv/config';
import { RealScraperService } from '../../src/services/realScraperService';
import { supabase } from '../../src/services/supabaseService';

const SOLO = (process.argv.find(a => a.startsWith('--serie=')) || '').split('=')[1] || '';

/** La misma consulta que hace la guarda: ¿alguna de estas urls es fuente de alguna ficha? */
async function duenaDe(paginas: string[]): Promise<any | null> {
  const TANDA = 40;
  for (let i = 0; i < paginas.length; i += TANDA) {
    const lote = paginas.slice(i, i + TANDA);
    const { data, error } = await supabase.from('media_items')
      .select('id,tmdb_id,title,source_urls').overlaps('source_urls', lote);
    if (error) { console.log(`   ERROR: ${error.message}`); return null; }
    if (data?.length) return data[0];
  }
  return null;
}

(async () => {
  const items: any[] = await (RealScraperService as any).scrapeAllFuegocine().catch((e: any) => {
    console.log(`ERROR bajando FuegoCine: ${e.message}`);
    return [];
  });
  const series = items.filter(i => i.type === 'tvseries' && String(i.id).startsWith('fc-'));
  const objetivo = SOLO ? series.filter(s => String(s.id).includes(SOLO)) : series;
  console.log(`series de FuegoCine: ${series.length}${SOLO ? ` (mirando ${objetivo.length})` : ''}\n`);

  let reconocidas = 0, propias = 0, invisibles = 0;
  for (const s of objetivo) {
    const { data: propia } = await supabase.from('media_items').select('id,tmdb_id').eq('id', s.id).maybeSingle();
    if (propia) { propias++; continue; }

    const paginas = [
      String((s as any)._source_url || ''),
      ...RealScraperService.paginasDeCapitulos((s as any).seasons, null).slice(0, 40),
    ].filter(Boolean);

    const duena = await duenaDe(paginas);
    if (duena) {
      reconocidas++;
      console.log(`   ✔ «${s.title}» (${paginas.length} páginas) → ya es ${duena.id} tmdb=${duena.tmdb_id} "${duena.title}"`);
    } else {
      invisibles++;
      if (invisibles <= 10) console.log(`   · «${s.title}» (${paginas.length} páginas): ninguna ficha reclama sus páginas — entraría como nueva`);
    }
  }

  console.log(`\n   con ficha propia ya guardada:            ${propias}`);
  console.log(`   la guarda las devolvería a su ficha:     ${reconocidas}`);
  console.log(`   ninguna ficha reclama sus páginas:       ${invisibles}`);
})();
