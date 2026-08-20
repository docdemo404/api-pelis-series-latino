import * as crypto from 'crypto';

/**
 * ───────────────────────────────────────────────────────────────────────────────────────────
 * DESCARGA DEL VÍDEO A UN PROXY EXTERNO — para que el tránsito deje de salir del plan.
 *
 * Solo el modo `proxy` gasta ancho de banda de verdad: medido sobre el catálogo, el 75,6% de las
 * reproducciones se resuelve con un 302 y el 21,4% con unos KB de playlist. El 3,0% restante —797
 * reproducciones— reenvía la película entera, y a ~3,2 GB cada una eso agota el plan de Vercel en
 * unas decenas de visionados.
 *
 * Lo que se manda fuera es EL EMBED, no la URL del CDN, y esa distinción es la clave de todo: 793
 * de esas 797 están atadas por IP (vidhideplus 772, ok.ru 26), o sea que el CDN exige que quien
 * descarga sea quien acuñó. Un proxy al que le pasáramos una URL ya acuñada aquí recibiría 403 en
 * todas. Pasándole el embed, el proxy acuña y descarga él, y el CDN ve una sola IP.
 *
 * TODO ESTO ESTÁ APAGADO mientras no existan las dos variables de entorno. Sin ellas, `proxyUrlFor`
 * devuelve null y la API se comporta exactamente como antes.
 * ───────────────────────────────────────────────────────────────────────────────────────────
 */

/** Origen del proxy externo (el Worker de Cloudflare). Sin esto no se delega nada. */
function baseUrl(): string {
  return (process.env.VIDEO_PROXY_URL || '').replace(/\/$/, '');
}

/** Secreto compartido con el proxy. Sin él, el proxy sería abierto y cualquiera podría usarlo. */
function signingKey(): string {
  return process.env.VIDEO_PROXY_KEY || '';
}

/** ¿Hay proxy externo configurado y listo para recibir tráfico? */
export function externalProxyEnabled(): boolean {
  return Boolean(baseUrl() && signingKey());
}

/**
 * URL del proxy externo para reproducir este embed, ya firmada.
 *
 * La firma cubre el parámetro `e`, que es lo único que el proxy necesita para trabajar. No es
 * decorativa: sin ella el proxy aceptaría cualquier embed que le llegara y se convertiría en un
 * relé abierto — justo el recurso que se está intentando no agotar.
 *
 * Devuelve null cuando no hay proxy configurado, y el llamador sigue con el camino de siempre.
 */
export function proxyUrlFor(embedUrl: string): string | null {
  const base = baseUrl();
  const key = signingKey();
  if (!base || !key || !embedUrl) return null;

  const e = Buffer.from(embedUrl, 'utf8').toString('base64url');
  const s = crypto.createHmac('sha256', key).update(e).digest('hex');
  return `${base}/?e=${e}&s=${s}`;
}

/**
 * URL de la CACHÉ POR TROZOS del Worker para un fichero permanente, ya firmada.
 *
 * Es prima de `proxyUrlFor` pero para otra cosa, y conviene no confundirlas: aquella manda un
 * EMBED para que el proxy lo acuñe y descargue él (hosts atados por IP); esta manda un FICHERO ya
 * conocido para que lo sirva por trozos desde R2.
 *
 * Lo que arregla, medido host por host el 2026-08-20:
 *
 *   files.eintim.me   contesta 200 a un rango de en medio 5 de cada 6 veces → no se puede saltar
 *   archive.org       ~10 s hasta el primer byte, en cada petición, sin caché de origen
 *   firestream.to     0,7 MB/s
 *
 * Con la caché delante, los tres se convierten en lo mismo: un host que contesta 206 al instante.
 *
 * Devuelve null si no hay Worker configurado, y entonces se entrega la url del origen como
 * siempre. Eso es lo que permite apagar todo esto cambiando una variable de entorno.
 */
export function cacheUrlFor(fileUrl: string): string | null {
  const url = proxyUrlFor(fileUrl);
  if (!url) return null;
  // `proxyUrlFor` apunta a la raíz; la caché por trozos vive en /v.
  return url.replace(/\/\?e=/, '/v?e=');
}

/**
 * EL FICHERO QUE HAY DENTRO DE UNA URL NUESTRA DE CACHÉ, o `null` si no es una.
 *
 * Existe por un caso que no se puede arreglar desde el servidor: hay quien tiene un **DNS
 * privado con listas de bloqueo**, y `*.workers.dev` está en casi todas —es un dominio
 * compartido por cualquiera que despliegue un Worker, así que las listas lo bloquean entero—.
 * Para esa persona, la url de la caché no resuelve y da igual lo bien que funcione el Worker.
 *
 * Comprobado en el aparato: con el DNS privado puesto fallaba, y quitándolo reprodujo. Los dos
 * hosts que se caen son `files.eintim.me` y el del Worker; el de esta API resuelve siempre.
 *
 * Así que el último recurso es servir los bytes desde aquí, y para eso hace falta deshacer el
 * envoltorio y recuperar el fichero de dentro. Se exige la FIRMA: sin ella esto sería una forma
 * de pedirle a la API que descargue cualquier url que a alguien se le ocurra.
 */
export function ficheroDentroDeNuestraCache(url: string): string | null {
  const base = baseUrl();
  const key = signingKey();
  if (!base || !key || !url || !url.startsWith(base + '/v?')) return null;

  try {
    const params = new URL(url).searchParams;
    const e = params.get('e');
    const s = params.get('s');
    if (!e || !s) return null;
    const esperada = crypto.createHmac('sha256', key).update(e).digest('hex');
    if (s !== esperada) return null;
    return Buffer.from(e, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}
