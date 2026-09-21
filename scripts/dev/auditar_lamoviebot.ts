/**
 * ¿SIGUE SIENDO CORRECTA LA IDENTIDAD DE LO QUE ESCRIBIÓ LAMOVIEBOT?
 *
 * Re-juzga las filas YA GUARDADAS con la guarda actual (`juzgarIdentidad`), no con la que estaba
 * puesta el día que se escribieron. Existe porque ese día la guarda era CIRCULAR —comparaba el
 * `original_title` de la fuente, que ella rellena desde TMDB, contra el de TMDB— y hubo que
 * rehacerla; sin esto, lo escrito bajo la guarda mala se queda sin revisar para siempre.
 *
 * Mira además la señal que habría cazado el señuelo de `voe.sx` desde el primer minuto y que
 * nadie miraba: un mismo `direct_stream` repetido en fichas DISTINTAS.
 *
 *   npx ts-node --transpile-only scripts/dev/auditar_lamoviebot.ts
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { juzgarIdentidad, VeredictoIdentidad } from '../../src/scrapers/lamoviebot';
import { datosDeLaUrl } from '../../src/scrapers/videoapi';
import { httpClient } from '../../src/utils/httpClient';
import { TMDB_API_KEY } from '../../src/services/tmdbService';

async function main() {
  const { data, error } = await supabase.from('media_items')
    .select('id,tmdb_id,type,title,servers,has_streams').like('id', 'lmb-%').order('id').range(0, 1999);
  if (error) throw new Error(error.message);
  const filas = (data || []) as any[];

  const cuenta: Record<string, number> = {};
  const dudosas: string[] = [];
  const porFichaUrl = new Map<string, Set<string>>();
  let conVideo = 0;

  for (const f of filas) {
    const srv = Array.isArray(f.servers) ? f.servers : [];
    if (srv.length) conVideo++;
    for (const s of srv) {
      const d = String(s.direct_stream || '');
      if (!d) continue;
      porFichaUrl.set(d, (porFichaUrl.get(d) || new Set()).add(f.id));
    }
    const slug = String(f.id).replace(/^lmb-(tv-)?/, '');
    const ids = srv.map((s: any) => datosDeLaUrl(String(s.embed_url || ''))).filter(Boolean).map((x: any) => x.tmdbId);
    const r = await httpClient.get(`https://api.themoviedb.org/3/${f.type === 'movie' ? 'movie' : 'tv'}/${f.tmdb_id}`, {
      params: { api_key: TMDB_API_KEY, language: 'es-ES' }, validateStatus: () => true, timeout: 15000 });
    if (r.status !== 200) { cuenta['tmdb-no-responde'] = (cuenta['tmdb-no-responde'] || 0) + 1; continue; }
    const v: VeredictoIdentidad = juzgarIdentidad(
      { slug, idsDeEmbeds: ids },
      { id: Number(f.tmdb_id), original_title: r.data.original_title || r.data.original_name,
        title: r.data.title || r.data.name, fecha: r.data.release_date || r.data.first_air_date });
    cuenta[v] = (cuenta[v] || 0) + 1;
    if (v === 'CONTRADICE' || v === 'sin-datos') {
      dudosas.push(`     · ${f.id}  tmdb ${f.tmdb_id} = "${r.data.title || r.data.name}" (${String(r.data.release_date || r.data.first_air_date).slice(0,4)})  [${v}]`);
    }
  }

  console.log(`\nAUDITORÍA DE LAMOVIEBOT · ${filas.length} filas\n`);
  console.log(`  con servidores: ${conVideo} · sin: ${filas.length - conVideo}`);
  console.log(`\n  veredicto de identidad con la guarda ACTUAL:`);
  for (const [k, n] of Object.entries(cuenta).sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(4)}  ${k}`);
  if (dudosas.length) console.log(`\n  sin respaldo (revisar):\n${dudosas.join('\n')}`);

  const cruzados = [...porFichaUrl.entries()].filter(([, ids]) => ids.size > 1);
  console.log(`\n  MISMO FICHERO EN FICHAS DISTINTAS (la señal del señuelo): ${cruzados.length}`);
  for (const [u, ids] of cruzados.slice(0, 5)) console.log(`     ${ids.size}× ${u.slice(0, 80)}\n        ${[...ids].join(', ')}`);
  if (!cruzados.length) console.log(`     ninguno — limpio`);
}
main().catch(e => { console.error(e.message); process.exit(1); });
