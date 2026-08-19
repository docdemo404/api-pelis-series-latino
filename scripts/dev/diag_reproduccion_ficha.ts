/**
 * REPRODUCIR UNA FICHA COMO LO HACE EL REPRODUCTOR, no como lo hace una sonda.
 *
 * Una sonda que baja UN segmento y se declara satisfecha no prueba lo que el espectador vive: el
 * reproductor carga el maestro, elige variante, y luego pide segmentos SEGUIDOS durante minutos.
 * El síntoma «carga la duración y da error» es exactamente eso — el manifiesto va, los segmentos
 * no— y una sonda de un solo segmento no lo distingue de una reproducción sana.
 *
 *   npx ts-node -T scripts/dev/diag_reproduccion_ficha.ts <id-de-la-ficha> [nSegmentos]
 */
import 'dotenv/config';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';

const API = 'https://api-pelis-series-latino-gilt.vercel.app';
const ID = process.argv[2] || 'el-show-de-truman-una-vida-en-directo';
const N_SEG = Number(process.argv[3]) || 6;

const get = (u: string, tipo: 'text' | 'arraybuffer' = 'text', ms = 60000) =>
  httpClient.get(u, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: ms, responseType: tipo as any,
    ...(tipo === 'text' ? { transformResponse: [(d: unknown) => d] } : {}),
    validateStatus: () => true, maxRedirects: 5,
  } as any);

(async () => {
  const r = await get(`${API}/api/v1/media/${encodeURIComponent(ID)}/streams`);
  let servidores: any[] = [];
  try { const j = JSON.parse(String(r.data || '{}')); servidores = j?.data?.servers ?? j?.servers ?? []; } catch {}
  console.log(`La API publica ${servidores.length} servidor(es) para «${ID}»\n`);

  for (const [i, s] of servidores.entries()) {
    console.log(`── servidor ${i + 1}: ${s.name || s.direct_host || '?'}  modo=${s.direct_mode || '?'}  tipo=${s.direct_kind || '?'}`);
    if (!s.direct_stream) { console.log('   sin vídeo directo\n'); continue; }

    // 1. Maestro — es lo que hace que el reproductor enseñe la duración.
    const t0 = Date.now();
    const rm = await get(s.direct_stream);
    const maestro = String(rm.data || '');
    console.log(`   maestro    http=${rm.status}  ${maestro.length} B  ${Date.now() - t0} ms`);
    if (rm.status !== 200 || !maestro.startsWith('#EXTM3U')) { console.log('   ✗ el maestro no llega\n'); continue; }

    // 2. Variante.
    let lista = maestro, base = s.direct_stream;
    if (/#EXT-X-STREAM-INF/.test(maestro)) {
      const vs = maestro.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      console.log(`   variantes  ${vs.length}`);
      if (!vs.length) { console.log('   ✗ maestro sin variantes\n'); continue; }
      base = new URL(vs[vs.length - 1], s.direct_stream).toString();
      const rv = await get(base);
      lista = String(rv.data || '');
      console.log(`   variante   http=${rv.status}  ${lista.length} B`);
      if (rv.status !== 200) { console.log('   ✗ la variante no llega\n'); continue; }
    }

    const segs = lista.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    console.log(`   segmentos  ${segs.length} en la lista`);
    if (!segs.length) { console.log('   ✗ lista sin segmentos\n'); continue; }

    // 3. VARIOS segmentos seguidos, que es donde se cae de verdad.
    let ok = 0, bytes = 0;
    const inicio = Date.now();
    for (const seg of segs.slice(0, N_SEG)) {
      const u = new URL(seg, base).toString();
      const t = Date.now();
      try {
        const rs = await get(u, 'arraybuffer', 45000);
        const kb = ((rs.data as ArrayBuffer)?.byteLength ?? 0) / 1024;
        const ms = Date.now() - t;
        if (rs.status === 200 && kb > 8) {
          ok++; bytes += kb;
          console.log(`     seg ${String(ok).padStart(2)}  ${kb.toFixed(0).padStart(5)} KB  ${String(ms).padStart(5)} ms  ${(kb / (ms / 1000)).toFixed(0)} KB/s`);
        } else {
          console.log(`     ✗ http=${rs.status}  ${kb.toFixed(0)} KB   ← AQUÍ SE CAE EL REPRODUCTOR`);
          break;
        }
      } catch (e: any) {
        console.log(`     ✗ ${e.code || e.message?.slice(0, 40)}   ← AQUÍ SE CAE EL REPRODUCTOR`);
        break;
      }
    }
    const seg = (Date.now() - inicio) / 1000;
    console.log(`   → ${ok}/${Math.min(N_SEG, segs.length)} segmentos · ${bytes.toFixed(0)} KB en ${seg.toFixed(1)} s (${(bytes / seg).toFixed(0)} KB/s)\n`);
  }
})();
