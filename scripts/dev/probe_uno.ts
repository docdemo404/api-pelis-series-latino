/**
 * Descarga UN embed y enseña lo que interesa. Herramienta de mano para escribir extractores.
 *
 *   npx ts-node --transpile-only scripts/dev/probe_uno.ts <url> [--todo] [--buscar=regex]
 */
import 'dotenv/config';
import { httpGetHtml, USER_AGENT } from '../../src/utils/httpClient';

const url = process.argv[2];
const arg = (n: string, d = '') => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const TODO = process.argv.includes('--todo');
const BUSCAR = arg('buscar');
const REFERER = arg('referer', 'https://tioplus.app/');

(async () => {
  const res = await httpGetHtml(url, {
    headers: { Referer: REFERER, 'User-Agent': USER_AGENT },
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d: unknown) => d],
  });
  const html = String(res.data || '');
  console.log(`HTTP ${res.status} · ${html.length}B · final=${res.request?.res?.responseUrl || url}`);
  console.log(`content-type: ${res.headers['content-type']}`);

  if (TODO) {
    console.log('\n───── cuerpo completo\n');
    console.log(html);
    return;
  }
  if (BUSCAR) {
    const re = new RegExp(`.{0,200}(?:${BUSCAR}).{0,300}`, 'gi');
    const hits = html.match(re) || [];
    console.log(`\n───── ${hits.length} coincidencias de /${BUSCAR}/\n`);
    for (const h of hits.slice(0, 10)) console.log(`· ${h}\n`);
    return;
  }
  console.log(`\n───── primeros 3000 caracteres\n`);
  console.log(html.slice(0, 3000));
})();
