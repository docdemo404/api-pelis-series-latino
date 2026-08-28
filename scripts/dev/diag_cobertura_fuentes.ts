/**
 * ¿ESTÁ EL 100 % DE LAS TRES FUENTES EN EL CATÁLOGO?
 *
 * Una ficha puede estar de dos formas y hay que contar las dos, o el resultado miente:
 *   · con SU id            — la fuente fue la primera en traer ese título;
 *   · fusionada en otra    — otra web ya lo tenía, y su página quedó en `source_urls`.
 *
 * Preguntar solo por el id da «falta el 26 %» en FuegoCine cuando en realidad falta el 1,7 %.
 * Por título tampoco vale: los acentos y el nombre regional de TMDB no casan.
 *
 *   npx ts-node -T scripts/dev/diag_cobertura_fuentes.ts [--n=250]
 */
import 'dotenv/config';
import { RealScraperService } from '../../src/services/realScraperService';
import { supabase } from '../../src/services/supabaseService';

const N = Number((process.argv.find(a => a.startsWith('--n=')) || '').split('=')[1] || 250);

/** La página de origen de un item recolectado, que es la clave con la que se comprueba. */
function paginaDe(it: any): string {
  if (it.source_url) return it.source_url;
  const id = String(it.id || '');
  // FuegoCine: `2026-08-toy-story-5-2026-html` → /2026/08/toy-story-5-2026.html
  const fc = id.match(/^(\d{4})-(\d{2})-(.+)-html$/);
  if (fc) return `https://www.fuegocine.com/${fc[1]}/${fc[2]}/${fc[3]}.html`;
  return '';
}

async function medir(nombre: string, items: any[]) {
  const muestra = items.slice(0, N);
  let propios = 0, fusionados = 0, faltan = 0, sinPagina = 0;
  const ejemplos: string[] = [];

  for (const it of muestra) {
    const { data: porId } = await supabase.from('media_items').select('id').eq('id', it.id).maybeSingle();
    if (porId) { propios++; continue; }
    const pagina = paginaDe(it);
    if (!pagina) { sinPagina++; if (ejemplos.length < 8) ejemplos.push(`${it.id}  «${it.title}»  (sin página deducible)`); continue; }
    const { data: porFuente } = await supabase.from('media_items')
      .select('id').contains('source_urls', [pagina]).limit(1);
    if (porFuente?.length) { fusionados++; continue; }
    faltan++;
    if (ejemplos.length < 8) ejemplos.push(`${it.id}  «${it.title}»`);
  }

  const p = (a: number) => `${((a / muestra.length) * 100).toFixed(1)}%`;
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`${nombre}: entrega ${items.length} títulos · muestreados ${muestra.length}`);
  console.log(`   con ficha propia    ${String(propios).padStart(4)}  (${p(propios)})`);
  console.log(`   fusionados en otra  ${String(fusionados).padStart(4)}  (${p(fusionados)})`);
  console.log(`   EN EL CATÁLOGO      ${String(propios + fusionados).padStart(4)}  (${p(propios + fusionados)})`);
  console.log(`   NO están            ${String(faltan + sinPagina).padStart(4)}  (${p(faltan + sinPagina)})`);
  if (ejemplos.length) console.log(`      ${ejemplos.join('\n      ')}`);
}

(async () => {
  // TioPlus: sus tres categorías, paginadas de verdad.
  for (const tipo of ['peliculas', 'series', 'animes'] as const) {
    const items = await RealScraperService.scrapeLatest(tipo, N).catch(() => []);
    await medir(`TIOPLUS /${tipo}`, items);
  }

  // FuegoCine, entero.
  const fuego = await (RealScraperService as any).scrapeAllFuegocine().catch(() => []);
  await medir('FUEGOCINE (todo)', fuego);
})();
