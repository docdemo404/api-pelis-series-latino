import { servirConCache } from './cacheDeTrozos.js';
/**
 * ───────────────────────────────────────────────────────────────────────────────────────────
 * PROXY DE VÍDEO EN CLOUDFLARE — el que quita el techo de ancho de banda.
 *
 * POR QUÉ EXISTE, con los números medidos (2026-07-29):
 *
 * De 28 744 reproducciones posibles del catálogo, el 75,6% se sirve con un 302 y el 21,4% con
 * unos KB de playlist: esas no cuestan tránsito y no pasan por aquí. El problema son las 797
 * (3,0%) cuyo único servidor con vídeo directo obliga a reenviar bytes: a ~3,2 GB por película,
 * bastan 30 reproducciones para agotar el plan Hobby de Vercel.
 *
 * POR QUÉ ESTO NO ES UN PROXY TONTO, que fue mi primera idea y era incorrecta: 793 de esas 797
 * están atadas POR IP (vidhideplus 772, ok.ru 26). Medido — la misma URL da 200 desde la máquina
 * que la acuñó y 403 desde cualquier otra. Un proxy que se limitara a reenviar una URL acuñada en
 * Vercel recibiría 403 en todas ellas, o sea que no habría servido para nada.
 *
 * De ahí el diseño: este Worker ACUÑA Y SIRVE. Pide el embed, saca la URL del vídeo y la descarga
 * él mismo, así que el CDN ve una sola IP —la suya— en las dos operaciones. Y cuando un segmento
 * da 403 porque la invocación salió por otra IP, vuelve a acuñar y trasplanta la firma nueva a la
 * misma ruta, que es lo que ya hacía la API.
 *
 * Cloudflare no cobra egreso, así que el vídeo deja de consumir plan.
 *
 * ⚠️ PROBADO EN PRODUCCIÓN (2026-07-30) Y NO FUNCIONA CON LOS HOSTS QUE MÁS IMPORTAN.
 *
 * Se desplegó, se enchufó y TODA reproducción delegada respondió 502: el CDN devuelve 403 después
 * de acuñar. La premisa de arriba —"este Worker acuña y sirve, así que el CDN ve una sola IP"— NO
 * se cumple en Cloudflare: acuñar y descargar son dos subpeticiones y pueden salir por IP
 * distinta, y estos CDN atan la firma a la IP que acuñó. Se añadió el reintento con re-acuñado que
 * ya tenían los segmentos y siguió dando 403.
 *
 * Comprobado que no era el vídeo: el mismo embed, acuñado y descargado desde una sola máquina,
 * devuelve 200. Y son justo los hosts que dominan el modo proxy — vidhideplus 772 de 797.
 *
 * Así que la delegación está APAGADA (sin `VIDEO_PROXY_URL`/`VIDEO_PROXY_KEY` en Vercel) y el
 * modo proxy vuelve a servirse desde la función, que sí mantiene la misma IP en las dos
 * operaciones. Este Worker queda aquí porque sirve para cualquier host que NO ate por IP; antes
 * de volver a enchufarlo hay que comprobar host por host, no en bloque.
 * ───────────────────────────────────────────────────────────────────────────────────────────
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Cabeceras que hacen que un navegador pueda leer esto. Sin ellas, el vídeo no se ve en web. */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Range,Content-Length,Accept-Ranges',
};

function b64urlDecode(value) {
  const norm = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  return decodeURIComponent(
    atob(pad)
      .split('')
      .map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * Firma que demuestra que la petición la fabricó NUESTRA API.
 *
 * Sin esto el Worker sería un proxy abierto: cualquiera podría pasarle una URL y descargar lo que
 * quisiera a través de él. Y eso no es una preocupación abstracta aquí — es exactamente el
 * recurso que estamos intentando no agotar.
 */
async function firmaValida(secreto, dato, firma) {
  if (!secreto) return true; // sin secreto configurado no se exige nada (desarrollo)
  if (!firma) return false;
  const clave = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secreto),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', clave, new TextEncoder().encode(dato));
  const esperada = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  // Comparación de tiempo constante: dos cadenas del mismo largo no revelan dónde difieren.
  if (esperada.length !== firma.length) return false;
  let diff = 0;
  for (let i = 0; i < esperada.length; i++) diff |= esperada.charCodeAt(i) ^ firma.charCodeAt(i);
  return diff === 0;
}

/** Desempaqueta el ofuscador P.A.C.K.E.R., que es donde vidhide esconde su `sources:[{file:…}]`. */
function unpackPacker(html) {
  const match = html.match(/\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)/s);
  if (!match) return null;
  let payload = match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  const radix = parseInt(match[2], 10);
  const count = parseInt(match[3], 10);
  const words = match[4].split('|');
  if (!Number.isFinite(radix) || !Number.isFinite(count)) return null;
  const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const toBase = n => {
    if (n === 0) return '0';
    let out = '';
    for (let x = n; x > 0; x = Math.floor(x / radix)) out = ALPHABET[x % radix] + out;
    return out;
  };
  for (let i = count - 1; i >= 0; i--) {
    if (!words[i]) continue;
    payload = payload.replace(new RegExp(`\\b${toBase(i)}\\b`, 'g'), words[i]);
  }
  return payload;
}

function extraerDeTexto(texto) {
  if (!texto) return null;
  const file = texto.match(/["']?file["']?\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i);
  if (file) return file[1].replace(/\\\//g, '/');
  const urls = texto.match(/https?:(?:\\\/\\\/|\/\/)[^\s"'<>\\)]+/g) || [];
  const norm = urls.map(u => u.replace(/\\\//g, '/'));
  return norm.find(u => /\.m3u8(\?|$)/i.test(u)) || norm.find(u => /\.mp4(\?|$)/i.test(u)) || null;
}

/**
 * Acuña la URL real del vídeo DESDE AQUÍ. Es el punto entero del Worker: el CDN tiene que ver la
 * misma IP acuñando y descargando.
 */
async function acunar(embedUrl) {
  const origin = new URL(embedUrl).origin;
  const res = await fetch(embedUrl, {
    headers: { 'User-Agent': UA, Referer: `${origin}/` },
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const url = extraerDeTexto(unpackPacker(html) || '') || extraerDeTexto(html);
  return url ? { url, referer: `${origin}/` } : null;
}

/** Reescribe el manifiesto para que TODO lo que referencia vuelva a pasar por este Worker. */
function reescribir(manifiesto, base, embedParam, firma, origenWorker) {
  const through = abs =>
    `${origenWorker}/seg?u=${btoa(abs).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}` +
    `&e=${embedParam}&s=${firma}`;
  return manifiesto
    .split(/\r?\n/)
    .map(linea => {
      const t = linea.trim();
      if (!t) return linea;
      if (t.startsWith('#')) {
        return linea.replace(/URI="([^"]+)"/g, (_f, uri) => {
          try {
            return `URI="${through(new URL(uri, base).toString())}"`;
          } catch {
            return _f;
          }
        });
      }
      try {
        return through(new URL(t, base).toString());
      } catch {
        return linea;
      }
    })
    .join('\n');
}

/** Trasplanta una firma recién acuñada a una URL que acaba de dar 403. */
async function refrescar(objetivo, embedUrl) {
  const fresco = await acunar(embedUrl);
  if (!fresco) return null;
  try {
    const q = new URL(fresco.url).search;
    if (!q) return null;
    const u = new URL(objetivo);
    u.search = q;
    return u.toString();
  } catch {
    return null;
  }
}

function respuestaVideo(upstream) {
  const h = new Headers(CORS);
  for (const k of ['content-range', 'content-length', 'content-type', 'accept-ranges']) {
    const v = upstream.headers.get(k);
    if (v) h.set(k, v);
  }
  if (!h.has('accept-ranges')) h.set('Accept-Ranges', 'bytes');
  return new Response(upstream.body, { status: upstream.status, headers: h });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origenWorker = url.origin;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { ...CORS, 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Allow-Methods': 'GET,OPTIONS' },
      });
    }

    const embedParam = url.searchParams.get('e') || '';
    const firma = url.searchParams.get('s') || '';
    const secreto = env.PROXY_SIGNING_KEY;

    if (!(await firmaValida(secreto, embedParam, firma))) {
      return new Response('firma no válida', { status: 403, headers: CORS });
    }

    let embedUrl;
    try {
      embedUrl = b64urlDecode(embedParam);
      if (!/^https?:\/\//i.test(embedUrl)) throw new Error('embed no válido');
    } catch {
      return new Response('parámetro ?e= no válido', { status: 400, headers: CORS });
    }

    /**
     * ── Fichero permanente, con caché por trozos en R2 ───────────────────────────────────
     *
     * Es la ruta de todo lo que el catálogo publica como url directa: mp4 planos servidos por
     * archive.org, el CDN de Rumble, eintim y demás. Lo que hace y por qué está en
     * cacheDeTrozos.js — resumen: unifica hosts que fallan por motivos distintos, y de paso los
     * hace rápidos.
     *
     * Comparte la firma con el resto del Worker: sin ella esto sería un proxy abierto que
     * cualquiera podría usar para servir lo que quisiera a nuestra costa.
     */
    if (url.pathname === '/v') {
      return servirConCache(request, env, ctx, embedUrl);
    }

    // ── Segmento o variante: la URL real viaja en ?u= ────────────────────────────────────
    if (url.pathname === '/seg') {
      let objetivo;
      try {
        objetivo = b64urlDecode(url.searchParams.get('u') || '');
      } catch {
        return new Response('parámetro ?u= no válido', { status: 400, headers: CORS });
      }
      const referer = new URL(embedUrl).origin + '/';
      const rango = request.headers.get('Range');
      const pedir = destino =>
        fetch(destino, {
          headers: { 'User-Agent': UA, Referer: referer, ...(rango ? { Range: rango } : {}) },
          // El segmento se cachea en el borde: la URL firmada identifica el contenido, así que dos
          // espectadores de lo mismo comparten respuesta y rebobinar no vuelve a tocar el CDN.
          cf: rango ? { cacheTtl: 0 } : { cacheEverything: true, cacheTtl: 86400 },
        });

      let upstream = await pedir(objetivo);

      // 403/410 = la firma caducó o esta invocación salió por otra IP. Se vuelve a acuñar.
      if ((upstream.status === 403 || upstream.status === 410)) {
        const refrescado = await refrescar(objetivo, embedUrl);
        if (refrescado) upstream = await pedir(refrescado);
      }

      if (upstream.status >= 400) {
        return new Response('el CDN rechazó el segmento', { status: 502, headers: CORS });
      }

      // Si resulta que era otra playlist, hay que reescribirla: sus hijos también vienen por aquí.
      const tipo = upstream.headers.get('content-type') || '';
      if (/mpegurl|vnd\.apple/i.test(tipo)) {
        const cuerpo = reescribir(await upstream.text(), objetivo, embedParam, firma, origenWorker);
        return new Response(cuerpo, {
          headers: { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' },
        });
      }
      return respuestaVideo(upstream);
    }

    // ── Entrada: acuñar el vídeo y servirlo ──────────────────────────────────────────────
    const acunado = await acunar(embedUrl);
    if (!acunado) {
      return new Response('no se pudo extraer el vídeo de este embed', { status: 502, headers: CORS });
    }

    const pedirEntrada = destino =>
      fetch(destino, {
        headers: {
          'User-Agent': UA,
          Referer: acunado.referer,
          ...(request.headers.get('Range') ? { Range: request.headers.get('Range') } : {}),
        },
        cf: { cacheTtl: 0 },
      });

    let upstream = await pedirEntrada(acunado.url);

    /**
     * REINTENTO EN LA ENTRADA, que faltaba.
     *
     * Los segmentos ya lo hacían y la entrada no, y es el MISMO problema: estos CDN atan la URL
     * firmada a la IP que la acuñó, y en Cloudflare acuñar y descargar son dos subpeticiones que
     * pueden salir por IP distinta. Sin este reintento el Worker acuñaba bien y acto seguido se
     * comía un 403 del CDN, así que TODA reproducción delegada respondía 502 — medido en cuanto se
     * enchufó. Se vuelve a acuñar y se trasplanta la firma nueva a la misma ruta.
     */
    if (upstream.status === 403 || upstream.status === 410) {
      const refrescado = await refrescar(acunado.url, embedUrl);
      if (refrescado) upstream = await pedirEntrada(refrescado);
    }

    if (upstream.status >= 400) {
      return new Response(`el CDN rechazó la petición (${upstream.status})`, { status: 502, headers: CORS });
    }

    const tipo = upstream.headers.get('content-type') || '';
    if (/mpegurl|vnd\.apple/i.test(tipo) || /\.m3u8(\?|$)/i.test(acunado.url)) {
      const cuerpo = reescribir(await upstream.text(), acunado.url, embedParam, firma, origenWorker);
      return new Response(cuerpo, {
        headers: { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' },
      });
    }
    return respuestaVideo(upstream);
  },
};
