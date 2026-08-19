// Solo tipos: evita un ciclo real en tiempo de ejecución con directStream, que importa de aquí.
import type { DirectKind } from './directStream';
import type { DirectMode } from '../types';

/**
 * QUÉ EXIGE CADA CDN PARA SERVIR SU VÍDEO — tabla MEDIDA, no supuesta.
 *
 * Durante mucho tiempo este proyecto dio por hecho que ningún host acepta una URL acuñada desde
 * otra red, y por eso servía el 100% del catálogo reenviando bytes desde la API. Se midió
 * (`scripts/dev/probe_hosts.ts`, 2026-07-25) y resultó falso: de 14 familias de host, **13
 * sirven perfectamente una URL acuñada desde otra IP**. La única que ata de verdad es
 * vidhideplus.
 *
 * La confusión venía de mezclar dos propiedades distintas:
 *   - la URL CADUCA (todas: 4 h en la familia upns) → da igual, se acuña al reproducir;
 *   - la URL va ATADA A LA IP que la pidió (solo vidhideplus) → esa sí obliga a proxear.
 *
 * CÓMO SE MIDIÓ `ipBound`, que es el dato que decide todo: se acuña la URL en local (IP
 * residencial) y se le pide a la API desplegada en Vercel que la descargue ella. Si el CDN se la
 * sirve, la URL cruza redes. Hay un detalle sin el cual la medición miente: `/stream/direct/seg`
 * RE-ACUÑA por su cuenta ante un 403, así que en la prueba se le pasa un `e=` que no se puede
 * re-acuñar. Con el control puesto, vidhideplus pasó de "no ata" a "ata" — era justo el falso
 * positivo que habría mandado a producción un `redirect` roto.
 *
 * UN MANIFIESTO NO ES UN SEGMENTO, y esa confusión ya costó un modo roto en producción. La
 * primera medición solo pidió la URL extraída —el m3u8 maestro— y dio por hecho que el resto de
 * la reproducción se comportaría igual. En la familia upns es al revés:
 *
 *   master.m3u8 / index-fN.m3u8  en pelisplus.upns.pro          → 200 sin Referer, 403 con uno AJENO
 *   seg-N.woff2                  en srcf.digitalhorizonlab.store → 403 SIN Referer, 200 con cualquiera
 *
 * Las dos reglas son incompatibles bajo un 302: no existe política de referrer de navegador que
 * cumpla las dos a la vez, y `Referrer-Policy: no-referrer` solo cubre el salto de la redirección
 * —la variante que hls.js pide después sale con el referrer de la página del reproductor—. De ahí
 * los campos `segment*` y el modo `manifest`.
 *
 * REGLA: ningún host sube de modo sin una medición que lo respalde, y la medición incluye AL
 * MENOS un segmento. Lo desconocido cae en `CONSERVATIVE`, que es el comportamiento de antes
 * (proxy).
 */

export interface HostPolicy {
  /**
   * Fragmentos de hostname del EMBED (no del CDN) que identifican a esta familia.
   *
   * Meter aquí un dominio que solo exista como CDN no da ningún error: simplemente no casa nunca,
   * y el host de embed que debía cubrir se queda en `CONSERVATIVE` reenviando bytes para siempre.
   * `scripts/dev/diag_host_policy_coverage.ts` es lo que saca a la luz esos huérfanos.
   */
  match: string[];
  /** El CDN valida la IP que acuñó la URL: no se puede redirigir al cliente. */
  ipBound: boolean;
  /** Devuelve 403 sin `Referer` del embed. Solo un cliente nativo puede ponerlo. */
  refererRequired: boolean;
  /**
   * Rechaza un `Referer` AJENO aunque tolere que no haya ninguno.
   *
   * Importa más de lo que parece: un navegador que siga nuestro 302 manda por defecto el
   * `Referer` de NUESTRA página, que para estos hosts es un referer ajeno → 403. Por eso el
   * redirect se emite con `Referrer-Policy: no-referrer`.
   */
  refererChecked: boolean;
  /** Manda `Access-Control-Allow-Origin`. Sin esto hls.js no puede leerlo desde un navegador. */
  cors: boolean;
  /** Exige un User-Agent de navegador. Los navegadores lo cumplen solos; los nativos no. */
  browserUaRequired: boolean;

  /**
   * Los tres campos siguientes describen el SEGMENTO, no el manifiesto, y pueden contradecirlo:
   * en la familia upns los segmentos ni siquiera están en el mismo host que las playlists.
   */

  /**
   * El segmento devuelve 403 SIN `Referer`. Un cliente que no manda ninguno no lo descarga.
   *
   * Y tiene que ser `https`: medido en upns, el mismo referer con esquema `http` da 403. Por eso
   * `clientSendsReferer` (stream.routes.ts) solo cuenta los seguros.
   */
  segmentRefererRequired: boolean;
  /** Además valida QUÉ Referer es. Si es falso, le vale el de la página del reproductor. */
  segmentRefererChecked: boolean;
  /** El host del segmento manda `Access-Control-Allow-Origin`. Sin esto hls.js no puede leerlo. */
  segmentCors: boolean;
  /**
   * Sus segmentos NO son vídeo tal y como se sirven: llegan envueltos en otra cosa.
   *
   * emturbovid aloja en Google Drive, que no sirve vídeo a cualquiera pero sí imágenes, así que
   * cada segmento sale con `Content-Type: image/png` y con un PNG de 806 bytes por delante del
   * MPEG-TS. Su reproductor lo desenvuelve por JavaScript; un reproductor cualquiera no.
   *
   * Es la única propiedad que puede ATAR un host al proxy aunque su CDN sea impecable: da igual
   * que cruce redes, que no pida Referer y que mande CORS —lo hace todo bien— si los bytes que
   * entrega no se pueden reproducir sin quitarles el disfraz, y eso solo lo podemos hacer aquí.
   * Ver `QuitarDisfraz` en src/routes/stream.routes.ts.
   */
  segmentosDisfrazados?: boolean;
  /**
   * Su vídeo NO se puede servir desde nuestra red por ninguna vía, así que no se ofrece como
   * vídeo directo: el servidor se queda con su embed, que en un navegador funciona.
   *
   * Es distinto de todo lo demás de esta tabla, que describe QUÉ hace falta para servirlo. Esto
   * dice que no hay nada que hacer, y solo se pone con medición delante.
   *
   * vidhideplus es el caso: ata la URL a la IP que la acuñó —así que un 302 al cliente da 403— y
   * a la vez ESTRANGULA a las IP de datacenter, así que el proxy tampoco vale. Medido sobre
   * "4Ever" T1E1 con el mismo proxy y en la misma pasada: emturbovid entregó 519 KB en 1,2 s
   * (441 KB/s) y vidhideplus, 507 KB en 60 s —unos 10 KB/s—, cuando no devolvía 502 directamente.
   * A esa velocidad, diez segundos de vídeo tardan casi cuatro minutos en llegar.
   *
   * Anunciarlo como "Vídeo directo" era la peor de las opciones: el reproductor lo elige PRIMERO
   * por estar mejor rotulado, carga el manifiesto, enseña la duración y se cae con
   * `fragLoadError` a los diez segundos. El embed, en cambio, reproduce.
   */
  noSePuedeServirDirecto?: boolean;
  /** Vida observada de la firma, en segundos. `null` = no la declara en la URL. */
  tokenTtlSeconds: number | null;
  measuredAt: string;
  /** CDN observado detrás de este embed, para reconocer si algún día cambia. */
  cdn?: string;
}

const MEASURED_AT = '2026-07-25';

/**
 * Perfil de lo desconocido: se asume lo peor de cada campo. Un host nuevo se comporta
 * exactamente como antes de que existiera este fichero.
 */
export const CONSERVATIVE: HostPolicy = {
  match: [],
  ipBound: true,
  refererRequired: true,
  refererChecked: true,
  cors: false,
  browserUaRequired: true,
  segmentRefererRequired: true,
  segmentRefererChecked: true,
  segmentCors: false,
  tokenTtlSeconds: null,
  measuredAt: 'nunca',
};

/** Se recorre en orden: lo más específico primero. */
const POLICIES: HostPolicy[] = [
  // ── Ata por IP: es el único que TIENE que seguir pasando por el proxy ──────────────
  {
    /**
     * VIDHIDEPLUS VUELVE, Y ES EL HOST MÁS NUMEROSO DEL CATÁLOGO (33.195 servidores).
     *
     * Estuvo vetado con `noSePuedeServirDirecto` desde el 2026-07-25, y el motivo era bueno
     * ENTONCES: medido sobre "4Ever" T1E1, entregaba 507 KB en 60 s —unos 10 KB/s— a una IP de
     * datacenter, mientras emturbovid daba 441 KB/s en la misma pasada. A esa velocidad, diez
     * segundos de vídeo tardan casi cuatro minutos.
     *
     * Re-medido el 2026-08-19 con `scripts/dev/probe_vidhide_vercel.ts`, que hace la pregunta
     * desde los dos sitios que importan —esta red y la API DESPLEGADA, que es quien sirve—,
     * bajando hasta un segmento real:
     *
     *     entregan desde Vercel   8 de 8      media 233 KB/s
     *     entregan desde casa     7 de 8      media 244 KB/s
     *
     * Ya no estrangula. Y no es un matiz: era el 71 % de los servidores sin vídeo directo del
     * catálogo, apagados por una medición que había dejado de ser cierta.
     *
     * `ipBound` SE QUEDA, y a propósito. Lo que se ha demostrado es que el host entrega bien
     * cuando los bytes pasan por aquí; el veto que se levanta es el de «no hay nada que hacer»,
     * no la decisión de proxear. Si algún día se quiere probar el 302 al cliente, es otra
     * medición distinta (`probe_hosts.ts`) y otro día — de momento, lo medido es el proxy.
     *
     * LA LECCIÓN, porque este proyecto ya la ha pagado dos veces: una medición de un host caduca.
     * `measuredAt` está en la tabla justo para esto, y un veto total merece re-medirse antes de
     * heredarse otro mes. Los segmentos siguen sin medir; da igual mientras `ipBound` corte la
     * cascada antes de llegar a ellos.
     */
    match: ['vidhideplus', 'vidhide'],
    ipBound: true,
    refererRequired: false,
    refererChecked: false,
    cors: true,
    browserUaRequired: false,
    segmentRefererRequired: true,
    segmentRefererChecked: true,
    segmentCors: false,
    tokenTtlSeconds: null,
    measuredAt: '2026-08-19',
  },

  {
    // Google Drive lleva la IP de quien pidió la URL ESCRITA DENTRO (`…&ip=2803:c600:…`) además
    // de un `expire=` de un par de horas. No hace falta medirlo para saber que no cruza redes:
    // es una declaración explícita del CDN. Un 302 al cliente daría 403 desde su propia red.
    match: ['drive.google', 'googleusercontent'],
    ipBound: true,
    refererRequired: false,
    refererChecked: false,
    cors: false,
    browserUaRequired: false,
    segmentRefererRequired: true,
    segmentRefererChecked: true,
    segmentCors: false,
    tokenTtlSeconds: null,
    measuredAt: '2026-07-30',
    cdn: 'c.drive.google.com',
  },

  // ── Familia upns (SPA con id en el hash). Firma de 4 h y rechaza referers ajenos ───
  {
    // EL CASO QUE OBLIGÓ A INVENTAR EL MODO `manifest`. Las playlists están en el host del embed
    // y rechazan un Referer ajeno; los segmentos están en OTRO host (`srcf.digitalhorizonlab.
    // store`) y exigen un Referer, cualquiera. Un navegador no puede cumplir las dos: si manda el
    // de su página, mueren las playlists; si no manda ninguno, mueren los segmentos. La salida es
    // servir las playlists desde aquí —con el Referer bueno— y dejar que los segmentos, que se
    // conforman con el de la página del reproductor, vayan del CDN al cliente.
    //
    // Y DESDE EL 2026-08-17 NO SIRVE NINGÚN VÍDEO. Su API contesta, pero sin vídeo detrás: sobre
    // los embeds del catálogo, `/api/v1/video` devuelve 404, 429, o un 200 cuyo payload descifrado
    // trae `listo=false` y CERO campos de CDN. No es nuestro extractor —el descifrado AES sigue
    // funcionando y el JSON se lee entero—, es que el host ya no publica el vídeo.
    //
    // Por qué se marca en vez de dejarlo fallar solo: estos hosts entran por `deferredDirectFields`,
    // que anuncia `direct_stream` SIN resolverlo. Así que la ficha salía con dos o tres upns
    // rotulados «[Vídeo directo]» y `status: online` que el ordenador ponía los PRIMEROS —incluido
    // `primary_stream`—, y el único servidor bueno de la lista, un turboviplay en modo `proxy`,
    // caía al tercer puesto. Medido sobre 12 episodios del catálogo: 20 enlaces upns publicados,
    // 20 errores, 0 aciertos; los 12 turboviplay, 12 aciertos. El cliente se comía dos 502 antes
    // de llegar al que reproduce, y como la API no entrega embeds, muchos se quedaban en «se
    // probaron todas las fuentes».
    //
    // Es exactamente el pecado que FUENTES.md §5 llama el peor: publicar un vídeo directo muerto es
    // PEOR que no publicar ninguno, porque el cliente lo elige primero justo por estar mejor
    // rotulado. Mientras la familia no vuelva a servir vídeo, no se anuncia.
    match: ['upns.', 'strp2p', '4meplayer', 'rpmstream'],
    ipBound: false,
    noSePuedeServirDirecto: true,
    refererRequired: false,
    refererChecked: true,
    cors: true,
    browserUaRequired: false,
    segmentRefererRequired: true,
    segmentRefererChecked: false,
    segmentCors: true,
    tokenTtlSeconds: 4 * 60 * 60,
    measuredAt: '2026-08-17',
  },

  // ── Exigen el Referer del embed: solo redirigibles a clientes que fijen cabeceras ──
  {
    // Manifiesto, variante y segmento están todos en `ds1.dropcdn.io` y piden LO MISMO: el
    // Referer del embed, ni ninguno ni uno ajeno. Coherente de arriba abajo, y por eso no le
    // sirve el modo `manifest`: los segmentos tampoco perdonan.
    match: ['dropload'],
    ipBound: false,
    refererRequired: true,
    refererChecked: true,
    cors: true,
    browserUaRequired: false,
    segmentRefererRequired: true,
    segmentRefererChecked: true,
    segmentCors: true,
    tokenTtlSeconds: null,
    measuredAt: MEASURED_AT,
  },
  {
    // Segmentos sin medir: da igual, `refererRequired` ya manda a proxy a todo cliente que no
    // fije cabeceras, y el que las fija se lleva un `redirect` antes de mirarlos.
    match: ['barmonrey'],
    ipBound: false,
    refererRequired: true,
    refererChecked: true,
    cors: true,
    browserUaRequired: false,
    segmentRefererRequired: true,
    segmentRefererChecked: true,
    segmentCors: true,
    tokenTtlSeconds: null,
    measuredAt: MEASURED_AT,
  },

  // ── Sin CORS: un `<video>` los reproduce, pero hls.js en navegador no puede leerlos ──
  {
    // ok.ru se queda en `ipBound` A PROPÓSITO, en contra de lo que salió al medirlo.
    //
    // La sonda consiguió servirlo desde otra red, pero su URL lleva la IP de origen escrita
    // dentro (`/srcIp/190.5.…/`), y eso es una intención declarada de atarla. Que una muestra
    // pasara puede significar que no lo validan siempre, no que no lo validen nunca — y
    // equivocarse aquí es entregarle a un cliente nativo un 302 que no reproduce. Se queda en
    // proxy hasta que una muestra amplia diga lo contrario. Para navegadores da igual: sin
    // CORS ya iba por proxy de todas formas.
    // Segmentos sin medir: `ipBound` corta antes, y sin CORS tampoco habría modo `manifest`.
    match: ['ok.ru', 'odnoklassniki', 'okcdn.ru'],
    ipBound: true,
    refererRequired: false,
    refererChecked: false,
    cors: false,
    browserUaRequired: true,
    segmentRefererRequired: true,
    segmentRefererChecked: true,
    segmentCors: false,
    tokenTtlSeconds: null,
    measuredAt: MEASURED_AT,
    cdn: 'okcdn.ru',
  },
  {
    // Segmentos sin medir. En mp4 no importa (un `<video src>` no pasa por CORS ni por
    // playlists); en HLS la falta de CORS ya lo manda a proxy.
    match: ['blogspot', 'blogfc'],
    ipBound: false,
    refererRequired: false,
    refererChecked: false,
    cors: false,
    browserUaRequired: false,
    segmentRefererRequired: true,
    segmentRefererChecked: true,
    segmentCors: false,
    tokenTtlSeconds: null,
    measuredAt: MEASURED_AT,
  },

  // ── Abiertos de par en par: redirigibles a cualquier cliente ───────────────────────
  {
    // Todo (maestro, variante y segmento) vive en `enc10.goodstream.one` y se comporta igual:
    // cruza redes, no pide Referer y tolera uno ajeno. Lo único que exige es el User-Agent de
    // navegador — sin él responde 403, que durante el sondeo se confundió con atadura de IP.
    match: ['gscdn', 'goodstream'],
    ipBound: false,
    refererRequired: false,
    refererChecked: false,
    cors: true,
    browserUaRequired: true,
    segmentRefererRequired: false,
    segmentRefererChecked: false,
    segmentCors: true,
    tokenTtlSeconds: null,
    measuredAt: MEASURED_AT,
  },
  {
    // Abierto de arriba abajo aunque cada escalón esté en un host distinto: maestro en
    // `turboviplay.com`, variantes en `turbosplayer.com`, segmentos en `googleusercontent.com`.
    // Los tres sirven sin cabeceras y con `ACAO: *`, así que el 302 basta.
    //
    // `unlimplay` entra aquí porque su vídeo sale por `vimeos.net`, el mismo CDN, y al medirlo
    // (tres muestras) dio exactamente este perfil. Antes no casaba con nada: `vimeos.net` estaba
    // en la lista, pero eso es el CDN y `policyFor` compara contra el host del EMBED, así que sus
    // 276 servidores se quedaban en `CONSERVATIVE` pagando proxy sin motivo.
    match: ['vimeos.net', 'unlimplay'],
    ipBound: false,
    refererRequired: false,
    refererChecked: false,
    cors: true,
    browserUaRequired: false,
    segmentRefererRequired: false,
    segmentRefererChecked: false,
    segmentCors: true,
    tokenTtlSeconds: null,
    measuredAt: MEASURED_AT,
  },
  {
    /**
     * emturbovid SE SEPARA de la entrada de arriba, con la que compartía perfil, porque hay una
     * cosa que aquella medición no miró: QUÉ HAY DENTRO de los segmentos.
     *
     * Todo lo demás lo cumple —cruza redes, no pide Referer, manda CORS— y por eso se le venía
     * dando `redirect`, que es lo más rápido que hay. Pero sus segmentos salen de Google Drive
     * disfrazados de PNG, así que el cliente recibía imágenes y ningún reproductor arrancaba: se
     * reportó como "el primer servidor dice Vídeo directo y no reproduce", y era exactamente eso.
     *
     * Con `segmentosDisfrazados` vuelve al proxy. Cuesta ancho de banda —es uno de los hosts más
     * grandes del catálogo— y aun así es la opción barata: lo otro es un servidor que se anuncia
     * y no funciona, que es peor que no ofrecerlo.
     */
    match: ['emturbovid', 'turbovidhls'],
    ipBound: false,
    refererRequired: false,
    refererChecked: false,
    cors: true,
    browserUaRequired: false,
    segmentRefererRequired: false,
    segmentRefererChecked: false,
    segmentCors: true,
    segmentosDisfrazados: true,
    tokenTtlSeconds: null,
    measuredAt: '2026-07-30',
    cdn: 'lh3.googleusercontent.com (PNG + MPEG-TS)',
  },
];

/**
 * `vidnest` (vidnest.io / vidnest.live) se sondeó y se dejó FUERA a propósito.
 *
 * Da mp4, cruza redes y no pide cabeceras — sobre el papel, `redirect`. Pero solo respondió en 2
 * de 5 intentos, y su CDN (`fs7.vidnest.live`) resultó inalcanzable tanto desde una red
 * residencial como desde Vercel. Dos aciertos flojos no son una medición, y equivocarse aquí es
 * entregar un 302 que no reproduce sin que nada lo reporte. Son 25 servidores de 30 155 (0,08 %
 * del catálogo): no compensa el riesgo. Se queda en `CONSERVATIVE` hasta que el host se
 * estabilice y se pueda medir en serio.
 */

/** Política del host de un embed. Lo no medido cae en `CONSERVATIVE`. */
export function policyFor(url: string): HostPolicy {
  if (!url) return CONSERVATIVE;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = url.toLowerCase();
  }
  return POLICIES.find(p => p.match.some(m => host.includes(m))) || CONSERVATIVE;
}

/**
 * Capacidades del reproductor que hay al otro lado.
 *
 * Existe porque habrá clientes de todo tipo y no todos pueden lo mismo: ExoPlayer y AVPlayer
 * fijan `Referer` y `User-Agent` a voluntad; un navegador NO puede (son cabeceras prohibidas en
 * fetch/XHR) y encima necesita CORS para que hls.js lea los segmentos. Sin declarar nada se
 * asume lo que funciona en todas partes.
 */
export interface ClientCaps {
  /** El cliente sabe fijar Referer/User-Agent (app nativa). Se activa con `?mode=redirect`. */
  setsHeaders?: boolean;
  /**
   * El cliente mandará un `Referer` en las peticiones que haga POR SU CUENTA (los segmentos).
   *
   * No lo declara nadie: se deduce de si la petición entrante trae `Referer`/`Origin`
   * (`stream.routes.ts`). Es un predictor exacto, no una corazonada, porque esa petición y las
   * de los segmentos salen de la MISMA página con la MISMA política de referrer.
   */
  sendsReferer?: boolean;
}

/**
 * El modo más rápido que este vídeo tolera con este cliente.
 *
 * Aquí vivía la afirmación de que un modo intermedio de "solo el manifiesto" no tenía caso de
 * uso. Era falso, y por una razón concreta: la medición que la respaldaba solo había pedido el
 * m3u8 maestro. En la familia upns las playlists y los segmentos están en hosts distintos y
 * exigen cosas opuestas, así que para un navegador NO hay 302 posible pero tampoco hace falta
 * reenviar vídeo: basta con servir las playlists desde aquí. Ese es el modo `manifest`.
 */
export function bestMode(embedUrl: string, kind: DirectKind, caps: ClientCaps = {}): DirectMode {
  const policy = policyFor(embedUrl);

  // La firma va atada a la red que la pidió: solo sirve desde la máquina que la acuñó.
  if (policy.ipBound) return 'proxy';

  // Los bytes no son vídeo hasta que les quitamos el envoltorio, así que tienen que pasar por
  // aquí. Va ANTES incluso de `caps.setsHeaders`: no es cuestión de qué cabeceras sepa poner el
  // cliente, es que ningún reproductor —nativo o no— sabe desenvolverlos.
  if (policy.segmentosDisfrazados) return 'proxy';

  // Un cliente nativo pone las cabeceras que haga falta, así que a partir de aquí puede todo.
  if (caps.setsHeaders) return 'redirect';

  // Un mp4 es una sola petición: no hay playlists que reescribir ni segmentos que perseguir, y
  // un `<video src>` ni siquiera pasa por CORS. Solo le afecta lo que exija esa única petición.
  if (kind !== 'hls') return policy.refererRequired ? 'proxy' : 'redirect';

  // ── HLS en un cliente que no puede fijar cabeceras (navegador, VLC, curl) ──────────
  //
  // Un 302 solo vale si aguanta TODA la reproducción, no solo la primera petición. Son dos
  // condiciones independientes porque a menudo son hosts distintos:

  // Las playlists. `refererChecked` cuenta aunque el 302 lleve `Referrer-Policy: no-referrer`:
  // esa cabecera solo cubre el salto de la redirección, y la variante que hls.js pide después
  // sale con el referrer de la página del reproductor, que para estos hosts es ajeno → 403.
  const playlistsOk = !policy.refererRequired && !policy.refererChecked && policy.cors;

  // Los segmentos. Lo que el cliente mande —o deje de mandar— es lo que llega al CDN.
  const segmentsOk =
    (!policy.segmentRefererRequired || Boolean(caps.sendsReferer)) &&
    !policy.segmentRefererChecked &&
    policy.segmentCors;

  if (playlistsOk && segmentsOk) return 'redirect';

  // Las playlists no se pueden entregar crudas, pero los segmentos sí: se sirven los m3u8 desde
  // aquí (unos KB) y el vídeo sigue yendo del CDN al reproductor.
  if (segmentsOk) return 'manifest';

  return 'proxy';
}

/**
 * Cabeceras que el CDN espera, para publicarlas junto al enlace.
 *
 * Un cliente nativo las copia y puede pedir `?mode=redirect`; un navegador las ignora porque no
 * puede fijarlas, y por eso `bestMode` no le ofrece redirect cuando hacen falta.
 */
export function requiredHeaders(embedUrl: string, userAgent: string): Record<string, string> | undefined {
  const policy = policyFor(embedUrl);
  const headers: Record<string, string> = {};
  if (policy.refererRequired || policy.refererChecked) {
    try {
      headers.Referer = `${new URL(embedUrl).origin}/`;
    } catch {}
  }
  if (policy.browserUaRequired) headers['User-Agent'] = userAgent;
  return Object.keys(headers).length ? headers : undefined;
}
