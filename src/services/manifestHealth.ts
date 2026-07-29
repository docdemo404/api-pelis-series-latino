import * as dns from 'dns';
import { streamClient } from '../utils/httpClient';

/**
 * ───────────────────────────────────────────────────────────────────────────────────────────
 * UN MANIFIESTO QUE RESPONDE 200 NO ES UN VÍDEO QUE SE PUEDA VER.
 *
 * Medido el 2026-07-29 sobre 25 fichas de emturbovid: 19 no reproducen, y 16 de ellas por la
 * misma razón — el maestro se descarga perfectamente desde `cdn1.turboviplay.com`, pero las
 * playlists de calidad que lista cuelgan de dominios que YA NO EXISTEN:
 *
 *   cdn57.valitobay.com, cdn63.vibanes.com, cdn37.tiurnews.com, cdn43.montfile.com…
 *
 * No es un subdominio caído ni un fallo de nuestra red: el apex entero da NXDOMAIN, y lo
 * confirman los resolutores públicos de Google y Cloudflare. Tampoco se arregla reacuñando —se
 * probó cinco veces seguidas sobre la misma ficha y siempre devuelve el mismo host muerto—,
 * porque el nodo de almacenamiento del host desapareció y el vídeo con él.
 *
 * POR QUÉ ESTO ERA INVISIBLE: `redirect` entrega un 302 al maestro y se aparta. El maestro vive
 * en un host sano, así que la API daba la reproducción por buena; el que se estrellaba contra el
 * dominio muerto era el reproductor, un salto más abajo, con `ERR_NAME_NOT_RESOLVED`. Todas las
 * sondas del proyecto medían el maestro y ninguna bajaba a las variantes.
 *
 * Y era el peor error posible de los tres que puede cometer esta API, porque no es que falle: es
 * que MIENTE. Un 502 hace que el cliente caiga a `embed_url` o pruebe otro de los servidores de
 * la ficha —hay nueve de media— y acabe viendo la película. Un 302 a un manifiesto envenenado le
 * dice "aquí tienes" y lo deja plantado sin nada a lo que recurrir.
 * ───────────────────────────────────────────────────────────────────────────────────────────
 */

/** Cuánto se recuerda que un host resuelve (o no). Un NXDOMAIN no se arregla en un minuto. */
const DNS_TTL_MS = 10 * 60 * 1000;

const dnsCache = new Map<string, { vivo: boolean; expira: number }>();

/**
 * ¿Existe este dominio?
 *
 * Se resuelve con el resolutor del sistema y se cachea en proceso: un maestro lista varias
 * variantes que suelen repetir host, y en una instancia serverless caliente las reproducciones
 * seguidas de la misma película preguntarían lo mismo una y otra vez.
 *
 * Ante la duda se contesta que SÍ. Un fallo de DNS por timeout o por un resolutor saturado no
 * puede tumbar una reproducción que habría funcionado: lo que se busca aquí es el NXDOMAIN
 * rotundo, no cualquier tropiezo.
 */
export async function hostResuelve(host: string): Promise<boolean> {
  if (!host) return false;

  const cacheado = dnsCache.get(host);
  if (cacheado && Date.now() < cacheado.expira) return cacheado.vivo;

  let vivo = true;
  try {
    await dns.promises.lookup(host);
  } catch (err: any) {
    // Solo estos dos códigos significan "este nombre no existe". `ETIMEOUT`, `ESERVFAIL` y
    // compañía son problemas NUESTROS, y con ellos se da el host por bueno.
    vivo = !(err?.code === 'ENOTFOUND' || err?.code === 'ENODATA');
  }

  dnsCache.set(host, { vivo, expira: Date.now() + DNS_TTL_MS });
  return vivo;
}

function hostDe(uri: string, base: string): string {
  try {
    return new URL(uri, base).hostname;
  } catch {
    return '';
  }
}

export interface EstadoManifiesto {
  /** Ninguna de las URIs que referencia apunta a un dominio que exista. */
  muerto: boolean;
  /** Alguna resuelve y alguna no: se puede reproducir, pero no con todas las calidades. */
  parcial: boolean;
  /** El manifiesto con las URIs muertas quitadas y las supervivientes ya absolutas. */
  cuerpo: string;
  /** Para el log: qué dominios se descartaron. */
  muertos: string[];
}

/**
 * Revisa a dónde apunta un manifiesto y quita lo que no existe.
 *
 * Solo mira UN nivel, y es deliberado: bajar hasta los segmentos costaría otra petición por
 * variante en el camino crítico entre pulsar Play y el primer fotograma, y no hace falta —lo que
 * se ha medido roto es el salto del maestro a las variantes, que es donde el host reparte entre
 * dominios desechables—. Un segmento que falle más abajo ya tiene su propia red de seguridad: lo
 * pide `/stream/direct/seg`, que reacuña y reintenta.
 *
 * Las URIs se absolutizan siempre. El cuerpo filtrado se sirve desde NUESTRO origen, y una URI
 * relativa que se dejara tal cual resolvería contra la API en vez de contra el CDN.
 */
export async function revisarManifiesto(manifiesto: string, urlBase: string): Promise<EstadoManifiesto> {
  const lineas = manifiesto.split(/\r?\n/);
  const salida: string[] = [];
  const muertos = new Set<string>();
  let vivas = 0;
  let total = 0;

  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i];
    const limpia = linea.trim();

    // Las etiquetas pasan tal cual, salvo la que precede a una URI que vamos a tirar: un
    // `#EXT-X-STREAM-INF` huérfano describe una calidad que ya no está y algunos reproductores
    // se atragantan con él.
    if (!limpia || limpia.startsWith('#')) {
      salida.push(linea);
      continue;
    }

    total++;
    const host = hostDe(limpia, urlBase);
    if (host && !(await hostResuelve(host))) {
      muertos.add(host);
      // Quitar también la etiqueta de cabecera que acabábamos de escribir, si la había.
      if (salida.length && /^#EXT-X-STREAM-INF/i.test(salida[salida.length - 1].trim())) salida.pop();
      continue;
    }

    vivas++;
    let absoluta = limpia;
    try {
      absoluta = new URL(limpia, urlBase).toString();
    } catch {}
    salida.push(absoluta);
  }

  return {
    muerto: total > 0 && vivas === 0,
    parcial: vivas > 0 && muertos.size > 0,
    cuerpo: salida.join('\n'),
    muertos: [...muertos],
  };
}

/** Descarga un manifiesto. Devuelve null si no se pudo (red o status de error). */
export async function bajarManifiesto(url: string, referer: string): Promise<string | null> {
  try {
    const res = await streamClient.get(url, {
      headers: { Referer: referer },
      responseType: 'text',
      timeout: 15000,
      validateStatus: () => true,
    });
    if (res.status >= 400) return null;
    return String(res.data || '');
  } catch {
    return null;
  }
}
