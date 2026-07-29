
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

/** Cuánto se recuerda si un host está o no alcanzable. Un dominio que no existe tarda en volver. */
const HOST_TTL_MS = 10 * 60 * 1000;

/**
 * Por qué se ha dado por muerto un destino. NO es decoración para el log: hay un motivo que
 * depende de QUIÉN pregunta y el resto que no, y esa diferencia decide si el veredicto puede
 * guardarse en el catálogo —donde lo hereda cualquier cliente— o solo vale para esta petición.
 *
 *   no-responde      la conexión falla o el host no existe   → vale para todos
 *   no-esta          404/410: el fichero no está             → vale para todos
 *   no-es-lo-pedido  contesta, pero no con lo que se pidió   → vale para todos
 *   prohibido        403 sobre lo que íbamos a entregar tal cual  → SOLO para este cliente
 *
 * `prohibido` es el que no se puede generalizar: un cliente nativo fija `Referer` y
 * `User-Agent` y pasa por donde un navegador se estrella. Anotarlo en el catálogo enterraría
 * para todo el mundo un servidor que a media plataforma le funciona.
 */
export type MotivoMuerte = 'no-responde' | 'no-esta' | 'no-es-lo-pedido' | 'prohibido';

export interface Sondeo {
  vivo: boolean;
  /** Solo cuando `vivo` es falso. */
  motivo?: MotivoMuerte;
  /** El destino manda `Access-Control-Allow-Origin`: un navegador puede leerlo. */
  cors: boolean;
}

const hostCache = new Map<string, { sondeo: Sondeo; expira: number }>();

/**
 * ¿Este destino deja que un NAVEGADOR lea su respuesta?
 *
 * Lo apunta la sonda de `hostAlcanzable`, que ya tiene la respuesta en la mano — preguntarlo
 * aparte sería otra petición para un dato que acabamos de ver pasar.
 *
 * Devuelve `undefined` si aún no se ha sondeado ese host: eso NO es "no tiene CORS", es "no se
 * sabe", y quien lo consulte tiene que tratarlo como tal.
 */
export function destinoSirveCors(url: string): boolean | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  for (const [clave, entrada] of hostCache) {
    if (clave.startsWith(host + '|') && Date.now() < entrada.expira) return entrada.sondeo.cors;
  }
  return undefined;
}

/**
 * ¿Sirve de algo esta URL?
 *
 * DOS INTENTOS ANTERIORES FALLARON AQUÍ, y los dos por creerle a la red equivocada:
 *
 *   1. Preguntar al DNS con `dns.lookup` y contar como muerto solo un `ENOTFOUND`. En el sandbox
 *      de Vercel un dominio inexistente no contesta eso, así que la regla "ante la duda, vivo"
 *      daba por bueno TODO. Acertaba en local y no servía de nada desplegado.
 *   2. Intentar la petición y aceptar cualquier respuesta como prueba de vida. Pero es que esos
 *      dominios SÍ resuelven desde la red de Vercel: van a una página de aparcamiento que
 *      responde 200 tan contenta. Otra vez el 302 de siempre.
 *
 * De ahí que ahora la pregunta no sea "¿existe el dominio?" sino "¿me está devolviendo lo que
 * pedí?". Cuando lo pedido es una playlist, la respuesta tiene que EMPEZAR POR `#EXTM3U`: eso lo
 * cumple un CDN vivo y no lo cumple ni un dominio revendido ni un resolutor creativo, y no depende
 * de códigos de error que cambian según dónde corra el proceso.
 *
 * Lo que NO condena: un timeout (un CDN lento no es un CDN caído) y, salvo en `entregaLiteral`,
 * tampoco un 403 — puede ser una cabecera que solo el reproductor sabe poner. Equivocarse hacia
 * "muerto" manda al cliente al embed o a otro servidor, que es recuperable; equivocarse hacia
 * "vivo" lo deja mirando una pantalla negra, que no lo es.
 *
 * Se cachea por host y por tipo de sonda: un maestro lista varias calidades que suelen compartir
 * dominio, y así se paga una sonda por host y no una por variante.
 */
export async function sondearDestino(
  url: string,
  referer: string,
  esperaManifiesto = false,
  /**
   * Esta respuesta es la que va a recibir el cliente tal cual (vamos a redirigirle aquí). Entonces
   * un 403 SÍ condena: lo verá igual y no tiene forma de arreglarlo.
   */
  entregaLiteral = false
): Promise<Sondeo> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { vivo: false, motivo: 'no-responde', cors: false };
  }

  const clave = `${host}|${esperaManifiesto}|${entregaLiteral}`;
  const cacheado = hostCache.get(clave);
  if (cacheado && Date.now() < cacheado.expira) return cacheado.sondeo;

  let vivo = true;
  let motivo: MotivoMuerte | undefined;
  let cors = false;
  const condenar = (m: MotivoMuerte) => { vivo = false; motivo = m; };
  try {
    const res = await streamClient.get(url, {
      // `Range` NO es una optimización, es lo que hace viable la sonda: sin él, comprobar un mp4
      // se descarga la película ENTERA en memoria antes de contestar. Se probó sin esto y los
      // hosts de mp4 (los blogspot con pixeldrain) dejaron de responder — 45 s y timeout.
      // Con 2 KB sobra: es más que suficiente para ver si el cuerpo empieza por `#EXTM3U`.
      //
      // Y el REFERER se manda o no según a quién estemos imitando. Con `entregaLiteral` el que va
      // a pedir esto es el reproductor siguiendo nuestro 302, y ese NO manda Referer —lo quita
      // nuestra `Referrer-Policy: no-referrer`—. Sondear con el Referer del embed medía a un
      // cliente que no existe: el CDN nos contestaba 200 y al navegador 403, así que la
      // comprobación daba luz verde a vídeos que nadie podía ver.
      headers: entregaLiteral
        ? { Range: 'bytes=0-2047' }
        : { Referer: referer, Range: 'bytes=0-2047' },
      responseType: 'text',
      timeout: 8000,
      // Cinturón por si el host ignora el `Range` y empieza a mandar el fichero completo.
      maxContentLength: 256 * 1024,
      validateStatus: () => true,
    });

    // Que conteste algo no basta, y esto también salió de mirar producción: el dominio que da
    // NXDOMAIN desde una red normal SÍ resuelve desde la red de Vercel —a una página de
    // aparcamiento que responde encantada—, así que "hubo respuesta" daba el vídeo por vivo y
    // volvía a entregar el 302 de siempre.
    //
    // Un 404 o un 410 sobre una playlist no admiten interpretación: el fichero no está. Un 403
    // sí, y por eso se perdona — puede ser una cabecera que solo el reproductor sabe poner.
    cors = res.headers['access-control-allow-origin'] !== undefined;

    if (res.status === 404 || res.status === 410) condenar('no-esta');
    // Un 403 aquí es el único veredicto que depende del cliente, y por eso lleva su propio
    // motivo: para el que sigue nuestro 302 es definitivo, para un nativo que fija cabeceras
    // puede no serlo, y quien guarde esto en el catálogo tiene que poder distinguirlo.
    if (vivo && entregaLiteral && res.status >= 400) {
      condenar(res.status === 403 || res.status === 401 ? 'prohibido' : 'no-esta');
    }

    // Y la prueba definitiva cuando lo que se pidió es una playlist: que el cuerpo SEA una
    // playlist. Un manifiesto empieza por `#EXTM3U`; una página de aparcamiento, no. Esto
    // distingue al CDN vivo del dominio revendido sin depender de ningún código de error.
    if (vivo && esperaManifiesto && !String(res.data || '').trimStart().startsWith('#EXTM3U')) {
      condenar('no-es-lo-pedido');
    }

    // Y con `entregaLiteral` sobre algo que no es playlist —un mp4 que vamos a redirigir— la
    // pregunta equivalente es si lo que empieza a llegar son bytes de medio. Varios blogspot
    // redirigían tan contentos a una página de error de su alojador, que responde 200.
    if (vivo && entregaLiteral && !esperaManifiesto) {
      if (/^\s*<(!doctype|html|\?xml)/i.test(String(res.data || ''))) condenar('no-es-lo-pedido');
    }
  } catch (err: any) {
    // Un timeout no condena: un CDN lento no es un CDN caído. Y pasarse del tope de bytes tampoco
    // —al revés: significa que el host está mandando el fichero, que es la prueba de vida más
    // rotunda que hay—. Cualquier otro fallo de conexión sí condena.
    const codigo = err?.code || err?.errno || err?.cause?.code;
    const esTimeout = codigo === 'ECONNABORTED' || codigo === 'ETIMEDOUT';
    const seLePasoElTope = /maxContentLength/i.test(String(err?.message || ''));
    if (!esTimeout && !seLePasoElTope) condenar('no-responde');
  }

  const sondeo: Sondeo = { vivo, motivo, cors };
  hostCache.set(clave, { sondeo, expira: Date.now() + HOST_TTL_MS });
  return sondeo;
}

/** `sondearDestino` cuando solo interesa el sí o el no. */
export async function hostAlcanzable(
  url: string,
  referer: string,
  esperaManifiesto = false,
  entregaLiteral = false
): Promise<boolean> {
  return (await sondearDestino(url, referer, esperaManifiesto, entregaLiteral)).vivo;
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
export async function revisarManifiesto(
  manifiesto: string,
  urlBase: string,
  referer: string
): Promise<EstadoManifiesto> {
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
    let absolutaCruda = limpia;
    try {
      absolutaCruda = new URL(limpia, urlBase).toString();
    } catch {}
    const host = hostDe(limpia, urlBase);
    const esPlaylist = /\.m3u8(\?|$)/i.test(absolutaCruda);
    if (host && !(await hostAlcanzable(absolutaCruda, referer, esPlaylist))) {
      muertos.add(host);
      // Quitar también la etiqueta de cabecera que acabábamos de escribir, si la había.
      if (salida.length && /^#EXT-X-STREAM-INF/i.test(salida[salida.length - 1].trim())) salida.pop();
      continue;
    }

    vivas++;
    salida.push(absolutaCruda);
  }

  return {
    muerto: total > 0 && vivas === 0,
    parcial: vivas > 0 && muertos.size > 0,
    cuerpo: salida.join('\n'),
    muertos: [...muertos],
  };
}

/** ¿Son bytes de vídeo? Una página de error también viaja con 200 y con su Content-Length. */
function pareceVideo(buf: Buffer): boolean {
  if (buf.length < 16) return false;
  const cabecera = buf.slice(0, 400).toString('latin1');
  if (/^\s*<(!doctype|html|\?xml)/i.test(cabecera)) return false;
  // MPEG-TS empieza por 0x47; fMP4 declara `ftyp`/`moof`/`styp` en los primeros bytes. Se acepta
  // lo desconocido: hay CDN que sirven contenedores raros y no se va a condenar un vídeo por eso.
  return true;
}

/**
 * Baja hasta un SEGMENTO de verdad y comprueba que se puede descargar.
 *
 * Es el escalón que faltaba. Comprobar el maestro y sus variantes deja fuera el fallo más
 * frecuente de todos —la playlist está perfecta y los segmentos dan 404 o 403—, y ese fallo llega
 * al cliente de la peor manera: la API contesta 200, el reproductor arranca, y la reproducción se
 * cae cuando ya nadie va a intentar otro servidor.
 *
 * Se pide solo el primer kilobyte con `Range`, así que cuesta lo que una cabecera aunque el
 * segmento pese megabytes. Y se hace UNA vez por acuñado, porque el veredicto se cachea.
 *
 * Devuelve `true` también cuando no hay nada que comprobar (un manifiesto sin segmentos a la
 * vista): lo que no se ha podido medir no se condena.
 */
export async function segmentoDescargable(
  manifiesto: string,
  urlBase: string,
  referer: string
): Promise<boolean> {
  const uris = manifiesto.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (!uris.length) return true;

  let objetivo: string;
  try {
    objetivo = new URL(uris[0], urlBase).toString();
  } catch {
    return true;
  }

  // Si el primer nivel es otra playlist, se baja un escalón más para llegar al segmento.
  if (/\.m3u8(\?|$)/i.test(objetivo)) {
    const variante = await bajarManifiesto(objetivo, referer);
    if (!variante) return true;
    const hijos = variante.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (!hijos.length) return true;
    try {
      objetivo = new URL(hijos[0], objetivo).toString();
    } catch {
      return true;
    }
    if (/\.m3u8(\?|$)/i.test(objetivo)) return true; // tres niveles: se deja pasar
  }

  try {
    const res = await streamClient.get(objetivo, {
      headers: { Referer: referer, Range: 'bytes=0-1023' },
      responseType: 'arraybuffer',
      timeout: 10000,
      validateStatus: () => true,
    });
    // Un 403 se perdona igual que arriba: puede ser una cabecera que solo el reproductor pone.
    if (res.status === 404 || res.status === 410) return false;
    if (res.status >= 500) return false;
    if (res.status >= 200 && res.status < 300) return pareceVideo(Buffer.from(res.data));
    return true;
  } catch (err: any) {
    const codigo = err?.code || err?.errno || err?.cause?.code;
    return codigo === 'ECONNABORTED' || codigo === 'ETIMEDOUT';
  }
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
