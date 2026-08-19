import { ServerOption, DirectMode } from '../types';
import { SourceManager, SourceConfig } from './sourceManager';
import { bestMode } from '../scrapers/hostPolicy';
import { directEndpointUrl } from '../scrapers/directStream';

/**
 * Cómo se va a servir este servidor HOY, no cómo se guardó.
 *
 * `direct_mode` es un valor persistido, y el catálogo arrastra decenas de miles de servidores
 * etiquetados `proxy` desde antes de que existiera `hostPolicy`. Ordenar por ese campo hacía que
 * todos empataran, que el desempate cayera en la prioridad de fuente y que se acabara eligiendo
 * SIEMPRE vidhideplus — el único host del catálogo que de verdad ata por IP y no puede evitar el
 * reenvío de bytes— teniendo al lado un emturbovid que se sirve con un 302. Medido: 482 KB/s
 * proxeado contra 1,2-2,1 MB/s por redirección, con el vídeo 1080p pidiendo 3,55 Mbps. Esa
 * diferencia es exactamente la que se nota como parones y como esperar al adelantar.
 *
 * Se asume un navegador (`sendsReferer: true`) porque al ordenar todavía no se sabe qué cliente
 * pedirá después, y es el caso mayoritario: separa bien "hay que reenviar bytes" (vidhideplus) de
 * "no hace falta" (upns → `manifest`, emturbovid → `redirect`). Equivocarse con un VLC solo
 * afecta al ORDEN, nunca a la corrección: `/api/v1/stream/direct` vuelve a decidir en cada
 * petición mirando las cabeceras reales.
 *
 * Sin `direct_kind` se asume HLS, que es el supuesto conservador: un mp4 nunca baja de modo por
 * culpa de los segmentos, así que dar por hecho HLS no puede sobrevalorar a nadie.
 */
export function effectiveDirectMode(server: ServerOption): DirectMode | undefined {
  if (!server.direct_stream) return undefined;
  // El modo `public` ya no existe, ni siquiera para las 1 115 fichas que lo llevan guardado: se
  // recalcula como cualquier otra. Ver `enlaceDirecto` justo debajo.
  if (!server.embed_url) return server.direct_mode;
  return bestMode(server.embed_url, server.direct_kind ?? 'hls', { sendsReferer: true });
}

/**
 * El `direct_stream` que se entrega hoy, aunque en la DB se guardara la URL cruda del CDN.
 *
 * Hubo un modo `public` que publicaba directamente el enlace del CDN cuando el mp4 no llevaba
 * firma: se ahorraba el salto por la API. Quedaron 1 115 servidores así (1,5 %) y salió mal por
 * tres sitios a la vez —lo reportó un cliente y lo confirmó la medición—:
 *
 *   1. CORS. archive.org (189) no manda `Access-Control-Allow-Origin` NINGUNO, así que un
 *      reproductor web que lea por fetch/MSE lo tiene bloqueado, y como la URL no es nuestra no
 *      hay forma de añadirle la cabecera.
 *   2. Se saltaba TODA la verificación de destino vivo: lo que no pasa por /stream/direct no se
 *      comprueba.
 *   3. Caducaba igual. 192 apuntaban a `cdn3.turboviplay.com`, que firma sus URLs — el enlace
 *      "permanente" que se guardó lleva meses muerto.
 *
 * Se corrige en la SALIDA y no solo en el scraper para no tener que esperar a que se vuelvan a
 * rastrear esas fichas: en cuanto se piden, ya salen apuntando a la API.
 */
export function enlaceDirecto(server: ServerOption): string | undefined {
  const actual = server.direct_stream;
  if (!actual || !server.embed_url) return actual;
  // Lo que ya apunta a la API (relativo o absoluto) se queda como está.
  if (!/^https?:\/\//i.test(actual) || actual.includes('/api/v1/stream/direct')) return actual;
  return directEndpointUrl(server.embed_url, server.direct_kind === 'mp4' ? 'mp4' : 'hls');
}

/**
 * Marcador de tipo de reproducción al final del nombre. Se busca con esta misma expresión para
 * poder QUITARLO antes de volver a ponerlo.
 *
 * Limpiar antes no es una precaución vacía: la lista que sale de `sortServersBySourcePriority` es
 * la que catalogService persiste en la DB, así que el nombre ya etiquetado vuelve a entrar por
 * aquí en la siguiente apertura. Sin este paso, cada pasada añadiría otro marcador y el nombre
 * acabaría siendo una cola de corchetes.
 *
 * Acepta las dos grafías de «vídeo» porque el nombre viaja por una base de datos y no siempre
 * vuelve con la tilde intacta.
 */
const MARCADOR_TIPO = /\s*\[(?:v[íi]deo\s+directo|embed)\]\s*$/i;

/**
 * Nombre del servidor con el tipo de reproducción escrito EN EL TÍTULO.
 *
 * `direct_stream` y `embed_url` no son dos alternativas equivalentes: el primero es el vídeo real
 * (m3u8/mp4), que se le pasa al reproductor tal cual; el segundo es un reproductor de terceros que
 * hay que incrustar en un iframe. Un nombre como «Streamwish - Latino» no distinguía uno de otro,
 * y para saber qué se iba a reproducir había que mirar los campos de cada servidor uno a uno.
 *
 * Todo servidor con vídeo directo conserva además su `embed_url` como respaldo, así que la
 * etiqueta dice cuál es la fuente PRIORITARIA, no la única.
 */
/**
 * Cuánto vale un sello de verificación antes de dejar de ser una prueba.
 *
 * Eran 48 h, calculadas para que el sello sobreviviera a una vuelta completa del barrido. Pero un
 * sello no es un turno de mantenimiento: es una promesa de que el vídeo está ahí, y estos hosts se
 * pudren en horas. Medido: «Milagro en la Celda 7» y «Volver al Futuro 3» se verificaron y tres
 * horas después daban 502 y 503 — y se seguían publicando porque el sello valía dos días.
 *
 * Seis horas. Y lo que hace viable acortarlo es que ahora el sello también se renueva al SERVIR:
 * cada vez que alguien abre una ficha, `revisarServidores` comprueba la cabeza de la lista y la
 * vuelve a sellar, así que lo que más se ve es lo que más fresco está.
 */
export const VERIFICADO_VIGENTE_MS = 6 * 60 * 60 * 1000;

/**
 * Lo que cuesta ENTREGAR este servidor, del más barato al más caro. Menor es mejor.
 *
 * `public` y `redirect` no hacen pasar ni un byte por esta API. `manifest` solo las playlists,
 * unos KB. `proxy` reenvía el vídeo entero.
 */
function costeDeEntrega(s: ServerOption): number {
  switch (s?.direct_mode) {
    case 'public': return 0;
    case 'redirect': return 1;
    case 'manifest': return 2;
    case 'proxy': return 3;
    default: return 2;   // sin declarar: ni lo mejor ni lo peor
  }
}

/** ¿A este servidor se le ha descargado vídeo de verdad hace poco? */
/**
 * Cuánto vale el sello de una URL PERMANENTE.
 *
 * Las seis horas de `VERIFICADO_VIGENTE_MS` existen porque la URL que se sella caduca sola: lleva
 * una firma con fecha dentro (`?e=129600`, `?expires=…`) y a las pocas horas devuelve 403 aunque
 * el fichero siga ahí. Sellar cada seis horas es perseguir esa caducidad.
 *
 * Un fichero de `archive.org` o de `1a-1791.com` no lleva firma ninguna: la URL que funcionó ayer
 * funciona hoy. Lo único que puede pasarle es que RETIREN el fichero, y eso no ocurre cada seis
 * horas. Aplicarles la misma ventana los sacaba del catálogo por no haber pasado el barrido, que
 * es justo el ir y venir de títulos del que veníamos.
 *
 * Una semana: lo bastante largo para que un barrido perdido no esconda nada, y lo bastante corto
 * para que un fichero retirado no se anuncie un mes.
 */
const VIGENCIA_PERMANENTE_MS = 7 * 24 * 60 * 60 * 1000;

function verificadoVigente(s: ServerOption): boolean {
  if (!s?.verified_at) return false;
  const t = Date.parse(s.verified_at);
  if (!Number.isFinite(t)) return false;
  const ventana = s.direct_mode === 'public' ? VIGENCIA_PERMANENTE_MS : VERIFICADO_VIGENTE_MS;
  return Date.now() - t < ventana;
}

export function nombreConTipo(name: string, tieneVideoDirecto: boolean): string {
  const base = (name || 'Servidor').replace(MARCADOR_TIPO, '').trim();
  return `${base} [${tieneVideoDirecto ? 'Vídeo directo' : 'Embed'}]`;
}

/**
 * Infiere la fuente de un servidor si no tiene source_id asignado
 */
export function getSourceId(server: ServerOption): string {
  if (server.source_id) return server.source_id.toLowerCase();
  const id = (server.id || '').toLowerCase();
  const name = (server.name || '').toLowerCase();
  if (id.includes('_fc_') || name.includes('fuegocine')) return 'fuegocine';
  if (id.includes('_db_') || name.includes('supabase')) return 'supabase';
  return 'tioplus';
}

/**
 * Ordena la lista de servidores respetando las prioridades configuradas en SourceManager (/panel):
 * 1. Status 'online' primero
 * 2. Vídeo directo (m3u8/mp4) antes que embed, y cuanto menos dependa de esta API, mejor
 * 3. Prioridad de Fuente de Servidor (Prioridad 1 primero, luego 2, etc.)
 * 4. Idioma Latino preferido
 * 5. Calidad más alta (4K > 1080p > 720p > 480p)
 *
 * El criterio 2 es lo que hace que reproducir signifique "vídeo directo" y que el iframe de
 * terceros quede como último recurso. Antes era el último desempate, así que un embed de una
 * fuente prioritaria adelantaba siempre a un servidor con vídeo directo de otra fuente.
 *
 * También filtra servidores pertenecientes a fuentes deshabilitadas (enabled: false).
 */
export function sortServersBySourcePriority(servers: ServerOption[], sourcesConfig?: SourceConfig[]): ServerOption[] {
  if (!servers || servers.length === 0) return [];

  const sources = sourcesConfig || SourceManager.getSources();
  const priorityMap: Record<string, number> = {};
  const enabledMap: Record<string, boolean> = {};

  sources.forEach(src => {
    const key = src.id.toLowerCase();
    priorityMap[key] = src.priority;
    enabledMap[key] = src.enabled;
  });

  // Filtrar servidores de fuentes deshabilitadas
  const activeServers = servers.filter(s => {
    const srcId = getSourceId(s);
    return enabledMap[srcId] !== false;
  });

  const qualityScore: Record<string, number> = {
    '4K': 4,
    '1080p': 3,
    '720p': 2,
    '480p': 1
  };

  // El modo se recalcula UNA vez por servidor, antes de ordenar: hacerlo dentro del comparador lo
  // repetiría en cada comparación. Y de paso se publica, para que el campo deje de mentir —
  // `direct_mode` es informativo (lo dice openapi.json) y anunciar el valor guardado describía un
  // comportamiento que ya no ocurre.
  //
  // El nombre se sella aquí por la misma razón: es el ÚLTIMO sitio por el que pasan todas las
  // listas antes de salir, vengan del scraper o de la DB. Los servidores guardados hace meses
  // llevan nombres de cuando no existía el vídeo directo, y catalogService le trasplanta
  // `direct_stream` a una ficha vieja cuando lo encuentra: en los dos casos el tipo real solo se
  // sabe con certeza aquí. No se muta el original —el caché en memoria entrega la misma
  // referencia en cada acierto—, se clona solo lo que cambia.
  const withEffectiveMode = activeServers.map(s => {
    const mode = effectiveDirectMode(s);
    const name = nombreConTipo(s.name, Boolean(s.direct_stream));
    const stream = enlaceDirecto(s);
    if (name === s.name && stream === s.direct_stream && (!mode || mode === s.direct_mode)) return s;
    return {
      ...s,
      name,
      ...(stream ? { direct_stream: stream } : {}),
      ...(mode ? { direct_mode: mode } : {}),
    };
  });

  /**
   * Un servidor con vídeo directo vale más que cualquier embed, y entre dos directos gana el que
   * menos depende de esta API. Los tres escalones están MEDIDOS, no supuestos (holgura en frío
   * desde Chile contra producción, `scripts/dev/diag_playback_speed.ts`):
   *
   *   public / redirect  el reproductor solo habla con el CDN     emturbovid 12,2x  gscdn 6,9x
   *   manifest           las playlists pasan por aquí             upns 0,8x - 1,4x
   *   proxy              cada byte pasa por aquí                  vidhideplus ~1,8x
   *
   * `manifest` y `redirect` empataban, y con el empate el desempate caía en la prioridad de
   * fuente: se acababa eligiendo un host con holgura 0,8x —que no puede reproducir sin pararse—
   * teniendo al lado uno de 12x. La diferencia no es el kilobyte de playlist que pasa por la API,
   * es que son CDN distintos y unos van mucho mejor que otros hacia Latinoamérica.
   *
   * OJO con leer la tabla al revés: en esa muestra `proxy` marcó mejor holgura que `manifest`, y
   * aun así va por debajo. Son dos cosas distintas. Ese 1,8x es de UN host cuyo CDN va bien y con
   * el borde ya caliente; lo que no cambia es que cada espectador de un `proxy` nos cuesta ancho
   * de banda del plan, así que no escala: cuando el presupuesto se agote dejará de proxear y esos
   * servidores no reproducirán nada. `manifest` es lento en upns por culpa de upns, no del modo.
   */
  const directScore = (s: ServerOption): number => {
    if (!s.direct_stream) return 0;
    // `public` es el más rápido que hay y estaba puntuando como `proxy`: su URL no caduca ni va
    // atada a una IP, así que se entrega tal cual y el reproductor habla DIRECTAMENTE con el CDN —
    // cero saltos, cero bytes nuestros, y adelantar cuesta lo que el CDN tarde. Empatarlo con el
    // modo que reenvía cada byte por nuestra función era lo contrario de lo que se quiere.
    if (s.direct_mode === 'public') return 4;
    if (s.direct_mode === 'redirect') return 3;
    if (s.direct_mode === 'manifest') return 2;
    return 1;
  };

  /**
   * AQUÍ NO SE FILTRA NADA. Ordenar y esconder no son la misma operación y no pueden vivir juntas.
   *
   * Hubo aquí un filtro que quitaba los embed cuando la ficha tenía vídeo directo vivo, y estaba
   * mal puesto: esta lista no es solo lo que se entrega, es también LO QUE SE GUARDA
   * —`catalogService` hace `result.servers = sortServersBySourcePriority(...)` y acto seguido
   * `persistStreams` lo escribe en Supabase—, así que cada ficha que pasaba por la resolución
   * completa perdía sus embed de la base de datos para siempre. No se ocultaban: se borraban.
   *
   * Esconderlos es una decisión de PRESENTACIÓN y vive en `paraElCliente`, al borde de la
   * respuesta, donde no puede tocar nada persistido.
   */
  return [...withEffectiveMode].sort((a, b) => {
    // 1. Status online primero
    if (a.status === 'online' && b.status !== 'online') return -1;
    if (b.status === 'online' && a.status !== 'online') return 1;

    // 2. Vídeo directo antes que embed
    const directA = directScore(a);
    const directB = directScore(b);
    if (directA !== directB) return directB - directA;

    // 3. LO QUE SE HA DEMOSTRADO QUE REPRODUCE, ANTES QUE LO QUE SOLO LO PARECE.
    //
    // `status: 'online'` y tener `direct_stream` dicen que el servidor se veía bien cuando se
    // scrapeó; no dicen que hoy haya vídeo al otro lado. `verified_at` sí: lo pone `--verificar`
    // después de bajar el manifiesto y descargarse un segmento real. Poniendo delante lo sellado,
    // el `primary_stream` —lo primero que intenta la app— es siempre algo probado, y lo no
    // verificado queda de reserva en vez de desaparecer.
    const verA = verificadoVigente(a);
    const verB = verificadoVigente(b);
    if (verA !== verB) return verA ? -1 : 1;

    /**
     * 4. ENTRE DOS QUE FUNCIONAN, EL QUE NO PASA POR AQUÍ.
     *
     * `direct_mode` no es decoración: dice por dónde viajan los bytes. Un `redirect` los manda del
     * CDN al reproductor y esta API se aparta; un `proxy` los reenvía uno a uno desde Vercel, lo
     * que añade un salto a cada segmento y se nota sobre todo al mover la barra, que es cuando el
     * reproductor pide muchos trozos seguidos.
     *
     * Medido sobre el catálogo: 2.609 servidores publicados, el 65% en `proxy` — y ahí no hay nada
     * que negociar, porque esos hosts atan la URL a la IP que la acuñó y un 302 le daría al cliente
     * un 403. Lo que sí se puede es que, cuando una ficha tiene de los dos, se entregue primero el
     * que va directo. No cambia lo que se puede ver; cambia lo que se tarda en verlo.
     */
    /**
     * 3.5 · LA MEJOR CALIDAD PRIMERO, y despues el que responda antes.
     *
     * Es la unica palanca real sobre la calidad. El reproductor solo puede elegir entre lo que el
     * servidor ofrece; si se le entrega uno que solo tiene 480p, no hay ajuste que lo suba. Medido
     * en Breaking Bad: su fuente tope a 720p y ningun cambio en ExoPlayer podia dar mas.
     *
     * Va DESPUES del sello —primero que funcione— y ANTES del coste de entrega: mas vale 1080p por
     * proxy que 480p directo. Un servidor sin medir no se penaliza ni se premia: se queda donde
     * estaba, que es el sesgo de siempre.
     */
    const altoA = a.max_height ?? 0;
    const altoB = b.max_height ?? 0;
    if (altoA !== altoB) return altoB - altoA;

    const tA = a.ttfb_ms ?? Number.MAX_SAFE_INTEGER;
    const tB = b.ttfb_ms ?? Number.MAX_SAFE_INTEGER;
    if (tA !== tB) return tA - tB;

    const costeA = costeDeEntrega(a);
    const costeB = costeDeEntrega(b);
    if (costeA !== costeB) return costeA - costeB;

    // 5. Prioridad de Fuente (1 primero, 2 después, 3 después...)
    const prioA = priorityMap[getSourceId(a)] ?? 99;
    const prioB = priorityMap[getSourceId(b)] ?? 99;
    if (prioA !== prioB) return prioA - prioB;

    // 6. Idioma Latino preferido
    if (a.language === 'latino' && b.language !== 'latino') return -1;
    if (b.language === 'latino' && a.language !== 'latino') return 1;

    // 7. Calidad más alta
    const scoreA = qualityScore[a.quality] || 0;
    const scoreB = qualityScore[b.quality] || 0;
    if (scoreA !== scoreB) return scoreB - scoreA;

    return 0;
  });
}

/**
 * LO ÚNICO QUE SALE HACIA LA APP: vídeo directo, y sin la URL del embed al lado.
 *
 * Son dos recortes, y el segundo es el que faltaba. Ocultar los servidores que solo tienen embed
 * no basta, porque un servidor CON vídeo directo seguía viajando con su `embed_url` puesta, y un
 * cliente que encuentre ese campo lo usa: lo reportó el usuario con «31 Minutos: Calurosa Navidad»,
 * cuyo único servidor está correctamente extraído —el endpoint contesta 302 a un mp4 de 886 MB en
 * rumble.cloud, comprobado— y aun así no se reproducía, porque la app cogía el `embed_url`, que
 * apunta a `repfuegocinefree.blogspot.com/?player=fluidplayer`: una página con su propio
 * reproductor dentro. «Viene con todo y reproductor», exactamente.
 *
 * Así que el campo no se entrega. No se pierde nada recuperable: `direct_stream` lleva la URL del
 * embed codificada en su parámetro `e=`, que es de donde `/api/v1/stream/direct` la vuelve a sacar
 * en cada petición para acuñar el enlace. Y en la base de datos sigue intacta —esto es un filtro de
 * SALIDA—, así que los repasos, las re-extracciones y el sondeo de salud siguen teniéndola.
 *
 * Un servidor `offline` no cuenta como vídeo directo: está demostrado muerto.
 *
 * Cuando no queda ninguno, la respuesta va VACÍA en vez de caer al embed. Es deliberado: la app de
 * este catálogo no sabe incrustar iframes, así que ofrecerle uno no es una alternativa peor, es
 * un botón de reproducir que no hace nada. Que la ficha conteste «no hay» es información; darle
 * algo irreproducible, no. Las fichas que se quedan sin nada se marcan `has_streams = false` con
 * `repairCatalog --sin-directo` y dejan de aparecer en los listados.
 */
export function paraElCliente<T extends ServerOption>(servers: T[] | undefined | null): T[] {
  if (!servers?.length) return [];
  return servers
    /**
     * Y ADEMÁS, DEMOSTRADO. Tener `direct_stream` y no estar `offline` dice que al scrapear se le
     * sacó una url y su página cargaba; no dice que hoy haya vídeo al otro lado. Sobre 4.087
     * servidores publicados, solo 447 lo habían demostrado — el resto eran una url y una
     * suposición.
     *
     * Es lo que quedaba por cerrar. El usuario lo dio con Breaking Bad: la serie salía con dos
     * capítulos, y ninguno reproducía. Los dos tenían `direct_stream`; ninguno había pasado por
     * `--verificar`, que es quien baja el manifiesto y se descarga un segmento real.
     *
     * El precio se sabe y se acepta: hasta que el verificador dé su primera vuelta, el catálogo
     * queda en una cuarta parte. Un catálogo pequeño donde todo se ve vale más que uno grande
     * donde falla el botón de reproducir.
     */
    .filter(s => verificadoVigente(s))
    .filter(s => s?.direct_stream && s.status !== 'offline')
    .map(s => {
      const { embed_url, ...resto } = s as ServerOption;
      return resto as T;
    });
}

/**
 * ¿Esta ficha tiene algo que el cliente pueda reproducir?
 *
 * ÚNICA FUENTE DE VERDAD DE `has_streams`. No es una comodidad: es la respuesta a que ese valor se
 * escribía desde cinco sitios con cinco criterios distintos, todos copias del de `paraElCliente`
 * hechas en momentos distintos. Mientras el criterio no cambió, las copias coincidían y nadie lo
 * notó; en cuanto `paraElCliente` empezó a exigir verificación, se separaron en silencio y el
 * catálogo empezó a anunciar fichas que no podían enseñar ni un capítulo. Una de las copias
 * —`despues.length > 0`, en la purga de servidores muertos— ni siquiera miraba los episodios, así
 * que decidía sobre una serie mirando solo lo que cuelga de la película.
 *
 * Lo que se copia se desincroniza. Lo que se llama, no.
 *
 * Una película necesita un directo propio; una serie, uno en cualquiera de sus CAPÍTULOS.
 *
 * Y en una serie los servidores de nivel ficha NO cuentan, que es la otra mitad del mismo fallo.
 * Salen de scrapear la página de la serie —el reproductor que esa página trae cargado, o sea UN
 * capítulo suelto, normalmente el último— y desde que un episodio no hereda nada, no aparecen por
 * ninguna parte de la respuesta: el cliente reproduce capítulos. Contarlos hacía visible una serie
 * que después no podía enseñar ni una línea de lista. Medido: entre las series visibles sin un
 * solo capítulo anunciable, unas cuantas lo eran solo por esto.
 */
export function fichaReproducible(item: {
  type?: string | null;
  servers?: ServerOption[] | null;
  seasons?: Array<{ episodes?: Array<{ servers?: ServerOption[] | null }> | null }> | null;
}): boolean {
  const enEpisodios = (item?.seasons || []).some(t =>
    (t?.episodes || []).some(e => paraElCliente(e?.servers).length > 0)
  );
  if (item?.type === 'tvseries') return enEpisodios;
  return paraElCliente(item?.servers).length > 0 || enEpisodios;
}

/**
 * QUÉ VALOR LE TOCA A `has_streams`, decidido en UN SOLO SITIO.
 *
 * `fichaReproducible` unificó el CRITERIO —qué cuenta como reproducible— y con eso se acabaron las
 * cinco copias que se habían desincronizado. Pero quedaba la otra mitad del problema, y es la que
 * mordió cuatro veces en la misma sesión: **cuándo hay derecho a decidir**.
 *
 * Siete sitios escribían el veredicto, cada uno en un momento distinto y con distinta cantidad de
 * información delante, y cada uno resolvía a su manera qué hacer cuando no encontraba nada. Los
 * daños fueron siempre del mismo tipo:
 *
 *   · La migración 007 escondió ~700 series calculando sobre capítulos que nunca se habían
 *     resuelto, porque un capítulo sin resolver y uno vacío se ven igual en la base de datos.
 *   · `persistEpisodeServers` enterraba una serie entera en cuanto el PRIMER capítulo comprobado
 *     salía vacío, con los otros veinticinco sin mirar: 789 series visibles cayeron a 534.
 *   · `--servidores-muertos` decidía sobre una serie mirando solo los servidores de la película.
 *
 * Ninguno era un error de criterio. Los tres eran concluir sin haber medido.
 *
 * La regla, ahora escrita una vez: **encontrar algo reproducible basta para decir que sí; no
 * encontrarlo solo basta para decir que no si de verdad se ha mirado todo lo que había que
 * mirar.** Cuando no, se devuelve `undefined` y quien llame no toca la columna — que es muy
 * distinto de escribir `false`.
 */
export type Disponibilidad = true | false | undefined;

/**
 * ¿Le queda a esta ficha algún servidor SIN MIRAR que todavía pudiera reproducir?
 *
 * Es la pieza que faltaba para poder concluir sobre una PELÍCULA en el camino de una petición, y
 * se puede leer del propio resultado de `revisarServidores` sin llevar la cuenta aparte:
 *
 *   · si se le sondeó y entregó vídeo  → lleva sello recién puesto (y entonces la ficha es
 *     reproducible, así que no se llega hasta aquí);
 *   · si se le sondeó y no lo entregó  → se le quitó el `direct_stream` y bajó a `offline`;
 *   · si no se le sondeó                → sigue tal cual: con su `direct_stream` y sin caer.
 *
 * O sea que un servidor con vídeo directo que no está `offline` es exactamente uno que esta
 * pasada NO llegó a mirar. Si no queda ninguno así, la lista se ha agotado: lo que hay se ha
 * probado entero.
 *
 * Los que solo traen `embed_url` no cuentan como pendientes: esta API no publica iframes, así
 * que por mucho que se les mire no van a aportar nada reproducible.
 */
function quedaPorMirar(servers?: ServerOption[] | null): boolean {
  return (servers || []).some(s => s?.direct_stream && s.status !== 'offline');
}

export function veredictoDisponibilidad(
  item: {
    type?: string | null;
    servers?: ServerOption[] | null;
    seasons?: Array<{ episodes?: Array<{ servers?: ServerOption[] | null; checked_at?: string }> | null }> | null;
  },
  /**
   * Qué se ha llegado a mirar de verdad en esta pasada:
   *   'todo'      se revisó la ficha entera (una purga completa, un recálculo sobre lo guardado).
   *   'parcial'   se miró una parte (un capítulo suelto, una tanda del verificador).
   *   'nada'      no se pudo preguntar a ninguna fuente: no se concluye NADA.
   */
  alcance: 'todo' | 'parcial' | 'nada'
): Disponibilidad {
  if (fichaReproducible(item)) return true;   // basta con encontrar uno
  if (alcance === 'nada') return undefined;
  if (alcance === 'todo') return false;

  /**
   * Parcial y sin nada: solo se concluye si la ficha está agotada, es decir, si no queda ningún
   * capítulo por comprobar. Es lo que impide que el primer capítulo vacío entierre la serie.
   */
  const episodios = (item?.seasons || []).flatMap(t => t?.episodes || []);
  if (episodios.length > 0) return episodios.every(e => e?.checked_at) ? false : undefined;

  /**
   * Y UNA SERIE SIN ÁRBOL DE TEMPORADAS TAMPOCO SE CONCLUYE, aunque no le quede ningún servidor.
   *
   * Es el caso que enterró ~700 series con la migración 007: una serie a la que todavía no se le
   * han resuelto los capítulos se ve EXACTAMENTE igual que una a la que se le miraron todos y no
   * tenía ninguno. Sus servidores de ficha no dicen nada —no se publican, ver `fichaReproducible`—
   * así que aquí no hay nada que haya sido mirado. Lo dice el banco de pruebas, no la intuición:
   * `test_veredicto_disponibilidad.ts` lo cubre desde entonces.
   */
  if (item?.type === 'tvseries') return undefined;

  /**
   * UNA PELÍCULA NO TIENE MÁS SITIOS DONDE MIRAR QUE SU LISTA DE SERVIDORES.
   *
   * Aquí se devolvía `undefined` siempre, y ese `undefined` es el agujero por el que se colaban
   * las fichas fantasma. El caso medido, «La Máscara»: la petición sondea sus seis servidores, el
   * único con vídeo directo contesta 403, se le retira el directo y la respuesta sale VACÍA. Se
   * acaba de demostrar que no hay nada que entregar… y no se escribía en ninguna parte, así que la
   * película seguía anunciándose en la portada, en el catálogo y en el buscador hasta que el
   * barrido de cada 3 h volviera a pasar por ella. Medido en producción: entre el 8 % y el 33 % de
   * lo que se anunciaba no entregaba un solo servidor.
   *
   * La cautela de la que nació ese `undefined` es real, pero es la de las SERIES —enterrar
   * veinticinco capítulos por lo que diga el primero— y ahí se queda, en la rama de arriba. En una
   * película «parcial» solo puede significar una cosa: que quedaron servidores sin sondear. Si no
   * queda ninguno, la pasada ha sido tan concluyente como la exhaustiva.
   */
  return quedaPorMirar(item?.servers) ? undefined : false;
}

/**
 * Selecciona el mejor enlace (Primary Stream) usando el servidor #1 tras ordenar por prioridad.
 * El orden ya antepone lo que está online y, dentro de eso, lo que trae vídeo directo, así que
 * el primero online es también el que mejor reproduce.
 */
export function getPrimaryStream(servers: ServerOption[]): ServerOption | undefined {
  if (!servers || servers.length === 0) return undefined;
  const sorted = sortServersBySourcePriority(servers);
  return sorted.find(s => s.status === 'online') || sorted[0];
}
