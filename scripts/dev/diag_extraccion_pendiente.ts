/**
 * ¿Por qué el 82 % del catálogo no tiene vídeo directo?
 *
 * Distingue las dos causas, que piden arreglos opuestos:
 *   · PENDIENTE  — su host tiene extractor escrito y nadie ha pasado todavía  → es caudal
 *   · SIN EXTRACTOR — no sabemos sacar el vídeo de ese host                    → es código
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { mereceRepasoDeExtraccion } from '../../src/scrapers/directStream';

(async () => {
  const pageSize = 500;
  let ultimoId = '';
  let filas = 0, sinDirecto = 0, pendientes = 0, sinExtractor = 0, sinServidores = 0;
  const hostsPend: Record<string, number> = {};
  const hostsSin: Record<string, number> = {};

  for (;;) {
    const { data, error } = await supabase
      .from('media_items')
      .select('id,type,servers,seasons')
      .gt('id', ultimoId).order('id').limit(pageSize);
    if (error) { console.error(error.message); break; }
    if (!data?.length) break;
    ultimoId = (data[data.length - 1] as any).id;

    for (const r of data as any[]) {
      filas++;
      const srv: any[] = Array.isArray(r.servers) ? r.servers : [];
      const eps: any[] = (Array.isArray(r.seasons) ? r.seasons : [])
        .flatMap((s: any) => Array.isArray(s?.episodes) ? s.episodes : [])
        .flatMap((e: any) => Array.isArray(e?.servers) ? e.servers : []);
      const todos = [...srv, ...eps];
      if (!todos.length) { sinServidores++; continue; }
      if (todos.some(s => s?.direct_stream && s.status !== 'offline')) continue;
      sinDirecto++;

      const embeds = todos.map(s => s?.embed_url || s?.url || '').filter(Boolean);
      const recuperables = embeds.filter(u => mereceRepasoDeExtraccion(u));
      const dest = recuperables.length ? hostsPend : hostsSin;
      if (recuperables.length) pendientes++; else sinExtractor++;
      for (const u of embeds) {
        try { dest[new URL(u).hostname.replace(/^www\./, '')] = (dest[new URL(u).hostname.replace(/^www\./, '')] || 0) + 1; } catch {}
      }
    }
    process.stderr.write(`  …${filas}\r`);
    if (filas >= 15000) break;
  }

  console.log(`\nFichas recorridas            ${filas}`);
  console.log(`  sin NINGÚN servidor        ${sinServidores}   <- el scraper no sacó enlaces`);
  console.log(`  con servidores, sin directo ${sinDirecto}`);
  console.log(`    · con extractor escrito (PENDIENTE de pasada)  ${pendientes}`);
  console.log(`    · sin extractor para su host                    ${sinExtractor}`);

  const top = (h: Record<string, number>, n = 15) =>
    Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([k, v]) => `      ${String(v).padStart(6)}  ${k}`).join('\n');
  console.log(`\n  Hosts en fichas PENDIENTES:\n${top(hostsPend)}`);
  console.log(`\n  Hosts en fichas SIN EXTRACTOR:\n${top(hostsSin)}`);
})();
