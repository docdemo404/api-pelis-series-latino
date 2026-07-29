import { Request } from 'express';

/**
 * ───────────────────────────────────────────────────────────────────────────────────────────
 * `direct_stream` SE PUBLICA ABSOLUTO, aunque se guarde relativo.
 *
 * `directEndpointUrl` fabrica `/api/v1/stream/direct?e=…` y eso es lo que viaja a la base de
 * datos, a propósito: una ruta sin dominio sobrevive a un cambio de despliegue, y las 40 355
 * fichas con vídeo directo no hay que reescribirlas cada vez que la API cambia de host.
 *
 * Pero lo que se GUARDA no puede ser lo que se ENTREGA. El contrato que publica la propia
 * documentación es «pásale `direct_stream` a tu reproductor y sigue la respuesta», y una ruta
 * relativa no cumple eso: un reproductor —o un `fetch` desde otro origen— la resuelve contra SU
 * dominio, no contra el de esta API, así que pide algo que no existe y el vídeo no arranca. El
 * síntoma es engañoso porque no hay error que mirar: `embed_url` sí es absoluto, y la ficha
 * parece correcta.
 *
 * Se resuelve aquí, en la salida, y no en el scraper, justamente para no atar el dato guardado a
 * un dominio. El `direct_stream` del modo `public` es ya la URL del CDN, absoluta: por eso solo
 * se toca lo que empieza por `/`.
 * ───────────────────────────────────────────────────────────────────────────────────────────
 */

/**
 * Origen público por el que ha entrado ESTA petición.
 *
 * Detrás del proxy de Vercel, `req.protocol` y `req.get('host')` describen el salto interno, no
 * la URL que escribió el cliente: hay que mirar las `x-forwarded-*`, que es lo que el borde
 * rellena con el dominio de verdad. Y se coge el PRIMER valor porque con varios proxies
 * encadenados la cabecera llega como lista (`https,http`).
 *
 * Devuelve cadena vacía si no hay host que usar; el llamador entonces deja la ruta como está,
 * que es peor pero no rompe nada nuevo.
 */
export function publicOrigin(req: Request): string {
  const primero = (valor: unknown): string =>
    String(Array.isArray(valor) ? valor[0] : valor || '').split(',')[0].trim();

  const host = primero(req.headers['x-forwarded-host']) || primero(req.get('host'));
  if (!host) return '';

  const protocolo = primero(req.headers['x-forwarded-proto']) || req.protocol || 'https';
  return `${protocolo}://${host}`;
}

/**
 * Devuelve el payload con todo `direct_stream` relativo convertido en URL absoluta.
 *
 * NO MUTA, y no es un detalle: `CacheStore` degrada a un Map en memoria que entrega la MISMA
 * referencia de objeto en cada acierto, así que reescribir en el sitio dejaría el dominio de la
 * primera petición grabado dentro del caché —y de paso perdería la forma relativa que hace
 * portable el dato guardado—.
 *
 * Solo clona la rama que de verdad cambia: si dentro de un nodo no había ningún `direct_stream`
 * relativo, se devuelve el nodo original tal cual. Un listado de catálogo es casi todo texto y
 * metadatos, así que en la práctica se copian unos pocos objetos por respuesta.
 */
export function withAbsoluteDirectStreams<T>(payload: T, origin: string): T {
  if (!origin) return payload;

  const reescribir = (valor: any): any => {
    if (Array.isArray(valor)) {
      let cambio = false;
      const salida = valor.map(elemento => {
        const nuevo = reescribir(elemento);
        if (nuevo !== elemento) cambio = true;
        return nuevo;
      });
      return cambio ? salida : valor;
    }

    if (valor && typeof valor === 'object') {
      let cambio = false;
      const salida: Record<string, any> = {};
      for (const clave of Object.keys(valor)) {
        const actual = valor[clave];
        const nuevo =
          clave === 'direct_stream' && typeof actual === 'string' && actual.startsWith('/')
            ? origin + actual
            : reescribir(actual);
        if (nuevo !== actual) cambio = true;
        salida[clave] = nuevo;
      }
      return cambio ? salida : valor;
    }

    return valor;
  };

  return reescribir(payload) as T;
}
