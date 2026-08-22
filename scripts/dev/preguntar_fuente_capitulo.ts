import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { pedirMoviedays, servidoresDeMoviedays, tituloDeMoviedays } from '../../src/scrapers/moviedays';

/**
 * ¿ES LA FUENTE O SOMOS NOSOTROS?
 *
 * Le pregunta a moviedays por un capítulo concreto y enseña, uno al lado del otro, lo que la fuente
 * contesta AHORA y lo que tenemos guardado. Si coinciden, nosotros colocamos lo que nos dieron y lo
 * que haya detrás del enlace es cosa suya. Si no coinciden, el fallo es nuestro.
 *
 *   preguntar_fuente_capitulo.ts <tmdbId> <temporada> <capitulo> [idFicha]
 */
(async () => {
  const tmdbId = Number(process.argv[2]) || 456;
  const season = Number(process.argv[3]) || 1;
  const episode = Number(process.argv[4]) || 1;
  const idFicha = process.argv[5] || `md-${tmdbId}`;

  console.log(`Preguntando a moviedays por tmdb ${tmdbId} · ${season}x${episode}\n`);
  const payload = await pedirMoviedays(tmdbId, 'tvseries', season, episode);
  if (!payload) {
    console.log('  la fuente no contesta nada para ese capítulo');
  } else {
    console.log(`  la fuente titula esto: «${tituloDeMoviedays(payload)}»`);
    const svs = await servidoresDeMoviedays(payload);
    for (const sv of svs) {
      console.log(`  la fuente da: ${String((sv as any).embed_url || (sv as any).direct_stream).slice(0, 110)}`);
    }
    if (!svs.length) console.log('  la fuente no da ningún servidor publicable');
  }

  const { data } = await getSupabaseAdmin()
    .from('media_items').select('id,title,seasons').eq('id', idFicha).maybeSingle();
  if (!data) { console.log(`\n  (no hay ficha ${idFicha} guardada)`); process.exit(0); }

  const r = data as any;
  const t = (r.seasons || []).find((x: any) => Number(x.season_number) === season);
  const e = (t?.episodes || []).find((x: any) => Number(x.episode_number) === episode);
  console.log(`\n  nosotros guardamos, en «${r.title}» ${season}x${episode} («${e?.name || '?'}»):`);
  for (const sv of (e?.servers || [])) {
    console.log(`  ${String(sv.embed_url || sv.direct_stream).slice(0, 110)}  [${sv.source_id}/${sv.status}${sv.verified_at ? '/sellado' : ''}]`);
  }
  if (!(e?.servers || []).length) console.log('  (ninguno)');
  process.exit(0);
})();
