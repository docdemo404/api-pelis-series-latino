/**
 * EL TECHO: si la extracción terminase su atraso HOY, ¿cuánto catálogo se vería?
 *
 * No basta con «tiene un host con extractor»: la familia upns tiene extractor escrito y está
 * apagada por política, y vudeo/ahvsh salieron MUERTOS al sondearlos. Cuenta solo los hosts que
 * hoy demuestran entregar vídeo.
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';

// Medido con scripts/dev/probe_extraccion.ts el 2026-08-19 (12 muestras por host).
// vidhideplus entra aquí desde que se levantó su veto el 2026-08-19: entrega 8/8 desde Vercel a
// 233 KB/s (probe_vidhide_vercel.ts) y su packer trae el m3u8 a la vista.
const EXTRAEN_HOY = ['vidhideplus', 'vidhide', 'emturbovid', 'turbovidhls', 'blogspot', 'blogfc', 'gscdn', 'goodstream', 'drive.google', 'voe.sx', 'unlimplay', 'vimeos'];
const APAGADOS_POR_POLITICA = ['upns.', 'strp2p', '4meplayer', 'rpmstream'];
const MUERTOS = ['vudeo.co', 'ahvsh.com'];

(async () => {
  let ultimoId = '';
  let filas = 0;
  let yaVisible = 0, recuperable = 0, soloApagados = 0, soloMuertos = 0, sinNada = 0, sinServidores = 0;

  for (;;) {
    const { data, error } = await supabase.from('media_items')
      .select('id,type,servers,seasons').gt('id', ultimoId).order('id').limit(500);
    if (error) { console.error(error.message); break; }
    if (!data?.length) break;
    ultimoId = (data[data.length - 1] as any).id;

    for (const r of data as any[]) {
      filas++;
      const todos = [
        ...(Array.isArray(r.servers) ? r.servers : []),
        ...(Array.isArray(r.seasons) ? r.seasons : [])
          .flatMap((s: any) => Array.isArray(s?.episodes) ? s.episodes : [])
          .flatMap((e: any) => Array.isArray(e?.servers) ? e.servers : []),
      ];
      if (!todos.length) { sinServidores++; continue; }
      if (todos.some(s => s?.direct_stream && s.status !== 'offline')) { yaVisible++; continue; }

      const urls = todos.map(s => s?.embed_url || s?.url || '').filter(Boolean);
      const tiene = (lista: string[]) => urls.some(u => lista.some(h => u.includes(h)));
      if (tiene(EXTRAEN_HOY)) recuperable++;
      else if (tiene(APAGADOS_POR_POLITICA)) soloApagados++;
      else if (tiene(MUERTOS)) soloMuertos++;
      else sinNada++;
    }
    process.stderr.write(`  …${filas}\r`);
  }

  const p = (a: number) => `${((a / filas) * 100).toFixed(1)}%`;
  console.log(`\nSobre ${filas} fichas del catálogo:`);
  console.log(`  ya tienen vídeo directo                       ${String(yaVisible).padStart(6)}  (${p(yaVisible)})`);
  console.log(`  RECUPERABLES con los extractores de hoy       ${String(recuperable).padStart(6)}  (${p(recuperable)})   <- solo falta pasar por ellas`);
  console.log(`  solo hosts apagados por política              ${String(soloApagados).padStart(6)}  (${p(soloApagados)})   <- vidhideplus / familia upns`);
  console.log(`  solo hosts MUERTOS                            ${String(soloMuertos).padStart(6)}  (${p(soloMuertos)})   <- vudeo / ahvsh`);
  console.log(`  hosts sin extractor (waaw, listeamed, …)      ${String(sinNada).padStart(6)}  (${p(sinNada)})   <- hay que escribir código`);
  console.log(`  sin NINGÚN servidor guardado                  ${String(sinServidores).padStart(6)}  (${p(sinServidores)})   <- el scraper no sacó enlaces`);
  console.log(`\n  TECHO alcanzable sin escribir un extractor nuevo: ${yaVisible + recuperable} fichas (${p(yaVisible + recuperable)})`);
})();
