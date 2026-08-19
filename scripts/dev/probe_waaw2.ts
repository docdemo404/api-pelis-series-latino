/**
 * Qué publica HOY waaw.to detrás de su embed. El comentario de DECOY_HOSTS describe una página
 * que ya no es la que sirve, así que esto vuelve a mirar de cero.
 */
import 'dotenv/config';
import * as fs from 'fs';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';

const EMBED = process.argv[2] || 'https://waaw.to/f/17qlg22yU2e5';
const H: Record<string, string> = { 'User-Agent': USER_AGENT, Referer: 'https://tioplus.app/' };

const get = (u: string, h: Record<string, string> = H) =>
  httpClient.get(u, {
    headers: h,
    timeout: 25000,
    responseType: 'text',
    transformResponse: [(d: unknown) => d],
    validateStatus: () => true,
    maxRedirects: 5,
  });

const todas = (html: string, re: RegExp, n = 4) => [...new Set(html.match(re) || [])].slice(0, n);

(async () => {
  const r1 = await get(EMBED);
  const html1 = String(r1.data || '');
  const salto = html1.match(/self\.location\.replace\('([^']+)'/);
  console.log(`embed  http=${r1.status} bytes=${html1.length}`);
  console.log(`salto  ${salto ? salto[1].slice(0, 100) : 'NINGUNO'}`);
  if (!salto) return;

  const url2 = new URL(salto[1], EMBED).toString();
  const r2 = await get(url2, { ...H, Referer: EMBED });
  const html2 = String(r2.data || '');
  fs.writeFileSync('waaw2.html', html2);

  console.log(`\nwatch_video  http=${r2.status} bytes=${html2.length}`);
  console.log(`  m3u8      ${todas(html2, /[\w./:%?=&-]+\.m3u8[\w./:%?=&-]*/g).join(' | ') || 'no'}`);
  console.log(`  mp4       ${todas(html2, /[\w./:%?=&-]+\.mp4[\w./:%?=&-]*/g).join(' | ') || 'no'}`);
  console.log(`  .php      ${todas(html2, /[\w./-]*\.php[\w?=&%-]*/g, 8).join(' | ') || 'no'}`);
  console.log(`  scripts   ${[...html2.matchAll(/<script[^>]+src="([^"]+)"/g)].map(x => x[1]).slice(0, 8).join('\n            ')}`);
  console.log(`  packer    ${/eval\(function\(p,a,c,k,e/.test(html2)}`);
  console.log(`  atob      ${(html2.match(/atob\(/g) || []).length} usos`);
  console.log(`  iframes   ${[...html2.matchAll(/<iframe[^>]+src="([^"]+)"/g)].map(x => x[1]).slice(0, 4).join(' | ') || 'no'}`);
  console.log(`  señales   adbact=${/adbact/i.test(html2)} adscore=${/adscore/i.test(html2)} popcount=${/popcount/i.test(html2)} isTrusted=${/isTrusted/i.test(html2)} mousemove=${/mousemove/i.test(html2)}`);
  console.log(`  captcha   ${/captcha|cf-challenge|turnstile/i.test(html2)}`);

  console.log('\n--- 2500 primeros caracteres ---');
  console.log(html2.slice(0, 2500));
})();
