/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CACHÉ POR TROZOS: lo que hace que el catálogo se vea rápido, venga de donde venga.
 *
 * Los cinco hosts del catálogo fallan por cosas distintas, y todas se arreglan poniendo esto
 * delante. Medido el 2026-08-20:
 *
 *   host                servidores   TTFB      velocidad    su problema
 *   1a-1791.com (Rumble)    101      1,0 s     1,1 MB/s     ninguno grave
 *   files.eintim.me          98      2,1 s     9,7 MB/s     IGNORA EL `Range`
 *   archive.org             ~20     10-25 s    1,1 MB/s     latencia brutal
 *   firestream.to           ~15      4,4 s     0,7 MB/s     poco ancho de banda
 *   cdn.rumble.cloud        ~10      4,4 s     1,9 MB/s     ninguno grave
 *
 * `files.eintim.me` es el más rápido del catálogo y el que más rompe la reproducción: al mismo
 * rango de en medio contestó `206` una vez y `200` las cinco siguientes. Un `200` a un rango de
 * en medio significa mandar el fichero DESDE EL PRINCIPIO, así que al saltar al minuto 40 el
 * reproductor se queda descargando cientos de megas que no necesita. Son la mitad del catálogo.
 *
 * archive.org es lo contrario: el ancho de banda le sobra (1,1 MB/s ≈ 9 Mbps) pero cobra ~10 s
 * hasta el primer byte EN CADA PETICIÓN, y no cachea nada — el mismo trozo pedido tres veces
 * cuesta lo mismo las tres. Como cada salto es una conexión nueva, cada salto son diez segundos.
 *
 * ─── Qué hace esto ──────────────────────────────────────────────────────────────────────────
 *
 * 1. Parte el fichero en TROZOS FIJOS de 8 MB. Da igual qué rango pida el cliente: por dentro
 *    siempre se trabaja con los mismos trozos, y por eso se pueden cachear y reutilizar.
 * 2. Busca el trozo en R2. Si está, se sirve desde ahí: milisegundos, y R2 no cobra tráfico de
 *    salida — que es justo lo caro de servir vídeo.
 * 3. Si no está, lo pide al origen y lo sirve al cliente MIENTRAS lo escribe en R2, no después.
 *    El primero que ve la película no espera dos veces.
 * 4. Si el origen ignora el `Range` y contesta 200, no se pelea con él: lee ese stream secuencial
 *    y va llenando TODOS los trozos por los que pasa. Con eintim a 9,7 MB/s, un solo 200 llena
 *    decenas de trozos en segundos — su defecto se convierte en la forma más rápida de calentar
 *    la caché.
 * 5. Al pedir el trozo N lanza el N+1 en segundo plano. Mientras el reproductor consume 8 MB
 *    —unos 30 s de película— la latencia del siguiente ya se está pagando. Después del primer
 *    trozo, los diez segundos de archive.org dejan de existir.
 * 6. SIEMPRE responde `206` con su `Content-Range`. El cliente ve un host que se comporta, venga
 *    de donde venga.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** 8 MB. Grande para que una película entera quepa en pocos cientos de trozos, y pequeño para
 *  que el primero llegue pronto: a 1,1 MB/s son unos 7 s, y el reproductor arranca con mucho menos. */
const TROZO = 8 * 1024 * 1024;

/** Lo que se espera como mucho al origen. archive.org tarda hasta 25 s solo en el primer byte. */
const TOPE_ORIGEN_MS = 45_000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Range,Content-Length,Accept-Ranges',
};

/**
 * La llave con la que se guarda un trozo.
 *
 * Lleva la url entera dentro (en base64url) y no un hash, a propósito: así se puede mirar el
 * bucket y saber qué hay, y sobre todo se puede BORRAR todo lo de un fichero sin llevar un índice
 * aparte. El precio es una llave larga, que a R2 le da igual.
 */
function llaveDe(url, indice) {
  const id = btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `v1/${id}/${String(indice).padStart(6, '0')}`;
}

/** El rango que pide el cliente, o el trozo cero si no pide ninguno. */
function rangoPedido(cabecera) {
  const m = /bytes=(\d+)-(\d*)/i.exec(String(cabecera || ''));
  if (!m) return { desde: 0, hasta: null };
  return { desde: Number(m[1]), hasta: m[2] ? Number(m[2]) : null };
}

/** El tamaño total del fichero, leído de donde el origen lo diga. */
function totalDe(respuesta) {
  const cr = respuesta.headers.get('content-range') || '';
  const m = /\/(\d+)\s*$/.exec(cr);
  if (m) return Number(m[1]);
  const cl = Number(respuesta.headers.get('content-length'));
  return Number.isFinite(cl) && cl > 0 ? cl : 0;
}

/**
 * Trae UN trozo del origen y lo deja en R2. Devuelve sus bytes.
 *
 * Aquí está el apaño que convierte el defecto de eintim en una ventaja. Se pide con `Range`; si
 * el origen contesta 206, perfecto. Si contesta 200 —o sea que va a mandar el fichero entero
 * desde el principio— no se aborta: se lee ese stream y se van guardando TODOS los trozos por los
 * que pasa hasta llegar al que se quería. Cuesta descargar de más una vez, y a cambio la caché
 * queda caliente para todo lo que venga después.
 */
async function traerTrozo(env, url, indice, ctx) {
  const inicio = indice * TROZO;
  const fin = inicio + TROZO - 1;

  const respuesta = await fetch(url, {
    headers: { 'User-Agent': UA, Range: `bytes=${inicio}-${fin}` },
    signal: AbortSignal.timeout(TOPE_ORIGEN_MS),
  });

  if (respuesta.status === 206) {
    const bytes = new Uint8Array(await respuesta.arrayBuffer());
    const total = totalDe(respuesta);
    ctx.waitUntil(env.CACHE.put(llaveDe(url, indice), bytes, {
      customMetadata: { total: String(total), visto: String(Date.now()) },
    }));
    return { bytes, total };
  }

  if (respuesta.status !== 200) {
    throw new Error(`el origen contestó ${respuesta.status}`);
  }

  /**
   * El origen ignoró el rango. Se lee de corrido guardando por el camino.
   *
   * Se para al llegar al trozo pedido: seguir sería descargar la película entera por una petición.
   * Lo que ya se ha guardado hasta ahí queda en R2 y sirve para las siguientes.
   */
  const total = totalDe(respuesta);
  const lector = respuesta.body.getReader();
  let acumulado = new Uint8Array(0);
  let trozoActual = 0;
  let devolver = null;

  while (true) {
    const { done, value } = await lector.read();
    if (done) break;

    const junto = new Uint8Array(acumulado.length + value.length);
    junto.set(acumulado);
    junto.set(value, acumulado.length);
    acumulado = junto;

    while (acumulado.length >= TROZO) {
      const completo = acumulado.slice(0, TROZO);
      acumulado = acumulado.slice(TROZO);
      const esteIndice = trozoActual++;
      ctx.waitUntil(env.CACHE.put(llaveDe(url, esteIndice), completo, {
        customMetadata: { total: String(total), visto: String(Date.now()) },
      }));
      if (esteIndice === indice) devolver = completo;
    }

    if (devolver) { try { await lector.cancel(); } catch { /* ya cerrado */ } break; }
  }

  // El último trozo del fichero no llega a 8 MB: se guarda igual.
  if (!devolver && acumulado.length) {
    const esteIndice = trozoActual;
    ctx.waitUntil(env.CACHE.put(llaveDe(url, esteIndice), acumulado, {
      customMetadata: { total: String(total), visto: String(Date.now()) },
    }));
    if (esteIndice === indice) devolver = acumulado;
  }

  if (!devolver) throw new Error('el origen no llegó hasta el trozo pedido');
  return { bytes: devolver, total };
}

/** El trozo, de R2 si está y del origen si no. */
async function trozo(env, url, indice, ctx) {
  const guardado = await env.CACHE.get(llaveDe(url, indice));
  if (guardado) {
    const total = Number(guardado.customMetadata?.total) || 0;
    return { bytes: new Uint8Array(await guardado.arrayBuffer()), total, deCache: true };
  }
  const traido = await traerTrozo(env, url, indice, ctx);
  return { ...traido, deCache: false };
}

/**
 * Sirve un rango de un fichero, con la caché por delante.
 *
 * `url` ya viene validada y firmada por quien llama.
 */
export async function servirConCache(request, env, ctx, url) {
  if (!env.CACHE) {
    // Sin bucket configurado esto no puede funcionar; se dice claro en vez de fallar raro.
    return new Response('R2 no está configurado en este Worker', { status: 501, headers: CORS });
  }

  const { desde } = rangoPedido(request.headers.get('Range'));
  const indice = Math.floor(desde / TROZO);

  let datos;
  try {
    datos = await trozo(env, url, indice, ctx);
  } catch (e) {
    return new Response(`no se pudo traer el vídeo: ${e.message}`, { status: 502, headers: CORS });
  }

  /**
   * LECTURA POR DELANTE: el trozo siguiente se empieza a traer ahora.
   *
   * Es lo que esconde la latencia del origen. Mientras el reproductor consume estos 8 MB —unos
   * 30 s de película— el siguiente ya se está descargando, así que cuando lo pida ya estará en
   * R2. Va con `waitUntil` para que el Worker no espere: la respuesta de ahora no se retrasa.
   */
  const total = datos.total;
  const hayMas = !total || (indice + 1) * TROZO < total;
  if (hayMas) {
    ctx.waitUntil(
      env.CACHE.head(llaveDe(url, indice + 1))
        .then(existe => (existe ? null : traerTrozo(env, url, indice + 1, ctx)))
        .catch(() => null)
    );
  }

  // Se recorta al rango que de verdad se pidió dentro del trozo.
  const inicioTrozo = indice * TROZO;
  const offset = Math.max(0, desde - inicioTrozo);
  const cuerpo = offset ? datos.bytes.slice(offset) : datos.bytes;
  const primerByte = inicioTrozo + offset;
  const ultimoByte = primerByte + cuerpo.length - 1;

  const cabeceras = {
    ...CORS,
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(cuerpo.length),
    'Content-Range': `bytes ${primerByte}-${ultimoByte}/${total || '*'}`,
    'X-Cache': datos.deCache ? 'HIT' : 'MISS',
  };

  return new Response(cuerpo, { status: 206, headers: cabeceras });
}
