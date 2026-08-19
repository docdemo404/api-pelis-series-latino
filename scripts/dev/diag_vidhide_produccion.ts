/**
 * ¿Llega vidhideplus hasta el reproductor, por la API de PRODUCCIÓN?
 *
 * Coge fichas cuyo servidor publicado sea vidhideplus, les pide los enlaces a la API desplegada
 * y baja hasta un segmento real por el mismo camino que el cliente.
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';

const API = process.argv[2] || 'https://api-pelis-series-latino-gilt.vercel.app';
const N = Number(process.argv[3]) || 5;

const get = (u: string, tipo: 'text' | 'arraybuffer' = 'text', ms = 60000) =>
  httpClient.get(u, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: ms, responseType: tipo as any,
    ...(tipo === 'text' ? { transformResponse: [(d: unknown) => d] } : {}),
    validateStatus: () => true, maxRedirects: 5,
  } as any);

(async () => {
  const { data } = await supabase.from('media_items')
    .select('id,title,type,servers')
    .eq('has_streams', true).eq('type', 'movie')
    .order('streams_updated_at', { ascending: false }).limit(400);

  const conVidhide = (data ?? []).filter((r: any) =>
    (r.servers ?? []).some((s: any) => s?.direct_stream && /vidhide/i.test(s?.embed_url || s?.direct_host || '')));

  console.log(`${conVidhide.length} fichas recientes con un vidhideplus publicado\n`);

  let ok = 0;
  for (const f of conVidhide.slice(0, N)) {
    const r = await get(`${API}/api/v1/media/${encodeURIComponent(f.id)}/streams`);
    let servidores: any[] = [];
    try { const j = JSON.parse(String(r.data || '{}')); servidores = j?.data?.servers ?? j?.servers ?? []; } catch {}
    // OJO: la respuesta al cliente NO lleva `embed_url` (lo quita `paraElCliente`), así que el
    // host de origen no se puede buscar ahí. Se coge el primero con vídeo directo y se dice qué es.
    const vh = servidores.find((s: any) => s?.direct_stream);
    if (!vh) {
      console.log(`  ✗ ${String(f.title).slice(0, 40).padEnd(40)} la API no publica ningún directo (${servidores.length} servidores)`);
      continue;
    }

    // El manifiesto por el camino del cliente, y de ahí el primer segmento.
    const rm = await get(vh.direct_stream);
    const cuerpo = String(rm.data || '');
    if (rm.status !== 200 || !cuerpo.startsWith('#EXTM3U')) {
      console.log(`  ✗ ${String(f.title).slice(0, 40).padEnd(40)} manifiesto http=${rm.status}`);
      continue;
    }
    const lineas = cuerpo.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (!lineas.length) { console.log(`  ✗ ${String(f.title).slice(0, 40).padEnd(40)} manifiesto sin entradas`); continue; }

    let seg = new URL(lineas[lineas.length - 1], vh.direct_stream).toString();
    if (/#EXT-X-STREAM-INF/.test(cuerpo)) {
      const rv = await get(seg);
      const lv = String(rv.data || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      if (!lv.length) { console.log(`  ✗ ${String(f.title).slice(0, 40).padEnd(40)} variante vacía`); continue; }
      seg = new URL(lv[0], seg).toString();
    }

    const t = Date.now();
    const rs = await get(seg, 'arraybuffer', 90000);
    const kb = ((rs.data as ArrayBuffer)?.byteLength ?? 0) / 1024;
    if (rs.status === 200 && kb > 32) {
      ok++;
      console.log(`  ✓ ${String(f.title).slice(0, 40).padEnd(40)} ${kb.toFixed(0)} KB @ ${(kb / ((Date.now() - t) / 1000)).toFixed(0)} KB/s   [${vh.direct_host || vh.name || '?'}]`);
    } else {
      console.log(`  ✗ ${String(f.title).slice(0, 40).padEnd(40)} segmento http=${rs.status} ${kb.toFixed(0)} KB`);
    }
  }
  console.log(`\n  reproducen por producción: ${ok}/${Math.min(N, conVidhide.length)}`);
})();
