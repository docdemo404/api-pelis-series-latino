/**
 * Qué contesta de verdad cada host. El inventario los daba por "opacos" con cuerpos de 1 KB, y un
 * cuerpo de 1 KB no es un reproductor: o es un aviso, o es una redirección, o falta una cabecera.
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';

const db = getSupabaseAdmin();
const HOSTS = (process.argv.find(a => a.startsWith('--hosts='))?.split('=')[1] || 'vudeo.co,filemoon.to,voe.sx,streamtape.com,listeamed.net,vidsonic.net,doodstream.com').split(',');

const get = (u: string, headers: Record<string, string>) =>
  httpClient.get(u, {
    headers, timeout: 20000, responseType: 'text',
    transformResponse: [(d: unknown) => d], validateStatus: () => true, maxRedirects: 5,
  });

(async () => {
  const muestras: Record<string, string> = {};
  for (let from = 0; from < 15000; from += 500) {
    const { data } = await db.from('media_items').select('servers,seasons')
      .not('servers', 'eq', '[]').range(from, from + 499);
    if (!data?.length) break;
    for (const r of data as any[]) {
      const todos = [
        ...(r.servers ?? []),
        ...((r.seasons ?? []).flatMap((s: any) => s?.episodes ?? []).flatMap((e: any) => e?.servers ?? [])),
      ];
      for (const s of todos) {
        const u: string = s?.embed_url || '';
        const h = HOSTS.find(x => u.includes(x));
        if (h && !muestras[h]) muestras[h] = u;
      }
    }
    if (HOSTS.every(h => muestras[h])) break;
  }

  for (const host of HOSTS) {
    const u = muestras[host];
    console.log(`\n${'='.repeat(70)}\n${host}  →  ${u || '(sin muestra)'}`);
    if (!u) continue;
    // Dos intentos: cabeceras mínimas y cabeceras de navegador completas.
    const intentos: Array<[string, Record<string, string>]> = [
      ['simple', { 'User-Agent': USER_AGENT, Referer: 'https://tioplus.app/' }],
      ['navegador', {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'cross-site',
        Referer: 'https://tioplus.app/',
      }],
    ];
    for (const [nombre, h] of intentos) {
      try {
        const r = await get(u, h);
        const body = String(r.data || '');
        console.log(`  [${nombre}] http=${r.status} bytes=${body.length} ctype=${r.headers['content-type']}`);
        console.log(`     ${body.replace(/\s+/g, ' ').slice(0, 420)}`);
      } catch (e: any) {
        console.log(`  [${nombre}] ERROR ${e.code || ''} ${e.message?.slice(0, 80)}`);
      }
    }
  }
})();
