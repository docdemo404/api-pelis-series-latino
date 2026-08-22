import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import * as fs from 'fs';

/**
 * DEVUELVE A SU CAPÍTULO LAS URLS QUE UNA PASADA SE LLEVÓ POR DELANTE.
 *
 * Se alimenta de una foto tomada con `snapshot_servers.ts` ANTES de la pasada: para cada capítulo
 * compara lo que había con lo que hay y repone lo que falta.
 *
 * Vuelven SIN `verified_at`, y eso es a propósito: la foto solo guardó la url y su fuente, así que
 * poner un sello sería afirmar algo que no consta. Sin sello no se anuncian —`paraElCliente` los
 * deja fuera— y es el verificador quien decide si vuelven al catálogo, que es de quien tiene que
 * salir esa decisión.
 */
(async () => {
  const foto = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as
    Record<string, { ficha: string[]; caps: Record<string, string[]> }>;
  const aplicar = process.argv.includes('--aplicar');

  const db = getSupabaseAdmin();
  let repuestos = 0, filas = 0;

  for (const [id, previo] of Object.entries(foto)) {
    if (!Object.keys(previo.caps).length) continue;

    const { data } = await db.from('media_items').select('id,seasons').eq('id', id).maybeSingle();
    if (!data) continue;
    const seasons = ((data as any).seasons as any[]) || [];
    if (!seasons.length) continue;

    let tocada = 0;
    for (const t of seasons) {
      for (const e of (t?.episodes || [])) {
        const clave = `${t?.season_number}x${e?.episode_number}`;
        const antes = previo.caps[clave];
        if (!antes?.length) continue;

        const ahora: any[] = Array.isArray(e.servers) ? e.servers : [];
        const urlsAhora = new Set(ahora.map((sv: any) => String(sv?.direct_stream || sv?.embed_url || '')));

        for (const marca of antes) {
          const corte = marca.indexOf('|');
          const fuente = marca.slice(0, corte);
          const url = marca.slice(corte + 1);
          if (!url || fuente === 'manual' || urlsAhora.has(url)) continue;
          // Detrás va, no delante: lo que la pasada acaba de comprobar tiene preferencia.
          ahora.push({
            id: `${id}_s${t.season_number}e${e.episode_number}_repuesto_${ahora.length}`,
            name: 'Repuesto',
            embed_url: url,
            direct_stream: url,
            direct_mode: 'public',
            direct_kind: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'mp4',
            status: 'online',
            source_id: fuente,
          });
          urlsAhora.add(url);
          tocada++;
        }
        e.servers = ahora;
      }
    }

    if (!tocada) continue;
    filas++;
    repuestos += tocada;
    console.log(`  ${id}: ${tocada} url(s) devueltas a sus capítulos`);
    if (aplicar) {
      const { error } = await db.from('media_items').update({ seasons }).eq('id', id);
      if (error) console.log(`     ✗ ${error.message}`);
    }
  }

  console.log(`\n${repuestos} urls en ${filas} filas${aplicar ? ' — ESCRITAS' : ' (ensayo: nada escrito, pasa --aplicar)'}`);
  process.exit(0);
})();
