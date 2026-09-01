import { ServerOption } from '../types';
import { CacheStore } from '../cache/store';
import { mintDirect, MintedStream } from './directResolver';
import { unwrapRedirector, describeDirect, esFicheroDirecto, isPubliclyShareable } from '../scrapers/directStream';

/**
 * ¿Este servidor es un FICHERO permanente y no una página de reproductor?
 *
 * Las dos condiciones importan. `esFicheroDirecto` distingue el mp4 del reproductor —sin ella
 * esto absolvería a cualquier embed sin firma, que son casi todos—, e `isPubliclyShareable`
 * exige que la url no lleve caducidad ni ate por IP, que es lo que la hace comprobable una vez y
 * fiable después. Es la misma pregunta que `urlPublicaDe` en `streamSorter`, hecha desde el otro
 * lado del sistema: allí decide qué se entrega, aquí qué NO hace falta volver a sondear.
 */
function esFicheroPermanente(s: ServerOption): boolean {
  const url = s?.direct_stream && /^https?:\/\//i.test(s.direct_stream) ? s.direct_stream : s?.embed_url;
  return Boolean(url) && esFicheroDirecto(url as string) && isPubliclyShareable(url as string);
}
import { verifyEmbedStatus } from '../scrapers/embedHealth';
import {
  bajarManifiesto,
  revisarManifiesto,
  segmentoDescargable,
  sondearDestino,
  MotivoMuerte,
} from './manifestHealth';
import { permanenteArranca } from './permanentHealth';
import { verificadoVigente } from './streamSorter';

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
  /** Lo mejor que ofrece el maestro, si se llegó a mirar. Ver `EstadoManifiesto.maxAltura`. */
  maxAltura?: number;
  /** Lo que tardó el destino en empezar a contestar. */
  ttfbMs?: number;
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
    /**
     * Cuántos segmentos CONSECUTIVOS tiene que entregar para aprobar. Uno por defecto, que es lo
     * que aguanta el camino de reproducción; el barrido pide tres, que es donde se caza al host
     * que sirve el primero —caliente en el borde del CDN— y falla el segundo.
     */
    segmentosExigidos?: number;
  } = {}
): Promise<Comprobacion> {
  const entregaLiteral = Boolean(opts.entregaLiteral);

  /**
   * LO PRIMERO: ¿YA SE SABE ALGO DE ESTE EMBED?
   *
   * Debajo hay un caché indexado por `verdict:<url acuñada>`, y esa URL se firma NUEVA en cada
   * acuñado — así que para los hosts que firman, que son casi todos, ese caché no acierta jamás.
   * Resultado medido: cada reproducción volvía a bajar el maestro, a recorrer todas sus variantes
   * y a descargarse un trozo de segmento, para concluir lo que se había concluido segundos antes
   * al sellar el servidor. Eran ~2,4 s del arranque, y sobraban.
   *
   * El veredicto bueno vive bajo `salud:<embed>` —clave ESTABLE, el embed no cambia— y esta
   * función no lo miraba. `veredictoConocido` es justo eso, y ya se usa en `revisarServidores`.
   *
   * `entregaLiteral` NO puede aprovecharlo: ese modo pregunta algo distinto —si el CDN acepta la
   * petición tal y como la hará el reproductor, sin Referer— y un veredicto guardado responde a la
   * pregunta general. Confundirlas fue lo que dejó pasar el archive.org de «Volver al Futuro 3».
   */
  if (!entregaLiteral && opts.embedUrl) {
    const sabido = await veredictoConocido(opts.embedUrl);
    if (sabido === 'vivo') return { veredicto: 'vivo', universal: true };
    if (sabido === 'muerto') return { veredicto: 'muerto', universal: true, motivo: 'ya-constaba' };
  }

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
  const inicioSondeo = Date.now();
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
  // Lo que el maestro anuncia y lo que tardó en llegar: dos datos que ya estaban delante y se
  // tiraban, y que son los que deciden qué servidor se entrega primero. Ver `streamSorter`.
  const calidad = { maxAltura: estado.maxAltura, ttfbMs: Date.now() - inicioSondeo };
  if (estado.muerto) {
    return guardar(muerto(`variantes-muertas: ${estado.muertos.join(', ')}`));
  }
  // Y la prueba de fuego: que un segmento de verdad se deje descargar. Sin esto se cuela el
  // fallo más común —playlist impecable, segmentos en 404— que además es el que peor llega al
  // cliente: la API dice 200, el reproductor arranca y se cae cuando ya nadie prueba otra cosa.
  if (hayTiempo() && !(await segmentoDescargable(estado.cuerpo, minted.url, minted.referer, {
    cuantos: opts.segmentosExigidos ?? 1,
    limite,
  }))) {
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
      ...calidad,
    };
  }
  return guardar({ veredicto: 'vivo', cuerpo: manifiesto, universal: true, ...calidad });
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
  opts: {
    limite?: number;
    /**
     * Este servidor se va a entregar con un 302, así que hay que sondearlo COMO LO PEDIRÁ EL
     * CLIENTE: sin Referer.
     *
     * El comentario de arriba dice que el catálogo nunca marca `entregaLiteral` porque no sabe qué
     * cliente vendrá. Es cierto en general y falso en un caso concreto: cuando el modo resuelto es
     * `redirect`, sí se sabe — el reproductor recibe la URL del CDN y la pide a pelo, sin Referer,
     * porque nuestra `Referrer-Policy: no-referrer` se lo quita.
     *
     * Sondear eso con Referer mide a alguien que no existe. «Volver al Futuro 3» pasaba la
     * comprobación y su archive.org devolvía 503 al reproductor.
     */
    entregaLiteral?: boolean;
    /** Cuántos segmentos consecutivos se exigen. Ver `comprobarDestino`. */
    segmentosExigidos?: number;
  } = {}
): Promise<Comprobacion & { sinVideo?: boolean; minted?: MintedStream }> {
  if (!embedUrl) return VIVO_DESCONOCIDO;
  const minted = await mintDirect(embedUrl);
  if (!minted) return { veredicto: 'desconocido', universal: false, sinVideo: true, motivo: 'sin-acunar' };
  // El acuñado viaja de vuelta porque es lo que permite RECONSTRUIR los campos de vídeo directo
  // de un servidor al que se le quitaron por darlo por muerto. Ver `resucitar`.
  return {
    ...(await comprobarDestino(minted, {
      limite: opts.limite,
      embedUrl,
      entregaLiteral: opts.entregaLiteral,
      segmentosExigidos: opts.segmentosExigidos,
    })),
    minted,
  };
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
    /**
     * Cuántos servidores DEMOSTRADOS se quieren antes de dar la pasada por terminada.
     *
     * `hastaElPrimeroUtil` cortaba en el primero, así que solo ese recibía sello — y como
     * `paraElCliente` exige sello, la ficha salía con UN servidor y sin nada a lo que caer si ese
     * se atascaba. Medido en el 1x1 de Breaking Bad: 10 servidores guardados, 4 con vídeo, 1
     * publicado.
     *
     * Con un objetivo, la pasada sigue hasta reunir alternativas o hasta agotar presupuesto, lo que
     * llegue antes. No se comprueba menos ni se publica nada sin comprobar: se comprueba MÁS.
     */
    objetivoSellados?: number;
    /** Cuántos servidores ya marcados `offline` se vuelven a mirar por si han resucitado. */
    resucitar?: number;
  } = {}
): Promise<ServerOption[]> {
  if (!servers || servers.length === 0) return servers || [];

  const presupuesto = opts.presupuestoMs ?? 4000;
  const maximo = opts.maximo ?? 3;
  const hastaElPrimeroUtil = opts.hastaElPrimeroUtil !== false;
  const objetivoSellados = Math.max(1, opts.objetivoSellados ?? 1);
  /** Cuántos llevan sello fresco en esta pasada. Lo que decide cuándo parar. */
  let demostrados = 0;
  const limite = Date.now() + presupuesto;

  const salida = [...servers];
  let sondeados = 0;

  for (let i = 0; i < salida.length; i++) {
    const servidor = salida[i];
    if (!servidor?.embed_url) continue;

    /**
     * NetMirror es un server VIRTUAL creado en `catalogService` con sello reciente. Su embed_url
     * es una ruta al propio Worker (`/api/v1/netmirror/stream/<tmdb>`) que no acuna nada por si
     * misma: el sondeo intentaria mint sobre esa ruta, fallaria y marcaria el server como
     * `sinVideoDirecto`, tirandolo. La regla aqui es la misma que aplica a los ficheros
     * permanentes: si el sello del catalogo es reciente, no se re-sondea.
     */
    if (String((servidor as any)?.source_id || '').toLowerCase() === 'netmirror' && verificadoVigente(servidor)) {
      continue;
    }

    /**
     * UN FICHERO NO SE JUZGA CON LAS REGLAS DE UN REPRODUCTOR.
     *
     * Un servidor `public` no lleva detrás una página con un reproductor: su `embed_url` ES el
     * mp4. Pasarlo por esta revisión hacía dos cosas, las dos malas, y las dos medidas sobre la
     * ficha manual de Shrek (1,78 GB en archive.org):
     *
     *   · Lo declaraba MUERTO. El inspector de embeds pide HTML y busca un reproductor dentro;
     *     recibe un mp4 y no encuentra ninguno, así que el veredicto es «muerto» sobre un fichero
     *     que se descarga perfectamente. Entonces `sinVideoDirecto` le quitaba el `direct_stream`
     *     y la ficha se quedaba sin nada que entregar.
     *   · Y ni siquiera terminaba: sondear ese mp4 se pasó de NUEVE MINUTOS sin devolver
     *     veredicto, contra un presupuesto de 4 s para la pasada entera.
     *
     * No se pierde comprobación, que es lo que importa: a estos se les exige haberse descargado
     * de verdad ANTES de entrar en la base (`urlsBuenasDe` en el crawl, `anadirFichaManual` en el
     * panel), y su sello dura 7 días —no 6 horas— justamente porque una url sin firma no caduca
     * sola (ver `verificadoVigente`). Lo único que puede pasarles es que RETIREN el fichero, y de
     * eso se encarga el barrido, que sí sabe pedirle un trozo a un mp4.
     */
    if (esFicheroPermanente(servidor)) {
      /**
       * PERO SIN SELLO NO SE PUBLICA, ASÍ QUE SALTARLO ERA CONDENARLO EN SILENCIO.
       *
       * Saltarlo evita el error de arriba, y hasta aquí bien. Lo que no se vio es la otra mitad:
       * `paraElCliente` exige `verified_at` vigente, y si el que sirve nunca mira estos ficheros,
       * el único que puede sellarlos es el barrido. O sea que su visibilidad dependía por completo
       * de cuándo pasara `verificarPermanentes`, y entre vuelta y vuelta desaparecían.
       *
       * A quien más le duele es a la fuente propia, que es justo la que no se puede volver a
       * descubrir: reportado el 2026-08-24 con el 1x01 de «Breaking Bad», donde la url pegada por
       * el panel estaba en la fila, era la primera del orden, y el capítulo se servía igualmente
       * con el servidor de moviedays. Y se realimentaba, porque con menos de dos servidores
       * publicables `getEpisode` vuelve a rastrear y a reescribir el capítulo en cada apertura:
       * dos aperturas seguidas movieron el sello del otro servidor y dejaron el manual sin él.
       *
       * Así que se le hace la pregunta que SÍ le corresponde a un fichero —el manifiesto y su
       * primer trozo, o el índice del mp4— y con eso se le sella. Es la misma comprobación que usa
       * el barrido, llamada, no copiada (ver `permanenteArranca`). Coste medido sobre la url del
       * caso: 914 ms el manifiesto y 583 ms el trozo, dentro del presupuesto de la petición.
       *
       * Solo cuando le FALTA la prueba: al que ya la tiene no se le gasta una sonda. Y un `false`
       * no condena a nadie —se le deja exactamente como estaba, que es lo que hacía antes—: aquí
       * solo se puede ganar sello, nunca perderlo. Retirar sigue siendo cosa del barrido, que es
       * quien puede permitirse insistir tres veces antes de dar a un host por incapaz.
       */
      if (verificadoVigente(servidor)) continue;
      const queda = limite - Date.now();
      if (sondeados >= maximo || queda < MINIMO_PARA_SONDEAR_MS) continue;

      sondeados++;
      // `conTopeSimple` y no `conTope`: el respaldo de este camino no es «vivo desconocido», es
      // «no se pudo concluir», que aquí significa simplemente no sellar.
      const arranque = await conTopeSimple(
        permanenteArranca(servidor),
        queda,
        { ok: false, causa: 'sin veredicto', detalle: 'se acabó el presupuesto', sinVeredicto: true }
      );
      if (arranque.ok) {
        salida[i] = {
          ...servidor,
          status: 'online',
          verified_at: new Date().toISOString(),
          last_checked: new Date().toISOString(),
        };
        demostrados++;
        if (hastaElPrimeroUtil && demostrados >= objetivoSellados) break;
      }
      continue;
    }

    let veredicto = veredictoRecordado(servidor.embed_url);
    let sinVideo = false;
    /** Lo que esta pasada haya medido del maestro. Vacío si el veredicto salió del caché. */
    let calidadMedida: { maxAltura?: number; ttfbMs?: number } | undefined;

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
        // Lo que ya se sepa de este embed —lo haya averiguado esta instancia u otra— sale del
        // caché y no gasta sonda. Sin esto cada petición volvía a empezar de cero, se le iban las
        // tres sondas en los muertos y el último de la lista se quedaba SIN comprobar,
        // conservando su `online` viejo. Es lo que dejaba el único servidor que quedaba en pie de
        // "El Chavo" T6E3 siendo precisamente uno que no reproduce.
        let conocido = await veredictoConocido(servidor.embed_url);

        if (!conocido) {
          const queda = limite - Date.now();
          if (sondeados >= maximo || queda < MINIMO_PARA_SONDEAR_MS) continue;
          sondeados++;
          const estado = await conTopeSimple(verifyEmbedStatus(servidor.embed_url), queda, 'desconocido');
          if (estado === 'online' || estado === 'offline') {
            conocido = estado === 'offline' ? 'muerto' : 'vivo';
            // Y se anota, para que la siguiente petición —y las demás instancias— no lo repitan.
            await anotarVeredicto(servidor.embed_url, conocido);
          }
        }

        if (conocido === 'muerto') {
          console.warn(`[salud] ${servidor.embed_url.slice(0, 70)} embed caído`);
          salida[i] = sinVideoDirecto({ ...servidor, status: 'offline' });
          continue;
        }
        if (conocido === 'vivo') {
          if (servidor.status !== 'online') {
            salida[i] = { ...servidor, status: 'online', last_checked: new Date().toISOString() };
          }
          /**
           * NO SE PARA AQUÍ, y este `break` costaba fichas enteras.
           *
           * `hastaElPrimeroUtil` significa «ya tenemos algo que entregar». Un embed vivo lo era
           * cuando la API entregaba iframes; desde que solo sale vídeo directo verificado, un
           * servidor sin `direct_stream` NO se publica — así que pararse en él deja la lista sin
           * comprobar justo donde estaban los que sí sirven.
           *
           * Medido en Breaking Bad: su 1x1 tiene cinco servidores y tres con vídeo directo, y la
           * respuesta salía con CERO porque el primero de la lista era un embed vivo y la pasada
           * terminaba ahí.
           */
        }
        continue;
      }
      /**
       * EL CACHÉ COMPARTIDO SE MIRA ANTES QUE EL PRESUPUESTO, y ese orden importa.
       *
       * Estaba al revés: primero se comprobaba si quedaban sondas y solo entonces se preguntaba
       * a Redis. Pero preguntar a Redis NO gasta una sonda —es lo único aquí que no toca al
       * host—, así que gatearlo detrás del cupo tiraba a la basura lo ya sabido justo cuando más
       * falta hace: con el presupuesto agotado, un servidor que otra petición acaba de demostrar
       * muerto seguía entregándose como bueno.
       *
       * Es exactamente el mismo razonamiento que ya está escrito unas líneas más arriba para los
       * embed sin vídeo directo. Aquí faltaba, y con él se caía el único aviso que llega desde la
       * ENTREGA real: cuando `/stream/direct` agota su plazo anota el veredicto, y si esta
       * consulta no lo mira, ese aviso no sirve de nada.
       */
      veredicto = await veredictoConocido(servidor.embed_url);

      const queda = limite - Date.now();
      // Agotado el cupo o el tiempo se deja de SONDEAR, pero se sigue recorriendo la lista: lo
      // que ya esté en memoria se aplica igual y no cuesta nada. Cortar aquí dejaba sin corregir
      // a un servidor de más abajo que se acababa de demostrar muerto en otra petición.
      if (!veredicto && (sondeados >= maximo || queda < MINIMO_PARA_SONDEAR_MS)) continue;

      if (!veredicto) {
        sondeados++;
        // Si a este servidor se le va a entregar con un 302, se le sondea como lo pedirá el
        // reproductor: sin Referer. Ver `entregaLiteral` en comprobarEmbed.
        const c = await conTope(
          comprobarEmbed(servidor.embed_url, { limite, entregaLiteral: servidor.direct_mode === 'redirect' }),
          queda
        );
        veredicto = c.veredicto;
        calidadMedida = { maxAltura: c.maxAltura, ttfbMs: c.ttfbMs };
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
    } else if (veredicto === 'vivo') {
      /**
       * ACABA DE DEMOSTRAR QUE ENTREGA VÍDEO: SE LE RENUEVA EL SELLO.
       *
       * `comprobarEmbed` baja el manifiesto y se descarga un segmento real — es exactamente lo que
       * hace `--verificar`, solo que aquí ocurre en el momento de servir. No aprovecharlo era
       * tirar la comprobación más valiosa que existe: la de ahora mismo.
       *
       * Y era lo que faltaba para que el sello signifique algo. Sin esto solo lo ponía el barrido,
       * cada muchas horas, así que se publicaba lo verificado hace rato y no lo verificado hace un
       * segundo: «Milagro en la Celda 7» salía con su único servidor sellado hacía 3 h, ya muerto,
       * mientras sus otros cinco quedaban escondidos por no llevar sello.
       *
       * Esta rama es además la VUELTA ATRÁS, tan importante como la condena: un servidor marcado
       * `offline` hace semanas al que hoy se le acaba de descargar un segmento está vivo, y aquí
       * recupera su `status` y su sello de una vez.
       */
      salida[i] = {
        ...servidor,
        status: 'online',
        verified_at: new Date().toISOString(),
        last_checked: new Date().toISOString(),
        // Lo que se acaba de ver del maestro. Solo se pisa lo anterior si ESTA pasada lo midió: un
        // veredicto que salió del caché no trae estos datos y no debe borrar los de antes.
        ...(calidadMedida?.maxAltura !== undefined ? { max_height: calidadMedida.maxAltura } : {}),
        ...(calidadMedida?.ttfbMs !== undefined ? { ttfb_ms: calidadMedida.ttfbMs } : {}),
      };
      demostrados++;
    }

    // Se para cuando hay ALTERNATIVAS suficientes, no en cuanto uno funciona. Ver `objetivoSellados`.
    if (hastaElPrimeroUtil && demostrados >= objetivoSellados) break;
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
    // Misma razón que en `revisarServidores`: el veredicto recordado de un fichero permanente
    // vino de juzgarlo como reproductor, y quitarle el `direct_stream` deja la ficha muda.
    if (esFicheroPermanente(s)) return s;
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
export function sinVideoDirecto(servidor: ServerOption): ServerOption {
  const { direct_stream, direct_kind, direct_mode, direct_host, ...resto } = servidor;
  return { ...resto, last_checked: new Date().toISOString() };
}
