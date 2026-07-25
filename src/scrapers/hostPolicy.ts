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
 * REGLA: ningún host sube de modo sin una medición que lo respalde. Lo desconocido cae en
 * `CONSERVATIVE`, que es exactamente el comportamiento de antes (proxy).
 */

export interface HostPolicy {
  /** Fragmentos de hostname del EMBED (no del CDN) que identifican a esta familia. */
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
  tokenTtlSeconds: null,
  measuredAt: 'nunca',
};

/** Se recorre en orden: lo más específico primero. */
const POLICIES: HostPolicy[] = [
  // ── Ata por IP: es el único que TIENE que seguir pasando por el proxy ──────────────
  {
    match: ['vidhideplus', 'vidhide'],
    ipBound: true,
    refererRequired: false,
    refererChecked: false,
    cors: true,
    browserUaRequired: false,
    tokenTtlSeconds: null,
    measuredAt: MEASURED_AT,
  },

  // ── Familia upns (SPA con id en el hash). Firma de 4 h y rechaza referers ajenos ───
  {
    match: ['upns.', 'strp2p', '4meplayer', 'rpmstream'],
    ipBound: false,
    refererRequired: false,
    refererChecked: true,
    cors: true,
    browserUaRequired: false,
    tokenTtlSeconds: 4 * 60 * 60,
    measuredAt: MEASURED_AT,
  },

  // ── Exigen el Referer del embed: solo redirigibles a clientes que fijen cabeceras ──
  {
    match: ['dropload'],
    ipBound: false,
    refererRequired: true,
    refererChecked: true,
    cors: true,
    browserUaRequired: false,
    tokenTtlSeconds: null,
    measuredAt: MEASURED_AT,
  },
  {
    match: ['barmonrey'],
    ipBound: false,
    refererRequired: true,
    refererChecked: true,
    cors: true,
    browserUaRequired: false,
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
    match: ['ok.ru', 'odnoklassniki', 'okcdn.ru'],
    ipBound: true,
    refererRequired: false,
    refererChecked: false,
    cors: false,
    browserUaRequired: true,
    tokenTtlSeconds: null,
    measuredAt: MEASURED_AT,
    cdn: 'okcdn.ru',
  },
  {
    match: ['blogspot', 'blogfc'],
    ipBound: false,
    refererRequired: false,
    refererChecked: false,
    cors: false,
    browserUaRequired: false,
    tokenTtlSeconds: null,
    measuredAt: MEASURED_AT,
  },

  // ── Abiertos de par en par: redirigibles a cualquier cliente ───────────────────────
  {
    match: ['gscdn', 'goodstream'],
    ipBound: false,
    refererRequired: false,
    refererChecked: false,
    cors: true,
    browserUaRequired: true,
    tokenTtlSeconds: null,
    measuredAt: MEASURED_AT,
  },
  {
    match: ['emturbovid', 'turbovidhls', 'vimeos.net'],
    ipBound: false,
    refererRequired: false,
    refererChecked: false,
    cors: true,
    browserUaRequired: false,
    tokenTtlSeconds: null,
    measuredAt: MEASURED_AT,
  },
];

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
}

/**
 * El modo más rápido que este vídeo tolera con este cliente.
 *
 * No existe un modo intermedio de "solo el manifiesto": la medición lo dejó sin caso de uso,
 * porque los hosts que exigen `Referer` lo exigen también en los segmentos y el único que ata
 * por IP lo ata todo. Si algún día aparece un host que sirva el manifiesto abierto y los
 * segmentos protegidos, ese será el momento de añadirlo.
 */
export function bestMode(embedUrl: string, kind: DirectKind, caps: ClientCaps = {}): DirectMode {
  const policy = policyFor(embedUrl);

  // La firma va atada a la red que la pidió: solo sirve desde la máquina que la acuñó.
  if (policy.ipBound) return 'proxy';

  // Un cliente nativo pone las cabeceras que haga falta, así que a partir de aquí puede todo.
  if (caps.setsHeaders) return 'redirect';

  // Un navegador no puede fijar `Referer`, y estos hosts lo exigen.
  if (policy.refererRequired) return 'proxy';

  // hls.js lee los segmentos por XHR: sin CORS el navegador los bloquea. Un mp4 en un
  // `<video src>` no pasa por ahí, así que le da igual.
  if (kind === 'hls' && !policy.cors) return 'proxy';

  return 'redirect';
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
