/**
 * Cuarto salto de waaw.to: `/player/embed_player.php?vid=<token>`, que es quien devuelve el vídeo.
 */
import 'dotenv/config';
import * as fs from 'fs';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';

const EMBED = process.argv[2] || 'https://waaw.to/f/17qlg22yU2e5';

const get = (u: string, ref: string) =>
  httpClient.get(u, {
    headers: {
      'User-Agent': USER_AGENT,
      Referer: ref,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: '*/*',
    },
    timeout: 25000,
    responseType: 'text',
    transformResponse: [(d: unknown) => d],
    validateStatus: () => true,
    maxRedirects: 5,
  });

const todas = (html: string, re: RegExp, n = 8) => [...new Set(html.match(re) || [])].slice(0, n);

(async () => {
  const r1 = await get(EMBED, 'https://tioplus.app/');
  const s1 = String(r1.data || '').match(/self\.location\.replace\('([^']+)'/);
  const url2 = new URL(s1![1], EMBED).toString();
  const r2 = await get(url2, EMBED);
  const ifr = String(r2.data || '').match(/<iframe[^>]+src="([^"]+)"/);
  const url3 = new URL(ifr![1].replace(/&amp;/g, '&'), EMBED).toString();
  const token = url3.match(/\/e\/([^?]+)/)![1];
  console.log(`token = ${token}`);

  const r3 = await get(url3, url2);
  const h3 = String(r3.data || '');
  const ws = h3.match(/var\s+ws\s*=\s*'([^']+)'/)?.[1] || '';
  console.log(`ws    = ${ws}`);

  for (const captcha of ['0', '1']) {
    const u = `https://waaw.to/player/embed_player.php?vid=${token}&need_captcha=${captcha}&pop=0&t=1`;
    const r = await get(u, url3);
    const h = String(r.data || '');
    fs.writeFileSync(`waaw_player_${captcha}.html`, h);
    console.log(`\n=== embed_player need_captcha=${captcha}  http=${r.status} bytes=${h.length}`);
    console.log(`  m3u8   ${todas(h, /[\w./:%?=&+-]+\.m3u8[\w./:%?=&+-]*/g).join('\n         ') || 'no'}`);
    console.log(`  mp4    ${todas(h, /[\w./:%?=&+-]+\.mp4[\w./:%?=&+-]*/g).join('\n         ') || 'no'}`);
    console.log(`  packer ${/eval\(function\(p,a,c,k,e/.test(h)}`);
    console.log(`  hosts  ${todas(h, /https?:\/\/[\w.-]+/g, 10).join(' | ')}`);
    console.log(`  cuerpo ${h.slice(0, 700).replace(/\s+/g, ' ')}`);
  }
})();
