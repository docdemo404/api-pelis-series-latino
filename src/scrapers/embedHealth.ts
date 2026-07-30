import { httpClient, USER_AGENT } from '../utils/httpClient';
import { unwrapRedirector } from './directStream';

/**
 * Verificación de salud de reproductores embed (capa de aplicación).
 * Extraído de realScraperService para separar la responsabilidad de
 * "¿este embed sigue vivo?" del scraping de catálogo en sí.
 */

/**
 * Frases que un host ENSEÑA al visitante cuando el vídeo ya no está. Se buscan en el texto
 * visible, con el `<script>` fuera.
 *
 * Sacar el script no es una precaución teórica: emturbovid —6.265 servidores, el segundo host más
 * grande del catálogo— salía marcado como caído entero porque su reproductor lleva
 * `throw new Error("Subtitle file not found")` en el JS, y `/file not found/i` casaba ahí dentro.
 * Los vídeos reproducían perfectamente (medido: holgura 6x en frío, 13x repetido), pero el orden
 * de servidores antepone lo que está `online`, así que el host más rápido quedaba enterrado.
 *
 * Una cadena de error DEFINIDA en código no es un error MOSTRADO. Esa es la distinción que faltaba.
 */
const SOFT_ERROR_PROSE = [
  /file is no longer available/i,
  /expired or has been deleted/i,
  /file not found/i,
  /file deleted/i,
  /video (has been|was) (deleted|removed)/i,
  /disabled due to copyright/i,
  /content removed/i,
  /video no disponible/i,
  /archivo (eliminado|no encontrado)/i,
  /404 not found/i,
  /this video (is|was) deleted/i,
  /media not found/i,
  /can't find the file/i,
  /we're sorry/i,
  /got deleted by the owner/i,
  /removed due a copyright/i,
  /copyright violation/i,
  /file you are looking for/i,
  /too many requests/i
];

/**
 * Marcadores que SÍ viven en el código o en los nombres de recurso: son la forma en que algunos
 * hosts señalan la baja sin escribir una frase. Se buscan en el HTML entero, script incluido,
 * porque es justo ahí donde aparecen.
 */
const SOFT_ERROR_MARKERS = [
  /player_blank\.jpg/i,
  /file_deleted/i,
  /video_not_found/i,
];

/**
 * ¿El host acabó redirigiendo a un dominio APARCADO?
 *
 * `wwN.<dominio>` (ww1, ww38…) es la firma de los aparcadores: el dueño dejó de servir y lo que
 * hay detrás es una página de anuncios que responde 200 tan feliz. Sin esta comprobación esos
 * embeds se declaran vivos para siempre — es lo que pasaba con listeamed.net (674 servidores),
 * que redirige a `ww1.listeamed.net`, y con vudeo.co, que acaba en `ww38.vudeo.co`.
 *
 * Un 200 de un aparcador es el peor caso posible: al espectador le sale un reproductor que nunca
 * arranca, y a nosotros nada nos dice que ese servidor haya que retirarlo.
 */
function esDominioAparcado(url: string): boolean {
  try {
    return /^ww\d+\./i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Los aparcadores que NO cambian de dominio: el host sigue siendo el de siempre y responde 200,
 * pero lo que sirve es el script de una plataforma de monetización.
 *
 * Se descubrió con `streamlare.com` y `ahvsh.com` (210 servidores). Su página mide exactamente lo
 * mismo sea cual sea el id del vídeo —4.711 bytes siempre—, se titula "Redirecting..." y lo único
 * que hace es un POST a `router.parklogic.com`. Y son un caso especialmente cruel: llevaban meses
 * apareciendo como "no se alcanza" por un problema de certificados nuestro, así que al arreglarlo
 * pasaron directamente a "falta extractor" — cuando lo que faltaba era enterarse de que el host
 * había cerrado.
 *
 * Se buscan routers concretos y no la palabra "parking" a secas: un reproductor legítimo no
 * manda peticiones a la pasarela de un aparcador, pero sí puede llevar esa palabra en cualquier
 * clase de CSS.
 */
const APARCADORES = [
  /router\.parklogic\.com/i,
  /parkingcrew\.net/i,
  /sedoparking\.com/i,
  /bodis\.com/i,
  /above\.com\/park/i,
];

/**
 * Hosts que sirven el fichero tal cual y a los que se les puede PREGUNTAR si sigue ahí.
 *
 * Los reproductores-envoltorio (el fluidplayer de Blogger que usa FuegoCine) cargan igual de bien
 * esté el vídeo o no: la página es suya, el fichero es de otro. 940 servidores del catálogo eran
 * exactamente eso —un envoltorio impecable con un `pixeldrain.com/api/file/<id>` borrado dentro—
 * y ningún control los tocaba porque todos miraban el envoltorio.
 */
const HOSTS_PREGUNTABLES = [/pixeldrain\.com\/api\/file\//i];

/** ¿Sigue existiendo el fichero que el envoltorio lleva en su parámetro? */
async function ficheroEnvueltoSigueVivo(embedUrl: string): Promise<boolean | null> {
  let dentro: string | null = null;
  try {
    const params = new URL(embedUrl).searchParams;
    for (const clave of ['link', 'url', 'file', 'source', 'src']) {
      const v = params.get(clave);
      if (v && HOSTS_PREGUNTABLES.some(re => re.test(v))) { dentro = v; break; }
    }
  } catch {
    return null;
  }
  if (!dentro) return null;

  try {
    // Se piden DOS BYTES, no el fichero: basta para saber si existe y no cuesta ancho de banda.
    const res = await httpClient.get(dentro, {
      headers: { 'User-Agent': USER_AGENT, Range: 'bytes=0-1' },
      timeout: 4000,
      validateStatus: () => true,
      responseType: 'arraybuffer',
    });
    return res.status === 200 || res.status === 206;
  } catch {
    // Un fallo de red no es una baja: no se condena a nadie por no haber podido preguntar.
    return null;
  }
}

/** Quita `<script>`, `<style>` y comentarios: deja lo que el visitante llegaría a leer. */
function visibleText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

/** ¿El cuerpo del embed dice que el vídeo ya no está? */
function hasSoftError(html: string): boolean {
  if (SOFT_ERROR_MARKERS.some(p => p.test(html))) return true;
  const texto = visibleText(html);
  return SOFT_ERROR_PROSE.some(p => p.test(texto));
}

/**
 * ¿Esta página ES el reproductor, o solo un trozo de paso que redirige a otro sitio?
 *
 * Importa para decidir si hacer caso a un `window.location` que aparezca en su JavaScript. Un
 * stub —el caso para el que se escribió aquel seguimiento, listeamed.net— no tiene reproductor:
 * su única función es mandarte a otra parte. Una página que trae el vídeo empaquetado dentro no
 * va a redirigir a nadie, y cualquier `location` que lleve estará en código condicional (avisos
 * de anti-sandbox, anti-devtools) que no se ejecuta en una reproducción normal.
 */
function isPlayerPage(html: string): boolean {
  return /eval\(function\(p,a,c,k,e,d\)/i.test(html)   // P.A.C.K.E.R.: el vídeo va dentro
    || /["']?sources["']?\s*:\s*\[/i.test(html)         // jwplayer y clones
    || /["']?file["']?\s*:\s*["'][^"']+\.(?:m3u8|mp4)/i.test(html);
}

export interface EmbedInspection {
  status: 'online' | 'offline';
  /** Cuerpo del embed. Vacío cuando no se llegó a descargar (403 del WAF, error de red). */
  html: string;
  /**
   * QUÉ regla condenó a este embed. Solo viaja cuando el veredicto es `offline`.
   *
   * No es decoración: hay dieciocho salidas distintas por las que una página acaba declarada
   * muerta, y sin saber cuál fue no se puede auditar una retirada masiva. Al probar la purga del
   * catálogo, waaw.to salía con un 33% de bajas; las páginas respondían 200 con su reproductor
   * intacto y ninguna de las reglas evidentes casaba. Sin este campo, la alternativa era
   * adivinar — y la consecuencia de adivinar mal es borrar servidores que funcionan.
   */
  motivo?: string;
}

/**
 * Verifica el estado real en la capa de aplicación de un iframe embed
 * (detecta Soft Errors HTTP 200 y distingue WAF HTTP 403).
 */
export async function verifyEmbedStatus(
  embedUrl: string,
  referer: string = 'https://tioplus.app'
): Promise<'online' | 'offline'> {
  return (await inspectEmbed(embedUrl, referer)).status;
}

/**
 * Igual que `verifyEmbedStatus` pero devolviendo además el HTML descargado.
 *
 * Existe para que la extracción del vídeo directo (src/scrapers/directStream.ts) reutilice
 * el cuerpo que esta comprobación ya se traía, en vez de volver a pedir la misma página:
 * así extraer el m3u8 durante el scraping no cuesta ni una petición HTTP extra.
 */
export async function inspectEmbed(
  embedUrl: string,
  referer: string = 'https://tioplus.app'
): Promise<EmbedInspection> {
  if (!embedUrl) return { status: 'offline', html: '' };
  // Se pide la URL NORMALIZADA, no la guardada: un redirector de Blogger o una ruta que el host
  // ya retiró darían un veredicto sobre la página equivocada. Ver `unwrapRedirector`.
  embedUrl = unwrapRedirector(embedUrl);
  // Se acumula aparte para poder devolverlo en CUALQUIER salida: aunque el embed se declare
  // caído, el cuerpo sigue sirviendo para diagnosticar por qué.
  let body = '';
  try {
    // 0. Detectar reproductores SPA basados en HASH (#hash_id) ej. upns.pro, rpmstream.live, 4meplayer.pro, strp2p.com
    const hashMatch = embedUrl.match(/https?:\/\/([^\/#]+)\/.*?#([a-zA-Z0-9_-]+)/);
    if (hashMatch) {
      const domain = hashMatch[1];
      const hashId = hashMatch[2];
      const apiUrl = `https://${domain}/api/v1/info?id=${hashId}`;
      try {
        const hashRes = await httpClient.get(apiUrl, {
          headers: { 'User-Agent': USER_AGENT, 'Referer': embedUrl },
          timeout: 4000,
          validateStatus: () => true
        });
        const dataStr = typeof hashRes.data === 'string' ? hashRes.data : JSON.stringify(hashRes.data || '');
        if (hashRes.status !== 200 || dataStr.length < 3600 || dataStr.includes('error') || dataStr.includes('not found')) {
          return { status: 'offline', html: body, motivo: 'spa-hash-sin-datos' };
        }
      } catch {
        return { status: 'offline', html: body, motivo: 'spa-hash-error' };
      }
    }

    const res = await httpClient.get(embedUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': referer,
      },
      timeout: 4000,
      validateStatus: () => true
    });

    // WAF / Anti-hotlink protection (ej. VidHide, StreamWish devuelven 403 Forbidden a scrapers automatizados pero funcionan 100% en navegador web)
    if (res.status === 403 || res.status === 401) {
      return { status: 'online', html: body };
    }

    if (res.status >= 400) return { status: 'offline', html: body, motivo: `http-${res.status}` };

    // El host dejó de servir y su dominio acabó en manos de un aparcador, que responde 200.
    if (esDominioAparcado(res.request?.res?.responseUrl || '')) return { status: 'offline', html: body, motivo: 'dominio-aparcado' };

    const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '');
    body = html;

    // El host no cambió de dominio: lo vendió. Lo que sirve ahora es un aparcador.
    if (APARCADORES.some(re => re.test(html))) return { status: 'offline', html: body, motivo: 'dominio-aparcado' };

    // Detectar mensajes de error en capa de aplicación (Soft Errors)
    if (hasSoftError(html)) return { status: 'offline', html: body, motivo: 'pagina-dice-borrado' };

    // El envoltorio carga bien pero el fichero que lleva dentro puede estar borrado. Solo se
    // pregunta cuando hay un fichero al que preguntar, así que no cuesta nada en el caso general.
    if ((await ficheroEnvueltoSigueVivo(embedUrl)) === false) return { status: 'offline', html: body, motivo: 'fichero-envuelto-borrado' };

    // Detectar redirecciones JS de window.location / document.location (ej. listeamed.net).
    //
    // Solo si la página es un TROZO DE PASO y no un reproductor: ver `isPlayerPage`. emturbovid
    // sirve el vídeo y además lleva una comprobación anti-sandbox con un
    // `window.location.href='/sandbox'` metido dentro de una función que solo corre si el iframe
    // trae el atributo `sandbox`. Nunca se ejecuta para un espectador, `/sandbox` responde 404, y
    // seguirla a ciegas marcaba como caídos sus 6.265 servidores.
    const jsLocationMatch = isPlayerPage(html) ? null : (
      html.match(/window\.location\.(?:replace|href)\s*=\s*['"]([^'"]+)['"]/i) ||
      html.match(/document\.location\.(?:replace|href)\s*=\s*['"]([^'"]+)['"]/i)
    );
    if (jsLocationMatch) {
      const redirectPath = jsLocationMatch[1];
      const targetUrl = redirectPath.startsWith('http') ? redirectPath : `${new URL(embedUrl).origin}${redirectPath}`;
      try {
        const jsRes = await httpClient.get(targetUrl, {
          headers: { 'User-Agent': USER_AGENT, 'Referer': embedUrl },
          timeout: 4000,
          validateStatus: () => true
        });

        if (jsRes.status >= 400 || jsRes.status === 429 || jsRes.status === 410) {
          return { status: 'offline', html: body, motivo: `salto-js-http-${jsRes.status}` };
        }
        // listeamed.net entrega su token en esta misma página y el salto acaba en `ww1.listeamed
        // .net`, un aparcador que responde 200: sin mirar el destino final, sus 674 servidores se
        // declaraban vivos.
        if (esDominioAparcado(jsRes.request?.res?.responseUrl || targetUrl)) {
          return { status: 'offline', html: body, motivo: 'salto-js-aparcado' };
        }

        const jsHtml = typeof jsRes.data === 'string' ? jsRes.data : '';
        if (hasSoftError(jsHtml)) return { status: 'offline', html: body, motivo: 'salto-js-dice-borrado' };
      } catch {
        return { status: 'offline', html: body, motivo: 'salto-js-error' };
      }
    }

    // Detectar redirección de huella JS de Vudeo (var redirect_link = '...') y seguir la redirección final
    const vudeoMatch = html.match(/var\s+redirect_link\s*=\s*['"]([^'"]+)['"]/i);
    if (vudeoMatch) {
      const targetUrl = vudeoMatch[1] + 'fp=-7';
      try {
        const vudeoRes = await httpClient.get(targetUrl, {
          headers: { 'User-Agent': USER_AGENT, 'Referer': embedUrl },
          timeout: 4000,
          validateStatus: () => true
        });

        if (vudeoRes.status >= 400 || vudeoRes.status === 410) {
          return { status: 'offline', html: body, motivo: `vudeo-http-${vudeoRes.status}` };
        }
        if (esDominioAparcado(vudeoRes.request?.res?.responseUrl || targetUrl)) {
          return { status: 'offline', html: body, motivo: 'vudeo-aparcado' };
        }

        const vudeoHtml = typeof vudeoRes.data === 'string' ? vudeoRes.data : '';
        if (hasSoftError(vudeoHtml)) return { status: 'offline', html: body, motivo: 'vudeo-dice-borrado' };
      } catch {
        return { status: 'offline', html: body, motivo: 'vudeo-error' };
      }
    }

    // Inspeccionar iframe interno de nivel 2 si el reproductor está encapsulado (ej. waaw.to / netu)
    const innerIframeMatch = html.match(/iframe[^>]+src=["']([^"']+)["']/i);
    if (innerIframeMatch) {
      const innerPath = innerIframeMatch[1];
      const innerUrl = innerPath.startsWith('http') ? innerPath : `${new URL(embedUrl).origin}${innerPath}`;
      try {
        const innerRes = await httpClient.get(innerUrl, {
          headers: { 'User-Agent': USER_AGENT, 'Referer': embedUrl },
          timeout: 3000,
          validateStatus: () => true
        });

        if (innerRes.status >= 400 || innerRes.status === 410) {
          return { status: 'offline', html: body, motivo: `iframe-interno-http-${innerRes.status}` };
        }

        const innerHtml = typeof innerRes.data === 'string' ? innerRes.data : '';
        if (hasSoftError(innerHtml)) return { status: 'offline', html: body, motivo: 'iframe-interno-dice-borrado' };
      } catch {}
    }

    // HTML extremadamente corto sin reproductores
    if (html.length < 250 && !html.includes('jwplayer') && !html.includes('video') && !html.includes('iframe') && !html.includes('source') && !html.includes('script')) {
      return { status: 'offline', html: body, motivo: 'cuerpo-vacio' };
    }

    return { status: 'online', html: body };
  } catch {
    if (embedUrl.includes('vidhide') || embedUrl.includes('streamwish') || embedUrl.includes('upns') || embedUrl.includes('waaw')) {
      return { status: 'online', html: body };
    }
    return { status: 'offline', html: body, motivo: 'excepcion' };
  }
}

/**
 * Extrae el nombre del servidor embed a partir de su URL o label
 */
export function getServerName(url: string, label?: string): string {
  if (label) return label.trim();
  const host = url.toLowerCase();
  if (host.includes('vidhide')) return 'VidHide';
  if (host.includes('streamwish')) return 'Streamwish';
  if (host.includes('filelions')) return 'FileLions';
  if (host.includes('voe')) return 'Voe';
  if (host.includes('doodstream') || host.includes('dood')) return 'DoodStream';
  if (host.includes('upstream')) return 'Upstream';
  if (host.includes('mp4upload')) return 'MP4Upload';
  if (host.includes('upfast') || host.includes('upf')) return 'UPFAST';
  if (host.includes('earnvids')) return 'Earnvids';
  if (host.includes('p2p')) return 'P2P';
  if (host.includes('mixdrop')) return 'MixDrop';
  if (host.includes('lulustream')) return 'LuluStream';
  return 'Servidor Latino';
}
