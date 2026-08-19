import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';

const db = getSupabaseAdmin();
(async () => {
  const urls: string[] = [];
  for (let from = 0; from < 4000 && urls.length < 6; from += 500) {
    const { data } = await db.from('media_items').select('servers').not('servers', 'eq', '[]').range(from, from + 499);
    for (const r of (data ?? []) as any[]) {
      for (const s of (r.servers ?? [])) {
        const u = s?.embed_url || '';
        if (u.includes('waaw.to') && !urls.includes(u)) urls.push(u);
        if (urls.length >= 6) break;
      }
      if (urls.length >= 6) break;
    }
  }
  console.log(`muestras: ${urls.length}`);
  for (const u of urls.slice(0, 3)) {
    console.log(`\n===== ${u}`);
    try {
      const r = await httpClient.get(u, {
        headers: { 'User-Agent': USER_AGENT, Referer: 'https://tioplus.app/' },
        timeout: 20000, responseType: 'text', transformResponse: [(d: unknown) => d], validateStatus: () => true,
      });
      const html = String(r.data || '');
      console.log(`  http=${r.status} bytes=${html.length} ctype=${r.headers['content-type']}`);
      console.log(`  ¿m3u8?  ${(html.match(/[^"'\s]+\.m3u8[^"'\s]*/g) || []).slice(0, 3).join(' | ') || 'no'}`);
      console.log(`  ¿mp4?   ${(html.match(/[^"'\s]+\.mp4[^"'\s]*/g) || []).slice(0, 3).join(' | ') || 'no'}`);
      console.log(`  ¿secip? ${/secip/i.test(html)}`);
      console.log(`  ajax.php: ${(html.match(/ajax\.php[^"'\s]*/g) || []).slice(0, 3).join(' | ') || 'no'}`);
      console.log(`  señales anti-adblock: adbact=${/adbact/i.test(html)} adscore=${/adscore/i.test(html)} popcount=${/popcount/i.test(html)} isTrusted=${/isTrusted/i.test(html)}`);
      console.log(`  primeras líneas:\n${html.slice(0, 400).replace(/\n+/g, ' ').slice(0, 400)}`);
    } catch (e: any) { console.log(`  ERROR ${e.message}`); }
  }
})();
