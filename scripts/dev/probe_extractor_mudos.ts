/**
 * ¿Qué saca HOY el extractor real de los hosts que dejan fichas mudas?
 *
 * Llama a `extractDirect` —el mismo que usa el repaso— sobre varias muestras de cada host, para
 * distinguir "este host no se sabe extraer" de "ese fichero concreto estaba borrado".
 *
 *   npx ts-node --transpile-only scripts/dev/probe_extractor_mudos.ts [--n=6] [voe.sx streamtape]
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { extractDirect } from '../../src/scrapers/directStream';
import { streamClient } from '../../src/utils/httpClient';

const db = getSupabaseAdmin();
const N = Number((process.argv.find(a => a.startsWith('--n=')) || '').split('=')[1] || 6);
const OBJETIVOS = process.argv.slice(2).filter(a => !a.startsWith('--'));
const HOSTS = OBJETIVOS.length ? OBJETIVOS : ['voe.sx', 'streamtape', 'vudeo', 'listeamed', 'filemoon', 'waaw.to'];

(async () => {
  const filas: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await db.from('media_items').select('id,servers').not('servers', 'eq', '[]').range(f, f + 999);
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 1000) break;
  }
  const todos: string[] = filas.flatMap(r => (r.servers || [])).map((s: any) => s?.embed_url).filter(Boolean);

  for (const host of HOSTS) {
    const urls = Array.from(new Set(todos.filter(u => u.includes(host)))).slice(0, N);
    if (!urls.length) { console.log(`${host.padEnd(14)} sin ejemplos`); continue; }
    const res = await Promise.all(urls.map(async u => {
      try {
        // El extractor recibe el HTML ya bajado, igual que en el repaso real.
        const r = await streamClient.get(u, {
          headers: { Referer: u, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36' },
          timeout: 25000, validateStatus: () => true, maxRedirects: 5,
        });
        const d = await extractDirect(u, String(r.data || ''), { allowNetwork: true });
        return d?.url ? `✅ ${d.kind || '?'}` : `— (${r.status})`;
      } catch (e: any) {
        return `✗ ${(e.code || e.message || '').toString().slice(0, 18)}`;
      }
    }));
    const ok = res.filter(r => r.startsWith('✅')).length;
    console.log(`${host.padEnd(14)} ${ok}/${urls.length}   ${res.join('  ')}`);
  }
})();
