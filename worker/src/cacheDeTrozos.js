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

/**
 * El tipo del fichero, SEGÚN SU EXTENSIÓN y no según lo que nos venga bien.
 *
 * Esto anunciaba `video/mp4` para todo, y mientras por aquí solo pasaban mp4 era verdad. Al
 * meter un Matroska por la caché deja de serlo, y no es una mentira inocua: hay reproductores que
 * eligen el extractor por el tipo declarado antes de olfatear el contenido, así que anunciar mp4
 * sobre un mkv es pedirle a la app que lo abra con la herramienta equivocada.
 */
function tipoDe(url) {
  const ruta = String(url).split('?')[0].toLowerCase();
  if (ruta.endsWith('.mkv')) return 'video/x-matroska';
  if (ruta.endsWith('.webm')) return 'video/webm';
  return 'video/mp4';
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
 * COPIA ACOTADA, Y SOLO CUANDO NO QUEDA OTRA.
 *
 * Este es el camino lento: toca los bytes en JS, uno a uno, y por eso se usa lo menos posible
 * (ver `volcarOrigen`). Hace dos cosas que ningún atajo del runtime sabe hacer: tirar los
 * primeros `saltar` bytes —cuando el origen ignora el `Range` y manda desde cero— y PARAR al
 * llegar a `tope`.
 *
 * Lo de parar es media reparación del 2026-09-20. Antes escribía todo lo que llegase, así que un
 * origen que contesta 200 a una petición de 4 MB volcaba la película entera en la respuesta:
 * medido contra el Worker, una petición de 4.194.304 bytes devolvió 88.166.400. La otra media es
 * que la respuesta ya no va sin medida (ver `cuerpoContinuo`).
 */
async function copiarAcotado(destino, cuerpo, saltar, tope) {
  const escritor = destino.getWriter();
  const lector = cuerpo.getReader();
  let porTirar = saltar;
  let escritos = 0;
  try {
    for (;;) {
      const { done, value } = await lector.read();
      if (done) return escritos;

      let util = value;
      if (porTirar > 0) {
        if (porTirar >= util.length) { porTirar -= util.length; continue; }
        util = util.subarray(porTirar);
        porTirar = 0;
      }

      if (escritos + util.length >= tope) {
        await escritor.write(util.subarray(0, tope - escritos));
        try { await lector.cancel(); } catch (e) { /* ya cerrado */ }
        return tope;
      }

      await escritor.write(util);
      escritos += util.length;
    }
  } finally {
    escritor.releaseLock();
  }
}

/**
 * VUELCA UNA RESPUESTA DEL ORIGEN, Y SIN TOCAR LOS BYTES SI SE PUEDE EVITAR.
 *
 * `pipeTo` no es una forma más corta de escribir el bucle: es otra cosa. El bucle trae cada
 * paquete al isolate y lo vuelve a escribir —trabajo de JS por cada 64 KB de película— y eso lo
 * paga la invocación en CPU. En el plan gratuito ese presupuesto es pequeño y NO se puede subir
 * (`CPU limits are not supported for the Free plan`), así que Cloudflare mataba la invocación a
 * mitad del envío: medido el 2026-09-20, el mismo trozo de 4 MB pedido cinco veces devolvió
 * 4.194.304, 499.712, 339.968, 400.611 y 466.147 bytes. El dato en R2 estaba entero; lo que se
 * rompía era la entrega, y para media3 una entrega a medias es el final de la película.
 *
 * Con `pipeTo` los bytes no pasan por el isolate: los mueve el runtime. El camino lento queda
 * para lo que de verdad lo necesita — un origen que ignoró el rango, o uno que anuncia más de lo
 * que cabe en lo que se pidió.
 *
 * Devuelve cuántos bytes escribió.
 */
async function volcarOrigen(destino, respuesta, saltar, tope) {
  if (saltar === 0) {
    const anunciado = Number(respuesta.headers.get('content-length'));
    if (Number.isFinite(anunciado) && anunciado > 0 && anunciado <= tope) {
      await respuesta.body.pipeTo(destino, { preventClose: true });
      return anunciado;
    }
  }
  return copiarAcotado(destino, respuesta.body, saltar, tope);
}

/**
 * SIRVE DESDE `desde` HASTA `hasta`, SIN CORTAR EN EL TROZO Y SIN PASARSE.
 *
 * El fallo original era contestar UN trozo y cerrar. Parecía correcto porque el `Content-Range`
 * decía la verdad, y cualquier cliente educado habría pedido el siguiente. media3 no lo hace:
 * cuando pide `bytes=N-` sin final toma el `Content-Length` como el tamaño del RECURSO, lee esos
 * 4 MB, se le acaban y da la película por terminada. «Misión Rescate» moría a los 10,875 s, que
 * son exactamente 4 MB de película.
 *
 * Eso se arregló entregando hasta el final. Lo que quedó roto —y se midió el 2026-09-20— es que
 * la entrega no cumplía lo prometido POR LOS DOS LADOS:
 *
 *   · de menos: el mismo trozo de 4 MB pedido cinco veces devolvió 4.194.304, 499.712, 339.968,
 *     400.611 y 466.147 bytes, con el dato entero en R2. La invocación se moría a mitad de envío
 *     por CPU, porque los bytes pasaban por un bucle en JS.
 *   · de más: una petición de 4 MB a una película de archive.org devolvió 88.166.400. El origen
 *     ignoró el rango, contestó 200, y nadie estaba poniendo el tope por arriba.
 *
 * Y las dos pasaban calladas porque la respuesta salía SIN `Content-Length`: el Worker lo ponía
 * en las cabeceras, pero al devolver un stream de longitud desconocida Cloudflare lo quita y
 * manda `chunked`. Una respuesta sin medida no la puede desmentir nadie.
 *
 * Ahora el cuerpo es un `FixedLengthStream` con la medida exacta declarada. Eso hace tres cosas:
 * devuelve el `Content-Length` a la respuesta, hace que pasarse sea imposible, y convierte
 * quedarse corto en un error visible en vez de en una película que termina antes de tiempo.
 *
 * El reparto sigue siendo el mismo, y en este orden: lo que ya está en R2 —el arranque
 * instantáneo—, una ráfaga corta al origen para amortizar su latencia de una vez, y UNA sola
 * petición para todo lo que quede. El bucle de fuera solo da otra vuelta si algún tramo entregó
 * menos de lo suyo, y entonces reintenta desde donde se quedó de verdad.
 */
function cuerpoContinuo(env, url, desde, hasta, ctx, respuestaYaAbierta, saltarDeEsa, totalFichero) {
  const { readable, writable } = new FixedLengthStream(hasta - desde + 1);

  const bombear = async () => {
    let pos = desde;
    try {
      if (respuestaYaAbierta) {
        // Ya se pidió al origen ahí arriba para saber el tamaño; se aprovecha esa misma respuesta.
        pos += await volcarOrigen(writable, respuestaYaAbierta, saltarDeEsa, hasta - pos + 1);
      }

      while (pos <= hasta) {
        const antes = pos;

        // --- tramo 1: lo que ya está en casa ---
        for (;;) {
          if (pos > hasta) break;
          const indice = Math.floor(pos / TROZO);
          const dentro = pos - indice * TROZO;

          /*
           * SE PREGUNTA CUÁNTO MIDE EL TROZO ANTES DE LEERLO, y se pide exactamente eso.
           *
           * No todo trozo guardado mide un trozo entero: si una escritura se cortó, en R2 queda
           * uno corto bajo una llave que promete 4 MB. Antes se leía a ciegas y se avanzaba
           * contando los bytes que salían, que funcionaba pero obligaba a contarlos en JS — justo
           * lo que había que dejar de hacer. Preguntando el tamaño se sabe de antemano cuánto va
           * a venir, se pide con `length` para no pasarse de lo pedido, y los bytes pueden ir
           * por `pipeTo` sin que nadie los mire.
           */
          const cabeza = await env.CACHE.head(llaveDe(url, indice)).catch(() => null);
          const disponible = cabeza ? Math.max(0, cabeza.size - dentro) : 0;
          if (disponible <= 0) break;

          const aLeer = Math.min(hasta - pos + 1, disponible);
          const guardado = await env.CACHE
            .get(llaveDe(url, indice), { range: { offset: dentro, length: aLeer } })
            .catch(() => null);
          if (!guardado || !guardado.body) break;

          await guardado.body.pipeTo(writable, { preventClose: true });
          pos += aLeer;
        }
        if (pos > hasta) break;

        /*
         * --- tramo 2: UNA RÁFAGA CORTA PARA LOS PRIMEROS MEGAS ---
         *
         * Con archive.org lo que cuesta no es el ancho de banda, es la latencia: entre 10 y 25 s
         * por petición, y el índice de una película larga son varios trozos. En fila esos
         * segundos se suman; en paralelo se pagan una vez. Medido: cuatro peticiones a la vez
         * traen 1 MB en 11,7 s contra 24,8 s de una sola.
         *
         * Acotada a seis tramos —24 MB— porque cubre cualquier índice y porque el plan gratuito
         * cuenta subpeticiones: una por trozo en una película de 2 GB serían quinientas.
         */
        const RAFAGA = 6;
        const enVuelo = [];
        let cursor = pos;
        for (let n = 0; n < RAFAGA && cursor <= hasta; n++) {
          const indice = Math.floor(cursor / TROZO);
          const finTramo = Math.min((indice + 1) * TROZO - 1, hasta);
          enVuelo.push({ desde: cursor, hasta: finTramo, promesa: pedirAlOrigen(url, cursor, finTramo) });
          cursor = finTramo + 1;
        }

        for (const tramo of enVuelo) {
          const respuesta = await tramo.promesa;
          if (!respuesta || !respuesta.ok || !respuesta.body) {
            throw new Error('origen ' + (respuesta ? respuesta.status : 'sin respuesta'));
          }
          // Si un tramo anterior se quedó corto, este ya no empieza donde se pidió: se descarta y
          // el bucle de fuera lo vuelve a pedir desde donde de verdad se está.
          if (tramo.desde !== pos) { respuesta.body.cancel(); break; }

          const saltar = respuesta.status === 200 ? tramo.desde : 0;
          pos += await volcarOrigen(writable, respuesta, saltar, tramo.hasta - tramo.desde + 1);
          if (pos !== tramo.hasta + 1) break;
        }

        // --- tramo 3: y el resto, de una sola petición ---
        if (pos === cursor && pos <= hasta) {
          const respuesta = await pedirAlOrigen(url, pos, hasta);
          if (!respuesta || !respuesta.ok || !respuesta.body) {
            throw new Error('origen ' + (respuesta ? respuesta.status : 'sin respuesta'));
          }
          const saltar = respuesta.status === 200 ? pos : 0;
          pos += await volcarOrigen(writable, respuesta, saltar, hasta - pos + 1);
        }

        /*
         * Una vuelta que no avanza ni un byte no va a avanzar en la siguiente: se corta aquí en
         * vez de dejar la petición girando hasta que Cloudflare la mate.
         */
        if (pos === antes) throw new Error('no se pudo avanzar desde el byte ' + pos);
      }

      /*
       * Cerrar un `FixedLengthStream` al que le faltan bytes LANZA, y es justo lo que se quiere:
       * el cliente ve una descarga rota en vez de una película que se acaba antes de tiempo.
       */
      await writable.close();
    } catch (e) {
      await writable.abort(e).catch(() => {});
    }
  };

  ctx.waitUntil(bombear());
  return readable;
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
      'Content-Type': tipoDe(url),
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LLENAR LA CACHÉ DE UNA PASADA, LEYENDO DE CORRIDO.
 *
 * `calentarIndice` pide siete trozos sueltos por rango, y eso vale para un origen cuyo problema
 * es la latencia (archive.org: 10-25 s por petición, vengan de donde vengan los bytes). Hay otra
 * clase de origen para el que es exactamente lo peor que se puede hacer, y se midió el 2026-09-20
 * sobre `permanent-video-share.lovable.app`:
 *
 *   una conexión desde el byte 0, 250 MB seguidos ......... 10,8 MB/s
 *   4 MB pedidos en el offset 100 MB ....................... 0,67 MB/s
 *   4 MB pedidos en el offset 1,2 GB ....................... 0,08 MB/s  (48 s)
 *   100 MB pedidos en el offset 1,2 GB ..................... 2,0 MB/s   (52 s)
 *
 * Que 4 MB y 100 MB desde el mismo sitio cuesten LO MISMO dice qué pasa: el coste no es por byte,
 * es un peaje FIJO por petición que crece con la profundidad — el origen no sabe saltar, recorre
 * el fichero desde el principio a ~25 MB/s. O sea que la forma de trabajar de la caché (un trozo
 * de 4 MB por petición) paga el peaje entero por cada 4 MB, y los trozos del final se pasan de
 * `TOPE_ORIGEN_MS` y fallan. Con un host así, la caché tal cual deja la reproducción PEOR que ir
 * directo al origen.
 *
 * Leyendo de corrido el peaje se paga UNA vez: 1,6 GB en unos dos minutos y medio, y a partir de
 * ahí cualquier salto sale de R2 al instante. Que es justo lo que el reproductor no podía hacer.
 *
 * ─── Por qué guarda por trozos y no el fichero entero de un `put` ──────────────────────────
 *
 * Porque lo que quede en R2 tiene que ser lo MISMO que escribe `traerTrozo`: mismas llaves, mismo
 * tamaño, mismos metadatos. Guardarlo bajo otra llave sería llenar R2 para nada — `servirConCache`
 * no lo encontraría.
 *
 * ─── Y por qué se puede reanudar ───────────────────────────────────────────────────────────
 *
 * Porque no se puede dar por hecho que una invocación llegue al final: hay topes de CPU, de
 * memoria y de tiempo, y esto dura minutos. Antes de tocar el origen se salta lo que ya esté en
 * R2, y la última línea de la respuesta dice por qué trozo se quedó. Quien llama vuelve a llamar
 * desde ahí, y repetir la pasada entera no cuesta tránsito: cuesta unos cuantos `head`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Lo que se espera a un llenado, que no es lo que se espera a un espectador.
 *
 * `TOPE_ORIGEN_MS` son 45 s porque al otro lado hay alguien mirando una pantalla. Aquí no hay
 * nadie: lo que importa es terminar. Y tiene que cubrir la pasada ENTERA, porque
 * `AbortSignal.timeout` corta también la lectura del cuerpo, no solo la espera a las cabeceras.
 */
const TOPE_LLENADO_MS = 600000;

/** Cuántas escrituras a R2 se dejan en vuelo. Sin esto, el origen espera a cada `put`. */
const PUTS_EN_VUELO = 4;

/**
 * Llena R2 leyendo el fichero de corrido desde `desdeTrozo`, como mucho `cuantos` trozos.
 *
 * Contesta en NDJSON y MIENTRAS TRABAJA, una línea cada dieciséis trozos. No es cosmético: una
 * respuesta que tarda dos minutos en emitir su primer byte la corta Cloudflare por el camino, y
 * quien llama se queda sin saber si iba bien. Con el goteo, además, se ve el progreso.
 */
export function llenarSecuencial(env, ctx, url, desdeTrozo, cuantos) {
  const { readable, writable } = new TransformStream();
  const texto = new TextEncoder();

  const trabajo = async () => {
    const escritor = writable.getWriter();
    const decir = obj => escritor.write(texto.encode(JSON.stringify(obj) + '\n'));

    try {
      if (!env.CACHE) { await decir({ ok: false, motivo: 'sin R2' }); return; }

      /*
       * PRIMERO SE MIRA QUÉ HAY YA, y se empieza en el primer hueco. Un `head` cuesta
       * milisegundos y no gasta tránsito; volver a bajar 800 MB que ya estaban, sí.
       */
      let indice = desdeTrozo;
      const tope = desdeTrozo + cuantos;
      let yaEstaban = 0;
      let totalConocido = 0;
      while (indice < tope) {
        const cabeza = await env.CACHE.head(llaveDe(url, indice)).catch(() => null);
        if (!cabeza) break;
        totalConocido = Number(cabeza.customMetadata && cabeza.customMetadata.total) || totalConocido;
        yaEstaban++;
        indice++;
      }

      if (totalConocido && indice * TROZO >= totalConocido) {
        await decir({ ok: true, completo: true, total: totalConocido, yaEstaban, guardados: 0, siguiente: indice });
        return;
      }

      /*
       * Si lo que ya estaba se comió el presupuesto entero, no hay nada que pedirle al origen.
       * Sin esto, una tanda que cae sobre trozos ya guardados abría igualmente la conexión, leía
       * el primer paquete y la cerraba al ver que no cabía nada: un peaje entero a cambio de
       * nada. Se paraba solo, pero pagando.
       */
      if (indice >= tope) {
        await decir({ ok: true, total: totalConocido, yaEstaban, guardados: 0, siguiente: indice, completo: false });
        return;
      }

      const inicio = indice * TROZO;
      await decir({ evento: 'empieza', desde: indice, yaEstaban });

      const respuesta = await fetch(url, {
        headers: { 'User-Agent': UA, Range: 'bytes=' + inicio + '-' },
        signal: AbortSignal.timeout(TOPE_LLENADO_MS),
      });
      if (!respuesta.ok || !respuesta.body) {
        await decir({ ok: false, motivo: 'origen ' + respuesta.status, siguiente: indice });
        return;
      }

      const total = totalDe(respuesta);
      if (!total) {
        respuesta.body.cancel();
        await decir({ ok: false, motivo: 'el origen no dice cuánto mide el fichero', siguiente: indice });
        return;
      }

      // Con un 200 el origen ignoró el rango y manda desde cero: hay que tirar lo anterior.
      let porTirar = respuesta.status === 200 ? inicio : 0;

      const lector = respuesta.body.getReader();

      /*
       * LOS BYTES NO SE TOCAN, SE DEJAN PASAR. Y no es una optimización: es la diferencia entre
       * que esto funcione y que no.
       *
       * La primera versión juntaba cada paquete que llegaba en un buffer de 4 MB (`buffer.set`) y
       * se lo daba a R2 ya completo. Cloudflare la mataba a media tanda con `Worker exceeded CPU
       * time limit`: copiar 192 MB —más reservar cuarenta y ocho buffers de 4 MB que hay que
       * poner a cero— es trabajo de CPU de verdad, y el plan gratuito no deja subir ese tope
       * (`CPU limits are not supported for the Free plan`). El trabajo se quedaba a medias sin
       * decir por qué, y encima de forma intermitente, que es la peor manera de fallar.
       *
       * `FixedLengthStream` le da la vuelta: se le declara a R2 cuánto va a medir el trozo y se
       * le enchufa el flujo. Lo que llega de la red se reenvía TAL CUAL —`subarray` en el corte
       * entre trozos no copia, solo apunta—, así que en JS no se mueve un solo byte. El trasiego
       * lo hace el runtime, que para eso está.
       */
      let escritorTrozo = null;
      let escritoEnTrozo = 0;
      let guardados = 0;
      const enVuelo = [];

      const abrirTrozo = n => {
        const flujo = new FixedLengthStream(TROZO);
        enVuelo.push(env.CACHE.put(llaveDe(url, n), flujo.readable, {
          customMetadata: { total: String(total), visto: String(Date.now()) },
        }));
        escritorTrozo = flujo.writable.getWriter();
        escritoEnTrozo = 0;
      };

      /*
       * Y LA COLA, que no mide un trozo entero, sí se junta en memoria.
       *
       * `FixedLengthStream` exige saber el tamaño por adelantado y el último trozo solo se sabe
       * cuando el fichero se acaba. Son 4 MB como mucho y UNA vez por fichero: ahí sí sale a
       * cuenta guardar los pedazos y unirlos al final.
       */
      const colaSuelta = [];
      let bytesDeCola = 0;

      for (;;) {
        const { done, value } = await lector.read();
        if (done) break;

        let util = value;
        if (porTirar > 0) {
          if (porTirar >= util.length) { porTirar -= util.length; continue; }
          util = util.subarray(porTirar);
          porTirar = 0;
        }

        let puesto = 0;
        while (puesto < util.length) {
          if (!escritorTrozo) {
            // ¿Queda sitio para otro trozo entero? Si el fichero se acaba antes, esto es la cola.
            if ((indice + 1) * TROZO <= total) abrirTrozo(indice);
            else break;
          }

          const cabe = Math.min(TROZO - escritoEnTrozo, util.length - puesto);
          await escritorTrozo.write(util.subarray(puesto, puesto + cabe));
          escritoEnTrozo += cabe;
          puesto += cabe;

          if (escritoEnTrozo === TROZO) {
            await escritorTrozo.close();
            escritorTrozo = null;
            guardados++;
            indice++;
            if (enVuelo.length >= PUTS_EN_VUELO) await enVuelo.shift();
            if (guardados % 4 === 0) await decir({ evento: 'va', trozo: indice, de: Math.ceil(total / TROZO) });
            if (indice >= tope) break;
          }
        }

        // Lo que quede después del último trozo entero del fichero es la cola.
        if (puesto < util.length && (indice + 1) * TROZO > total) {
          const resto = util.subarray(puesto);
          colaSuelta.push(resto);
          bytesDeCola += resto.length;
        }

        if (indice >= tope) { try { await lector.cancel(); } catch (e) { /* ya cerrado */ } break; }
      }

      /*
       * Un trozo a medias NO se guarda: sería un agujero silencioso bajo una llave que promete
       * 4 MB, y el que lo leyera se encontraría menos bytes de los prometidos. Se aborta, no
       * queda nada en R2, y la vuelta siguiente lo rehace entero.
       */
      if (escritorTrozo) {
        await escritorTrozo.abort(new Error('trozo incompleto')).catch(() => {});
        escritorTrozo = null;
      }

      if (bytesDeCola > 0 && indice < tope) {
        const cola = new Uint8Array(bytesDeCola);
        let n = 0;
        for (const pedazo of colaSuelta) { cola.set(pedazo, n); n += pedazo.length; }
        enVuelo.push(env.CACHE.put(llaveDe(url, indice), cola, {
          customMetadata: { total: String(total), visto: String(Date.now()) },
        }));
        guardados++;
        indice++;
      }

      await Promise.all(enVuelo);
      await decir({
        ok: true,
        total,
        trozosDelFichero: Math.ceil(total / TROZO),
        yaEstaban,
        guardados,
        siguiente: indice,
        completo: indice * TROZO >= total,
      });
    } catch (e) {
      // Las líneas anteriores ya salieron; esta dice por qué se paró.
      await decir({ ok: false, motivo: String(e && e.message ? e.message : e) }).catch(() => {});
    } finally {
      await escritor.close().catch(() => {});
    }
  };

  ctx.waitUntil(trabajo());
  return new Response(readable, {
    headers: { ...CORS, 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' },
  });
}
