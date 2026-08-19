/**
 * ¿REPRODUCE VIDHIDEPLUS POR EL CAMINO DEL CLIENTE? — la pregunta que no hice bien.
 *
 * El 2026-08-19 se le levantó el veto midiendo UN segmento por ficha, y salió 8/8 a 233 KB/s.
 * Pero el reproductor no pide un segmento: pide el maestro, la variante y luego segmentos
 * SEGUIDOS, y todo a través del proxy de la API. Un fallo ahí se ve como «carga la duración y da
 * error», que es justo lo que se reportó con «El show de Truman».
 *
 * Esto recorre fichas cuyo ÚNICO servidor publicado es vidhideplus y mide la cadena entera.
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';

const API = 'https://api-pelis-series-latino-gilt.vercel.app';
const N_FICHAS = Number((process.argv.find(a => a.startsWith('--n=')) || '').split('=')[1] || 8);
const N_SEG = 3;

const get = (u: string, tipo: 'text' | 'arraybuffer' = 'text', ms = 45000) =>
  httpClient.get(u, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: ms, responseType: tipo as any,
    ...(tipo === 'text' ? { transformResponse: [(d: unknown) => d] } : {}),
    validateStatus: () => true, maxRedirects: 5,
  } as any);

async function reproduce(id: string): Promise<{ estado: string; detalle: string }> {
  const r = await get(`${API}/api/v1/media/${encodeURIComponent(id)}/streams`);
  let servidores: any[] = [];
  try { const j = JSON.parse(String(r.data || '{}')); servidores = j?.data?.servers ?? j?.servers ?? []; } catch {}
  const s = servidores.find((x: any) => x?.direct_stream);
  if (!s) return { estado: 'SIN SERVIDOR', detalle: `la API publica ${servidores.length}` };

  const rm = await get(s.direct_stream);
  const maestro = String(rm.data || '');
  if (rm.status !== 200 || !maestro.startsWith('#EXTM3U')) return { estado: 'SIN MAESTRO', detalle: `http=${rm.status}` };

  let lista = maestro, base = s.direct_stream;
  if (/#EXT-X-STREAM-INF/.test(maestro)) {
    const vs = maestro.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (!vs.length) return { estado: 'SIN VARIANTE', detalle: '' };
    base = new URL(vs[0], s.direct_stream).toString();   // la PRIMERA, como hls.js al empezar
    const rv = await get(base);
    if (rv.status !== 200) return { estado: 'SIN VARIANTE', detalle: `http=${rv.status}` };
    lista = String(rv.data || '');
  }
  const segs = lista.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (!segs.length) return { estado: 'SIN SEGMENTOS', detalle: '' };

  let ok = 0, kb = 0;
  const t0 = Date.now();
  for (const seg of segs.slice(0, N_SEG)) {
    try {
      const rs = await get(new URL(seg, base).toString(), 'arraybuffer', 45000);
      const n = ((rs.data as ArrayBuffer)?.byteLength ?? 0) / 1024;
      if (rs.status !== 200 || n <= 8) return { estado: 'CORTA EN SEGMENTO', detalle: `tras ${ok} ok · http=${rs.status}` };
      ok++; kb += n;
    } catch (e: any) {
      return { estado: 'CORTA EN SEGMENTO', detalle: `tras ${ok} ok · ${e.code || 'error'}` };
    }
  }
  const s2 = (Date.now() - t0) / 1000;
  return { estado: 'REPRODUCE', detalle: `${ok} seg · ${(kb / s2).toFixed(0)} KB/s` };
}

(async () => {
  // Fichas cuyo único servidor con directo es vidhideplus: si falla, la ficha no reproduce nada.
  const candidatas: any[] = [];
  let ultimoId = '';
  while (candidatas.length < N_FICHAS) {
    const { data } = await supabase.from('media_items')
      .select('id,title,servers').eq('has_streams', true).gt('id', ultimoId).order('id').limit(400);
    if (!data?.length) break;
    ultimoId = (data[data.length - 1] as any).id;
    for (const r of data as any[]) {
      const conDirecto = (r.servers ?? []).filter((s: any) => s?.direct_stream && s.status !== 'offline');
      if (!conDirecto.length) continue;
      if (!conDirecto.every((s: any) => /vidhide/i.test(s.embed_url || ''))) continue;
      candidatas.push(r);
      if (candidatas.length >= N_FICHAS) break;
    }
  }

  console.log(`${candidatas.length} fichas cuyo ÚNICO vídeo directo es vidhideplus\n`);
  const cuenta: Record<string, number> = {};
  for (const f of candidatas) {
    const { estado, detalle } = await reproduce(f.id);
    cuenta[estado] = (cuenta[estado] || 0) + 1;
    const marca = estado === 'REPRODUCE' ? '✓' : '✗';
    console.log(`  ${marca} ${String(f.title).slice(0, 38).padEnd(38)} ${estado.padEnd(19)} ${detalle}`);
  }
  console.log(`\nRESUMEN: ${Object.entries(cuenta).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
})();
