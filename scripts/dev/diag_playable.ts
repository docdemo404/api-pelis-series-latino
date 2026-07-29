import 'dotenv/config';
import axios from 'axios';
import * as fs from 'fs';

/**
 * ¿REPRODUCE DE VERDAD? — la prueba que faltaba.
 *
 * Todas las sondas del proyecto se quedaban en el primer escalón: pedían `direct_stream`, veían
 * un 200 o un 302 y lo daban por bueno. Eso NO demuestra nada, y ha costado dos fallos en
 * producción: un maestro puede descargarse perfectamente y listar calidades en dominios que ya no
 * existen, y un dominio muerto puede resolver a una página de aparcamiento que responde 200.
 *
 * Aquí se baja hasta el final —maestro → variante → SEGMENTO— y se comprueba que lo que llega son
 * bytes de vídeo. Es la única prueba que no se puede falsear.
 *
 * Además se mira lo que solo le importa a un navegador: que todo lo que tenga que pedir POR SU
 * CUENTA traiga `Access-Control-Allow-Origin`. Un segmento que se descarga con curl pero no trae
 * CORS es un vídeo que no se ve en la web.
 *
 *   npx ts-node scripts/dev/diag_playable.ts muestras.txt
 *   npx ts-node scripts/dev/diag_playable.ts muestras.txt https://api-pelis-series-latino.vercel.app
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const PAGINA = 'https://mi-app.example';

/** Peticiones a NUESTRA API: salen de la página del reproductor, con su Referer y su Origin. */
const A_LA_API = { 'User-Agent': UA, Referer: `${PAGINA}/`, Origin: PAGINA };
/** Tras seguir nuestro 302 el navegador NO manda Referer (`Referrer-Policy: no-referrer`). */
const AL_CDN_TRAS_302 = { 'User-Agent': UA, Origin: PAGINA };
/** Lo que el manifiesto deja apuntando al CDN lo pide la página, con su propio Referer. */
const AL_CDN = { 'User-Agent': UA, Referer: `${PAGINA}/`, Origin: PAGINA };

interface Resultado {
  reproduce: boolean;
  motivo: string;
}

const get = (url: string, headers: Record<string, string>, binario = false) =>
  axios.get(url, {
    // `Range` en las descargas binarias: sin él, comprobar un mp4 se traga la película entera y
    // la sonda se queda colgada. Con 256 KB sobra para ver si son bytes de vídeo de verdad.
    headers: binario ? { ...headers, Range: 'bytes=0-262143' } : headers,
    timeout: 20000,
    maxContentLength: 2 * 1024 * 1024,
    validateStatus: () => true,
    maxRedirects: 0,
    responseType: binario ? 'arraybuffer' : 'text',
    transformResponse: [(d: unknown) => d],
  });

/** ¿Son bytes de vídeo? Un HTML de error también viaja con 200 y con Content-Length. */
function esVideo(buf: Buffer): boolean {
  if (buf.length < 64) return false;
  const cabecera = buf.slice(0, 400).toString('latin1');
  if (/^\s*<(!doctype|html|\?xml)/i.test(cabecera)) return false;
  // MPEG-TS empieza por 0x47; fMP4 trae `ftyp`/`moof`/`styp` en los primeros bytes.
  if (buf[0] === 0x47) return true;
  return /ftyp|moof|styp|mdat/.test(cabecera);
}

async function comprobar(api: string, embed: string): Promise<Resultado> {
  const e = Buffer.from(embed, 'utf8').toString('base64url');
  let r;
  try {
    r = await get(`${api}/api/v1/stream/direct?e=${e}`, A_LA_API);
  } catch (err: any) {
    return { reproduce: false, motivo: `API no responde (${err.code || err.message})` };
  }

  // Un 502 es una respuesta CORRECTA: la API avisa y el cliente cae al embed u otro servidor.
  if (r.status >= 400) return { reproduce: false, motivo: `avisa con ${r.status}` };

  let cuerpo: string;
  let base: string;
  let cabeceras = A_LA_API;

  if (r.status === 302) {
    const destino = String(r.headers.location || '');
    if (!destino) return { reproduce: false, motivo: '302 sin destino' };
    const cdn = await get(destino, AL_CDN_TRAS_302);
    if (cdn.status >= 400) return { reproduce: false, motivo: `302 -> CDN ${cdn.status}` };
    if (cdn.headers['access-control-allow-origin'] === undefined) {
      return { reproduce: false, motivo: `302 -> sin CORS en ${new URL(destino).hostname}` };
    }
    cuerpo = String(cdn.data);
    base = destino;
    cabeceras = AL_CDN;
    // Un mp4 servido directo: si son bytes de vídeo, ya está.
    if (!cuerpo.trimStart().startsWith('#EXTM3U')) {
      const bin = await get(destino, AL_CDN_TRAS_302, true);
      return esVideo(Buffer.from(bin.data as any))
        ? { reproduce: true, motivo: `302 mp4 ${new URL(destino).hostname}` }
        : { reproduce: false, motivo: '302 -> no son bytes de vídeo' };
    }
  } else {
    cuerpo = String(r.data);
    base = `${api}/api/v1/stream/direct?e=${e}`;
    if (!cuerpo.trimStart().startsWith('#EXTM3U')) {
      const bin = await get(base, A_LA_API, true);
      return esVideo(Buffer.from(bin.data as any))
        ? { reproduce: true, motivo: 'proxy de bytes' }
        : { reproduce: false, motivo: 'la API devolvió algo que no es vídeo' };
    }
  }

  // Bajar por las playlists hasta dar con un segmento.
  for (let nivel = 0; nivel < 3; nivel++) {
    const lineas = cuerpo.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (!lineas.length) return { reproduce: false, motivo: `manifiesto vacío (nivel ${nivel})` };

    const siguiente = lineas[0];
    const absoluta = siguiente.startsWith('/') ? api + siguiente : new URL(siguiente, base).toString();
    const propia = absoluta.startsWith(api);
    const h = propia ? A_LA_API : cabeceras;

    // ¿Es otra playlist o ya un segmento? Cuando la URI viene envuelta por nuestra API, lo que
    // manda es la URL REAL que viaja dentro de `?u=`, no la ruta del envoltorio.
    const esPlaylist = (() => {
      try {
        const envuelta = new URL(absoluta).searchParams.get('u');
        const real = envuelta ? Buffer.from(envuelta, 'base64url').toString('utf8') : absoluta;
        return /\.m3u8(\?|$)/i.test(real);
      } catch {
        return /\.m3u8(\?|$)/i.test(absoluta);
      }
    })();
    if (esPlaylist) {
      const sig = await get(absoluta, h);
      if (sig.status >= 400) return { reproduce: false, motivo: `variante ${sig.status}` };
      if (!propia && sig.headers['access-control-allow-origin'] === undefined) {
        return { reproduce: false, motivo: `variante sin CORS en ${new URL(absoluta).hostname}` };
      }
      const texto = String(sig.data);
      if (!texto.trimStart().startsWith('#EXTM3U')) {
        return { reproduce: false, motivo: `variante no es playlist (${new URL(absoluta).hostname})` };
      }
      cuerpo = texto;
      base = absoluta;
      continue;
    }

    // Segmento: la prueba de fuego.
    const seg = await get(absoluta, h, true);
    if (seg.status >= 400) return { reproduce: false, motivo: `segmento ${seg.status}` };
    if (!propia && seg.headers['access-control-allow-origin'] === undefined) {
      return { reproduce: false, motivo: `segmento sin CORS en ${new URL(absoluta).hostname}` };
    }
    const buf = Buffer.from(seg.data as any);
    return esVideo(buf)
      ? { reproduce: true, motivo: `${(buf.length / 1024).toFixed(0)} KB de vídeo` }
      : { reproduce: false, motivo: 'el segmento no son bytes de vídeo' };
  }

  return { reproduce: false, motivo: 'demasiados niveles de manifiesto' };
}

async function main() {
  const fichero = process.argv[2];
  const api = (process.argv[3] || 'http://localhost:3000').replace(/\/$/, '');
  const filas = fs.readFileSync(fichero, 'utf8').trim().split('\n')
    .map(l => l.split('\t')).filter(p => p.length === 2);

  const stat = new Map<string, { ok: number; avisa: number; miente: number; total: number }>();

  for (const [familia, embed] of filas) {
    // Cualquier tropiezo de red al bajar por la cadena es un dato, no un motivo para abortar la
    // medición entera: se anota y se sigue con la siguiente ficha.
    let res: Resultado;
    try {
      res = await comprobar(api, embed);
    } catch (err: any) {
      res = { reproduce: false, motivo: `fallo al comprobar (${err.code || err.message})`.slice(0, 50) };
    }
    const s = stat.get(familia) || { ok: 0, avisa: 0, miente: 0, total: 0 };
    s.total++;
    if (res.reproduce) s.ok++;
    else if (/^avisa con/.test(res.motivo)) s.avisa++;
    else s.miente++;
    stat.set(familia, s);
    const etiqueta = res.reproduce ? 'OK    ' : /^avisa con/.test(res.motivo) ? 'AVISA ' : 'MIENTE';
    console.log(`${etiqueta} ${familia.padEnd(12)} ${res.motivo.slice(0, 52).padEnd(52)} ${embed.slice(0, 40)}`);
  }

  console.log('\n=== RESUMEN ===');
  console.log('  familia        reproduce   avisa (502)   MIENTE (dice OK y no va)   total');
  let miente = 0, total = 0;
  for (const [f, s] of stat) {
    miente += s.miente; total += s.total;
    console.log(`  ${f.padEnd(14)} ${String(s.ok).padStart(6)} ${String(s.avisa).padStart(13)} ${String(s.miente).padStart(21)} ${String(s.total).padStart(11)}`);
  }
  console.log(`\n  MIENTE en ${miente}/${total} (${(miente / total * 100).toFixed(0)}%) — es lo que hay que llevar a cero.`);
}

main().then(() => process.exit(0));
