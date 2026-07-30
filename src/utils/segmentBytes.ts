/**
 * QUÉ SON DE VERDAD LOS BYTES DE UN SEGMENTO.
 *
 * Vive en un solo sitio y lo usan los DOS caminos que necesitan la respuesta —el que sirve el
 * vídeo (src/routes/stream.routes.ts) y el que decide si un servidor se ofrece
 * (src/services/manifestHealth.ts)—, porque tenerlo duplicado ya nos costó un arreglo antes con
 * la lectura de las páginas de FuegoCine: se corrige en un camino, el otro sigue con el criterio
 * viejo, y el fallo reaparece por donde nadie mira.
 *
 * EL CASO QUE LO OBLIGÓ A EXISTIR. emturbovid aloja en Google Drive, que no sirve ficheros de
 * vídeo a cualquiera pero sí sirve imágenes. Así que cada segmento sale de
 * `lh3.googleusercontent.com` con `Content-Type: image/png` y con esta forma:
 *
 *     [ PNG real, 806 bytes ] [ "a - S01E01 - vip.hdlatino.us" + relleno 0xFF ] [ MPEG-TS ]
 *
 * El vídeo empieza en el byte 941 del ejemplo medido, y a partir de ahí son 7.028 paquetes de
 * 188 bytes con el 100 % de sus marcas de sincronía y sin sobrar ninguno. O sea: el vídeo está
 * intacto y lo que sobra es el disfraz, que su reproductor quita por JavaScript.
 *
 * Nosotros ni lo quitábamos ni lo detectábamos, y las dos cosas fallaban a la vez:
 *
 *   · al SERVIR, a ese host se le daba modo `redirect`, así que el cliente pedía los segmentos
 *     al CDN y recibía imágenes — de ahí "el primer servidor dice Vídeo directo y no reproduce";
 *   · al COMPROBAR, la sonda solo descartaba HTML y aceptaba "lo desconocido". Un PNG no es un
 *     contenedor desconocido: es un formato conocido que no es vídeo, y colarlo por esa puerta
 *     es lo que mantuvo el servidor en la lista, rotulado como bueno, durante meses.
 */

const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Firmas de imagen que NO son vídeo por sí mismas. Una de ellas puede ser un disfraz. */
const FIRMAS_DE_IMAGEN: Array<[string, Buffer]> = [
  ['png', FIRMA_PNG],
  ['jpeg', Buffer.from([0xff, 0xd8, 0xff])],
  ['gif', Buffer.from('GIF8', 'latin1')],
  ['bmp', Buffer.from('BM', 'latin1')],
];

/**
 * Dónde empieza el MPEG-TS: el primer 0x47 que arranca una cadencia limpia de 188 bytes.
 *
 * Se exigen TRES marcas seguidas y no una sola a propósito: un 0x47 suelto aparece por
 * casualidad cada 256 bytes en cualquier fichero binario, así que buscar uno solo daría un
 * comienzo inventado y cortaría el segmento por donde no es.
 */
export function inicioDelTs(buf: Buffer, tope = 65536): number {
  const limite = Math.min(buf.length - 376, tope);
  for (let i = 0; i < limite; i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47) return i;
  }
  return -1;
}

/** ¿Empieza por la firma de una imagen? */
export function pareceImagen(buf: Buffer): boolean {
  return FIRMAS_DE_IMAGEN.some(([, firma]) => buf.length >= firma.length && buf.subarray(0, firma.length).equals(firma));
}

/** ¿Es el disfraz de emturbovid: una imagen con vídeo detrás? */
export function esSegmentoDisfrazado(buf: Buffer): boolean {
  return pareceImagen(buf) && inicioDelTs(buf) >= 0;
}

/**
 * ¿Estos bytes se pueden reproducir —tal cual o después de que les quitemos el disfraz?
 *
 * Sigue aceptando lo DESCONOCIDO, que era la intención original y es correcta: hay CDN que
 * sirven contenedores raros y no se condena un vídeo por no reconocerlo. Lo que ya no se acepta
 * es lo conocido-y-que-no-es-vídeo: una página HTML o una imagen sin nada detrás.
 */
export function bytesReproducibles(buf: Buffer): boolean {
  if (buf.length < 16) return false;
  if (/^\s*<(!doctype|html|\?xml)/i.test(buf.subarray(0, 400).toString('latin1'))) return false;
  // Una imagen solo vale si trae vídeo escondido; si no, es una imagen y ya está.
  if (pareceImagen(buf)) return inicioDelTs(buf) >= 0;
  return true;
}
