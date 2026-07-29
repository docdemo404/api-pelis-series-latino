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
