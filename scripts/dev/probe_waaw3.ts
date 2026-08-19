/**
 * Tercer salto de waaw.to: la página `/e/<token>`, que es la que carga el reproductor de verdad.
 */
import 'dotenv/config';
import * as fs from 'fs';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';

const EMBED = process.argv[2] || 'https://waaw.to/f/17qlg22yU2e5';

const get = (u: string, ref: string) =>
  httpClient.get(u, {
    headers: { 'User-Agent': USER_AGENT, Referer: ref },
    timeout: 25000,
    responseType: 'text',
    transformResponse: [(d: unknown) => d],
    validateStatus: () => true,
    maxRedirects: 5,
  });

const todas = (html: string, re: RegExp, n = 6) => [...new Set(html.match(re) || [])].slice(0, n);

(async () => {
  const r1 = await get(EMBED, 'https://tioplus.app/');
  const h1 = String(r1.data || '');
  const s1 = h1.match(/self\.location\.replace\('([^']+)'/);
  const url2 = new URL(s1![1], EMBED).toString();

  const r2 = await get(url2, EMBED);
  const h2 = String(r2.data || '');
  const ifr = h2.match(/<iframe[^>]+src="([^"]+)"/);
  const url3 = new URL(ifr![1].replace(/&amp;/g, '&'), EMBED).toString();
  console.log(`/e/  ${url3.slice(0, 140)}`);

  const r3 = await get(url3, url2);
  const h3 = String(r3.data || '');
  fs.writeFileSync('waaw3.html', h3);
  console.log(`\nhttp=${r3.status} bytes=${h3.length}`);
  console.log(`  m3u8    ${todas(h3, /[\w./:%?=&-]+\.m3u8[\w./:%?=&-]*/g).join('\n          ') || 'no'}`);
  console.log(`  mp4     ${todas(h3, /[\w./:%?=&-]+\.mp4[\w./:%?=&-]*/g).join('\n          ') || 'no'}`);
  console.log(`  .php    ${todas(h3, /[\w./-]*\.php[\w?=&%.-]*/g, 10).join(' | ') || 'no'}`);
  console.log(`  packer  ${/eval\(function\(p,a,c,k,e/.test(h3)}`);
  console.log(`  atob    ${(h3.match(/atob\(/g) || []).length}`);
  console.log(`  hosts   ${todas(h3, /https?:\/\/[\w.-]+/g, 12).join(' | ')}`);
  console.log(`  señales adbact=${/adbact/i.test(h3)} adscore=${/adscore/i.test(h3)} popcount=${/popcount/i.test(h3)} isTrusted=${/isTrusted/i.test(h3)}`);
  console.log(`  vars    ${todas(h3, /var\s+\w+\s*=\s*['"][^'"]{6,90}['"]/g, 14).join('\n          ')}`);

  console.log('\n--- scripts en línea ---');
  const inline = [...h3.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1].trim()).filter(Boolean);
  inline.slice(0, 6).forEach((s, i) => console.log(`\n[${i}] ${s.slice(0, 900)}`));
})();
