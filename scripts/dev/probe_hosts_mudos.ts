/**
 * Los hosts que dejan fichas mudas: ¿se les puede escribir un extractor?
 *
 * Baja el HTML real de un embed de cada uno y enseña por dónde va: si trae `sources:[{file}]`,
 * P.A.C.K.E.R., un blob base64, o una pared.
 *
 *   npx ts-node --transpile-only scripts/dev/probe_hosts_mudos.ts [voe streamtape ...]
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { streamClient } from '../../src/utils/httpClient';

const db = getSupabaseAdmin();
const OBJETIVOS = process.argv.slice(2).filter(a => !a.startsWith('--'));
const HOSTS = OBJETIVOS.length ? OBJETIVOS : ['voe.sx', 'streamtape', 'vudeo', 'listeamed', 'filemoon'];

(async () => {
  const filas: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await db.from('media_items').select('id,servers').not('servers', 'eq', '[]').range(f, f + 999);
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 1000) break;
  }

  for (const host of HOSTS) {
    const url = filas.flatMap(r => (r.servers || []))
      .map((s: any) => s?.embed_url).filter(Boolean)
      .find((u: string) => u.includes(host));
    if (!url) { console.log(`${host}: sin ejemplos en el catálogo\n`); continue; }

    console.log(`\n════ ${host}\n   ${url}`);
    try {
      const r = await streamClient.get(url, {
        headers: { Referer: url, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36' },
        timeout: 20000, validateStatus: () => true, maxRedirects: 5,
      });
      const html = String(r.data || '');
      console.log(`   HTTP ${r.status} · ${html.length} bytes · ${r.headers['content-type']}`);
      const pistas: string[] = [];
      if (/sources\s*:\s*\[/.test(html)) pistas.push('sources:[…]');
      if (/eval\(function\(p,a,c,k,e/.test(html)) pistas.push('P.A.C.K.E.R.');
      if (/\.m3u8/.test(html)) pistas.push('m3u8 a la vista');
      if (/\.mp4/.test(html)) pistas.push('mp4 a la vista');
      if (/robotlink|videolink/.test(html)) pistas.push('streamtape robotlink');
      if (/MKGMa=|wego\.here|localStorage\.setItem\('\w+'/.test(html)) pistas.push('blob ofuscado voe');
      if (/window\.location\s*=|location\.replace/.test(html)) pistas.push('redirección JS');
      if (/captcha|challenge|cf-browser/i.test(html)) pistas.push('⛔ captcha/challenge');
      if (/File Not Found|not found|deleted/i.test(html)) pistas.push('⛔ fichero borrado');
      console.log(`   pistas: ${pistas.join(' · ') || '(ninguna)'}`);
      const m3u8 = html.match(/https?:\\?\/\\?\/[^"'\s\\]+\.m3u8[^"'\s\\]*/);
      const mp4 = html.match(/https?:\\?\/\\?\/[^"'\s\\]+\.mp4[^"'\s\\]*/);
      if (m3u8) console.log(`   m3u8: ${m3u8[0].replace(/\\/g, '').slice(0, 130)}`);
      if (mp4) console.log(`   mp4 : ${mp4[0].replace(/\\/g, '').slice(0, 130)}`);
      if (!m3u8 && !mp4) console.log(`   cabecera: ${html.replace(/\s+/g, ' ').slice(0, 220)}`);
    } catch (e: any) {
      console.log(`   error: ${e.code || e.message}`);
    }
  }
})();
