/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PARTIR UN PEGOTE DE TEXTO EN URLS, SIN ROMPER LAS QUE LLEVAN COMAS DENTRO.
 *
 * La regla vieja era «separa por espacios, comas y puntos y coma», que parece razonable hasta que
 * alguien pega una url de las que el propio host construye con comas. Las hay, y son normales:
 *
 *   https://cdn1.videok.pro/hls3/01/00000/,tksbm55iuir2_l,tksbm55iuir2_n,lang/spa/…,.urlset/master.m3u8
 *
 * Eso es UNA url —el `.urlset` de nginx-vod/kaltura lista las calidades y los idiomas separados
 * por comas dentro de la misma ruta— y la fuente propia la recibía como NUEVE, todas inválidas.
 * El panel contestaba «ninguna url entregó vídeo» sobre un enlace que reproduce perfectamente.
 *
 * Así que una coma no es un separador: es un separador SOLO cuando detrás empieza otra url. Y lo
 * mismo vale para el hueco en blanco, que además arregla de paso las de archive.org con espacios
 * en el nombre del fichero (`…/download/foo/My Movie.mp4`), que se partían en dos.
 *
 * Lo único que separa siempre es el salto de línea: una url no puede contener uno.
 *
 * Vive aquí, en un solo sitio, porque este mismo corte se hacía por DOS puertas —el `<input>` de
 * cada capítulo en el panel y el cuerpo del POST— y un pegote arreglado en una sola de ellas es
 * exactamente la clase de arreglo a medias que este proyecto ya ha pagado varias veces.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Dónde empieza una url: `https://`, `http://` o la forma sin esquema `//host/…`. */
const ARRANQUE_DE_URL = /[\s,;]+(?=(?:https?:)?\/\/)/g;

/**
 * Las urls que hay en `texto`, en el orden en que se escribieron.
 *
 * El orden importa y no es un detalle: la primera url de un servidor manual es la que se entrega
 * para reproducir, así que moverla arriba en la caja es una decisión de verdad.
 */
export function partirUrlsPegadas(texto: unknown): string[] {
  return String(texto ?? '')
    .replace(/\r\n?/g, '\n')
    // Un separador solo corta si detrás arranca otra url; si no, es parte de la que hay.
    .replace(ARRANQUE_DE_URL, '\n')
    .split('\n')
    // La coma o el punto y coma que quedan al final de una línea son puntuación de quien pegó.
    .map(l => l.trim().replace(/[\s,;]+$/, '').trim())
    .filter(Boolean);
}

/**
 * Lo mismo, para lo que llega por el cuerpo de una petición: una cadena, una lista, o una lista
 * cuyos elementos son a su vez pegotes (una línea con dos urls separadas por coma).
 */
export function urlsDelCuerpo(valor: unknown): string[] {
  const crudas = Array.isArray(valor) ? valor : [valor];
  return crudas.flatMap(u => partirUrlsPegadas(u));
}
