import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { paraElCliente } from '../../src/services/streamSorter';

/**
 * ¿Está la serie entera, y cada capítulo con SU vídeo?
 *
 * Lo segundo no es paranoia: la forma clásica de que una serie parezca completa sin estarlo es que
 * todos los capítulos apunten al mismo fichero — ya pasó en este proyecto, con un respaldo que
 * rellenaba los enlaces del capítulo con los de la serie.
 */
(async () => {
  const id = process.argv[2] || 'md-1396';
  const { data } = await getSupabaseAdmin()
    .from('media_items').select('id,title,total_episodes,seasons').eq('id', id).maybeSingle();
  if (!data) { console.log('no existe', id); process.exit(1); }

  const r = data as any;
  const url = (sv: any) => String(sv?.direct_stream || sv?.embed_url || '');
  const porUrl = new Map<string, string[]>();
  let total = 0, anunciables = 0;
  const faltan: string[] = [];

  for (const t of (r.seasons || [])) {
    for (const e of (t?.episodes || [])) {
      total++;
      const clave = `${t.season_number}x${e.episode_number}`;
      const pub = paraElCliente(e?.servers);
      if (!pub.length) { faltan.push(clave); continue; }
      anunciables++;
      for (const sv of pub) {
        const u = url(sv);
        if (!porUrl.has(u)) porUrl.set(u, []);
        porUrl.get(u)!.push(clave);
      }
    }
  }

  const repetidas = [...porUrl.entries()].filter(([, caps]) => caps.length > 1);

  console.log(`«${r.title}» (${r.id}) — TMDB dice ${r.total_episodes} capítulos`);
  console.log(`  guardados: ${total} · anunciables: ${anunciables}${faltan.length ? ' · faltan: ' + faltan.join(', ') : ''}`);
  console.log(`  urls distintas: ${porUrl.size}`);
  if (repetidas.length) {
    console.log(`  ❌ ${repetidas.length} url(s) compartidas por varios capítulos:`);
    repetidas.slice(0, 10).forEach(([u, caps]) => console.log(`     ${caps.join(', ')} -> ${u.slice(0, 90)}`));
  } else {
    console.log('  ✅ cada capítulo con url propia, ninguna repetida');
  }
  console.log(anunciables === total && !faltan.length && !repetidas.length
    ? '\n✅ SERIE COMPLETA Y SIN REPETIDOS'
    : '\n⚠ revisar lo de arriba');
  process.exit(0);
})();
