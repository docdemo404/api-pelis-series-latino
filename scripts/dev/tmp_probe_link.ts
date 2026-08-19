/**
 * TEMPORAL. Sondea qué entrega de verdad cada `link=` publicado como vídeo directo.
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { streamClient } from '../../src/utils/httpClient';

const db = getSupabaseAdmin();
const MUESTRAS = Number((process.argv.find(a => a.startsWith('--muestras=')) || '').split('=')[1] || 6);

function paramUrl(embed: string): string | null {
  try {
    const p = new URL(embed).searchParams;
    for (const k of ['link', 'url', 'file', 'source', 'src']) {
      const v = p.get(k);
      if (v && /^(https?:)?\/\//i.test(v)) return v.startsWith('//') ? 'https:' + v : v;
    }
  } catch {}
  return null;
}

async function queEs(url: string): Promise<string> {
  try {
    const r = await streamClient.get(url, {
      headers: { Range: 'bytes=0-2047' },
      responseType: 'arraybuffer',
      timeout: 25000,
      validateStatus: () => true,
      maxRedirects: 3,
    });
    if (r.status >= 400) return `HTTP ${r.status}`;
    const b = Buffer.from(r.data as any);
    const ct = String(r.headers['content-type'] || '');
    const cab = b.subarray(0, 400).toString('latin1');
    if (/^\s*#EXTM3U/.test(cab)) return `HLS (${ct})`;
    if (/^\s*<(!doctype|html)/i.test(cab)) return `❌ HTML (${ct})`;
    if (b[0] === 0x47) return `MPEG-TS (${ct})`;
    if (b.subarray(4, 8).toString('latin1') === 'ftyp') return `MP4 (${ct})`;
    if (b.subarray(0, 4).toString('latin1') === '\x1aE\xdf\xa3') return `❌ MATROSKA/MKV (${ct})`;
    if (b.subarray(1, 4).toString('latin1') === 'PNG') return `❌ PNG (${ct})`;
    return `❓ ${b.subarray(0, 8).toString('hex')} (${ct})`;
  } catch (e: any) {
    return `error ${e.code || e.message}`.slice(0, 50);
  }
}

(async () => {
  const filas: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await db.from('media_items').select('id,title,servers').not('servers', 'eq', '[]').range(f, f + 999);
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 1000) break;
  }

  const porHost = new Map<string, Array<{ url: string; direct: string; title: string }>>();
  for (const fila of filas) {
    for (const s of fila.servers || []) {
      if (!s?.embed_url) continue;
      const dentro = paramUrl(s.embed_url);
      if (!dentro) continue;
      let host = '(?)';
      try { host = new URL(dentro).hostname.replace(/^www\./, ''); } catch {}
      const clave = host.replace(/^(ia|dn)\d+\..*archive\.org$/, 'archive.org-node').replace(/^s\w+\..*$/, m => /archive|rumble|pixeldrain|eintim|1a-1791/.test(m) ? m : '(cdn .txt rotativo)');
      const l = porHost.get(clave) || [];
      l.push({ url: dentro, direct: s.direct_stream ? s.direct_kind || 'si' : 'NO', title: fila.title });
      porHost.set(clave, l);
    }
  }

  for (const [host, items] of Array.from(porHost).sort((a, b) => b[1].length - a[1].length)) {
    const paso = Math.max(1, Math.floor(items.length / MUESTRAS));
    const muestra = Array.from({ length: Math.min(MUESTRAS, items.length) }, (_, i) => items[i * paso]).filter(Boolean);
    const res = await Promise.all(muestra.map(async m => `${m.direct}:${await queEs(m.url)}`));
    console.log(`\n${host}  (${items.length} servidores)`);
    for (let i = 0; i < res.length; i++) console.log(`   ${res[i].padEnd(46)} ${muestra[i].title?.slice(0, 40)}`);
  }
})();
