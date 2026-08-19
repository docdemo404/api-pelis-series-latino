/**
 * ¿Cuánto del catálogo se puede ANUNCIAR ahora mismo, y qué escalón lo está tapando?
 *
 * Los listados exigen tres cosas a la vez (`CatalogService.soloPublicables`): has_streams,
 * póster y un sello de verificación vigente. Este script cuenta cuántas filas caen en cada
 * escalón por separado, que es lo único que distingue «no hay catálogo» de «el catálogo está
 * ahí pero sin sellar».
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';

const H = 3600 * 1000;

async function n(apply: (q: any) => any): Promise<number> {
  const { count, error } = await apply(supabase.from('media_items').select('id', { count: 'exact', head: true }));
  if (error) { console.error('  !', error.message); return -1; }
  return count ?? 0;
}

const pct = (a: number, b: number) => b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—';

(async () => {
  const total = await n(q => q);
  console.log(`TOTAL filas                 ${total}`);
  for (const t of ['movie', 'tvseries']) {
    console.log(`  ${t.padEnd(24)}  ${await n(q => q.eq('type', t))}`);
  }

  console.log('\n--- escalones de `soloPublicables`, por separado ---');
  const conPoster = await n(q => q.not('poster', 'is', null));
  const hsTrue = await n(q => q.eq('has_streams', true));
  const hsFalse = await n(q => q.eq('has_streams', false));
  const hsNull = await n(q => q.is('has_streams', null));
  console.log(`con póster                  ${conPoster}  (${pct(conPoster, total)})`);
  console.log(`has_streams = true          ${hsTrue}  (${pct(hsTrue, total)})`);
  console.log(`has_streams = false         ${hsFalse}  (${pct(hsFalse, total)})   <- condenadas`);
  console.log(`has_streams = NULL          ${hsNull}  (${pct(hsNull, total)})   <- nunca comprobadas`);

  console.log('\n--- frescura del sello (streams_checked_at) ---');
  for (const horas of [6, 12, 24, 72, 24 * 7]) {
    const c = await n(q => q.gt('streams_checked_at', new Date(Date.now() - horas * H).toISOString()));
    console.log(`  sellado < ${String(horas).padStart(4)} h        ${c}  (${pct(c, total)})`);
  }
  const sinSello = await n(q => q.is('streams_checked_at', null));
  console.log(`  sin sello nunca           ${sinSello}  (${pct(sinSello, total)})`);

  console.log('\n--- LO QUE VE LA APP (los tres a la vez, ventana 6 h) ---');
  const vis = (q: any) => q.eq('has_streams', true).not('poster', 'is', null)
    .gt('streams_checked_at', new Date(Date.now() - 6 * H).toISOString());
  const visibles = await n(vis);
  console.log(`ANUNCIABLES                 ${visibles}  (${pct(visibles, total)} del catálogo)`);
  console.log(`  películas                 ${await n(q => vis(q).eq('type', 'movie'))}`);
  console.log(`  series                    ${await n(q => vis(q).eq('type', 'tvseries'))}`);

  console.log('\n--- si se quitara SOLO la exigencia del sello vigente ---');
  const sinExigirSello = await n(q => q.eq('has_streams', true).not('poster', 'is', null));
  console.log(`  serían anunciables        ${sinExigirSello}  (${pct(sinExigirSello, total)})`);
})();
