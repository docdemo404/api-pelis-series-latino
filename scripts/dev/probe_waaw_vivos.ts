/**
 * ¿Cuántos de los 23.381 servidores de waaw.to siguen teniendo fichero?
 *
 * Antes de escribir un extractor hay que saber si hay algo que extraer. Su reproductor dice en
 * texto plano cuándo el fichero ya no está ("We can't find the file you are looking for"), así que
 * se puede contar sin bajar un solo byte de vídeo.
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';

const db = getSupabaseAdmin();
const MUESTRAS = Number((process.argv.find(a => a.startsWith('--n=')) || '').split('=')[1] || 40);

const get = (u: string, ref: string) =>
  httpClient.get(u, {
    headers: { 'User-Agent': USER_AGENT, Referer: ref },
    timeout: 20000,
    responseType: 'text',
    transformResponse: [(d: unknown) => d],
    validateStatus: () => true,
    maxRedirects: 5,
  });

type Estado = 'BORRADO' | 'VIVO' | 'CAPTCHA' | 'ERROR';

async function estadoDe(embed: string): Promise<{ estado: Estado; nota: string }> {
  try {
    const r1 = await get(embed, 'https://tioplus.app/');
    const h1 = String(r1.data || '');
    if (r1.status >= 400) return { estado: 'ERROR', nota: `embed ${r1.status}` };
    const s1 = h1.match(/self\.location\.replace\('([^']+)'/);
    if (!s1) return { estado: 'ERROR', nota: 'sin salto' };

    const url2 = new URL(s1[1], embed).toString();
    const r2 = await get(url2, embed);
    const h2 = String(r2.data || '');
    const ifr = h2.match(/<iframe[^>]+src="([^"]+)"/);
    if (!ifr) return { estado: 'ERROR', nota: 'sin iframe' };

    const url3 = new URL(ifr[1].replace(/&amp;/g, '&'), embed).toString();
    const r3 = await get(url3, url2);
    const h3 = String(r3.data || '');
    if (/We can't find the file|got deleted by the owner|copyright violation/i.test(h3)) {
      return { estado: 'BORRADO', nota: '' };
    }
    if (/hcaptcha|recaptcha/i.test(h3) && /need_captcha=1/.test(h3)) return { estado: 'CAPTCHA', nota: '' };
    const ws = h3.match(/var\s+ws\s*=\s*'([^']+)'/)?.[1] || '';
    return { estado: 'VIVO', nota: ws ? `ws presente` : 'sin ws' };
  } catch (e: any) {
    return { estado: 'ERROR', nota: e.message?.slice(0, 40) || 'red' };
  }
}

(async () => {
  const urls: string[] = [];
  for (let from = 0; from < 14000 && urls.length < MUESTRAS; from += 500) {
    const { data } = await db.from('media_items').select('servers,seasons')
      .not('servers', 'eq', '[]').range(from, from + 499);
    for (const r of (data ?? []) as any[]) {
      const todos = [
        ...(r.servers ?? []),
        ...((r.seasons ?? []).flatMap((s: any) => s?.episodes ?? []).flatMap((e: any) => e?.servers ?? [])),
      ];
      for (const s of todos) {
        const u = s?.embed_url || '';
        if (u.includes('waaw.to') && !urls.includes(u)) urls.push(u);
        if (urls.length >= MUESTRAS) break;
      }
      if (urls.length >= MUESTRAS) break;
    }
  }

  console.log(`sondeando ${urls.length} embeds de waaw.to\n`);
  const cuenta: Record<Estado, number> = { BORRADO: 0, VIVO: 0, CAPTCHA: 0, ERROR: 0 };
  const CONC = 5;
  for (let i = 0; i < urls.length; i += CONC) {
    const lote = await Promise.all(urls.slice(i, i + CONC).map(async u => ({ u, ...(await estadoDe(u)) })));
    for (const r of lote) {
      cuenta[r.estado]++;
      console.log(`  ${r.estado.padEnd(8)} ${r.u.slice(0, 46).padEnd(46)} ${r.nota}`);
    }
  }
  console.log(`\nRESUMEN de ${urls.length}:`);
  for (const [k, v] of Object.entries(cuenta)) {
    console.log(`  ${k.padEnd(8)} ${String(v).padStart(3)}  (${((v / urls.length) * 100).toFixed(0)}%)`);
  }
})();
