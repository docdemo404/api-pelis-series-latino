import { ServerOption } from '../types';
import { CacheStore } from '../cache/store';
import { mintDirect, MintedStream } from './directResolver';
import { unwrapRedirector, describeDirect } from '../scrapers/directStream';
import { verifyEmbedStatus } from '../scrapers/embedHealth';
import {
  bajarManifiesto,
  revisarManifiesto,
  segmentoDescargable,
  sondearDestino,
  MotivoMuerte,
} from './manifestHealth';

/**
 * ───────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE SE SABE AL REPRODUCIR TIENE QUE SABERLO TAMBIÉN EL QUE ORDENA LA LISTA.
 *
 * Este fichero nace de un fallo concreto y reproducible. El servidor #1 de «Sin salida» (2024)
 * era `emturbovid.com/t/669b4529d04ab`, y la API lo entregaba como `status: "online"` y como
 * `primary_stream`. No reproducía nada:
 *
 *   embed     emturbovid.com/t/669b4529d04ab      200, reproductor entero, ni un mensaje de error
 *   maestro   cdn2.turboviplay.com/….m3u8         200, m3u8 impecable, dos calidades
 *   variantes cdn105.silvedi.com, cdn125.chanchae.com    LAS DOS en NXDOMAIN
 *
 * Y lo llamativo: `/api/v1/stream/direct` YA devolvía 502 para ese mismo embed. La comprobación
 * a fondo existía y acertaba — vivía dentro de la ruta de reproducción, se ejecutaba cuando el
 * cliente pulsaba Reproducir y su veredicto moría con la petición, cacheado bajo la URL ACUÑADA
 * del CDN, que cambia en cada acuñado y por tanto no le sirve a nadie más.
 *
 * Mientras tanto el catálogo seguía decidiendo con `inspectEmbed`, que mira si el reproductor
 * carga. El reproductor cargaba. Un escalón más abajo no había vídeo.
 *
 * O sea que la API tenía DOS definiciones de "este servidor funciona" y la peor de las dos era
 * la que decidía el orden. Aquí vive la buena, con una clave que ambas partes pueden compartir:
 * el EMBED. Es lo único estable — el embed no cambia, la URL firmada sí.
 * ───────────────────────────────────────────────────────────────────────────────────────────
 */

/** Qué se ha podido demostrar sobre un embed. `desconocido` NO es un aprobado: es un no consta. */
export type Veredicto = 'vivo' | 'muerto' | 'desconocido';

/**
 * Cuánto se recuerda cada veredicto, y por qué son distintos.
 *
 * Recordar «vivo» de más es entregar un servidor que se murió hace rato; recordar «muerto» de
 * más es enterrar uno que ha vuelto. Lo primero deja al espectador con la pantalla negra y lo
 * segundo solo le quita una opción de las nueve que trae una ficha de media, así que la memoria
 * de la muerte puede permitirse ser más larga. Y además se lo ha ganado: lo que se detecta aquí
 * no son caídas de un minuto, son dominios que han dejado de existir.
 */
const TTL_VIVO_SECONDS = 10 * 60;
const TTL_MUERTO_SECONDS = 60 * 60;

/**
 * Memoria del proceso, aparte del caché compartido.
 *
 * Existe porque el paso barato —repasar los 18 servidores de una ficha antes de entregarla— tiene
 * que costar CERO. Con `CacheStore` sería un viaje a Redis por servidor: dieciocho idas y vueltas
 * metidas en el camino de una respuesta que hoy tarda 350 ms. Aquí se lee de un Map y lo que no
 * esté, no está: el conocimiento que llegue de otra lambda entra por la vía lenta o por el
 * `status` ya persistido en la ficha.
 */
const memoria = new Map<string, { veredicto: Veredicto; expira: number }>();

/** El embed sin el redirector de Blogger: la misma clave que usa el catálogo para deduplicar. */
function claveDe(embedUrl: string): string {
  return unwrapRedirector(embedUrl || '');
}

/** Veredicto ya sabido POR ESTE PROCESO. Sin red, sin promesas: o está en memoria o no está. */
export function veredictoRecordado(embedUrl: string): Veredicto | undefined {
  const entrada = memoria.get(claveDe(embedUrl));
  if (!entrada) return undefined;
  if (Date.now() > entrada.expira) {
    memoria.delete(claveDe(embedUrl));
    return undefined;
  }
  return entrada.veredicto;
}

/** Igual, pero mirando también el caché compartido: lo que aprendió otra instancia. */
export async function veredictoConocido(embedUrl: string): Promise<Veredicto | undefined> {
  const local = veredictoRecordado(embedUrl);
  if (local) return local;
  const remoto = await CacheStore.get<Veredicto>(`salud:${claveDe(embedUrl)}`);
  if (remoto === 'vivo' || remoto === 'muerto') {
    apuntarEnMemoria(embedUrl, remoto);
    return remoto;
  }
  return undefined;
}

function apuntarEnMemoria(embedUrl: string, veredicto: Veredicto): void {
  const ttl = veredicto === 'muerto' ? TTL_MUERTO_SECONDS : TTL_VIVO_SECONDS;
  memoria.set(claveDe(embedUrl), { veredicto, expira: Date.now() + ttl * 1000 });
}

/**
 * Deja anotado que este embed reproduce (o no).
 *
 * SOLO se llama con veredictos que valgan para cualquier cliente. Un 403 sobre la URL que
 * íbamos a redirigir condena esa reproducción concreta y punto: al que fija cabeceras le
 * funciona. Ver `MotivoMuerte` en manifestHealth.
 */
export async function anotarVeredicto(embedUrl: string, veredicto: Veredicto): Promise<void> {
  if (!embedUrl || veredicto === 'desconocido') return;
  apuntarEnMemoria(embedUrl, veredicto);
  const ttl = veredicto === 'muerto' ? TTL_MUERTO_SECONDS : TTL_VIVO_SECONDS;
  await CacheStore.set(`salud:${claveDe(embedUrl)}`, veredicto, ttl);
}

export interface Comprobacion {
  veredicto: Veredicto;
  /**
   * Maestro ya descargado, para que quien lo sirva no vuelva a pedirlo. Viene vacío cuando el
   * veredicto salió del caché o cuando no había manifiesto que bajar (mp4). `filtrado` avisa de
   * que se le han quitado calidades muertas: entonces hay que servir ESE cuerpo y no se puede
   * redirigir al original, que sigue envenenado.
   */
  cuerpo?: string;
  filtrado?: boolean;
  /** Para el log. */
  motivo?: string;
  /**
   * El veredicto vale para CUALQUIER cliente y por tanto puede guardarse. Falso cuando lo único
   * que se ha visto es un 403 sobre la entrega literal, que otro cliente puede no sufrir.
   */
  universal: boolean;
}

const VIVO_DESCONOCIDO: Comprobacion = { veredicto: 'desconocido', universal: false };

/**
 * Cuánto se recuerda el veredicto de una URL ACUÑADA concreta. La clave es la URL firmada del
 * CDN, así que identifica un vídeo concreto; y lo que se comprueba —que el dominio exista— no
 * cambia de un minuto para otro.
 */
const VEREDICTO_ACUNADO_TTL_SECONDS = 10 * 60;

type VeredictoCacheado = { kind: 'vivo' | 'muerto' };

/**
 * ¿Se puede entregar esta URL y olvidarse?
 *
 * Existe porque un 302 es un billete sin vuelta: en cuanto sale, el reproductor queda a solas con
 * el CDN y ningún fallo suyo puede ya convertirse en el 502 que haría al cliente probar otro
 * servidor. Y lo que se ha medido es que el maestro RESPONDE aunque el vídeo no esté: emturbovid
 * reparte sus calidades entre dominios desechables que caducan (19 de 25 fichas no reproducían,
 * 16 por dominios en NXDOMAIN). Ver src/services/manifestHealth.ts.
 *
 * Para un mp4 basta con mirar su host: no hay manifiesto que abrir. Para HLS hay que bajar el
 * maestro —unos KB—, mirar a dónde apunta y pedir un segmento de verdad.
 *
 * Ante cualquier duda se contesta `desconocido`, que aguas abajo se trata como utilizable: si el
 * maestro no se deja bajar puede ser un CDN lento o una cabecera que solo el reproductor sabe
 * poner. Solo se condena con la certeza de un destino que no entrega lo que se le pide.
 */
export async function comprobarDestino(
  minted: MintedStream,
  opts: {
    /**
     * Vamos a redirigir al cliente aquí tal cual, así que un 403 lo verá él. Lo pone la ruta de
     * reproducción cuando el modo resuelto es `redirect`; desde el catálogo NUNCA, porque allí
     * todavía no se sabe qué cliente vendrá a por esta ficha.
     */
    entregaLiteral?: boolean;
    /** Instante a partir del cual se deja de comprobar y se contesta lo que se tenga. */
    limite?: number;
    /** Embed del que salió: si se pasa, el veredicto universal queda anotado para el catálogo. */
    embedUrl?: string;
  } = {}
): Promise<Comprobacion> {
  const entregaLiteral = Boolean(opts.entregaLiteral);
  const cacheKey = `verdict:${minted.url}`;
  const cacheado = await CacheStore.get<VeredictoCacheado>(cacheKey);
  if (cacheado) return { veredicto: cacheado.kind, universal: true };

  /**
   * PRESUPUESTO DE TIEMPO, y está aquí por un destrozo propio: al añadir la comprobación del
   * segmento, los hosts lentos (ok.ru, los blogspot con pixeldrain) dejaron de responder — la
   * petición a la PROPIA API se comía 45 s y expiraba. Se había cambiado "entrega vídeo roto" por
   * "no entrega nada", que es peor.
   *
   * Así que la verificación tiene un tope y falla A FAVOR del vídeo: si no le da tiempo a
   * demostrar que algo está muerto, se entrega igual. Comprobar es un extra, no un peaje —
   * ninguna reproducción puede morir esperando a que terminemos de comprobarla.
   */
  const limite = opts.limite ?? Date.now() + 3500;
  const hayTiempo = () => Date.now() < limite;

  // Se cachea el VEREDICTO, nunca el cuerpo: guardar manifiestos enteros en KV no compensa, y
  // además el cuerpo solo sirve para ahorrarse una descarga dentro de esta misma petición.
  const guardar = async (c: Comprobacion): Promise<Comprobacion> => {
    if (c.veredicto !== 'desconocido') {
      await CacheStore.set(cacheKey, { kind: c.veredicto }, VEREDICTO_ACUNADO_TTL_SECONDS);
      // Y la parte que le faltaba a todo esto: dejarlo anotado bajo el EMBED, que es la clave
      // que el catálogo sí puede volver a mirar. Solo si el veredicto vale para todos.
      if (c.universal && opts.embedUrl) await anotarVeredicto(opts.embedUrl, c.veredicto);
    }
    return c;
  };

  /** Un 403 sobre lo que íbamos a redirigir mata ESTA reproducción, no el servidor. */
  const muerto = (motivo: MotivoMuerte | string): Comprobacion => ({
    veredicto: 'muerto',
    motivo: String(motivo),
    universal: motivo !== 'prohibido',
  });

  // El destino de primer nivel. Si ni siquiera se puede conectar con él, no hay nada que bajar
  // ni que redirigir. Para un mp4 esto es toda la comprobación: no hay manifiesto que abrir.
  const primero = await sondearDestino(minted.url, minted.referer, false, entregaLiteral);
  if (!primero.vivo) return guardar(muerto(primero.motivo || 'no-responde'));

  if (minted.kind !== 'hls') return guardar({ veredicto: 'vivo', universal: true });

  const manifiesto = await bajarManifiesto(minted.url, minted.referer);
  if (!manifiesto) return VIVO_DESCONOCIDO;

  // Un maestro sin una sola URI no es un vídeo: no hay nada que reproducir en él.
  if (!manifiesto.split(/\r?\n/).some(l => l.trim() && !l.trim().startsWith('#'))) {
    return guardar(muerto('maestro-sin-contenido'));
  }

  if (!hayTiempo()) return { veredicto: 'desconocido', cuerpo: manifiesto, universal: false };

  const estado = await revisarManifiesto(manifiesto, minted.url, minted.referer);
  if (estado.muerto) {
    return guardar(muerto(`variantes-muertas: ${estado.muertos.join(', ')}`));
  }
  // Y la prueba de fuego: que un segmento de verdad se deje descargar. Sin esto se cuela el
  // fallo más común —playlist impecable, segmentos en 404— que además es el que peor llega al
  // cliente: la API dice 200, el reproductor arranca y se cae cuando ya nadie prueba otra cosa.
  if (hayTiempo() && !(await segmentoDescargable(estado.cuerpo, minted.url, minted.referer))) {
    return guardar(muerto('segmentos-no-descargables'));
  }

  if (estado.parcial) {
    // Reproduce, pero no con todas las calidades: el cuerpo filtrado no se cachea porque es lo
    // único que se puede servir y hay que tenerlo delante para servirlo.
    return {
      veredicto: 'vivo',
      cuerpo: estado.cuerpo,
      filtrado: true,
      motivo: `calidades-caidas: ${estado.muertos.join(', ')}`,
      universal: true,
    };
  }
  return guardar({ veredicto: 'vivo', cuerpo: manifiesto, universal: true });
}

/**
 * Lo mismo, pero partiendo del embed: acuña el vídeo y lo comprueba.
 *
 * Es la puerta por la que entra el catálogo, y por eso NUNCA pone `entregaLiteral`: una ficha la
 * leen navegadores y apps nativas, y lo que un navegador no puede pedir otro sí. Solo se marca
 * lo que está muerto para todos.
 *
 * Que no se pueda acuñar NO es que el servidor esté muerto: significa que hoy no se le puede
 * sacar el vídeo directo, y el iframe puede seguir funcionando. Se distingue con `sinVideo`.
 */
export async function comprobarEmbed(
  embedUrl: string,
  opts: { limite?: number } = {}
): Promise<Comprobacion & { sinVideo?: boolean; minted?: MintedStream }> {
  if (!embedUrl) return VIVO_DESCONOCIDO;
  const minted = await mintDirect(embedUrl);
  if (!minted) return { veredicto: 'desconocido', universal: false, sinVideo: true, motivo: 'sin-acunar' };
  // El acuñado viaja de vuelta porque es lo que permite RECONSTRUIR los campos de vídeo directo
  // de un servidor al que se le quitaron por darlo por muerto. Ver `resucitar`.
  return { ...(await comprobarDestino(minted, { limite: opts.limite, embedUrl })), minted };
}

/**
 * Con menos de esto por delante no se empieza una sonda: no daría tiempo ni a acuñar, y lo
 * único que se conseguiría es sumarle ese tiempo a la respuesta para acabar sin veredicto.
 */
const MINIMO_PARA_SONDEAR_MS = 600;

/**
 * Deja de esperar a una comprobación que se pasa del tiempo. NO la cancela.
 *
 * La diferencia importa y es la mitad de la gracia: la petición sigue su curso, termina, y su
 * veredicto queda anotado en memoria. Quien pida la ficha dentro de unos segundos se lo encuentra
 * hecho y gratis. Abortarla habría tirado el trabajo justo antes de cobrarlo.
 *
 * Hace falta porque el presupuesto se miraba solo ENTRE servidores, y una sola sonda lenta lo
 * revienta entera: medido, dos comprobaciones seguidas se fueron a 6,3 s con 4 s de tope. Los
 * timeouts de axios (8 s el sondeo, 15 s el manifiesto) son por petición, no por pasada.
 */
/** Tope de tiempo para cualquier promesa; si se pasa o falla, se queda con el valor de respaldo. */
function conTopeSimple<T>(promesa: Promise<T>, ms: number, respaldo: T): Promise<T> {
  return new Promise<T>(resolve => {
    const reloj = setTimeout(() => resolve(respaldo), Math.max(0, ms));
    promesa.then(
      valor => { clearTimeout(reloj); resolve(valor); },
      () => { clearTimeout(reloj); resolve(respaldo); }
    );
  });
}

function conTope<T extends Comprobacion>(promesa: Promise<T>, ms: number): Promise<T | Comprobacion> {
  return new Promise<T | Comprobacion>(resolve => {
    const reloj = setTimeout(() => resolve(VIVO_DESCONOCIDO), Math.max(0, ms));
    promesa.then(
      valor => { clearTimeout(reloj); resolve(valor); },
      () => { clearTimeout(reloj); resolve(VIVO_DESCONOCIDO); }
    );
  });
}

/**
 * Repasa una lista de servidores YA ORDENADA y deja al frente algo que de verdad reproduzca.
 *
 * Es la respuesta a "no debe entregar servidores que no funcionan", y el matiz está en el «no
 * funcionan»: lo que se demuestra aquí es que el VÍDEO DIRECTO no existe. El iframe del host
 * puede seguir cargando, así que un servidor condenado no se borra —se le quita el vídeo directo
 * que se ha probado que no está y baja al final con `status: 'offline'`—. Borrarlo sería apostar
 * la última opción del espectador a que nuestra sonda nunca se equivoca.
 *
 * Tres reglas que gobiernan el coste, porque esto corre en el camino de una respuesta:
 *
 *   1. Lo ya sabido es gratis. Un veredicto en memoria se aplica sin tocar la red, a todos.
 *   2. Se comprueba DESDE ARRIBA y se para en cuanto hay una cabeza fiable. Lo que el cliente
 *      va a probar primero es lo único que tiene que estar verificado; el resto son reservas.
 *   3. Hay un tope de tiempo y se falla a favor del vídeo. Un servidor sin comprobar sale tal
 *      cual: no comprobado no es lo mismo que roto.
 */
export async function revisarServidores(
  servers: ServerOption[],
  opts: {
    /** Milisegundos para TODA la pasada. */
    presupuestoMs?: number;
    /** Cuántos servidores como mucho se sondean por red. */
    maximo?: number;
    /** Parar en cuanto uno de los de arriba resulte utilizable (camino de petición). */
    hastaElPrimeroUtil?: boolean;
    /** Cuántos servidores ya marcados `offline` se vuelven a mirar por si han resucitado. */
    resucitar?: number;
  } = {}
): Promise<ServerOption[]> {
  if (!servers || servers.length === 0) return servers || [];

  const presupuesto = opts.presupuestoMs ?? 4000;
  const maximo = opts.maximo ?? 3;
  const hastaElPrimeroUtil = opts.hastaElPrimeroUtil !== false;
  const limite = Date.now() + presupuesto;

  const salida = [...servers];
  let sondeados = 0;

  for (let i = 0; i < salida.length; i++) {
    const servidor = salida[i];
    if (!servidor?.embed_url) continue;

    let veredicto = veredictoRecordado(servidor.embed_url);
    let sinVideo = false;

    if (!veredicto) {
      /**
       * SIN VÍDEO DIRECTO: se le vuelve a mirar el EMBED.
       *
       * Antes se saltaban con el argumento de que su embed ya lo miró el scraper. Pero ese
       * veredicto es de cuando se scrapeó —puede ser de hace semanas— y un enlace que ha muerto
       * desde entonces se sigue entregando como `online`. Es lo que quedaba dando error en las
       * series: los embeds puros nunca se volvían a comprobar.
       *
       * `inspectEmbed` es la misma comprobación del scraper, así que reconoce lo que ya sabía
       * reconocer: el 404, el "file not found" servido con 200, el redirector que ya no lleva a
       * ninguna parte y los reproductores por hash cuya API dice que el vídeo no está. Lo que NO
       * puede es juzgar a los que sirven una SPA —filemoon devuelve la misma página exista el
       * vídeo o no—: esos se dejan como están, porque condenarlos por no traer reproductor en el
       * HTML se llevaría por delante a los que sí funcionan.
       *
       * Cuesta lo mismo que una sonda y sale del mismo cupo, así que no cambia el presupuesto.
       */
      if (!servidor.direct_stream) {
        const queda = limite - Date.now();
        if (sondeados >= maximo || queda < MINIMO_PARA_SONDEAR_MS) continue;
        sondeados++;
        const estado = await conTopeSimple(verifyEmbedStatus(servidor.embed_url), queda, 'online');
        if (estado === 'offline') {
          console.warn(`[salud] ${servidor.embed_url.slice(0, 70)} embed caído`);
          salida[i] = sinVideoDirecto({ ...servidor, status: 'offline' });
          continue;
        }
        if (servidor.status !== 'online') {
          salida[i] = { ...servidor, status: 'online', last_checked: new Date().toISOString() };
        }
        if (hastaElPrimeroUtil) break;
        continue;
      }
      const queda = limite - Date.now();
      // Agotado el cupo o el tiempo se deja de SONDEAR, pero se sigue recorriendo la lista: lo
      // que ya esté en memoria se aplica igual y no cuesta nada. Cortar aquí dejaba sin corregir
      // a un servidor de más abajo que se acababa de demostrar muerto en otra petición.
      if (sondeados >= maximo || queda < MINIMO_PARA_SONDEAR_MS) continue;
      sondeados++;

      // Antes de gastar una sonda, preguntar al caché COMPARTIDO. En Vercel cada petición puede
      // caer en una instancia distinta, así que sin esto cada lambda vuelve a descubrir por su
      // cuenta lo que la de al lado ya sabe. Solo se paga en los pocos que se iban a sondear.
      veredicto = await veredictoConocido(servidor.embed_url);

      if (!veredicto) {
        const c = await conTope(comprobarEmbed(servidor.embed_url, { limite }), queda);
        veredicto = c.veredicto;
        sinVideo = Boolean('sinVideo' in c && c.sinVideo);
        if (c.veredicto === 'muerto') {
          console.warn(`[salud] ${servidor.embed_url.slice(0, 70)} no reproduce (${c.motivo})`);
        }
      }
    }

    if (veredicto === 'muerto') {
      salida[i] = sinVideoDirecto({ ...servidor, status: 'offline' });
      continue;
    }
    if (sinVideo) {
      // Acuñar falla pero el host sigue en pie: se le quita el enlace directo que no lleva a
      // ninguna parte y se deja como embed. Sigue siendo utilizable, así que cuenta como cabeza.
      salida[i] = sinVideoDirecto(servidor);
    } else if (veredicto === 'vivo' && servidor.status !== 'online') {
      // Y la vuelta atrás, que es tan importante como la condena: un servidor marcado offline
      // hace semanas al que hoy se le ha descargado un segmento está vivo, y sin esto se
      // quedaría enterrado para siempre porque la lista ordenada nunca lo volvería a poner
      // arriba para comprobarlo.
      salida[i] = { ...servidor, status: 'online', last_checked: new Date().toISOString() };
    }

    if (hastaElPrimeroUtil) break;
  }

  return resucitarCaidos(salida, limite, opts.resucitar ?? 0);
}

/**
 * Vuelve a mirar unos cuantos de los que están marcados `offline`.
 *
 * NO es una floritura, es el contrapeso de todo lo anterior. Un `status` caído es un campo
 * PERSISTIDO, y el orden antepone lo que está `online`, así que un servidor mal condenado nunca
 * vuelve a subir lo bastante como para que nadie lo compruebe: se queda enterrado para siempre.
 * Ya pasó en este proyecto —la comprobación de embed daba por caído a emturbovid entero, 6.265
 * servidores, y hubo que sacarlos con una fecha de corte a mano en catalogService—. Una sonda que
 * puede condenar tiene que poder absolver.
 *
 * Solo corre en la pasada a fondo, que es la que escribe en la DB y donde no hay nadie esperando.
 * Y con el mismo presupuesto: si no queda tiempo, no se resucita a nadie y se prueba mañana.
 */
async function resucitarCaidos(servers: ServerOption[], limite: number, cupo: number): Promise<ServerOption[]> {
  if (cupo <= 0) return servers;
  const salida = [...servers];
  let intentos = 0;

  for (let i = 0; i < salida.length && intentos < cupo; i++) {
    const servidor = salida[i];
    if (!servidor?.embed_url || servidor.status !== 'offline') continue;
    if (veredictoRecordado(servidor.embed_url)) continue;
    const queda = limite - Date.now();
    if (queda < MINIMO_PARA_SONDEAR_MS) break;

    intentos++;
    const c = await conTope(comprobarEmbed(servidor.embed_url, { limite }), queda);
    if (c.veredicto !== 'vivo') continue;

    // Los campos de vídeo directo pueden habérsele quitado al condenarlo, así que se rehacen con
    // el acuñado que la comprobación acaba de conseguir. Sin esto volvería como embed pelado.
    const minted = 'minted' in c ? c.minted : undefined;
    console.warn(`[salud] ${servidor.embed_url.slice(0, 70)} vuelve a reproducir`);
    salida[i] = {
      ...servidor,
      ...(minted ? describeDirect(servidor.embed_url, minted) : {}),
      status: 'online',
      last_checked: new Date().toISOString(),
    };
  }

  return salida;
}

/**
 * Lo mismo pero SIN RED: aplica solo lo que este proceso ya sabe.
 *
 * Para los caminos calientes —ficha servida desde el caché o con los enlaces frescos de la DB—,
 * donde no se puede pagar una sonda pero sí se puede evitar volver a entregar como bueno algo
 * que se acaba de demostrar muerto hace dos minutos.
 */
export function aplicarVeredictosRecordados(servers: ServerOption[]): ServerOption[] {
  if (!servers || servers.length === 0) return servers || [];
  let cambiado = false;
  const salida = servers.map(s => {
    if (!s?.embed_url) return s;
    if (veredictoRecordado(s.embed_url) !== 'muerto') return s;
    if (s.status === 'offline' && !s.direct_stream) return s;
    cambiado = true;
    return sinVideoDirecto({ ...s, status: 'offline' });
  });
  return cambiado ? salida : servers;
}

/**
 * Quita los campos de vídeo directo de un servidor.
 *
 * Se ha PROBADO que ese enlace no lleva a ningún vídeo, y anunciarlo igual es lo que hace que el
 * cliente lo intente el primero y se quede plantado. Sin ellos, `sortServersBySourcePriority`
 * vuelve a sellar el nombre como `[Embed]` y el servidor cae al fondo de la lista, que es
 * exactamente donde debe estar un último recurso.
 */
function sinVideoDirecto(servidor: ServerOption): ServerOption {
  const { direct_stream, direct_kind, direct_mode, direct_host, ...resto } = servidor;
  return { ...resto, last_checked: new Date().toISOString() };
}
