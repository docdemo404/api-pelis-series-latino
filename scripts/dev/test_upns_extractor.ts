/**
 * Prueba de extremo a extremo del extractor de upns contra un servidor local que emula
 * `/api/v1/video` con el MISMO cifrado y la MISMA forma de payload que el host real.
 *
 * Existe porque ahora mismo ningún vídeo de la familia upns sirve streams (su API contesta
 * 200 sin ningún campo de vídeo), así que no hay forma de comprobar el camino bueno contra
 * el sitio de verdad.
 */
import http from 'http';
import crypto from 'crypto';
import dns from 'dns';

// El extractor solo entra por `hostDiferido` si el hostname contiene 'upns.', así que la prueba
// necesita ese nombre apuntando al servidor local. Se resuelve solo dentro de este proceso.
const lookupReal = dns.lookup.bind(dns);
(dns as any).lookup = (host: string, opts: any, cb: any) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (String(host).endsWith('upns.test')) {
    // `net` pide `all: true` y entonces espera un ARRAY; con la forma escalar da
    // ERR_INVALID_IP_ADDRESS antes de abrir el socket.
    return opts && opts.all
      ? cb(null, [{ address: '127.0.0.1', family: 4 }])
      : cb(null, '127.0.0.1', 4);
  }
  return lookupReal(host, opts, cb);
};

import { extractDirect } from '../../src/scrapers/directStream';

const KEY = Buffer.from('kiemtienmua911ca', 'utf8');
const IV = Buffer.from('1234567890oiuytr', 'utf8');

function cifrar(obj: any): string {
  const c = crypto.createCipheriv('aes-128-cbc', KEY, IV);
  return Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]).toString('hex');
}

const CASOS: Array<{ nombre: string; payload: any; espera: string | null }> = [
  {
    nombre: 'order respetado: Tiktok antes que In-House',
    payload: {
      streamingConfig: JSON.stringify({ order: ['Tiktok', 'In-House'], adjust: {} }),
      hlsVideoTiktok: 'https://tt.example.com/a/master.m3u8',
      source: 'https://inhouse.example.com/b/master.m3u8',
    },
    espera: 'https://tt.example.com/a/master.m3u8',
  },
  {
    nombre: 'CDN disabled se salta y cae al siguiente',
    payload: {
      streamingConfig: JSON.stringify({ order: ['Tiktok', 'In-House'], adjust: { Tiktok: { disabled: true } } }),
      hlsVideoTiktok: 'https://tt.example.com/a/master.m3u8',
      source: 'https://inhouse.example.com/b/master.m3u8',
    },
    espera: 'https://inhouse.example.com/b/master.m3u8',
  },
  {
    nombre: 'params de adjust se escriben en la query',
    payload: {
      streamingConfig: JSON.stringify({ order: ['Tiktok'], adjust: { Tiktok: { params: { v: '1766826492' } } } }),
      hlsVideoTiktok: 'https://tt.example.com/a/master.m3u8',
    },
    espera: 'https://tt.example.com/a/master.m3u8?v=1766826492',
  },
  {
    nombre: '/hls/ se desvía a /hlsmod/<domain>/',
    payload: {
      streamingConfig: JSON.stringify({
        order: ['Tiktok'],
        adjust: { Tiktok: { domain: 'p16-ad-site-sign-sg.tiktokcdn.com' } },
      }),
      hlsVideoTiktok: 'https://tt.example.com/hls/x/master.m3u8',
    },
    espera: 'https://tt.example.com/hlsmod/p16-ad-site-sign-sg.tiktokcdn.com/x/master.m3u8',
  },
  {
    nombre: 'pk firma las rutas /v4/',
    payload: {
      streamingConfig: JSON.stringify({ order: ['In-House'], adjust: {} }),
      source: 'https://inhouse.example.com/v4/abc/master.m3u8',
      pk: { k: 'TOKEN123', kx: 1786940724 },
    },
    espera: 'https://inhouse.example.com/v4/abc/master.m3u8?k=TOKEN123&kx=1786940724',
  },
  {
    nombre: 'pk NO firma lo que no pasa por /v4/',
    payload: {
      streamingConfig: JSON.stringify({ order: ['In-House'], adjust: {} }),
      source: 'https://inhouse.example.com/otra/master.m3u8',
      pk: { k: 'TOKEN123', kx: 1786940724 },
    },
    espera: 'https://inhouse.example.com/otra/master.m3u8',
  },
  {
    nombre: 'cf (Cloudflare) gana a cfNative',
    payload: {
      streamingConfig: JSON.stringify({ order: ['Cloudflare'], adjust: {} }),
      cf: 'https://cf.example.com/bueno/master.m3u8',
      cfNative: 'https://cf.example.com/safari/master.m3u8',
    },
    espera: 'https://cf.example.com/bueno/master.m3u8',
  },
  {
    nombre: 'vídeo no listo: 200 con payload y SIN campos de stream → null',
    payload: {
      title: 'tt7461200.mp4',
      player: { allowDownload: true },
      streamingConfig: JSON.stringify({ order: ['Tiktok', 'Google', 'Cloudflare', 'In-House'], adjust: {} }),
      pk: { k: 'CmEyTF', kx: 1786941144 },
    },
    espera: null,
  },
  {
    nombre: 'sin streamingConfig usa el orden por defecto (Cloudflare, In-House)',
    payload: { cf: 'https://cf.example.com/x/master.m3u8', source: 'https://in.example.com/y/master.m3u8' },
    espera: 'https://cf.example.com/x/master.m3u8',
  },
];

(async () => {
  let caso = 0;
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/api/v1/video')) { res.statusCode = 404; return res.end('{}'); }
    res.setHeader('content-type', 'application/octet-stream');
    res.end(cifrar(CASOS[caso].payload));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;

  // `hostDiferido` mira que el hostname contenga 'upns.', y `upns.localhost` resuelve a 127.0.0.1.
  const base = `http://pelisplus.upns.test:${port}`;

  let ok = 0, mal = 0;
  for (caso = 0; caso < CASOS.length; caso++) {
    const c = CASOS[caso];
    const got = await extractDirect(`${base}/#vid${caso}`, '', { allowNetwork: true });
    const url = got?.url ?? null;
    const bien = url === c.espera;
    bien ? ok++ : mal++;
    console.log(`${bien ? 'OK  ' : 'MAL '} ${c.nombre}`);
    if (!bien) console.log(`       esperaba: ${c.espera}\n       obtuvo  : ${url}`);
  }
  server.close();
  console.log(`\n${ok} correctos · ${mal} fallidos`);
  process.exit(mal ? 1 : 0);
})();
