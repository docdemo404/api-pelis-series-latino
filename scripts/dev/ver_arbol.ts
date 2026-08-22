import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { paraElCliente } from '../../src/services/streamSorter';

/** Qué capítulos tiene guardados una serie, cuáles reproducen y cuáles están sin mirar. */
(async () => {
  const id = process.argv[2] || 'md-1396';
  const { data } = await getSupabaseAdmin()
    .from('media_items')
    .select('id,title,type,total_seasons,total_episodes,seasons')
    .eq('id', id)
    .maybeSingle();
  if (!data) { console.log('no existe', id); process.exit(1); }

  const r = data as any;
  console.log(`${r.id} «${r.title}» ${r.type} · TMDB dice ${r.total_seasons} temporadas / ${r.total_episodes} capítulos`);

  let total = 0, conServidor = 0, anunciables = 0, sinMirar = 0;
  for (const t of (r.seasons || [])) {
    const eps = t?.episodes || [];
    const con = eps.filter((e: any) => (e.servers || []).length);
    const pub = eps.filter((e: any) => paraElCliente(e.servers).length);
    const nuevos = eps.filter((e: any) => !e.checked_at);
    total += eps.length; conServidor += con.length; anunciables += pub.length; sinMirar += nuevos.length;
    console.log(`  T${t.season_number}: ${eps.length} capítulos guardados · ${con.length} con servidor · ${pub.length} anunciables · ${nuevos.length} sin mirar`);
  }
  console.log(`\nTOTAL guardado: ${total} capítulos · ${conServidor} con servidor · ${anunciables} anunciables · ${sinMirar} sin mirar`);
  process.exit(0);
})();
