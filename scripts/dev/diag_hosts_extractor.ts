/** Por HOST: cuántos servidores sin vídeo directo, y si sabemos extraerlo de ese host. */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { mereceRepasoDeExtraccion } from '../../src/scrapers/directStream';

(async () => {
  let ultimoId = '';
  let filas = 0;
  const stat: Record<string, { sinDirecto: number; conDirecto: number; extractor: boolean }> = {};

  for (;;) {
    const { data, error } = await supabase.from('media_items')
      .select('id,servers,seasons').gt('id', ultimoId).order('id').limit(500);
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
      for (const s of todos) {
        const u = s?.embed_url || s?.url || '';
        if (!u) continue;
        let host = '';
        try { host = new URL(u).hostname.replace(/^www\./, ''); } catch { continue; }
        stat[host] ??= { sinDirecto: 0, conDirecto: 0, extractor: mereceRepasoDeExtraccion(u) };
        if (s?.direct_stream && s.status !== 'offline') stat[host].conDirecto++;
        else stat[host].sinDirecto++;
      }
    }
    process.stderr.write(`  …${filas}\r`);
  }

  const filas2 = Object.entries(stat).sort((a, b) => b[1].sinDirecto - a[1].sinDirecto).slice(0, 25);
  console.log(`\n${'HOST'.padEnd(30)} ${'sin directo'.padStart(11)} ${'con directo'.padStart(11)} ${'% éxito'.padStart(8)}  extractor`);
  for (const [h, v] of filas2) {
    const tot = v.sinDirecto + v.conDirecto;
    console.log(`${h.padEnd(30)} ${String(v.sinDirecto).padStart(11)} ${String(v.conDirecto).padStart(11)} ${((v.conDirecto / tot) * 100).toFixed(1).padStart(7)}%  ${v.extractor ? 'sí' : 'NO'}`);
  }
})();
