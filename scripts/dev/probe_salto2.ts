/**
 * vudeo.co y listeamed.net no sirven el reproductor en la primera petición: contestan una página
 * de una línea que redirige a sí misma con un parámetro añadido. Esto sigue ese salto.
 */
import 'dotenv/config';
import * as fs from 'fs';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';
import { unpackPacker } from '../../src/scrapers/directStream';

const db = getSupabaseAdmin();
const RE_VIDEO = /https?:\/\/[\w./:%?=&+~-]+\.(?:m3u8|mp4)[\w./:%?=&+~-]*/g;

const get = (u: string, ref: string, cookie = '') =>
  httpClient.get(u, {
    headers: {
      'User-Agent': USER_AGENT,
      Referer: ref,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    timeout: 25000,
    responseType: 'text',
    transformResponse: [(d: unknown) => d],
    validateStatus: () => true,
    maxRedirects: 5,
  });

function mirar(nombre: string, html: string) {
  const directas = [...new Set(html.match(RE_VIDEO) || [])];
  console.log(`  [${nombre}] bytes=${html.length}`);
  if (directas.length) {
    console.log(`     VÍDEO A LA VISTA: ${directas.slice(0, 3).join('\n                       ')}`);
    return true;
  }
  if (/eval\(function\(p,a,c,k,e/.test(html)) {
    const abierto = unpackPacker(html) || '';
    const dentro = [...new Set(abierto.match(RE_VIDEO) || [])];
    console.log(`     PACKER → ${dentro.length ? dentro.slice(0, 3).join(' | ') : 'sin url dentro'}`);
    if (dentro.length) return true;
    console.log(`     desempaquetado (400 ch): ${abierto.slice(0, 400)}`);
    return false;
  }
  if (/File was deleted|not found|no longer available/i.test(html)) { console.log('     BORRADO'); return false; }
  console.log(`     sin vídeo. ${html.replace(/\s+/g, ' ').slice(0, 260)}`);
  return false;
}

async function seguirVudeo(embed: string) {
  console.log(`\n===== vudeo.co  ${embed}`);
  const r1 = await get(embed, 'https://tioplus.app/');
  const h1 = String(r1.data || '');
  const link = h1.match(/var redirect_link = '([^']+)'/)?.[1];
  console.log(`  redirect_link = ${link}`);
  if (!link) return;
  // Su JS llama redirect(suffix) con la huella; probamos primero sin sufijo alguno.
  for (const sufijo of ['', 'fp=0', 'fpjs=0']) {
    const u = link + sufijo;
    const r = await get(u, embed, `tr_uuid=${link.match(/tr_uuid=([^&]+)/)?.[1] || ''}`);
    const h = String(r.data || '');
    if (mirar(`sufijo="${sufijo}" http=${r.status}`, h)) { fs.writeFileSync('vudeo_ok.html', h); return; }
  }
}

async function seguirListeamed(embed: string) {
  console.log(`\n===== listeamed.net  ${embed}`);
  const r1 = await get(embed, 'https://tioplus.app/');
  const h1 = String(r1.data || '');
  const dest = h1.match(/window\.location\.replace\('([^']+)'/)?.[1];
  console.log(`  salto = ${dest?.slice(0, 120)}`);
  if (!dest) { mirar('sin salto', h1); return; }
  const cookies = (r1.headers['set-cookie'] || []).map((c: string) => c.split(';')[0]).join('; ');
  const r2 = await get(dest, embed, cookies);
  const h2 = String(r2.data || '');
  if (mirar(`salto http=${r2.status}`, h2)) { fs.writeFileSync('listeamed_ok.html', h2); return; }
  fs.writeFileSync('listeamed2.html', h2);
}

(async () => {
  const muestras: Record<string, string[]> = { 'vudeo.co': [], 'listeamed.net': [] };
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
        for (const h of Object.keys(muestras)) {
          if (u.includes(h) && muestras[h].length < 3 && !muestras[h].includes(u)) muestras[h].push(u);
        }
      }
    }
    if (Object.values(muestras).every(v => v.length >= 3)) break;
  }

  for (const u of muestras['vudeo.co']) await seguirVudeo(u);
  for (const u of muestras['listeamed.net']) await seguirListeamed(u);
})();
