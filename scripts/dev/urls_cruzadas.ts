import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';

/**
 * ¿HAY ALGUNA URL SIRVIENDO EN DOS FICHAS DISTINTAS?
 *
 * Es la pregunta que separa «la fuente nos dio el vídeo equivocado» de «nosotros lo colocamos
 * mal». Si el mismo fichero está anunciado en dos obras distintas, el fallo es nuestro; si cada
 * ficha tiene urls que no comparte con nadie, lo que haya detrás es cosa de la fuente.
 *
 * Dentro de la MISMA ficha, ficha y 1x01 comparten url a propósito (la serie se sondea por su
 * primer capítulo), así que eso no cuenta como cruce.
 */
(async () => {
  const db = getSupabaseAdmin();
  const filas: any[] = [];
  for (let desde = 0; ; desde += 200) {
    const { data, error } = await db
      .from('media_items').select('id,title,type,servers,seasons').order('id').range(desde, desde + 199);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 200) break;
  }

  const url = (sv: any) => String(sv?.direct_stream || sv?.embed_url || '');
  const donde = new Map<string, Set<string>>();
  const detalle = new Map<string, string[]>();

  for (const r of filas) {
    const apuntar = (u: string, sitio: string) => {
      if (!u) return;
      if (!donde.has(u)) { donde.set(u, new Set()); detalle.set(u, []); }
      donde.get(u)!.add(r.id);
      detalle.get(u)!.push(`${r.id} «${r.title}» ${sitio}`);
    };
    for (const sv of (r.servers || [])) apuntar(url(sv), 'FICHA');
    for (const t of (r.seasons || [])) {
      for (const e of (t?.episodes || [])) {
        for (const sv of (e?.servers || [])) apuntar(url(sv), `${t.season_number}x${e.episode_number}`);
      }
    }
  }

  const cruces = [...donde.entries()].filter(([, ids]) => ids.size > 1);
  console.log(`fichas: ${filas.length} · urls distintas: ${donde.size}`);
  console.log(`urls que aparecen en MÁS DE UNA ficha: ${cruces.length}`);
  for (const [u, ids] of cruces.slice(0, 20)) {
    console.log(`\n  ${u.slice(0, 100)}`);
    for (const d of detalle.get(u)!) console.log(`     ${d}`);
  }
  if (!cruces.length) console.log('\n✅ ninguna url se comparte entre fichas distintas');
  process.exit(0);
})();
