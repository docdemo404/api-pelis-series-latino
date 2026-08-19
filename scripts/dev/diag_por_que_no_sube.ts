/**
 * ¿POR QUÉ NO SUBE LO ANUNCIABLE?
 *
 * Un total que no se mueve puede ser dos cosas muy distintas, y hasta separarlas no se sabe dónde
 * mirar:
 *   · ESTANCADO — no entra nada nuevo (el motor está parado o no acierta)
 *   · EN VAIVÉN  — entra tanto como sale (el motor va, pero algo las tira por el otro lado)
 *
 * La cadena para que una ficha se anuncie tiene tres tramos, y cada uno la puede estar frenando:
 *   1. extraer      → gana `direct_stream`
 *   2. verificar    → ese servidor gana un `verified_at` vigente (dura 6 h)
 *   3. anunciar     → `has_streams = true`
 *
 * Si el tramo 2 no alcanza, el 1 trabaja para nada: la ficha tiene vídeo y nadie lo ha sellado.
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';

const H = 3600 * 1000;

async function n(aplicar: (q: any) => any): Promise<number> {
  const { count, error } = await aplicar(supabase.from('media_items').select('id', { count: 'exact', head: true }));
  if (error) { console.error('  !', error.message); return -1; }
  return count ?? 0;
}

const hace = (h: number) => new Date(Date.now() - h * H).toISOString();

(async () => {
  console.log('── ¿ENTRA ALGO? Fichas anunciables según cuándo se tocaron por última vez');
  for (const h of [1, 3, 6, 12, 24]) {
    const c = await n(q => q.eq('has_streams', true).gt('streams_updated_at', hace(h)));
    console.log(`   resueltas hace < ${String(h).padStart(2)} h y anunciables   ${String(c).padStart(6)}`);
  }

  console.log('\n── EL EMBUDO, tramo a tramo');
  const conDirecto = await n(q => q.neq('servers', '[]').not('streams_updated_at', 'is', null));
  const anunciables = await n(q => q.eq('has_streams', true));
  const selloVigente = await n(q => q.gt('streams_checked_at', hace(6)));
  const selloYVideo = await n(q => q.eq('has_streams', true).gt('streams_checked_at', hace(6)));
  console.log(`   resueltas alguna vez (con servidores)   ${conDirecto}`);
  console.log(`   con sello vigente (<6 h)                ${selloVigente}`);
  console.log(`   ANUNCIABLES (has_streams = true)        ${anunciables}`);
  console.log(`   …y además con sello vigente             ${selloYVideo}`);

  console.log('\n── ¿SE CAEN POR EL OTRO LADO? Condenadas recientemente');
  for (const h of [1, 3, 6, 12, 24]) {
    const c = await n(q => q.eq('has_streams', false).gt('streams_checked_at', hace(h)));
    console.log(`   condenadas y selladas hace < ${String(h).padStart(2)} h   ${String(c).padStart(6)}`);
  }

  console.log('\n── EL SELLO, que es el cuello de botella si no alcanza');
  const total = await n(q => q);
  for (const h of [2, 4, 6, 12, 24]) {
    const c = await n(q => q.gt('streams_checked_at', hace(h)));
    console.log(`   selladas hace < ${String(h).padStart(2)} h   ${String(c).padStart(6)}  (${((c / total) * 100).toFixed(1)}%)`);
  }

  console.log('\n── EXTRACCIÓN: fichas resueltas en las últimas horas, y cuántas salieron bien');
  for (const h of [1, 3, 6, 12]) {
    const tocadas = await n(q => q.gt('streams_updated_at', hace(h)));
    const buenas = await n(q => q.gt('streams_updated_at', hace(h)).eq('has_streams', true));
    const pct = tocadas > 0 ? ((buenas / tocadas) * 100).toFixed(1) : '—';
    console.log(`   últimas ${String(h).padStart(2)} h: ${String(tocadas).padStart(6)} tocadas · ${String(buenas).padStart(5)} anunciables (${pct}%)`);
  }
})();
