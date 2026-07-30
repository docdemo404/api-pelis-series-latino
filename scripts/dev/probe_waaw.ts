/**
 * ¿El muro de waaw.to es real o solo aparatoso? Se prueba, no se supone.
 *
 * Recorre su cadena completa —/f/<id> → iframe /e/<b64> → POST /player/get_md5.php— con los
 * parámetros que SÍ se pueden leer de la página, y enseña qué contesta el servidor cuando faltan
 * los que no se pueden obtener sin falsificar interacción humana (adscore, click_hash, clickx/y).
 *
 *   npx ts-node --transpile-only scripts/dev/probe_waaw.ts <url /f/>
 */
import 'dotenv/config';
import { httpGetHtml, httpClient, USER_AGENT } from '../../src/utils/httpClient';

const entrada = process.argv[2] || 'https://waaw.to/f/4zQ9cWZ4QCBA';

async function get(url: string, referer: string) {
  const res = await httpGetHtml(url, {
    headers: { Referer: referer, 'User-Agent': USER_AGENT },
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d: unknown) => d],
  });
  return { status: res.status, html: String(res.data || ''), final: res.request?.res?.responseUrl || url };
}

(async () => {
  const paso1 = await get(entrada, 'https://tioplus.app/');
  console.log(`1) ${entrada} → HTTP ${paso1.status} · ${paso1.html.length}B`);

  const watch = paso1.html.match(/watch_video\.php\?v=[^"'\s]+/);
  let pagina = paso1;
  if (watch) {
    const url = new URL(watch[0], 'https://waaw.to').toString();
    pagina = await get(url, entrada);
    console.log(`2) watch_video.php → HTTP ${pagina.status} · ${pagina.html.length}B`);
  }

  const marco = pagina.html.match(/https?:\/\/[^"'\s]*\/e\/[^"'\s]+/) || pagina.html.match(/\/e\/[A-Za-z0-9=+/]+[^"'\s]*/);
  if (!marco) {
    console.log('   no se encontró el iframe /e/ — fin');
    return;
  }
  const marcoUrl = new URL(marco[0].replace(/&amp;/g, '&'), 'https://waaw.to').toString();
  const player = await get(marcoUrl, pagina.final);
  console.log(`3) iframe ${marcoUrl.slice(0, 80)} → HTTP ${player.status} · ${player.html.length}B`);

  // Lo que la página nos da gratis.
  const leer = (nombre: string) => {
    const m = player.html.match(new RegExp(`(?:var|let)\\s+${nombre}\\s*=\\s*['"]([^'"]*)['"]`));
    return m ? m[1] : '';
  };
  const campos = {
    htoken: leer('htoken'),
    sh: leer('shh') || leer('sh'),
    secure: leer('secure'),
    v: leer('videokeyorig') || leer('videokey'),
    token: leer('token'),
    gt: leer('gtr') || leer('gt'),
    embed_from: leer('embedfrm') || leer('embed_from'),
  };
  console.log('4) parámetros legibles en la página:');
  for (const [k, v] of Object.entries(campos)) console.log(`     ${k.padEnd(11)} ${v ? `"${v.slice(0, 40)}"` : '— ausente'}`);

  // Y ahora el POST, con lo que hay y SIN falsificar señales de interacción.
  const cuerpo = {
    ...campos,
    ver: '4',
    adb: '0',
    wasmcheck: '0',
    adscore: '',
    click_hash: '',
    clickx: '0',
    clicky: '0',
  };
  const res = await httpClient.post('https://waaw.to/player/get_md5.php', JSON.stringify(cuerpo), {
    headers: {
      'Content-Type': 'application/json',
      Referer: marcoUrl,
      'User-Agent': USER_AGENT,
      'X-Requested-With': 'XMLHttpRequest',
    },
    timeout: 20000,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d: unknown) => d],
  });
  console.log(`5) POST /player/get_md5.php → HTTP ${res.status}`);
  console.log(`   respuesta: ${String(res.data || '').slice(0, 400)}`);
})();
