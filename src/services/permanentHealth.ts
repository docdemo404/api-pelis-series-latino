/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ¿ARRANCA ESTE FICHERO PERMANENTE? La misma pregunta, para el barrido y para el que sirve.
 *
 * Un servidor `public` —un mp4 o un `.m3u8` que se piden tal cual, sin página de reproductor
 * delante— no se puede juzgar con las reglas de un embed: el inspector pide HTML, busca un
 * reproductor dentro, no lo encuentra y lo declara muerto. Por eso `revisarServidores` los
 * SALTABA, y por eso su sello solo lo ponía `verificarPermanentes`.
 *
 * Eso dejaba un agujero que se reportó el 2026-08-24 con el 1x01 de «Breaking Bad»: la url que el
 * usuario pegó por el panel se quedaba SIN SELLO entre vuelta y vuelta del barrido, y sin sello
 * `paraElCliente` no la publica. Así que el capítulo se servía con el servidor de la otra fuente
 * —el que el catálogo pone SEGUNDO— y desde fuera parecía que la prioridad no se respetaba.
 * Medido: la fila tenía la url, el orden era el correcto, y aun así no salía.
 *
 * Peor todavía, se realimentaba: sin dos servidores publicables, `getEpisode` da el capítulo por
 * NO resuelto, así que cada apertura volvía a rastrear y a reescribir el capítulo, sellando al
 * de la otra fuente y nunca al manual. Comprobado sobre producción — dos aperturas seguidas
 * movieron el sello de moviedays de 07:19:18 a 07:21:57 y dejaron el manual en `NO`.
 *
 * La salida no es publicar sin prueba, que es la regla de la casa y no se toca. Es que el que
 * sirve PUEDA conseguir la prueba, con la comprobación que le corresponde a un fichero. Vive aquí
 * —y no en el script— para que la respuesta sea la misma se pregunte desde donde se pregunte.
 * Este proyecto ya sabe cómo acaba la otra opción: lo que se copia se desincroniza.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { ServerOption } from '../types';
import { puedeAbrirse } from './arranqueMp4';
import { bajarManifiesto, segmentoDescargable } from './manifestHealth';

/** El veredicto de una comprobación de fichero. `sinVeredicto` no sella ni condena. */
export interface ArranquePermanente {
  ok: boolean;
  causa: string;
  detalle: string;
  sinVeredicto?: boolean;
}

/**
 * ¿ESTO ES UN MANIFIESTO Y NO UN FICHERO? Cambia las DOS comprobaciones de esta pasada.
 *
 * Todo este barrido está escrito para un fichero: `sigueVivo` pide un trozo del byte 1.000.000 y
 * `puedeAbrirse` lee las cajas de un mp4. A un `.m3u8` —que es un texto de unos kilobytes— las dos
 * le contestan mal, y de formas distintas:
 *
 *   · el rango de en medio da 416, o peor, un 200 con el manifiesto entero, que aquí se lee como
 *     «no sabe hacer rangos» y RETIRA el sello;
 *   · y si llega al arranque, `puedeAbrirse` dice «no es un mp4» y se va sin veredicto, así que el
 *     sello no se renueva NUNCA.
 *
 * Lo segundo es lo grave y es silencioso: `paraElCliente` solo publica lo que lleva sello vigente
 * —doce horas para un permanente—, así que una url HLS pegada por el panel se ve durante medio día
 * y desaparece sola, sin que nadie la haya condenado. Y el panel las acepta a propósito: tiene una
 * rama entera para manifiestos (`manifiestoTraeVideo`), porque un `.m3u8` bueno pesa unos cientos
 * de bytes y el criterio de «pesa poco, es una página de error» no le sirve.
 *
 * Así que a un manifiesto se le pregunta lo suyo: que el texto declare vídeo y que su primer trozo
 * se pueda bajar. Es la misma comprobación que hace el panel al guardarlo.
 */
export function esManifiestoHls(sv: any): boolean {
  const url = String(sv?.direct_stream || '');
  if (String(sv?.direct_kind || '').toLowerCase() === 'hls') return true;
  try {
    return /\.m3u8$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * El equivalente de `puedeAbrirse` para un manifiesto: ¿declara vídeo y llegan sus trozos?
 *
 * Devuelve el mismo trato de siempre a lo que no se puede concluir: `sinVeredicto` no suma golpe
 * ni renueva sello. `segmentoDescargable` ya perdona por su cuenta lo que no le dio tiempo a mirar
 * —no condena por lentitud—, así que un `false` suyo es una negativa medida, no un mal rato.
 */
export async function manifiestoArranca(
  url: string
): Promise<{ ok: boolean; causa: string; detalle: string; sinVeredicto?: boolean }> {
  const texto = await bajarManifiesto(url, url);
  if (texto === null) {
    return { ok: false, causa: 'el manifiesto no llega', detalle: 'sin respuesta utilizable', sinVeredicto: true };
  }
  if (!/#EXTM3U/i.test(texto)) {
    return { ok: false, causa: 'no es un manifiesto', detalle: 'la respuesta no empieza por #EXTM3U' };
  }
  if (!/#EXTINF|#EXT-X-STREAM-INF/i.test(texto)) {
    return { ok: false, causa: 'manifiesto vacío', detalle: 'ni trozos ni calidades' };
  }
  const llegan = await segmentoDescargable(texto, url, url);
  return llegan
    ? { ok: true, causa: 'arranca', detalle: 'manifiesto con trozos' }
    : { ok: false, causa: 'sus trozos no llegan', detalle: 'el primero dio error' };
}

/**
 * LA PREGUNTA COMPLETA: manifiesto o fichero, la que toque.
 *
 * Es el reparto que ya hacía el barrido en su bucle, puesto donde puedan llamarlo los dos. Un
 * `.m3u8` se juzga por su texto y su primer trozo; un mp4, por su índice — `puedeAbrirse` es más
 * estricta que preguntar si el fichero está, porque comprueba lo que de verdad decide si alguien
 * ve algo: que el reproductor pueda ABRIRLO dentro del plazo que aguanta la app.
 *
 * Lo que no se pueda concluir vuelve como `sinVeredicto`, y quien llame tiene que tratarlo como lo
 * trata el barrido: ni sella ni retira. Un timeout nuestro no es una baja suya (FUENTES.md §7.11).
 */
export async function permanenteArranca(servidor: ServerOption): Promise<ArranquePermanente> {
  const url = String(servidor?.direct_stream || servidor?.embed_url || '');
  if (!url) return { ok: false, causa: 'sin url', detalle: 'el servidor no trae dirección', sinVeredicto: true };
  if (esManifiestoHls(servidor)) return manifiestoArranca(url);
  return puedeAbrirse(url);
}
