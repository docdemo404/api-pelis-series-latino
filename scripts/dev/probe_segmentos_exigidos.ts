/**
 * ¿SIRVE DE ALGO EXIGIR TRES SEGMENTOS EN VEZ DE UNO?
 *
 * Compara el veredicto de `comprobarEmbed` con `segmentosExigidos: 1` y con `3` sobre LOS MISMOS
 * embeds. Si el cambio no encuentra nada que antes se colaba, no vale la pena pagarlo.
 *
 * Los dos pasan por el mismo sitio y en el mismo momento, así que la diferencia es la exigencia
 * y no la hora del día. Se limpia el veredicto cacheado entre una y otra: sin eso, la segunda
 * llamada contestaría lo que dijo la primera y saldría un empate falso.
 *
 *   npx ts-node -T scripts/dev/probe_segmentos_exigidos.ts [--host=vidhide] [--n=12]
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { comprobarEmbed } from '../../src/services/playbackHealth';
import { CacheStore } from '../../src/cache/store';

const db = getSupabaseAdmin();
const arg = (n: string, d = '') => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const HOST = arg('host', 'vidhide');
const N = Number(arg('n', '12'));

(async () => {
  const embeds: string[] = [];
  for (let from = 0; from < 15000 && embeds.length < N; from += 500) {
    const { data } = await db.from('media_items').select('servers')
      .not('servers', 'eq', '[]').range(from, from + 499);
    if (!data?.length) break;
    for (const r of data as any[]) {
      for (const s of (r.servers ?? [])) {
        const u = s?.embed_url || '';
        if (u.includes(HOST) && s?.direct_stream && !embeds.includes(u)) embeds.push(u);
        if (embeds.length >= N) break;
      }
      if (embeds.length >= N) break;
    }
  }

  console.log(`${embeds.length} embeds de "${HOST}" con vídeo directo publicado\n`);
  let soloCon3 = 0, iguales = 0, soloCon1 = 0;

  for (const embed of embeds) {
    // El veredicto se cachea por embed y por url acuñada: sin limpiarlo, la segunda medición
    // sería un eco de la primera.
    const limpiar = async () => {
      try { await CacheStore.del(`salud:${embed}`); } catch { /* da igual */ }
    };

    await limpiar();
    const uno = await comprobarEmbed(embed, { limite: Date.now() + 40000, segmentosExigidos: 1 });
    await limpiar();
    const tres = await comprobarEmbed(embed, { limite: Date.now() + 40000, segmentosExigidos: 3 });

    let nota = '';
    if (uno.veredicto === 'vivo' && tres.veredicto === 'muerto') { soloCon3++; nota = '← LO CAZA SOLO CON 3'; }
    else if (uno.veredicto === 'muerto' && tres.veredicto === 'vivo') { soloCon1++; nota = '← raro: aprueba con 3 y no con 1'; }
    else iguales++;

    console.log(`  ${embed.slice(-22).padEnd(24)} 1 seg: ${String(uno.veredicto).padEnd(11)} 3 seg: ${String(tres.veredicto).padEnd(11)} ${nota}`);
  }

  console.log(`\n  mismo veredicto        ${iguales}/${embeds.length}`);
  console.log(`  los caza SOLO con 3    ${soloCon3}/${embeds.length}   ← lo que se estaba colando`);
  if (soloCon1) console.log(`  ⚠ aprueban con 3 y no con 1: ${soloCon1} (mirar antes de dar por bueno el cambio)`);
})();
