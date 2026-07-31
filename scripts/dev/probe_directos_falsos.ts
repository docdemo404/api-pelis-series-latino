/**
 * ¿Algún "vídeo directo" no lo es?
 *
 * Coge servidores que la API anuncia con `direct_stream` y comprueba QUÉ entrega realmente el
 * endpoint: un manifiesto, bytes de vídeo, o una página HTML —que sería el embed disfrazado de
 * vídeo directo, el peor caso: el reproductor lo elige primero por estar mejor rotulado y no
 * puede hacer nada con ello.
 *
 *   npx ts-node --transpile-only scripts/dev/probe_directos_falsos.ts [--muestras=4] [--host=x]
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { streamClient } from '../../src/utils/httpClient';

/** Se prueba contra PRODUCCIÓN, que es lo que recibe el cliente, no contra el extractor local. */
const API = 'https://api-pelis-series-latino-gilt.vercel.app';

const db = getSupabaseAdmin();
const arg = (n: string, d = '') => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const MUESTRAS = Number(arg('muestras', '4'));
const SOLO = arg('host');

function hostDe(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '(?)';
  }
}

/** Qué es de verdad lo que hay al final del enlace. */
async function queEs(url: string, referer: string): Promise<string> {
  try {
    const r = await streamClient.get(url, {
      headers: { Referer: referer, Range: 'bytes=0-4095' },
      responseType: 'arraybuffer',
      timeout: 20000,
      validateStatus: () => true,
      maxRedirects: 3,
    });
    if (r.status >= 400) return `HTTP ${r.status}`;
    const b = Buffer.from(r.data as any);
    const cabecera = b.subarray(0, 400).toString('latin1');
    if (/^\s*#EXTM3U/.test(cabecera)) return 'manifiesto HLS';
    if (/^\s*<(!doctype|html)/i.test(cabecera)) return '❌ PÁGINA HTML (es un embed, no vídeo)';
    if (b[0] === 0x47) return 'MPEG-TS';
    if (b.subarray(4, 8).toString('latin1') === 'ftyp') return 'MP4';
    if (b.subarray(0, 4).toString('latin1') === '\x89PNG') return 'PNG (disfraz)';
    return `desconocido (${b.subarray(0, 8).toString('hex', 0, 8)})`;
  } catch (e: any) {
    return `error ${e.code || e.message}`.slice(0, 40);
  }
}

(async () => {
  const filas: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await db.from('media_items').select('id,servers').not('servers', 'eq', '[]').range(f, f + 999);
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 1000) break;
  }

  // Un embed por host, entre los que SE ANUNCIAN como vídeo directo.
  const porHost = new Map<string, string[]>();
  for (const fila of filas) {
    for (const s of fila.servers || []) {
      if (!s?.embed_url || !s.direct_stream) continue;
      const h = hostDe(s.embed_url);
      if (SOLO && !h.includes(SOLO)) continue;
      const l = porHost.get(h) || [];
      if (l.length < 60) l.push(s.embed_url);
      porHost.set(h, l);
    }
  }

  console.log(`hosts que anuncian vídeo directo: ${porHost.size}\n`);
  for (const [host, urls] of Array.from(porHost).sort((a, b) => b[1].length - a[1].length)) {
    const paso = Math.max(1, Math.floor(urls.length / MUESTRAS));
    const muestra = Array.from({ length: Math.min(MUESTRAS, urls.length) }, (_, i) => urls[i * paso]).filter(Boolean);
    const resultados = await Promise.all(muestra.map(async u => {
      const enlace = `${API}/api/v1/stream/direct?e=${Buffer.from(u, 'utf8').toString('base64url')}`;
      return queEs(enlace, '');
    }));
    const malos = resultados.filter(r => r.startsWith('❌')).length;
    console.log(`${host.padEnd(32)} ${malos ? '⚠ ' : '  '}${resultados.join('  |  ')}`);
  }
})();
