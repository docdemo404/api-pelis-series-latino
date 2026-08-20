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

/**
 * 4 MB, y bajó de 8 por una razón medida.
 *
 * archive.org cobra entre 10 y 25 s solo hasta el primer byte, y luego da ~1,1 MB/s. Con trozos
 * de 8 MB, traer uno frío llegaba a los 32 s y Cloudflare cortaba la petición con un 503: la
 * PRIMERA reproducción de cada película fallaba, y solo funcionaba a partir de la segunda, cuando
 * el trozo ya estaba en R2.
 *
 * Con 4 MB el traspaso baja a la mitad. Y sobre todo, ahora la respuesta va en streaming (ver
 * `servirConCache`), así que el reloj de la petición ya no espera a tener el trozo entero.
 */
const TROZO = 4 * 1024 * 1024;

/** Lo que se espera como mucho al origen. archive.org tarda hasta 25 s solo en el primer byte. */
const TOPE_ORIGEN_MS = 45_000;

/** Cuántas veces se le insiste al origen cuando contesta 5xx. Ver `traerTrozo`. */
const INTENTOS_ORIGEN = 3;

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

  /**
   * SE INSISTE CUANDO EL ORIGEN DA 5xx, en vez de rendirse a la primera.
   *
   * archive.org devuelve 500, 502 y 503 a puñados cuando va cargado —se vio en el mismo fichero
   * que un minuto antes servía bien—, y eso no dice nada sobre el fichero: dice que el host está
   * teniendo un mal momento. Rendirse ahí le da al espectador un error sobre una película que
   * está perfectamente ahí.
   *
   * Tres intentos con espera creciente. Un 4xx no se reintenta: eso sí es el host declarando algo
   * sobre el recurso.
   */
  let respuesta = null;
  for (let intento = 1; intento <= INTENTOS_ORIGEN; intento++) {
    respuesta = await fetch(url, {
      headers: { 'User-Agent': UA, Range: `bytes=${inicio}-${fin}` },
      signal: AbortSignal.timeout(TOPE_ORIGEN_MS),
    });
    if (respuesta.status < 500) break;
    if (intento < INTENTOS_ORIGEN) await new Promise(r => setTimeout(r, 500 * intento));
  }

  if (respuesta.status === 206) {
    /**
     * SE SIRVE MIENTRAS SE GUARDA, no después.
     *
     * Antes esto hacía `await respuesta.arrayBuffer()`: esperaba a tener el trozo ENTERO en
     * memoria, lo guardaba, y solo entonces contestaba. Con un origen que tarda 25 s en soltar el
     * primer byte eso se iba a los 32 s y Cloudflare cortaba la petición con un 503 — o sea que
     * la primera vez que alguien abría una película, fallaba; a la segunda ya iba, porque el
     * trozo había quedado en R2 de todas formas. Un fallo que se cura solo es peor que uno
     * constante: parece cosa de la red.
     *
     * `tee()` parte el stream en dos: una mitad sale hacia el reproductor en cuanto llegan los
     * primeros bytes, la otra se va a R2 por su cuenta con `waitUntil`. Nadie espera a nadie.
     */
    const total = totalDe(respuesta);
    const [paraElCliente, paraGuardar] = respuesta.body.tee();

    ctx.waitUntil(
      env.CACHE.put(llaveDe(url, indice), paraGuardar, {
        customMetadata: { total: String(total), visto: String(Date.now()) },
      }).catch(() => null)
    );

    return { stream: paraElCliente, total };
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

/**
 * El trozo, de R2 si está y del origen si no.
 *
 * Devuelve un STREAM y no bytes: ni siquiera lo que sale de R2 se materializa en memoria. Con
 * trozos de 4 MB y varias reproducciones a la vez, cargarlos enteros es la forma más rápida de
 * que el Worker se quede sin memoria por nada.
 */
async function trozo(env, url, indice, ctx) {
  const guardado = await env.CACHE.get(llaveDe(url, indice));
  if (guardado) {
    const total = Number(guardado.customMetadata?.total) || 0;
    return { stream: guardado.body, tamano: guardado.size, total, deCache: true };
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

  const { desde, hasta } = rangoPedido(request.headers.get('Range'));
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
  /*
   * DOS TROZOS POR DELANTE, no uno.
   *
   * Con uno solo la cuenta salía justa y por eso se seguía notando lento: un trozo son unos 30 s
   * de película, y traerlo de archive.org cuesta hasta 32 s entre latencia y traspaso. O sea que
   * el adelanto llegaba al mismo tiempo que se necesitaba, y cualquier tropiezo se veía como un
   * parón.
   *
   * Con dos hay un trozo entero de colchón. Y como los dos se piden a la vez, la latencia se paga
   * UNA sola vez para los dos — medido: cuatro peticiones en paralelo a archive.org traen 1 MB en
   * 11,7 s contra 24,8 s de una sola.
   */
  if (hayMas) {
    for (const siguiente of [indice + 1, indice + 2]) {
      if (total && siguiente * TROZO >= total) break;
      ctx.waitUntil(
        env.CACHE.head(llaveDe(url, siguiente))
          .then(existe => (existe ? null : traerTrozo(env, url, siguiente, ctx)))
          .catch(() => null)
      );
    }
  }

  /**
   * SE CONTESTA CON EL STREAM TAL CUAL, sin recortar.
   *
   * El trozo empieza donde el reproductor pidió o antes, y el `Content-Range` dice exactamente
   * qué tramo va dentro. Un cliente HTTP sabe leer eso y quedarse con lo que necesita — es lo
   * mismo que hace cualquier CDN cuando te sirve un bloque alineado.
   *
   * Recortar obligaría a tener el trozo entero en memoria para cortarlo, que es justo lo que
   * causaba los 503 en la primera reproducción. Servir de más cuesta unos megas; servir tarde
   * cuesta la película.
   */
  const inicioTrozo = indice * TROZO;
  const tamano = datos.tamano ?? (total ? Math.min(TROZO, total - inicioTrozo) : TROZO);
  const ultimoByte = inicioTrozo + tamano - 1;

  const cabeceras = {
    ...CORS,
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${inicioTrozo}-${ultimoByte}/${total || '*'}`,
    'X-Cache': datos.deCache ? 'HIT' : 'MISS',
  };

  return new Response(datos.stream, { status: 206, headers: cabeceras });
}
