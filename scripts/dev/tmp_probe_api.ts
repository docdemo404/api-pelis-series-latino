/**
 * TEMPORAL. ¿Qué entrega DE VERDAD cada `direct_stream` publicado, tal y como lo recibe la app?
 * Se pide a producción, no al extractor local.
 */
import 'dotenv/config';
import * as fs from 'fs';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { streamClient } from '../../src/utils/httpClient';

const API = 'https://api-pelis-series-latino.vercel.app';
const SALIDA = process.argv.find(a => a.startsWith('--out='))?.split('=')[1] || 'tmp_probe_api.log';
const MUESTRAS = Number(process.argv.find(a => a.startsWith('--muestras='))?.split('=')[1] || 5);
const SOLO = process.argv.find(a => a.startsWith('--host='))?.split('=')[1] || '';
const db = getSupabaseAdmin();

const log = (s: string) => { console.log(s); fs.appendFileSync(SALIDA, s + '\n'); };

function hostDe(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '(?)'; }
}

async function queEs(url: string): Promise<string> {
  try {
    const r = await streamClient.get(url, {
      headers: { Range: 'bytes=0-2047' },
      responseType: 'arraybuffer',
      timeout: 20000,
      validateStatus: () => true,
      maxRedirects: 3,
    });
    const ct = String(r.headers['content-type'] || '').split(';')[0];
    if (r.status >= 400) return `❌ HTTP ${r.status}`;
    const b = Buffer.from(r.data as any);
    const cab = b.subarray(0, 400).toString('latin1');
    if (/^\s*#EXTM3U/.test(cab)) return 'HLS';
    if (/^\s*<(!doctype|html)/i.test(cab)) return `❌ HTML (${ct})`;
    if (b[0] === 0x47) return 'TS';
    if (b.subarray(4, 8).toString('latin1') === 'ftyp') return 'MP4';
    if (b.subarray(0, 4).toString('hex') === '1a45dfa3') return `❌ MKV (${ct})`;
    if (b.subarray(1, 4).toString('latin1') === 'PNG') return `❌ PNG (${ct})`;
    if (b.subarray(0, 3).toString('hex') === 'fff1' || cab.startsWith('ID3')) return 'audio?';
    return `❌ ??? ${b.subarray(0, 8).toString('hex')} (${ct})`;
  } catch (e: any) {
    return `⏱ ${e.code || String(e.message).slice(0, 24)}`;
  }
}

(async () => {
  fs.writeFileSync(SALIDA, '');
  const filas: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await db.from('media_items').select('id,title,servers').not('servers', 'eq', '[]').range(f, f + 999);
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 1000) break;
  }
  log(`fichas: ${filas.length}`);

  const porHost = new Map<string, Array<{ embed: string; kind: string; title: string }>>();
  let publicados = 0;
  for (const fila of filas) {
    for (const s of fila.servers || []) {
      if (!s?.embed_url || !s.direct_stream || s.status === 'offline') continue;
      publicados++;
      const h = hostDe(s.embed_url);
      if (SOLO && !h.includes(SOLO)) continue;
      const l = porHost.get(h) || [];
      l.push({ embed: s.embed_url, kind: s.direct_kind || '?', title: fila.title });
      porHost.set(h, l);
    }
  }
  log(`servidores publicados como vídeo directo: ${publicados} en ${porHost.size} hosts de embed\n`);

  for (const [host, items] of Array.from(porHost).sort((a, b) => b[1].length - a[1].length)) {
    const paso = Math.max(1, Math.floor(items.length / MUESTRAS));
    const muestra = Array.from({ length: Math.min(MUESTRAS, items.length) }, (_, i) => items[i * paso]).filter(Boolean);
    const res = await Promise.all(muestra.map(async m => {
      const ext = m.kind === 'mp4' ? '/v.mp4' : '/v.m3u8';
      const url = `${API}/api/v1/stream/direct${ext}?e=${Buffer.from(m.embed, 'utf8').toString('base64url')}`;
      return `${m.kind}→${await queEs(url)}`;
    }));
    const malos = res.filter(r => r.includes('❌')).length;
    log(`${malos ? '⚠' : ' '} ${host.padEnd(34)} n=${String(items.length).padStart(5)}  ${res.join('  |  ')}`);
  }
  log('\nFIN');
})();
