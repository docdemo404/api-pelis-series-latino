/**
 * TEMPORAL. ¿Cuántos "vídeo directo" entregan un contenedor que no es el que anuncian?
 * Lee los primeros bytes del fichero real (el `link=`), sin pasar por la API.
 */
import 'dotenv/config';
import * as fs from 'fs';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { streamClient } from '../../src/utils/httpClient';

const SALIDA = process.argv.find(a => a.startsWith('--out='))?.split('=')[1] || 'scan_container.log';
const CONCURRENCIA = 12;
const db = getSupabaseAdmin();
const log = (s: string) => { console.log(s); fs.appendFileSync(SALIDA, s + '\n'); };

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

async function contenedor(url: string): Promise<string> {
  try {
    const r = await streamClient.get(url, {
      headers: { Range: 'bytes=0-63' },
      responseType: 'arraybuffer',
      timeout: 20000,
      validateStatus: () => true,
      maxRedirects: 3,
    });
    if (r.status >= 400) return `HTTP ${r.status}`;
    const b = Buffer.from(r.data as any);
    const hex = b.subarray(0, 4).toString('hex');
    if (b.subarray(4, 8).toString('latin1') === 'ftyp') return 'MP4';
    if (hex === '1a45dfa3') return 'MKV';
    if (b[0] === 0x47) return 'TS';
    if (/^\s*#EXTM3U/.test(b.subarray(0, 40).toString('latin1'))) return 'HLS';
    if (/^\s*<(!doctype|html)/i.test(b.subarray(0, 40).toString('latin1'))) return 'HTML';
    if (b.subarray(0, 4).toString('latin1') === 'RIFF') return 'AVI';
    return `??? ${hex}`;
  } catch (e: any) {
    return `err ${e.code || String(e.message).slice(0, 20)}`;
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

  const objetivos: Array<{ title: string; id: string; url: string; kind: string }> = [];
  for (const fila of filas) {
    for (const s of fila.servers || []) {
      if (!s?.embed_url || !s.direct_stream || s.status === 'offline') continue;
      const dentro = paramUrl(s.embed_url);
      if (!dentro) continue;
      objetivos.push({ title: fila.title, id: fila.id, url: dentro, kind: s.direct_kind || '?' });
    }
  }
  log(`ficheros a comprobar: ${objetivos.length}`);

  const cuenta = new Map<string, number>();
  const raros: string[] = [];
  let hechos = 0;
  for (let i = 0; i < objetivos.length; i += CONCURRENCIA) {
    const lote = objetivos.slice(i, i + CONCURRENCIA);
    const res = await Promise.all(lote.map(async o => ({ o, c: await contenedor(o.url) })));
    for (const { o, c } of res) {
      cuenta.set(c, (cuenta.get(c) || 0) + 1);
      if (c !== 'MP4' && c !== 'HLS' && c !== 'TS') {
        raros.push(`${c.padEnd(14)} kind=${o.kind.padEnd(4)} ${o.title?.slice(0, 44).padEnd(44)} ${o.url.slice(0, 100)}`);
      }
    }
    hechos += lote.length;
    if (hechos % 120 === 0) console.error(`  ${hechos}/${objetivos.length}`);
  }

  log('\n== contenedores ==');
  for (const [k, v] of Array.from(cuenta).sort((a, b) => b[1] - a[1])) log(`${String(v).padStart(5)}  ${k}`);
  log('\n== los que no son vídeo reproducible tal cual ==');
  for (const r of raros) log(r);
})();
