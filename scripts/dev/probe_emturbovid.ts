/**
 * ¿Por qué falla el vídeo directo de un host? ¿Es suyo o es nuestro?
 *
 * Compara lo que ve la API (desde Vercel) con lo que se ve desde AQUÍ, que es una conexión
 * normal. Si la API falla y aquí funciona, el problema es de dónde pedimos; si falla en los dos
 * sitios, el vídeo no está.
 *
 * OJO — la trampa que me comí escribiendo esto: `extractDirect` devolviendo una URL NO significa
 * que haya vídeo. emturbovid extrae su m3u8 perfectamente y ese m3u8 son 25 bytes:
 * `#EXTM3U\n#EXT-X-VERSION:6` y se acabó, sin una sola variante. La cabecera está, el vídeo no.
 * Por eso este probe BAJA lo extraído y cuenta lo que hay dentro; si solo mirara el código de
 * estado diría "extrae bien" de un catálogo entero de vídeos borrados.
 *
 *   npx ts-node --transpile-only scripts/dev/probe_emturbovid.ts [--host=emturbovid] [--n=4]
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { streamClient } from '../../src/utils/httpClient';
import { extractDirect } from '../../src/scrapers/directStream';

const db = getSupabaseAdmin();
const HOST = (process.argv.find(a => a.startsWith('--host=')) || '--host=emturbovid').split('=')[1];
const N = Number((process.argv.find(a => a.startsWith('--n=')) || '').split('=')[1] || 4);
const API = 'https://api-pelis-series-latino-gilt.vercel.app';

/**
 * Lo que de verdad importa: ¿la URL extraída tiene VÍDEO?
 *
 * Un manifiesto sin variantes ni segmentos es 200, es `application/vnd.apple.mpegurl`, y no
 * reproduce nada. Un mp4 de cero bytes, igual. Se cuenta el contenido, no el código de estado.
 */
async function hayVideoDetras(url: string, referer: string): Promise<string> {
  try {
    const r = await streamClient.get(url, {
      headers: { Referer: referer, Range: 'bytes=0-8191' },
      responseType: 'arraybuffer', timeout: 25000, validateStatus: () => true, maxRedirects: 3,
    });
    if (r.status >= 400) return `❌ el destino da HTTP ${r.status}`;
    const buf = Buffer.from(r.data as any);
    const texto = buf.subarray(0, 2000).toString('latin1');
    if (/^\s*#EXTM3U/.test(texto)) {
      const variantes = (texto.match(/#EXT-X-STREAM-INF/g) || []).length;
      const segmentos = (texto.match(/#EXTINF/g) || []).length;
      if (!variantes && !segmentos) return `❌ MANIFIESTO VACÍO (${buf.length} bytes, ni una variante ni un segmento) — el vídeo no está`;
      if (segmentos) return `✅ ${segmentos} segmentos en el propio manifiesto`;
      // Un maestro con variantes tampoco prueba nada: la variante puede estar vacía. Hay que
      // BAJAR. Es la misma trampa un piso más abajo, y es donde se decide si hay vídeo o no.
      const rel = texto.split(/\r?\n/).find(l => l.trim() && !l.startsWith('#'));
      if (!rel) return `❌ ${variantes} variantes anunciadas y ninguna URL debajo`;
      const hija = new URL(rel.trim(), url).toString();
      const v = await streamClient.get(hija, {
        headers: { Referer: referer, Range: 'bytes=0-8191' },
        responseType: 'arraybuffer', timeout: 25000, validateStatus: () => true, maxRedirects: 3,
      });
      if (v.status >= 400) return `❌ ${variantes} variantes, pero la variante da HTTP ${v.status} — el vídeo no está`;
      const vt = Buffer.from(v.data as any).toString('latin1');
      const segs = (vt.match(/#EXTINF/g) || []).length;
      return segs
        ? `✅ ${variantes} variantes · la primera trae ${segs} segmentos`
        : `❌ ${variantes} variantes y la variante está VACÍA — el vídeo no está`;
    }
    if (buf.length < 1024) return `❌ solo ${buf.length} bytes`;
    return `✅ ${buf.length} bytes de vídeo`;
  } catch (e: any) {
    return `❌ error ${e.code || e.message}`;
  }
}

(async () => {
  const { data } = await db.from('media_items').select('id,servers').not('servers', 'eq', '[]').range(0, 1499);
  const urls: string[] = [];
  for (const r of data || []) {
    for (const s of (r as any).servers || []) {
      if (s?.direct_stream && String(s.embed_url || '').includes(HOST)) urls.push(s.embed_url);
    }
  }
  console.log(`${urls.length} servidores de ${HOST} que dicen tener vídeo directo\n`);

  for (const u of urls.slice(0, N)) {
    const e = Buffer.from(u, 'utf8').toString('base64url');
    const r = await streamClient.get(`${API}/api/v1/stream/direct?e=${e}`, {
      validateStatus: () => true, timeout: 30000, maxRedirects: 0,
    });
    const cuerpo = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    console.log(`API  ${String(r.status).padEnd(4)} ${u.slice(0, 52)}`);
    console.log(`     ${String(cuerpo).replace(/\s+/g, ' ').slice(0, 160)}`);

    // Y lo mismo desde AQUÍ, sin pasar por la lambda: separa "el host no da vídeo" de
    // "el host no nos da vídeo A NOSOTROS desde Vercel".
    try {
      const pag = await streamClient.get(u, {
        headers: { Referer: u, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36' },
        timeout: 25000, validateStatus: () => true,
      });
      const d = await extractDirect(u, String(pag.data || ''), { allowNetwork: true });
      if (!d?.url) { console.log(`     local: HTTP ${pag.status} · — no se extrae nada`); continue; }
      console.log(`     local: extrae ${d.kind} ${d.url.slice(0, 66)}`);
      console.log(`            ${await hayVideoDetras(d.url, u)}`);
    } catch (err: any) {
      console.log(`     local: error ${err.code || err.message}`);
    }
  }
})();
