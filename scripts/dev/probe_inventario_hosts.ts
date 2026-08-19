/**
 * INVENTARIO: host por host, qué hay detrás del embed y si se puede sacar el vídeo.
 *
 * Es el paso previo a escribir extractores. "No hay extractor" mezcla cosas que piden trabajos
 * opuestos, y sin separarlas se escribe código para un host que ya no tiene ficheros:
 *
 *   BORRADO   el host dice que el fichero no está
 *   CAPTCHA   exige resolver un desafío humano — fuera de alcance
 *   PACKER    trae el vídeo en un `eval(function(p,a,c,k,e,d)`, que ya sabemos desempaquetar
 *   A LA VISTA la url del vídeo está en el HTML (sources/file/m3u8/mp4)
 *   API       hay que pedírsela a un endpoint suyo
 *   OPACO     la página carga y no se ve por dónde sale el vídeo
 *
 *   npx ts-node -T scripts/dev/probe_inventario_hosts.ts [--n=6]
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';
import { unpackPacker } from '../../src/scrapers/directStream';

const db = getSupabaseAdmin();
const N = Number((process.argv.find(a => a.startsWith('--n=')) || '').split('=')[1] || 6);

const HOSTS = [
  'vudeo.co', 'listeamed.net', 'filemoon.to', 'filemoon.sx', 'voe.sx', 'streamtape.com',
  'luluvdo.com', 'firestream.to', 'krakenfiles.com', 'vidsonic.net', 'doodstream.com',
  'vidhideplus.com',
];

type Veredicto = 'BORRADO' | 'CAPTCHA' | 'PACKER' | 'A LA VISTA' | 'API' | 'OPACO' | 'RED';

const get = (u: string, ref = 'https://tioplus.app/') =>
  httpClient.get(u, {
    headers: { 'User-Agent': USER_AGENT, Referer: ref, Accept: 'text/html,*/*' },
    timeout: 20000,
    responseType: 'text',
    transformResponse: [(d: unknown) => d],
    validateStatus: () => true,
    maxRedirects: 5,
  });

const RE_VIDEO = /https?:\/\/[\w./:%?=&+~-]+\.(?:m3u8|mp4)[\w./:%?=&+~-]*/g;

function analizar(html: string): { veredicto: Veredicto; pista: string } {
  if (!html) return { veredicto: 'RED', pista: 'cuerpo vacío' };
  if (/File (was deleted|not found)|no longer available|can't find the file|Video is unavailable|not found on this server/i.test(html)) {
    return { veredicto: 'BORRADO', pista: '' };
  }
  if (/hcaptcha|g-recaptcha|recaptcha\/api|turnstile/i.test(html)) {
    return { veredicto: 'CAPTCHA', pista: '' };
  }

  const directas = [...new Set(html.match(RE_VIDEO) || [])];
  if (directas.length) return { veredicto: 'A LA VISTA', pista: directas[0].slice(0, 90) };

  if (/eval\(function\(p,a,c,k,e/.test(html)) {
    const abierto = unpackPacker(html) || '';
    const dentro = [...new Set(abierto.match(RE_VIDEO) || [])];
    return dentro.length
      ? { veredicto: 'PACKER', pista: dentro[0].slice(0, 90) }
      : { veredicto: 'PACKER', pista: 'se desempaqueta pero no trae url de vídeo' };
  }

  const api = [...new Set(html.match(/["'](\/[\w./-]*(?:api|ajax|player|source|dl)[\w./-]*\.(?:php|json)[^"']*)["']/gi) || [])];
  if (api.length) return { veredicto: 'API', pista: api.slice(0, 2).join(' | ').slice(0, 110) };

  return { veredicto: 'OPACO', pista: `${html.length} B` };
}

(async () => {
  // Una sola pasada por el catálogo, recogiendo muestras de todos los hosts a la vez.
  const muestras: Record<string, string[]> = {};
  for (let from = 0; from < 15000; from += 500) {
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
        const h = HOSTS.find(x => u.includes(x));
        if (!h) continue;
        muestras[h] ??= [];
        if (muestras[h].length < N && !muestras[h].includes(u)) muestras[h].push(u);
      }
    }
    if (HOSTS.every(h => (muestras[h]?.length ?? 0) >= N)) break;
    process.stderr.write(`  …${from}\r`);
  }

  console.log(`\n${'HOST'.padEnd(18)} ${'muestras'.padStart(8)}  reparto`);
  const resumen: Array<[string, string]> = [];

  for (const host of HOSTS) {
    const urls = muestras[host] ?? [];
    if (!urls.length) { console.log(`${host.padEnd(18)} ${'0'.padStart(8)}  (sin muestras)`); continue; }

    const cuenta: Record<string, number> = {};
    const pistas: string[] = [];
    for (const u of urls) {
      let html = '';
      try {
        const r = await get(u);
        html = r.status >= 400 ? '' : String(r.data || '');
        if (r.status >= 400) { cuenta['RED'] = (cuenta['RED'] || 0) + 1; continue; }
      } catch { cuenta['RED'] = (cuenta['RED'] || 0) + 1; continue; }
      const { veredicto, pista } = analizar(html);
      cuenta[veredicto] = (cuenta[veredicto] || 0) + 1;
      if (pista && pistas.length < 2) pistas.push(pista);
    }
    const reparto = Object.entries(cuenta).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(`${host.padEnd(18)} ${String(urls.length).padStart(8)}  ${reparto}`);
    for (const p of pistas) console.log(`${' '.repeat(28)}↳ ${p}`);
    resumen.push([host, reparto]);
  }

  console.log('\n───── dónde hay extractor que escribir');
  for (const [h, r] of resumen) {
    if (/A LA VISTA|PACKER|API/.test(r)) console.log(`   ${h.padEnd(18)} ${r}`);
  }
})();
