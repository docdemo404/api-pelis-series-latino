import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import * as fs from 'fs';

/**
 * FOTO DE TODOS LOS SERVIDORES DEL CATÁLOGO, para poder decir después qué desapareció.
 *
 * «El crawl no borra nada» no se demuestra mirando la ficha que a uno le preocupa: se demuestra
 * comparando el antes y el después de TODAS. Se guarda la url de cada servidor —de la ficha y de
 * cada capítulo— con su fuente, que es lo único que hace falta para detectar una pérdida.
 */
(async () => {
  const salida = process.argv[2];
  if (!salida) { console.error('uso: snapshot_servers.ts <fichero.json>'); process.exit(1); }

  const db = getSupabaseAdmin();
  const foto: Record<string, { ficha: string[]; caps: Record<string, string[]> }> = {};
  let from = 0, total = 0;

  for (;;) {
    const { data, error } = await db
      .from('media_items')
      .select('id,servers,seasons')
      .order('id')
      .range(from, from + 199);
    if (error) { console.error('ERROR', error.message); process.exit(1); }
    if (!data?.length) break;
    total += data.length;

    for (const r of data as any[]) {
      const marca = (sv: any) =>
        `${String(sv?.source_id || '?')}|${String(sv?.direct_stream || sv?.embed_url || '')}`;
      const caps: Record<string, string[]> = {};
      for (const t of (r.seasons || [])) {
        for (const e of (t?.episodes || [])) {
          const lista = (e?.servers || []).map(marca);
          if (lista.length) caps[`${t?.season_number}x${e?.episode_number}`] = lista;
        }
      }
      foto[r.id] = { ficha: (r.servers || []).map(marca), caps };
    }
    if (data.length < 200) break;
    from += 200;
  }

  fs.writeFileSync(salida, JSON.stringify(foto, null, 0));
  const nFicha = Object.values(foto).reduce((a, x) => a + x.ficha.length, 0);
  const nCaps = Object.values(foto).reduce(
    (a, x) => a + Object.values(x.caps).reduce((b, y) => b + y.length, 0), 0);
  console.log(`foto de ${total} filas · ${nFicha} servidores de ficha · ${nCaps} de capítulos → ${salida}`);
  process.exit(0);
})();
