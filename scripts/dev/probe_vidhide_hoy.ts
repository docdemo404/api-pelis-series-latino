/**
 * vidhideplus, el host más numeroso del catálogo (33.195 servidores), está apagado por
 * `noSePuedeServirDirecto` desde una medición del 2026-07-25: entregaba 507 KB en 60 s (~10 KB/s)
 * a una IP de datacenter. Esto vuelve a medirlo, porque si eso cambió es el mayor volumen de
 * catálogo que se puede recuperar de una vez.
 *
 * Mide DOS cosas distintas, que es donde estuvo el error la primera vez:
 *   1. ¿se puede EXTRAER la url del vídeo?      (el packer trae el m3u8)
 *   2. ¿a qué velocidad entrega los BYTES?      (maestro → variante → segmento, cronometrado)
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';
import { unpackPacker } from '../../src/scrapers/directStream';

const db = getSupabaseAdmin();
const N = Number((process.argv.find(a => a.startsWith('--n=')) || '').split('=')[1] || 5);
const RE_VIDEO = /https?:\/\/[\w./:%?=&+~-]+\.(?:m3u8|mp4)[\w./:%?=&+~-]*/g;

const get = (u: string, ref: string, tipo: 'text' | 'arraybuffer' = 'text') =>
  httpClient.get(u, {
    headers: { 'User-Agent': USER_AGENT, Referer: ref },
    timeout: 60000,
    responseType: tipo as any,
    ...(tipo === 'text' ? { transformResponse: [(d: unknown) => d] } : {}),
    validateStatus: () => true,
    maxRedirects: 5,
  });

async function medirEntrega(maestro: string, ref: string) {
  const t0 = Date.now();
  const r1 = await get(maestro, ref);
  if (r1.status !== 200) return `maestro ${r1.status}`;
  const cuerpo = String(r1.data || '');
  const base = new URL(maestro);

  // Del maestro a una variante concreta (o el maestro ya lo es).
  const lineas = cuerpo.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  let variante = maestro;
  if (/#EXT-X-STREAM-INF/.test(cuerpo) && lineas.length) {
    variante = new URL(lineas[lineas.length - 1], base).toString();
    const r2 = await get(variante, ref);
    if (r2.status !== 200) return `variante ${r2.status}`;
    var listaSeg = String(r2.data || '');
  } else {
    var listaSeg = cuerpo;
  }

  const segs = listaSeg.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (!segs.length) return 'sin segmentos';
  const segUrl = new URL(segs[0], new URL(variante)).toString();

  const t1 = Date.now();
  const r3 = await get(segUrl, ref, 'arraybuffer');
  const ms = Date.now() - t1;
  const bytes = (r3.data as ArrayBuffer)?.byteLength ?? 0;
  if (r3.status !== 200) return `segmento ${r3.status}`;
  const kbs = bytes / 1024 / (ms / 1000);
  return `segmento ${(bytes / 1024).toFixed(0)} KB en ${(ms / 1000).toFixed(1)} s → ${kbs.toFixed(0)} KB/s   (cadena entera ${((Date.now() - t0) / 1000).toFixed(1)} s)`;
}

(async () => {
  const urls: string[] = [];
  for (let from = 0; from < 15000 && urls.length < N; from += 500) {
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
        if (u.includes('vidhideplus') && !urls.includes(u)) urls.push(u);
        if (urls.length >= N) break;
      }
      if (urls.length >= N) break;
    }
  }

  console.log(`${urls.length} embeds de vidhideplus\n`);
  for (const u of urls) {
    console.log(`===== ${u}`);
    const r = await get(u, 'https://tioplus.app/');
    const html = String(r.data || '');
    if (r.status >= 400) { console.log(`  http=${r.status}\n`); continue; }
    if (/File was deleted|not found|no longer available/i.test(html)) { console.log('  BORRADO\n'); continue; }

    let urls2 = [...new Set(html.match(RE_VIDEO) || [])];
    if (!urls2.length && /eval\(function\(p,a,c,k,e/.test(html)) {
      const abierto = unpackPacker(html) || '';
      urls2 = [...new Set(abierto.match(RE_VIDEO) || [])];
      if (!urls2.length) {
        console.log(`  packer sin url. Trozo: ${abierto.slice(0, 300)}`);
        const otras = [...new Set(abierto.match(/https?:\/\/[\w./:%?=&+~-]{20,}/g) || [])].slice(0, 5);
        console.log(`  urls en el desempaquetado: ${otras.join('\n                             ') || 'ninguna'}`);
      }
    }
    if (!urls2.length) { console.log('  sin url de vídeo\n'); continue; }

    console.log(`  extraído: ${urls2[0].slice(0, 110)}`);
    console.log(`  entrega : ${await medirEntrega(urls2[0], u)}\n`);
  }
})();
