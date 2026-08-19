/**
 * LA PREGUNTA QUE APAGÓ VIDHIDEPLUS, REPETIDA HOY.
 *
 * Su veto (`noSePuedeServirDirecto`) se puso el 2026-07-25 con esta medición: 507 KB en 60 s
 * (~10 KB/s) desde una IP de datacenter, cuando emturbovid daba 441 KB/s en la misma pasada. Con
 * 33.195 servidores en el catálogo es, con diferencia, el mayor volumen que se puede recuperar de
 * una vez — así que el veto merece re-medirse en vez de heredarse.
 *
 * Mide lo mismo desde los DOS sitios que importan, porque son distintos y ya nos ha costado caro
 * confundirlos (ver `--entrega`): esta red (residencial, como un móvil) y la API desplegada
 * (datacenter, que es quien sirve de verdad).
 *
 *   npx ts-node -T scripts/dev/probe_vidhide_vercel.ts [host] [n]
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';
import { extractDirect } from '../../src/scrapers/directStream';

const db = getSupabaseAdmin();
const MARCA = process.argv[2] || 'vidhide';
const N = Number(process.argv[3]) || 8;
const API = process.argv[4] || 'https://api-pelis-series-latino-gilt.vercel.app';

const get = (u: string, ref: string, tipo: 'text' | 'arraybuffer' = 'text', ms = 60000) =>
  httpClient.get(u, {
    headers: { 'User-Agent': USER_AGENT, Referer: ref },
    timeout: ms,
    responseType: tipo as any,
    ...(tipo === 'text' ? { transformResponse: [(d: unknown) => d] } : {}),
    validateStatus: () => true,
    maxRedirects: 5,
  });

/** Del maestro al primer segmento real, como haría ExoPlayer. */
async function primerSegmento(maestro: string, ref: string): Promise<string | null> {
  const r1 = await get(maestro, ref);
  if (r1.status !== 200) return null;
  let lista = String(r1.data || '');
  let base = maestro;
  if (/#EXT-X-STREAM-INF/.test(lista)) {
    const variantes = lista.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (!variantes.length) return null;
    base = new URL(variantes[variantes.length - 1], maestro).toString();
    const r2 = await get(base, ref);
    if (r2.status !== 200) return null;
    lista = String(r2.data || '');
  }
  const segs = lista.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  return segs.length ? new URL(segs[0], base).toString() : null;
}

(async () => {
  const embeds: string[] = [];
  for (let from = 0; from < 15000 && embeds.length < N * 4; from += 500) {
    const { data } = await db.from('media_items').select('servers,seasons')
      .not('servers', 'eq', '[]').range(from, from + 499);
    if (!data?.length) break;
    for (const r of data as any[]) {
      const todos = [
        ...(r.servers ?? []),
        ...((r.seasons ?? []).flatMap((s: any) => s?.episodes ?? []).flatMap((e: any) => e?.servers ?? [])),
      ];
      for (const s of todos) {
        const u: string = s?.embed_url || '';
        if (u.includes(MARCA) && !embeds.includes(u)) embeds.push(u);
      }
    }
  }

  console.log(`Probando ${MARCA} sobre ${embeds.length} embeds hasta juntar ${N} vivos\n`);
  let vivos = 0, entreganLocal = 0, entreganVercel = 0;
  const velLocal: number[] = [], velVercel: number[] = [];

  for (const embed of embeds) {
    if (vivos >= N) break;
    const r = await get(embed, 'https://tioplus.app/');
    const html = String(r.data || '');
    if (r.status >= 400 || /no longer available|File was deleted|not found/i.test(html)) continue;

    const directo = await extractDirect(embed, html, { allowNetwork: false });
    if (!directo) continue;
    const seg = await primerSegmento(directo.url, embed).catch(() => null);
    if (!seg) { console.log(`  ${embed.slice(-14)}  extrae, pero su manifiesto no da segmento`); continue; }
    vivos++;

    // 1. Desde esta red.
    let local = 'n/a';
    try {
      const t = Date.now();
      const rs = await get(seg, embed, 'arraybuffer');
      const ms = Date.now() - t;
      const kb = ((rs.data as ArrayBuffer)?.byteLength ?? 0) / 1024;
      if (rs.status === 200 && kb > 0) {
        const v = kb / (ms / 1000);
        velLocal.push(v); entreganLocal++;
        local = `${kb.toFixed(0)} KB @ ${v.toFixed(0)} KB/s`;
      } else local = `http ${rs.status}`;
    } catch (e: any) { local = `ERR ${e.code || e.message?.slice(0, 20)}`; }

    // 2. Desde la API desplegada, que es quien sirve al cliente.
    let vercel = 'n/a';
    try {
      // `u` y `e` viajan en base64url: el endpoint los decodifica con `decodeEmbedParam`, y
      // pasarlos url-encoded devuelve 400 (parámetro ausente), no un fallo del host.
      const u = `${API}/api/v1/stream/direct/seg?u=${Buffer.from(seg).toString('base64url')}&e=${Buffer.from(embed).toString('base64url')}`;
      const t = Date.now();
      const rv = await get(u, API, 'arraybuffer', 90000);
      const ms = Date.now() - t;
      const kb = ((rv.data as ArrayBuffer)?.byteLength ?? 0) / 1024;
      if (rv.status === 200 && kb > 0) {
        const v = kb / (ms / 1000);
        velVercel.push(v); entreganVercel++;
        vercel = `${kb.toFixed(0)} KB @ ${v.toFixed(0)} KB/s`;
      } else vercel = `http ${rv.status}`;
    } catch (e: any) { vercel = `ERR ${e.code || e.message?.slice(0, 20)}`; }

    console.log(`  ${embed.slice(-14)}  local: ${local.padEnd(24)} vercel: ${vercel}`);
  }

  const media = (a: number[]) => a.length ? `${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(0)} KB/s` : 'n/a';
  console.log(`\n─────────────────────────────────`);
  console.log(`  vivos probados      ${vivos}`);
  console.log(`  entregan (local)    ${entreganLocal}   media ${media(velLocal)}`);
  console.log(`  entregan (VERCEL)   ${entreganVercel}   media ${media(velVercel)}   ← lo que decide`);
})();
