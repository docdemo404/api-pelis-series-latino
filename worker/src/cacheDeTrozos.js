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
  /*
   * `v2` y no `v1`: hubo una tanda de trozos escritos con el tamaño de fichero equivocado (ver
   * `relevarDelOrigen`). Un apunte malo en la caché no se cura solo ni se va con un despliegue, y
   * salir a borrarlos uno a uno es más frágil que dejarlos morir olvidados. Cambiar el prefijo los
   * jubila de golpe; lo único que cuesta es volver a calentar la caché.
   */
  return `v2/${id}/${String(indice).padStart(6, '0')}`;
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
/**
 * Cuántos trozos se dejan escritos en R2 mientras se sirve la cola desde el origen.
 *
 * Hay tope porque cada escritura cuenta como subpetición y el plan gratuito da pocas. Doce trozos
 * son ~48 MB: bastante para que la próxima vez el arranque y los primeros minutos salgan de la
 * caché, que es donde se nota la espera.
 */
const TROZOS_QUE_SE_GUARDAN = 12;

/**
 * Vuelca un stream en el escritor y devuelve CUÁNTOS BYTES escribió.
 *
 * Lo de devolver la cuenta no es un detalle: quien lee de la caché tiene que avanzar por lo que
 * de verdad salió, no por lo que se suponía que había. Ver `cuerpoContinuo`.
 */
async function volcar(origen, escritor) {
  const lector = origen.getReader();
  let escritos = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) return escritos;
    await escritor.write(value);
    escritos += value.length;
  }
}

/** Pide al origen desde `desde` hasta `hasta`, insistiendo si contesta 5xx. */
async function pedirAlOrigen(url, desde, hasta) {
  const rango = 'bytes=' + desde + '-' + (hasta === null ? '' : hasta);
  let respuesta = null;
  for (let intento = 1; intento <= INTENTOS_ORIGEN; intento++) {
    /*
     * CON TOPE. Sin él, una conexión que el origen acepta y luego no alimenta deja el Worker
     * esperando hasta que Cloudflare lo corta por su cuenta — y eso sale como un 500, que es la
     * peor forma de fallar: no dice nada y el reproductor no aprende nada.
     */
    respuesta = await fetch(url, {
      headers: { 'User-Agent': UA, Range: rango },
      signal: AbortSignal.timeout(TOPE_ORIGEN_MS),
    });
    if (respuesta.status < 500) break;
    if (respuesta.body) respuesta.body.cancel();
    if (intento < INTENTOS_ORIGEN) await new Promise(r => setTimeout(r, 500 * intento));
  }
  return respuesta;
}

/**
 * Escribe en `escritor` los bytes de una respuesta del origen. NO GUARDA NADA, y eso es el arreglo.
 *
 * Guardaba: iba juntando lo que pasaba hasta completar un trozo y lo escribía en R2. Parecía
 * gratis —los bytes ya estaban de camino— y no lo era, porque juntar 4 MB significa tenerlos en
 * memoria, y completar el trozo significa copiarlos otra vez para partirlos. Tres copias de 4 MB
 * por trozo. Con la ráfaga de seis en paralelo eso son más de setenta megas de golpe, y el Worker
 * tiene ciento veintiocho: se quedaba sin memoria A MITAD DEL ENVÍO.
 *
 * Y morirse a mitad del envío es la peor forma de fallar aquí, porque las cabeceras ya salieron
 * diciendo cuánto iba a medir la respuesta. El cliente recibe menos de lo prometido. Un navegador
 * lo perdona —vuelve a pedir lo que falta y sigue tan tranquilo—, pero media3 no: da el fichero
 * por terminado. De ahí venía exactamente lo que se reportó, que el navegador reproduce una
 * película y la app no.
 *
 * Medido por el camino de entrega: cuatro de doce entregaban el índice a medias —una, 1.066.553
 * bytes de los 5.267.222 que había prometido—. Sin guardar nada, la memoria deja de ser un
 * problema y los bytes salen tal como vienen.
 *
 * La caché se sigue llenando, solo que donde toca: en la lectura por delante y en el calentador,
 * que usan `traerTrozo` y escriben en R2 con un `tee()` — sin juntar nada en memoria.
 */
async function relevarDelOrigen(escritor, respuesta, saltar) {
  let porTirar = saltar;
  const lector = respuesta.body.getReader();
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    let util = value;
    if (porTirar > 0) {
      if (porTirar >= util.length) { porTirar -= util.length; continue; }
      util = util.subarray(porTirar);
      porTirar = 0;
    }
    await escritor.write(util);
  }
}

/**
 * SIRVE DESDE `desde` HASTA `hasta`, SIN CORTAR EN EL TROZO.
 *
 * Aquí estaba el fallo que rompía la reproducción entera, y era mío: se contestaba UN trozo y se
 * cerraba. Parecía correcto porque el `Content-Range` decía la verdad —qué tramo iba dentro y
 * cuánto medía el fichero entero— y cualquier cliente educado habría pedido el siguiente.
 *
 * media3 no lo hace. Cuando pide `bytes=N-` sin final, toma el `Content-Length` de la respuesta
 * como el tamaño del RECURSO: lee esos 4 MB, se le acaban, y da la película por terminada. Ni
 * error ni reintento — se acabó, y el reproductor salta al final.
 *
 * Y encaja con todo lo que se venía viendo sin explicación: 4 MB son unos diez segundos de
 * película, y «Misión Rescate» moría exactamente a los 10,875 s. Lo que parecía un CDN lento o un
 * host caído era esto. En «Destino final» ni siquiera arrancaba: su índice `moov` pesa 7,5 MB, o
 * sea que con 4 MB el reproductor no llegaba nunca a saber cuánto duraba ni dónde estaba nada.
 *
 * Ahora la respuesta va HASTA EL FINAL, en dos tramos: primero los trozos que ya están en R2 —el
 * arranque instantáneo— y cuando falta uno, UNA sola petición al origen desde ahí hasta el final.
 * Una, no una por trozo: el plan gratuito cuenta subpeticiones y quinientas no caben en ningún
 * límite.
 */
function cuerpoContinuo(env, url, desde, hasta, ctx, respuestaYaAbierta, saltarDeEsa, totalFichero) {
  const { readable, writable } = new TransformStream();

  const bombear = async () => {
    const escritor = writable.getWriter();
    try {
      if (respuestaYaAbierta) {
        // Ya se pidió al origen ahí arriba para saber el tamaño; se aprovecha esa misma
        // respuesta en vez de volver a llamar.
        await relevarDelOrigen(escritor, respuestaYaAbierta, saltarDeEsa);
      } else {
        let pos = desde;

        // --- tramo 1: lo que ya está en casa ---
        while (pos <= hasta) {
          const indice = Math.floor(pos / TROZO);
          const inicioTrozo = indice * TROZO;
          const guardado = await env.CACHE.get(llaveDe(url, indice), {
            range: { offset: pos - inicioTrozo },
          }).catch(() => null);
          if (!guardado || !guardado.body) break;

          /*
           * SE AVANZA POR LO QUE SALIÓ, NO POR LO QUE DEBERÍA HABER SALIDO.
           *
           * Antes esto hacía `pos = inicioTrozo + TROZO`, dando por hecho que todo trozo guardado
           * mide un trozo entero. No siempre es verdad: si el origen corta una descarga a medias,
           * en R2 queda un trozo corto bajo una llave que promete uno completo. Al leerlo se
           * escribían menos bytes de los que se contaban, el hueco no lo rellenaba nadie, y el
           * `Content-Length` anunciado dejaba de cuadrar con lo entregado.
           *
           * Se vio midiendo el catálogo entero: «Volver al Futuro» entregaba 1.306.588 bytes de
           * índice de los 5.202.291 que había pedido. Un mp4 con el índice a medias no se puede
           * abrir.
           *
           * Contando lo escrito, el fallo se cura solo: la vuelta siguiente empieza justo donde se
           * quedó y, si en la caché no hay más, cae al origen y lo completa.
           */
          const escritos = await volcar(guardado.body, escritor);
          if (escritos <= 0) break;
          pos += escritos;
        }

        /*
         * --- tramo 2a: UNA RÁFAGA EN PARALELO PARA LOS PRIMEROS MEGAS ---
         *
         * Esta es la causa raíz de que las películas de archive.org no arrancaran, y hasta ahora
         * la estaba atacando de una en una. Se midió sobre las 21 fichas del catálogo que salen de
         * ahí: arrancaban 12, y de las 9 que no, SEIS fallaban por lo mismo — traer el índice
         * tardaba más de los 25 s que el reproductor espera.
         *
         * El problema no es el ancho de banda de archive.org, que da de sobra: es su LATENCIA. Cada
         * petición cuesta entre 10 y 25 s hasta el primer byte, y el índice de una película larga
         * son varios trozos. En fila, esos segundos se suman; en paralelo se pagan UNA vez.
         * Medido: cuatro peticiones a la vez traen 1 MB en 11,7 s contra 24,8 s de una sola.
         *
         * La ráfaga está acotada a seis trozos —24 MB— por dos razones. Cubre de sobra cualquier
         * índice, que es lo que hay que resolver antes del primer fotograma; y el plan gratuito
         * cuenta subpeticiones, así que abrir una por trozo en una película de 2 GB serían
         * quinientas y no cabe. Pasados esos 24 MB manda la reproducción secuencial, y ahí una sola
         * petición continua es lo correcto: la latencia se paga una vez y los bytes fluyen.
         */
        const RAFAGA = 6;
        const enVuelo = [];
        let cursor = pos;
        for (let n = 0; n < RAFAGA && cursor <= hasta; n++) {
          const indice = Math.floor(cursor / TROZO);
          const finTrozo = Math.min((indice + 1) * TROZO - 1, hasta);
          enVuelo.push({ desde: cursor, hasta: finTrozo, promesa: pedirAlOrigen(url, cursor, finTrozo) });
          cursor = finTrozo + 1;
        }

        for (const tramo of enVuelo) {
          const respuesta = await tramo.promesa;
          if (!respuesta || !respuesta.ok || !respuesta.body) {
            throw new Error('origen ' + (respuesta ? respuesta.status : 'sin respuesta'));
          }
          const saltar = respuesta.status === 200 ? tramo.desde : 0;
          await relevarDelOrigen(escritor, respuesta, saltar);
        }

        // --- tramo 2b: y el resto, ya en secuencia, de una sola petición ---
        if (cursor <= hasta) {
          const respuesta = await pedirAlOrigen(url, cursor, hasta);
          if (!respuesta || !respuesta.ok || !respuesta.body) {
            throw new Error('origen ' + (respuesta ? respuesta.status : 'sin respuesta'));
          }
          const saltar = respuesta.status === 200 ? cursor : 0;
          await relevarDelOrigen(escritor, respuesta, saltar);
        }
      }
    } catch (e) {
      // Las cabeceras salieron hace rato, así que no se puede cambiar el status: se corta, y el
      // reproductor lo trata como lo que es — una descarga interrumpida.
      await escritor.abort(e).catch(() => {});
      return;
    }
    await escritor.close().catch(() => {});
  };

  ctx.waitUntil(bombear());
  return readable;
}

export async function servirConCache(request, env, ctx, url) {
  if (!env.CACHE) {
    // Sin bucket configurado esto no puede funcionar; se dice claro en vez de fallar raro.
    return new Response('R2 no está configurado en este Worker', { status: 501, headers: CORS });
  }

  const { desde, hasta } = rangoPedido(request.headers.get('Range'));
  const indiceActual = Math.floor(desde / TROZO);

  /**
   * EL TAMAÑO SE AVERIGUA SIN GASTAR UN VIAJE DE MÁS.
   *
   * Hay que saber cuánto mide el fichero ANTES de contestar, porque el `Content-Range` lo lleva.
   * La primera versión lo preguntaba con una petición aparte (`bytes=0-0`) y eso costó la
   * reproducción: archive.org tarda entre 10 y 25 s en contestar CUALQUIER cosa, así que la
   * cabecera salía a los 25 s y el reproductor ya se había ido al siguiente servidor.
   *
   * Si el primer trozo está en caché, el tamaño está anotado ahí y no se toca la red. Si no está,
   * se hace la petición que hacía falta de todas formas —la de los bytes— y se le saca el tamaño
   * a su `Content-Range`. Un viaje, no dos.
   */
  const cabeza = await env.CACHE.head(llaveDe(url, indiceActual)).catch(() => null);
  const anotado = Number(cabeza && cabeza.customMetadata && cabeza.customMetadata.total);

  let total = Number.isFinite(anotado) && anotado > 0 ? anotado : 0;
  let respuestaYaAbierta = null;
  let saltarDeEsa = 0;

  if (!total) {
    /*
     * ESTO IBA SIN RED Y SE NOTABA. `pedirAlOrigen` puede LANZAR —se agota el tope, el origen
     * corta la conexión, el DNS falla— y aquí no lo recogía nadie: el Worker contestaba 500.
     *
     * Un 500 es una respuesta que no dice nada. Se midió sobre las 21 películas de archive.org del
     * catálogo y salían a puñados, mezclados con fallos de otra naturaleza, así que ni siquiera se
     * podía separar «el origen no está» de «hay un fallo en este código». Un 502 con su motivo sí
     * se puede leer, y además el reproductor lo trata como lo que es: este servidor no sirve,
     * prueba otro.
     */
    let respuesta = null;
    try {
      respuesta = await pedirAlOrigen(url, desde, hasta);
    } catch (e) {
      return new Response('el origen no contestó a tiempo: ' + e.message, { status: 502, headers: CORS });
    }
    if (!respuesta || !respuesta.ok || !respuesta.body) {
      return new Response('el origen no sirvió el vídeo: ' + (respuesta ? respuesta.status : 'sin respuesta'), {
        status: 502,
        headers: CORS,
      });
    }
    total = totalDe(respuesta);
    // Con un 200 el `Content-Length` es el fichero entero contando desde cero, así que el total
    // es ese; y hay que tirar todo lo anterior a `desde`.
    if (respuesta.status === 200) saltarDeEsa = desde;
    if (!total) {
      if (respuesta.body) respuesta.body.cancel();
      return new Response('el origen no dice cuánto mide el fichero', { status: 502, headers: CORS });
    }
    respuestaYaAbierta = respuesta;
  }

  if (desde >= total) {
    if (respuestaYaAbierta && respuestaYaAbierta.body) respuestaYaAbierta.body.cancel();
    return new Response('rango fuera del fichero', {
      status: 416,
      headers: { ...CORS, 'Content-Range': 'bytes */' + total },
    });
  }

  const ultimo = hasta === null ? total - 1 : Math.min(hasta, total - 1);

  /**
   * LECTURA POR DELANTE, Y AHORA TAMBIÉN EN EL CAMINO FRÍO — que es donde hacía falta.
   *
   * La había quitado del camino frío razonando que esta misma petición ya iba a llenar los trozos
   * al pasar. Era falso, y el aparato lo dejó claro: en un mp4 grande el reproductor lee el ÍNDICE
   * y se detiene ahí. Medido, entraron 7.346 KB —el tamaño exacto del `moov` de esa película— y ni
   * un byte más: leído el índice, media3 cierra esa petición y abre otra en el punto donde empieza
   * el vídeo de verdad.
   *
   * O sea que la petición que importa es la SEGUNDA, y llegaba a un archive.org frío que tarda
   * entre 10 y 25 s en soltar el primer byte. La película se quedaba sin abrir por eso.
   *
   * Trayendo los dos trozos siguientes MIENTRAS el reproductor está ocupado leyendo el índice, esa
   * segunda petición se encuentra la caché caliente y arranca al momento. Es exactamente el hueco
   * de tiempo que había que aprovechar, y estaba desaprovechado.
   */
  const porDelante = [indiceActual + 1, indiceActual + 2];

  /**
   * Y LA COLA DEL FICHERO, cuando se está abriendo por el principio.
   *
   * Un mp4 puede llevar su índice `moov` al principio —«faststart»— o AL FINAL. Los de archive.org
   * suelen llevarlo al final: se comprobó en «El diario íntimo de una cabaretera», cuyas primeras
   * cajas son `ftyp`, `free` y un `mdat` de 863 MB. No hay índice por delante.
   *
   * Con eso, lo primero que hace el reproductor es SALTAR AL FINAL a buscarlo. Ese salto cae a 869
   * MB de distancia, o sea en un trozo frío, o sea en una petición a archive.org que tarda entre
   * 10 y 25 s en dar el primer byte. Y como el índice no cabe en un solo trozo, ese peaje se paga
   * varias veces antes de que se vea un solo fotograma. La película se quedaba sin abrir.
   *
   * Traer los dos últimos trozos MIENTRAS el reproductor lee la cabecera cuesta dos peticiones y
   * convierte ese salto en una lectura de caché. Solo se hace al abrir por el principio: en un
   * salto a mitad de película no hay ninguna razón para pensar que alguien va a querer el final.
   */
  if (indiceActual === 0) {
    /*
     * CUATRO TROZOS DE COLA, y no dos. Con dos seguía sin arrancar, y la cuenta dice por qué: en
     * «El diario íntimo de una cabaretera» el `mdat` acaba en el byte 863.099.777 de 869.670.784,
     * o sea que el índice ocupa los últimos 6,5 MB — más de lo que caben en dos trozos de 4. El
     * reproductor leía la parte precargada y se caía a un trozo frío justo en medio del índice.
     *
     * Cuatro son 16 MB, con margen para los índices de una película larga. Solo se traen al abrir
     * por el principio, así que es una vez por película y no por reproducción.
     */
    const ultimoTrozo = Math.floor((total - 1) / TROZO);
    for (let n = 0; n < 4; n++) {
      const cola = ultimoTrozo - n;
      if (cola > indiceActual + 2) porDelante.push(cola);
    }
  }

  for (const siguiente of porDelante) {
    if (siguiente < 0 || siguiente * TROZO >= total) continue;
    /*
     * Y SE CONSUME LO QUE VUELVE, aunque aquí no interese.
     *
     * `traerTrozo` parte el stream con `tee()`: una mitad para quien lo pidió y otra para R2. En
     * la lectura por delante nadie pide nada —solo se quiere llenar la caché—, así que esa mitad
     * quedaba sin leer. Una rama de un `tee()` que nadie lee NO se descarta: frena a la otra y la
     * memoria crece hasta que Cloudflare tumba el Worker con un 500. Salían a puñados al medir el
     * catálogo entero, y parecían cosa de archive.org.
     */
    ctx.waitUntil(
      env.CACHE.head(llaveDe(url, siguiente))
        .then(existe => (existe ? null : traerTrozo(env, url, siguiente, ctx)))
        .then(traido => (traido && traido.stream ? traido.stream.cancel() : null))
        .catch(() => null)
    );
  }

  return new Response(cuerpoContinuo(env, url, desde, ultimo, ctx, respuestaYaAbierta, saltarDeEsa, total), {
    status: 206,
    headers: {
      ...CORS,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Range': 'bytes ' + desde + '-' + ultimo + '/' + total,
      'Content-Length': String(ultimo - desde + 1),
      'X-Cache': respuestaYaAbierta ? 'MISS' : 'HIT',
    },
  });
}

/**
 * DEJA EL ÍNDICE DE UNA PELÍCULA EN R2 ANTES DE QUE NADIE LA ABRA.
 *
 * Esto es lo que faltaba, y es la diferencia entre arreglar películas y arreglar el problema.
 *
 * Todo lo demás de este fichero hace la reproducción más rápida, pero alguien sigue pagando el
 * arranque frío: el PRIMERO que abre cada película. Y con archive.org ese primero muchas veces no
 * llega — se midió sobre las 21 fichas del catálogo que salen de ahí y seis fallaban por lo mismo,
 * que traer el índice tardaba más de los 25 s que el reproductor aguanta.
 *
 * Ese trabajo no tiene por qué hacerlo un espectador. El barrido que comprueba los enlaces ya
 * pasa por todas las películas cada veinte minutos, no tiene prisa, y puede tardar lo que haga
 * falta. Llamando aquí desde ahí, cuando alguien abre una película el índice ya está en casa.
 *
 * Se calientan los tres primeros trozos y los CUATRO últimos: un mp4 puede llevar el índice
 * delante o detrás, y desde fuera no se sabe cuál sin mirar el fichero. Cuatro por detrás porque
 * un índice de película larga pasa de los 6 MB y con dos se queda a medias.
 */
export async function calentarIndice(env, ctx, url) {
  if (!env.CACHE) return { ok: false, motivo: 'sin R2' };

  let total = 0;
  try {
    const sonda = await pedirAlOrigen(url, 0, 0);
    if (!sonda || !sonda.ok) return { ok: false, motivo: 'origen ' + (sonda ? sonda.status : 'mudo') };
    total = totalDe(sonda);
    if (sonda.body) sonda.body.cancel();
  } catch (e) {
    return { ok: false, motivo: e.message };
  }
  if (!total) return { ok: false, motivo: 'el origen no dice el tamaño' };

  const ultimo = Math.floor((total - 1) / TROZO);
  const quiero = [0, 1, 2, ultimo, ultimo - 1, ultimo - 2, ultimo - 3]
    .filter(i => i >= 0 && i <= ultimo)
    .filter((i, n, lista) => lista.indexOf(i) === n);

  /*
   * EN PARALELO PERO DE TRES EN TRES, y consumiendo lo que se trae.
   *
   * Las dos cosas se aprendieron fallando. Con los siete a la vez el Worker contestaba 503 —el
   * límite de recursos de Cloudflare— y no por el número de peticiones: `traerTrozo` parte el
   * stream en dos con `tee()`, una mitad para quien pidió y otra para R2, y aquí solo interesaba
   * la de R2. Una rama de un `tee()` que nadie lee no se descarta: frena a la otra y la memoria
   * crece hasta que el Worker cae. Hay que beberse la mitad que no se usa.
   *
   * Y de tres en tres porque con archive.org lo que cuesta es la latencia, no el ancho de banda:
   * tres a la vez la pagan una sola vez sin acercarse a ningún límite.
   */
  const hechos = [];
  for (let i = 0; i < quiero.length; i += 3) {
    const tanda = quiero.slice(i, i + 3);
    const resultados = await Promise.all(tanda.map(async indice => {
      const ya = await env.CACHE.head(llaveDe(url, indice)).catch(() => null);
      if (ya) return 'ya';
      try {
        const traido = await traerTrozo(env, url, indice, ctx);
        if (traido && traido.stream) await traido.stream.cancel().catch(() => {});
        return 'traído';
      } catch {
        return 'falló';
      }
    }));
    hechos.push(...resultados);
  }

  return {
    ok: hechos.filter(h => h === 'falló').length === 0,
    total,
    trozos: quiero.length,
    traidos: hechos.filter(h => h === 'traído').length,
    yaEstaban: hechos.filter(h => h === 'ya').length,
    fallaron: hechos.filter(h => h === 'falló').length,
  };
}
