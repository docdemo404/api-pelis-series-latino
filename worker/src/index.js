import { servirConCache, calentarIndice, llenarSecuencial, escribirTrozo } from './cacheDeTrozos.js';
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
 * EL SALTO DE VIDEOAPI, que aquí hay que repetir aunque ya esté en la API.
 *
 * `videoapi.la` (y su piel `videoapp.zip`) no llevan vídeo propio: su HTML trae el reproductor
 * real escrito en un `<iframe>` que apunta a `vimeos.net`. Sin dar ese salto, `extraerDeTexto` no
 * encuentra nada y el Worker contesta «no se pudo extraer el vídeo de este embed» — que es
 * exactamente lo que devolvía para las 7.200 fichas importadas de esa fuente.
 *
 * SÍ, ESTO ES UNA COPIA de `extraerVideoapi` (src/scrapers/directStream.ts), y este repositorio
 * tiene escrito en varios sitios que lo que se copia se desincroniza. No hay alternativa: el
 * Worker corre en Cloudflare, en otro runtime, y no puede importar el TypeScript de la API. Lo que
 * sí se puede es dejar dicho dónde está el gemelo — si se toca uno, se toca el otro.
 *
 * Y SE LE QUITA EL `cf=`, que es la parte que no se adivina: con ese token puesto, vimeos devuelve
 * una cáscara de 901 bytes que espera a un navegador de verdad; pedida a secas devuelve el
 * reproductor entero con su `eval(function(p,a,c,k,e,d))` y el m3u8 dentro. Medido en tres
 * títulos: con `cf` → nada; sin `cf` → HLS en los tres.
 */
function saltoDeVideoapi(embedUrl, html) {
  if (!/(?:videoapi\.la|videoapp\.zip)\/e\//i.test(embedUrl)) return null;
  const m = html.match(/<iframe[^>]+src=["'](https:\/\/[^"']*vimeos\.[a-z]+\/[^"']+)["']/i);
  return m ? m[1].replace(/&amp;/g, '&').split('?')[0] : null;
}

/**
 * Acuña la URL real del vídeo DESDE AQUÍ. Es el punto entero del Worker: el CDN tiene que ver la
 * misma IP acuñando y descargando.
 */
/**
 * EL SALTO DE VIDEOAPI SE RECUERDA. La página de videoapi.la tarda 3,3 s (medido el 2026-09-16) y
 * lo único que aporta es la url del reproductor de vimeos, que es fija por título: el slug
 * `embed-524lenj4bdra.html` es el id del fichero y no cambia. Se guarda en R2 siete días, y a
 * partir de la primera reproducción cada arranque se ahorra ese viaje. El token que sí caduca se
 * acuña en el paso siguiente, que no se cachea.
 */
const SALTO_EN_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

async function saltoRecordado(env, embedUrl) {
  if (!env?.CACHE) return null;
  const obj = await env.CACHE.get(`salto/${embedUrl}`).catch(() => null);
  if (!obj) return null;
  if (Number(obj.customMetadata?.hasta) < Date.now()) return null;
  return obj.text();
}

function recordarSalto(env, embedUrl, dentro) {
  if (!env?.CACHE) return;
  env.CACHE.put(`salto/${embedUrl}`, dentro, {
    customMetadata: { hasta: String(Date.now() + SALTO_EN_CACHE_MS) },
  }).catch(() => {});
}

async function acunar(embedUrl, saltos = 1, env = null) {
  const origin = new URL(embedUrl).origin;

  if (saltos > 0 && /(?:videoapi\.la|videoapp\.zip)\/e\//i.test(embedUrl)) {
    const recordado = await saltoRecordado(env, embedUrl);
    if (recordado) return acunar(recordado, saltos - 1, env);
  }

  const res = await fetch(embedUrl, {
    headers: { 'User-Agent': UA, Referer: `${origin}/` },
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) return null;
  const html = await res.text();

  // Un agregador no tiene vídeo propio: se sigue a su reproductor real. UN salto, igual que el
  // `SALTOS_MAXIMOS` de la API — basta para todo lo medido y evita que una cadena de redirectores
  // convierta una reproducción en una ráfaga de peticiones.
  if (saltos > 0) {
    const dentro = saltoDeVideoapi(embedUrl, html);
    if (dentro) {
      recordarSalto(env, embedUrl, dentro);
      return acunar(dentro, saltos - 1, env);
    }
  }

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
async function refrescar(objetivo, embedUrl, env = null) {
  const fresco = await acunar(embedUrl, 1, env);
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

/**
 * PRECALENTAR: lo que el reproductor va a pedir dentro de un segundo, pedido AHORA.
 *
 * Medido desde Bolivia el 2026-09-16, con una película de VideoAPI: el maestro tarda 2–3 s (tres
 * viajes al origen: embed, reproductor, m3u8), la playlist de la variante 2 s, la de audio otros
 * 2 s, y el primer segmento 1,2 s. El reproductor los pide EN FILA, porque no sabe el siguiente
 * hasta leer el anterior, así que el primer fotograma llegaba a los 8–10 s. Y la caché del borde
 * no ayudaba: cada apertura acuña un token nuevo, la URL cambia y no hay dos peticiones iguales.
 *
 * Aquí, mientras se le entrega el maestro, el Worker sigue trabajando (`ctx.waitUntil`): baja
 * las playlists hijas —variantes y pistas de audio, no los I-frames, que nadie pide al arrancar—
 * las reescribe y las guarda en la caché del borde bajo la MISMA url que el reproductor va a
 * pedir; y de cada una trae sus dos primeros segmentos, que se quedan en la caché de Cloudflare
 * por la url del CDN. Cuando el reproductor llega, todo está a un salto de borde: unos 50 ms la
 * playlist, 300 ms el segmento. La fila de 8–10 s se queda en lo que tarda el maestro.
 *
 * Con moderación: dos segmentos por pista y no más de tres peticiones a la vez contra el CDN,
 * que es el mismo que devuelve 502 cuando se le insiste.
 *
 * LAS PLAYLISTS VAN A R2, NO A `caches.default`. En un dominio `*.workers.dev` —que es donde vive
 * este Worker— la Cache API no guarda nada (está documentado, y se comprobó), y la caché de
 * `fetch` solo retiene lo que Cloudflare cachea por defecto: los `.ts` sí, los `.m3u8` no. R2 ya
 * está enchufado para los trozos de mp4; una playlist son unos KB con diez minutos de vida.
 * No se purgan solas: el que se relee caducado se borra, el resto se queda. A 5 KB cada una,
 * mil reproducciones al día son 15 MB al día; con el bucket lleno, `put` falla y se sigue igual.
 */
const SEGMENTOS_A_PRECALENTAR = 2;
const PLAYLIST_EN_CACHE_MS = 10 * 60 * 1000;

function llaveDePlaylist(urlSeg) {
  const u = new URL(urlSeg).searchParams.get('u') || '';
  return `playlist/${u}`;
}

async function playlistGuardada(env, urlSeg) {
  if (!env.CACHE) return null;
  const clave = llaveDePlaylist(urlSeg);
  const obj = await env.CACHE.get(clave).catch(() => null);
  if (!obj) return null;
  if (Number(obj.customMetadata?.hasta) < Date.now()) {
    env.CACHE.delete(clave).catch(() => {});
    return null;
  }
  return obj.text();
}

async function guardarPlaylist(env, urlSeg, cuerpo) {
  if (!env.CACHE) return;
  await env.CACHE.put(llaveDePlaylist(urlSeg), cuerpo, {
    httpMetadata: { contentType: 'application/vnd.apple.mpegurl' },
    customMetadata: { hasta: String(Date.now() + PLAYLIST_EN_CACHE_MS) },
  }).catch(() => {});
}

function hijasDelMaestro(maestroReescrito) {
  const variantes = [];
  const pistas = [];
  const lineas = maestroReescrito.split(/\r?\n/);
  for (let i = 0; i < lineas.length; i++) {
    const t = lineas[i].trim();
    if (t.startsWith('#EXT-X-MEDIA:')) {
      const m = t.match(/URI="([^"]+)"/);
      if (m) pistas.push(m[1]);
    } else if (t.startsWith('#EXT-X-STREAM-INF:')) {
      const sig = (lineas[i + 1] || '').trim();
      if (sig && !sig.startsWith('#')) variantes.push(sig);
    }
  }
  return [...variantes, ...pistas];
}

function primerosSegmentos(playlistReescrita, cuantos) {
  return playlistReescrita
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .slice(0, cuantos);
}

/** El destino real (`?u=`) de una url `/seg` nuestra. */
function objetivoDe(urlSeg) {
  try {
    return b64urlDecode(new URL(urlSeg).searchParams.get('u') || '');
  } catch {
    return null;
  }
}

async function precalentar(env, maestroReescrito, referer, embedParam, firma, origenWorker, conocidas = new Map()) {
  const cabeceras = { 'User-Agent': UA, Referer: referer };
  const hijas = hijasDelMaestro(maestroReescrito);

  const unaHija = async urlSeg => {
    const objetivo = objetivoDe(urlSeg);
    if (!objetivo) return;
    let cuerpo = conocidas.get(urlSeg);
    if (cuerpo) {
      await guardarPlaylist(env, urlSeg, cuerpo);
    } else {
      cuerpo = await playlistGuardada(env, urlSeg);
      if (!cuerpo) {
        const res = await fetch(objetivo, { headers: cabeceras, cf: { cacheTtl: 0 } });
        if (!res.ok) { console.log('precalentar: playlist', res.status, new URL(objetivo).host); return; }
        cuerpo = reescribir(await res.text(), objetivo, embedParam, firma, origenWorker);
        await guardarPlaylist(env, urlSeg, cuerpo);
      }
    }
    // Sus primeros segmentos, en fila para no aporrear el CDN. Se lee el cuerpo entero: si no,
    // Cloudflare no lo guarda.
    for (const seg of primerosSegmentos(cuerpo, SEGMENTOS_A_PRECALENTAR)) {
      const destino = objetivoDe(seg);
      if (!destino) continue;
      try {
        const r = await fetch(destino, { headers: cabeceras, cf: { cacheEverything: true, cacheTtl: 86400 } });
        await r.arrayBuffer();
        if (!r.ok) console.log('precalentar: segmento', r.status, new URL(destino).host);
      } catch {
        /* un segmento que no llega ahora llegará cuando lo pida el reproductor */
      }
    }
  };

  // Tres hijas a la vez como mucho (dos variantes y una pista de audio es lo normal).
  const cola = hijas.slice();
  const obreros = Array.from({ length: Math.min(3, cola.length) }, async () => {
    while (cola.length) {
      const siguiente = cola.shift();
      try {
        await unaHija(siguiente);
      } catch {
        /* precalentar es un extra: nunca rompe la reproducción */
      }
    }
  });
  await Promise.all(obreros);
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
      // `/ajustes` no lleva una url dentro del `e`, lleva el nombre del ajuste. Todo lo demás sí,
      // y ahí la comprobación se mantiene: servir una url que no es una url no lleva a nada bueno.
      if (url.pathname !== '/ajustes' && !/^https?:\/\//i.test(embedUrl)) throw new Error('embed no válido');
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

    /**
     * ── Calentar el índice, para que el espectador no lo pague ───────────────────────────
     *
     * No la llama ningún reproductor: la llama el barrido que comprueba los enlaces. Lleva la
     * misma firma que todo lo demás, así que no es una puerta abierta para que un tercero nos
     * haga descargar lo que quiera.
     */
    /**
     * ── Ajustes del panel, guardados en R2 ───────────────────────────────────────────────
     *
     * Existe porque el sitio donde se guardaban antes NO GUARDABA. La configuración del panel
     * vivía en variables de entorno de Vercel escritas por su API, y se comprobó que la escritura
     * falla en silencio: se encendió un dominio, la respuesta dijo «success», y al leer la
     * variable seguía valiendo `[]`. Un ajuste que contesta que sí y no persiste es peor que uno
     * que no existe, porque nadie vuelve a comprobarlo.
     *
     * R2 sí escribe —lleva toda la caché de vídeo funcionando sobre él— y además es donde tiene
     * sentido que viva un ajuste que decide qué pasa por este Worker. Se firma igual que todo lo
     * demás: sin firma, cualquiera podría reescribir la configuración.
     */
    if (url.pathname === '/ajustes') {
      if (!env.CACHE) return new Response('R2 no está configurado', { status: 501, headers: CORS });
      const clave = 'ajustes/' + embedUrl.replace(/[^a-z0-9_.-]/gi, '_');

      if (request.method === 'PUT' || request.method === 'POST') {
        const cuerpo = await request.text();
        await env.CACHE.put(clave, cuerpo, { httpMetadata: { contentType: 'application/json' } });
        return new Response(cuerpo, { headers: { ...CORS, 'Content-Type': 'application/json' } });
      }

      const guardado = await env.CACHE.get(clave);
      if (!guardado) return new Response('null', { headers: { ...CORS, 'Content-Type': 'application/json' } });
      return new Response(guardado.body, { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    /**
     * LLENAR LA CACHÉ DE CORRIDO, para los hosts a los que pedir trozos sueltos les sale caro.
     *
     * `d` es el trozo por el que empezar y `n` cuántos como mucho. No van firmados y no hace
     * falta que lo vayan: solo eligen QUÉ PARTE del fichero que la firma ya autorizó se guarda,
     * así que lo peor que puede hacer quien los toquetee es cachear un trozo de más de algo que
     * ya podía pedir entero.
     *
     * El tope de 512 trozos (2 GB) no es por gusto: cada trozo es una escritura a R2, y una
     * invocación con miles de escrituras es la forma de descubrir un límite de Cloudflare en
     * mitad de un trabajo que dura minutos. Lo que no quepa se pide en otra llamada, que para eso
     * la respuesta dice por dónde se quedó.
     */
    /**
     * Un trozo empujado desde fuera. Es la salida para las colas que `/llena` no alcanza: hay
     * orígenes que tardan casi un minuto en soltar sus últimos megas y una invocación no vive
     * tanto. Ver `escribirTrozo` — valida el tamaño exacto y anota el total.
     */
    if (url.pathname === '/trozo' && (request.method === 'PUT' || request.method === 'POST')) {
      return escribirTrozo(
        env,
        request,
        embedUrl,
        Math.trunc(Number(url.searchParams.get('d'))),
        Math.trunc(Number(url.searchParams.get('t')))
      );
    }

    if (url.pathname === '/llena') {
      const desde = Math.max(0, Math.trunc(Number(url.searchParams.get('d')) || 0));
      const pedidos = Math.trunc(Number(url.searchParams.get('n')) || 512);
      const cuantos = Math.min(512, Math.max(1, pedidos));
      return llenarSecuencial(env, ctx, embedUrl, desde, cuantos);
    }

    if (url.pathname === '/calienta') {
      const resultado = await calentarIndice(env, ctx, embedUrl);
      return new Response(JSON.stringify(resultado), {
        status: resultado.ok ? 200 : 502,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // ── Segmento o variante: la URL real viaja en ?u= ────────────────────────────────────
    if (url.pathname === '/seg') {
      let objetivo;
      try {
        objetivo = b64urlDecode(url.searchParams.get('u') || '');
      } catch {
        return new Response('parámetro ?u= no válido', { status: 400, headers: CORS });
      }

      // Una playlist que `precalentar` dejó lista: se sirve de R2 sin tocar el CDN.
      if (!request.headers.get('Range')) {
        const lista = await playlistGuardada(env, request.url);
        if (lista) {
          return new Response(lista, {
            headers: { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store', 'X-Precalentada': '1' },
          });
        }
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
        const refrescado = await refrescar(objetivo, embedUrl, env);
        if (refrescado) upstream = await pedir(refrescado);
      }

      if (upstream.status >= 400) {
        console.log('seg: el CDN rechazó', upstream.status, new URL(objetivo).host);
        return new Response('el CDN rechazó el segmento', { status: 502, headers: CORS });
      }

      // Si resulta que era otra playlist, hay que reescribirla: sus hijos también vienen por aquí.
      const tipo = upstream.headers.get('content-type') || '';
      if (/mpegurl|vnd\.apple/i.test(tipo)) {
        const cuerpo = reescribir(await upstream.text(), objetivo, embedParam, firma, origenWorker);
        // Si el precalentado no llegó a tiempo (o esta playlist no venía del maestro), al menos
        // que sus dos primeros segmentos vayan por delante del reproductor.
        ctx.waitUntil(
          precalentar(env, `#EXT-X-STREAM-INF:\n${request.url}`, referer, embedParam, firma, origenWorker, new Map([[request.url, cuerpo]]))
        );
        return new Response(cuerpo, {
          headers: { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' },
        });
      }
      return respuestaVideo(upstream);
    }

    // ── Entrada: acuñar el vídeo y servirlo ──────────────────────────────────────────────
    const acunado = await acunar(embedUrl, 1, env);
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
    console.log('entrada:', upstream.status, acunado.url, 'referer', acunado.referer);

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
      const refrescado = await refrescar(acunado.url, embedUrl, env);
      if (refrescado) upstream = await pedirEntrada(refrescado);
    }

    if (upstream.status >= 400) {
      return new Response(`el CDN rechazó la petición (${upstream.status})`, { status: 502, headers: CORS });
    }

    const tipo = upstream.headers.get('content-type') || '';
    if (/mpegurl|vnd\.apple/i.test(tipo) || /\.m3u8(\?|$)/i.test(acunado.url)) {
      const cuerpo = reescribir(await upstream.text(), acunado.url, embedParam, firma, origenWorker);
      ctx.waitUntil(precalentar(env, cuerpo, acunado.referer, embedParam, firma, origenWorker));
      return new Response(cuerpo, {
        headers: { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' },
      });
    }
    return respuestaVideo(upstream);
  },
};
