/**
 * ¿SEPARA EL CAUDAL A LOS QUE REPRODUCEN DE LOS QUE NO?
 *
 * Exigir más segmentos no cazó nada (0/12): estos hosts no fallan con un 404 en el segmento 2,
 * fallan entregando a 8-14 KB/s, y 8 KB llegan igual de bien a esa velocidad. Lo que hay que
 * medir entonces es el CAUDAL — pero antes de poner un suelo hay que saber si los buenos y los
 * malos se separan de verdad, porque este proyecto ya se tumbó entero con una regla que daba por
 * muerto lo que tardara más de 12 s (`goodstream` tarda 26 y reproduce).
 *
 * Así que esto no condena a nadie: descarga un segmento ENTERO por servidor y enseña el reparto
 * por host. Si hay dos poblaciones claras, un suelo es defendible; si se solapan, no.
 *
 *   npx ts-node -T scripts/dev/probe_caudal_segmentos.ts [--n=24]
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';
import { mintDirect } from '../../src/services/directResolver';
import { bajarManifiesto } from '../../src/services/manifestHealth';

const db = getSupabaseAdmin();
const N = Number((process.argv.find(a => a.startsWith('--n=')) || '').split('=')[1] || 24);

const get = (u: string, ref: string, tipo: 'text' | 'arraybuffer' = 'text', ms = 45000) =>
  httpClient.get(u, {
    headers: { 'User-Agent': USER_AGENT, Referer: ref },
    timeout: ms, responseType: tipo as any,
    ...(tipo === 'text' ? { transformResponse: [(d: unknown) => d] } : {}),
    validateStatus: () => true, maxRedirects: 5,
  } as any);

const hostDe = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '?'; } };

(async () => {
  const embeds: string[] = [];
  for (let from = 0; from < 15000 && embeds.length < N * 3; from += 500) {
    const { data } = await db.from('media_items').select('servers')
      .not('servers', 'eq', '[]').range(from, from + 499);
    if (!data?.length) break;
    for (const r of data as any[]) {
      for (const s of (r.servers ?? [])) {
        const u = s?.embed_url || '';
        if (s?.direct_stream && s.status !== 'offline' && !embeds.includes(u)) embeds.push(u);
      }
    }
  }
  // Reparto por host para no medir 24 veces el mismo sitio.
  const porHost = new Map<string, string[]>();
  for (const u of embeds) {
    const h = hostDe(u);
    if (!porHost.has(h)) porHost.set(h, []);
    if (porHost.get(h)!.length < 5) porHost.get(h)!.push(u);
  }
  const muestra = Array.from(porHost.values()).flat().slice(0, N);

  console.log(`${muestra.length} servidores de ${porHost.size} hosts\n`);
  const medidas: Array<{ host: string; kbs: number | null; nota: string }> = [];

  for (const embed of muestra) {
    const host = hostDe(embed);
    const minted = await mintDirect(embed).catch(() => null);
    if (!minted) { medidas.push({ host, kbs: null, nota: 'no se acuña' }); continue; }

    let lista = minted.kind === 'hls' ? await bajarManifiesto(minted.url, minted.referer) : null;
    let base = minted.url;
    if (minted.kind === 'hls') {
      if (!lista) { medidas.push({ host, kbs: null, nota: 'sin maestro' }); continue; }
      if (/#EXT-X-STREAM-INF/.test(lista)) {
        const vs = lista.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        if (!vs.length) { medidas.push({ host, kbs: null, nota: 'sin variantes' }); continue; }
        base = new URL(vs[0], minted.url).toString();
        lista = await bajarManifiesto(base, minted.referer);
        if (!lista) { medidas.push({ host, kbs: null, nota: 'variante muerta' }); continue; }
      }
    }
    const segs = (lista || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const objetivo = minted.kind === 'hls'
      ? (segs.length ? new URL(segs[0], base).toString() : '')
      : minted.url;
    if (!objetivo) { medidas.push({ host, kbs: null, nota: 'sin segmentos' }); continue; }

    // Un segmento ENTERO (o 2 MB de un mp4): es lo que de verdad mide el caudal.
    const t = Date.now();
    try {
      const r = await get(objetivo, minted.referer, 'arraybuffer');
      const kb = ((r.data as ArrayBuffer)?.byteLength ?? 0) / 1024;
      const s = (Date.now() - t) / 1000;
      if (r.status >= 400 || kb < 8) { medidas.push({ host, kbs: null, nota: `http ${r.status}` }); continue; }
      medidas.push({ host, kbs: kb / s, nota: `${kb.toFixed(0)} KB en ${s.toFixed(1)}s` });
    } catch (e: any) {
      medidas.push({ host, kbs: null, nota: e.code || 'error' });
    }
  }

  console.log(`${'host'.padEnd(30)} ${'KB/s'.padStart(8)}  detalle`);
  for (const m of medidas.sort((a, b) => (b.kbs ?? -1) - (a.kbs ?? -1))) {
    console.log(`${m.host.padEnd(30)} ${(m.kbs != null ? m.kbs.toFixed(0) : '—').padStart(8)}  ${m.nota}`);
  }

  const vivos = medidas.filter(m => m.kbs != null).map(m => m.kbs!) as number[];
  vivos.sort((a, b) => a - b);
  const q = (x: number) => vivos.length ? vivos[Math.floor(vivos.length * x)].toFixed(0) : '—';
  console.log(`\n  reparto del caudal (${vivos.length} medidos): p10=${q(0.1)} p25=${q(0.25)} p50=${q(0.5)} p75=${q(0.75)} p90=${q(0.9)} KB/s`);
  console.log(`  por debajo de 50 KB/s: ${vivos.filter(v => v < 50).length}   ·  por debajo de 100: ${vivos.filter(v => v < 100).length}`);
})();
