/**
 * IMPORTA EL CATÁLOGO DE VIDEOAPI, Y LO MANTIENE AL DÍA.
 *
 * Es el primer poblador del proyecto que no crawlea nada. videoapi.la publica su catálogo entero
 * en listas de ids de TMDB, así que aquí no hay índice que recorrer, ni plantilla que parsear, ni
 * identidad que demostrar: se piden las listas, se restan las que ya tenemos, y lo que sobra se
 * pide por su número. Ver la cabecera de `src/scrapers/videoapi.ts` para el porqué de todo eso.
 *
 * QUE ESTO SIRVA PARA LA CARGA INICIAL Y PARA LA SINCRONIZACIÓN NO ES UNA COMODIDAD: ES EL DISEÑO.
 * No hay dos modos ni dos scripts. Cada corrida hace lo mismo —bajar las listas, comparar, meter
 * lo que falte— y por eso «ponerse al día cuando ellos publiquen algo nuevo» sale gratis: lo nuevo
 * es, por definición, lo que aparece en su lista y no está en la nuestra. La primera corrida
 * encuentra 8.891 diferencias y la de dentro de seis horas encontrará las que hayan añadido.
 *
 * Un script que hiciera la carga inicial y otro la sincronización serían dos criterios de «qué es
 * nuevo» destinados a separarse, que es el patrón que este repositorio ya ha pagado varias veces.
 *
 * CADA FICHA SE ESCRIBE CON SU ENLACE DEMOSTRADO. No se guarda una url y se supone: se resuelve,
 * se baja el manifiesto y se descarga un segmento real, igual que hace el crawl. Cuesta 2,4 s por
 * ficha (medido sobre cinco títulos), diez veces menos que la media del catálogo, porque la cadena
 * es corta y uniforme. Lo que no reproduce no se escribe — sin esto el catálogo crecería en
 * títulos y no en cosas que se puedan ver, que es justo lo que `paraElCliente` existe para evitar.
 *
 *   npm run importar:videoapi -- --dry                 ← qué haría, sin escribir
 *   npm run importar:videoapi                          ← una tanda (300 fichas, 20 min)
 *   npm run importar:videoapi -- --limite=800 --minutos=45
 *   npm run importar:videoapi -- --solo=series
 *   npm run importar:videoapi -- --rehacer             ← revisita lo que ya tiene servidor suyo
 *   npm run importar:videoapi -- --tmdb=1399,550       ← solo estos, para probar un caso
 *   npm run importar:videoapi -- --limite=0 --minutos=0 --capitulos=0   ← TODO, de una sentada
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { httpClient } from '../src/utils/httpClient';
import { extractDirect } from '../src/scrapers/directStream';
import { bajarManifiesto, segmentoDescargable } from '../src/services/manifestHealth';
import { TmdbService } from '../src/services/tmdbService';
import { CatalogService, fusionarTemporadas } from '../src/services/catalogService';
import { searchIndexKey } from '../src/utils/text';
import {
  listarCatalogo,
  embedDeVideoapi,
  claseDeSerie,
  esUrlDeVideoapi,
  UA_NAVEGADOR,
  ClaseVideoapi,
  CatalogoDeVideoapi,
  CapituloDeVideoapi,
} from '../src/scrapers/videoapi';
import { MediaItem, ServerOption, ContentType } from '../src/types';

/**
 * El cliente CON PERMISOS, igual que `refreshCatalog`.
 *
 * `media_items` tiene RLS y la clave anónima no puede escribir: sin esto cada inserción vuelve con
 * «new row violates row-level security policy», y como el importador cuenta lo intentado y no lo
 * escrito, la corrida decía «6 fichas nuevas» sin haber guardado ninguna. Se degrada al cliente
 * anónimo si no hay `SUPABASE_SERVICE_ROLE_KEY`, que es lo que hace `getSupabaseAdmin`.
 */
const db = getSupabaseAdmin();

const argv = process.argv.slice(2);
/**
 * Un número de la línea de órdenes, donde **CERO SIGNIFICA SIN TOPE**.
 *
 * El `Number(x) || pordefecto` de toda la vida no vale aquí: cero es falso en JavaScript, así que
 * `--limite=0` devolvía 300 calladamente y no había forma de pedir «todo». Y hace falta pedirlo —
 * los topes de este script están puestos para que una corrida QUEPA en un runner de GitHub, no
 * porque el trabajo deba partirse. La carga inicial se hace de una sentada.
 */
const bandera = (nombre: string, pordefecto: number): number => {
  const v = argv.find((a) => a.startsWith(`--${nombre}=`));
  if (!v) return pordefecto;
  const n = Number(v.split('=')[1]);
  return Number.isFinite(n) && n >= 0 ? n : pordefecto;
};
const SIN_TOPE = Number.POSITIVE_INFINITY;
const DRY = argv.includes('--dry');
const REHACER = argv.includes('--rehacer');
const SOLO = (argv.find((a) => a.startsWith('--solo=')) || '').split('=')[1] || '';
/**
 * Trabajar SOLO estos `tmdb_id`, separados por comas.
 *
 * Existe para poder probar un camino concreto sin esperar a que la cola llegue a él. Hace falta de
 * verdad: la cola pone las fichas nuevas delante (ver el `sort` de `main`), así que el camino de
 * «esta obra ya está, añádele el servidor» —que es el que toca 739 películas y 86 series— queda al
 * final y no se ejerce en una tanda corta. Sin esto solo se probaría la mitad del importador.
 */
const TMDB = ((argv.find((a) => a.startsWith('--tmdb=')) || '').split('=')[1] || '')
  .split(',')
  .map(Number)
  .filter((n) => n > 0);
const LIMITE = bandera('limite', 300) || SIN_TOPE;
const MINUTOS = bandera('minutos', 20) || SIN_TOPE;
/**
 * Tope de capítulos por serie y corrida, con el mismo número que usa el crawl
 * (`CAPITULOS_POR_SERIE_Y_PASADA`). No es prudencia genérica: una serie larga se comería el
 * presupuesto entero de la tanda y dejaría fuera a cien fichas que solo necesitaban una petición.
 * Lo que no entre hoy entra en la vuelta siguiente, que es dentro de seis horas.
 */
const CAPITULOS_POR_SERIE = bandera('capitulos', 24) || SIN_TOPE;
/**
 * Seis a la vez. Lo que tumba a un runner de GitHub no es el total de peticiones sino la RÁFAGA
 * —está documentado en `poblar.yml`, con tres corridas canceladas para demostrarlo—, y seis es lo
 * que este repositorio ya usa para trabajo parecido sin que nadie conteste 429.
 */
const A_LA_VEZ = bandera('a-la-vez', 6);

const REFERER_VIMEOS = 'https://vimeos.net/';
const fin = MINUTOS === SIN_TOPE ? SIN_TOPE : Date.now() + MINUTOS * 60_000;
const quedaTiempo = () => Date.now() < fin;

interface Trabajo {
  clase: ClaseVideoapi;
  tmdbId: number;
  type: ContentType;
  /** La fila que ya existe, si existe. */
  fila?: { id: string; servers: any[]; seasons: any[] };
}

const cuenta = {
  fichasNuevas: 0,
  fichasEnriquecidas: 0,
  capitulos: 0,
  sinVideo: 0,
  sinTmdb: 0,
  errores: 0,
};

/**
 * EL ID DE LA FILA, CON EL TIPO DENTRO CUANDO ES SERIE.
 *
 * `va-<tmdb>` a secas no vale, y lo dice el propio esquema: **TMDB numera películas y series por
 * separado y los números se repiten** (movie 108291 es «Road Dogz» y tv 108291 es «Snowdrop»). Con
 * el número pelado como clave primaria, la serie 87093 chocaba contra la película 87093 —«Ojos
 * grandes», ya guardada— y la inserción moría con `duplicate key ... media_items_pkey`. Salieron
 * cuatro en cuanto la carga llegó a las series, y habrían salido muchas más.
 *
 * La tabla ya se defiende de esto en su UNIQUE `(tmdb_id, type)`; lo que faltaba era que el id de
 * la fila llevara la misma pareja. Las películas conservan `va-<tmdb>` para no reescribir las
 * 6.900 que ya están guardadas — el tipo solo hace falta para desempatar, y basta con que UNO de
 * los dos lo lleve.
 */
function idDeFicha(type: ContentType, tmdbId: number): string {
  return type === 'movie' ? `va-${tmdbId}` : `va-tv-${tmdbId}`;
}

/**
 * ¿REPRODUCE ESTE EMBED? Resolver, bajar el manifiesto y descargar un segmento de verdad.
 *
 * Los tres pasos, y no dos. Que `extractDirect` devuelva una url solo dice que se supo leer la
 * página; que el manifiesto baje solo dice que el CDN contesta. Lo único que le importa a quien
 * mira es que lleguen bytes de vídeo, y eso es el tercer paso. El proyecto ya se llevó ese
 * disgusto con Breaking Bad —dos capítulos anunciados, ninguno reproducía, los dos con
 * `direct_stream`— y por eso `paraElCliente` exige el sello que aquí se acuña.
 */
async function resolverYVerificar(
  embedUrl: string
): Promise<{ url: string; kind: 'hls' | 'mp4'; host: string } | null> {
  try {
    const r = await httpClient.get(embedUrl, {
      timeout: 20000,
      responseType: 'text',
      transformResponse: [(d: unknown) => d],
      headers: { 'User-Agent': UA_NAVEGADOR },
      validateStatus: () => true,
    });
    if (r.status !== 200) return null;

    const directo = await extractDirect(embedUrl, String(r.data), { allowNetwork: true });
    if (!directo) return null;

    // Un mp4 no tiene manifiesto que revisar: con que el host conteste al rango basta, y de eso
    // ya se encarga la verificación periódica. Aquí solo se cierra el caso del HLS, que es lo
    // que esta fuente entrega en el 100 % de lo medido.
    if (directo.kind === 'hls') {
      const manifiesto = await bajarManifiesto(directo.url, REFERER_VIMEOS);
      if (!manifiesto) return null;
      if (!(await segmentoDescargable(manifiesto, directo.url, REFERER_VIMEOS))) return null;
    }

    let host = '';
    try {
      host = new URL(directo.url).hostname;
    } catch {}
    return { url: directo.url, kind: directo.kind, host };
  } catch {
    return null;
  }
}

/**
 * El servidor que se guarda.
 *
 * `embed_url` es la url de videoapi —derivable del `tmdb_id`, o sea permanente—, NO la de vimeos
 * que hay detrás. La de vimeos rota entre copias espejo y su token dura 6 h: guardarla sería
 * guardar algo que se pudre. Ver `embedDeVideoapi`.
 *
 * `direct_stream` va con la url recién acuñada y su sello. El sello es lo que hace visible la
 * ficha (`paraElCliente` lo exige) y caduca, así que a partir de aquí la mantiene al día
 * `verificar.yml` como con cualquier otro servidor.
 */
function servidorDeVideoapi(
  embedUrl: string,
  directo: { url: string; kind: 'hls' | 'mp4'; host: string },
  etiqueta: string
): ServerOption {
  const ahora = new Date().toISOString();
  return {
    id: `videoapi-${etiqueta}`,
    name: 'VideoAPI',
    quality: '1080p',
    language: 'latino',
    embed_url: embedUrl,
    direct_stream: directo.url,
    direct_kind: directo.kind,
    direct_host: directo.host,
    headers: { Referer: REFERER_VIMEOS, 'User-Agent': UA_NAVEGADOR },
    status: 'online',
    last_checked: ahora,
    verified_at: ahora,
    source_id: 'videoapi',
  } as ServerOption;
}

/**
 * QUÉ CAPÍTULOS LE FALTAN A ESTA SERIE, mirando solo lo que ya está guardado.
 *
 * Vive en UNA función porque la respuesta se necesita en dos momentos —al armar la cola y al
 * trabajar la serie— y las dos tienen que contestar lo mismo. Se calculó primero solo en el
 * segundo, y eso dejaba un agujero que solo se nota con el tiempo: la cola metía las 1.800 series
 * en cada corrida, incluidas las ya completas, y como la tanda se recorta a `LIMITE` **antes** de
 * mirar si hay algo que hacer, una vuelta futura podía gastarse entera en series terminadas sin
 * escribir nada. La carga inicial no lo nota; la sincronización de dentro de un mes, sí.
 */
function capitulosPendientes(
  fila: { seasons: any[] } | undefined,
  capitulos: CapituloDeVideoapi[]
): CapituloDeVideoapi[] {
  if (REHACER) return capitulos;
  const yaResueltos = new Set<string>();
  for (const temp of fila?.seasons || []) {
    for (const ep of (temp as any)?.episodes || []) {
      if (yaTieneVideoapi(ep?.servers)) {
        yaResueltos.add(`${(temp as any).season_number}x${ep.episode_number}`);
      }
    }
  }
  return capitulos.filter((c) => !yaResueltos.has(`${c.temporada}x${c.capitulo}`));
}

/**
 * ¿Esta lista ya trae un servidor NUESTRO QUE SIRVA? — y lo segundo es la mitad importante.
 *
 * Miraba solo si existía la url del embed, y con eso el importador daba por hecha una ficha que se
 * había quedado MUDA. Pasa de verdad: cuando una sonda de salud juzga muerto un servidor —basta un
 * fallo transitorio— `sinVideoDirecto` le quita el `direct_stream` y lo deja como embed pelado. Un
 * servidor así NO SE PUBLICA (`paraElCliente` exige vídeo directo), y el camino de servir nunca
 * vuelve a extraerlo: la rama de `revisarServidores` para servidores sin directo solo comprueba
 * que el embed siga en pie, no reextrae.
 *
 * O sea que la ficha quedaba atrapada entre dos puertas: invisible para el cliente y ya-hecha para
 * el importador. Reportado con «Mad Max 2», que la fuente entrega sin problema; eran 14 de 6.491.
 *
 * Exigiendo `direct_stream` estas fichas vuelven a la cola y la siguiente vuelta las repara sola.
 * Es la misma idea que `--direct-only` en el crawl, sin necesidad de un modo aparte.
 */
function yaTieneVideoapi(servers: any[] | null | undefined): boolean {
  return (servers || []).some(
    (s) => esUrlDeVideoapi(String(s?.embed_url || '')) && Boolean(s?.direct_stream)
  );
}

/** Añade el servidor sin pisar los que ya estaban, y sin duplicarse a sí mismo. */
function fusionarServidores(previos: any[], nuevo: ServerOption): any[] {
  const resto = (previos || []).filter((s) => String(s?.embed_url || '') !== nuevo.embed_url);
  // Delante: la prioridad de fuente ya la reordena `sortServersBySourcePriority` al servir, pero
  // dejarlo primero aquí evita que una ficha con veinte servidores muertos lo esconda al final.
  return [nuevo, ...resto];
}

/** El catálogo nuestro, indexado por `tipo:tmdb`. Se pagina: supabase corta en 1000 por consulta. */
async function nuestroCatalogo(): Promise<Map<string, { id: string; servers: any[]; seasons: any[] }>> {
  const idx = new Map<string, { id: string; servers: any[]; seasons: any[] }>();
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await db
      .from('media_items')
      .select('id, tmdb_id, type, servers, seasons')
      .gt('tmdb_id', 0)
      .range(desde, desde + 999);
    if (error) throw new Error(error.message);
    for (const f of data || []) {
      idx.set(`${f.type}:${f.tmdb_id}`, {
        id: String(f.id),
        servers: (f as any).servers || [],
        seasons: (f as any).seasons || [],
      });
    }
    if (!data || data.length < 1000) break;
  }
  return idx;
}

/**
 * La ficha completa a partir del `tmdb_id`, sin pasar por el matcher.
 *
 * `enrichMediaItem` toma el id tal cual cuando viene positivo —no vuelve a emparejar nada— así que
 * esto es exactamente el camino que el proyecto ya usa para una ficha resuelta, y no un atajo: la
 * metadata la pone TMDB, con sus traducciones, su logo y su clasificación por edades.
 */
async function fichaDesdeTmdb(tmdbId: number, type: ContentType): Promise<MediaItem | null> {
  const semilla: MediaItem = {
    id: idDeFicha(type, tmdbId),
    tmdb_id: tmdbId,
    imdb_id: null,
    type,
    title: '',
    original_title: '',
    aliases: [],
    overview: '',
    rating: 0,
    genres: [],
    subcategories: [],
    poster: null,
    backdrop: null,
    logo: null,
    trailer: null,
    cast: [],
    dubbing_cast: [],
  };
  try {
    const ficha = await TmdbService.enrichMediaItem(semilla);
    // Sin ficha de TMDB no se anuncia nada (`veredictoDisponibilidad`), así que tampoco se
    // escribe: sería una fila invisible con enlaces dentro, que es basura que hay que purgar
    // después. La fuente direcciona POR tmdb_id, o sea que si esto falla es que TMDB no conoce
    // ese número — no que nos hayamos equivocado de obra.
    if (!ficha || !(ficha.tmdb_id > 0) || !ficha.title) return null;
    return ficha;
  } catch {
    return null;
  }
}

/** Escribe una ficha nueva. El id es `va-<tmdb>`, que es el molde registrado en `candidateIdsForUrl`. */
async function insertarFicha(ficha: MediaItem, servers: ServerOption[], seasons: any[]): Promise<boolean> {
  const ahora = new Date().toISOString();
  const fila: Record<string, unknown> = {
    id: ficha.id,
    tmdb_id: ficha.tmdb_id,
    imdb_id: ficha.imdb_id ?? null,
    type: ficha.type,
    title: ficha.title,
    original_title: ficha.original_title || ficha.title,
    title_normalized: searchIndexKey(ficha.title, ficha.original_title, ficha.aliases),
    aliases: ficha.aliases || [],
    tagline: ficha.tagline || '',
    overview: ficha.overview || '',
    rating: ficha.rating || 0,
    content_rating: ficha.content_rating || null,
    release_date: ficha.release_date || '',
    genres: ficha.genres || [],
    subcategories: ficha.subcategories || [],
    poster: ficha.poster,
    backdrop: ficha.backdrop,
    logo: ficha.logo,
    trailer: ficha.trailer,
    cast_data: (ficha.cast_details && ficha.cast_details.length ? ficha.cast_details : ficha.cast) || [],
    dubbing_cast_data: ficha.dubbing_cast || [],
    runtime: ficha.runtime ?? null,
    director: ficha.director || (ficha.created_by || []).join(', ') || null,
    metadata_source: ficha.metadata_source || 'tmdb',
    servers,
    seasons,
    total_seasons: ficha.total_seasons || seasons.length || 0,
    total_episodes: ficha.total_episodes || 0,
    source_url: servers[0]?.embed_url || null,
    source_urls: servers[0]?.embed_url ? [servers[0].embed_url] : [],
    has_streams: true,
    streams_updated_at: ahora,
    streams_checked_at: ahora,
    updated_at: ahora,
  };

  const { error } = await db.from('media_items').insert(fila);
  if (!error) return true;

  /**
   * Choque de `(tmdb_id, type)`: la obra ya está con otro id de fila. No es un fallo — pasa cuando
   * otra fuente la trajo entre que se leyó el índice y se llegó aquí. Se trata como lo que es: una
   * ficha que ya existe a la que hay que AÑADIRLE el servidor, nunca sustituirla.
   */
  if (/duplicate key/i.test(error.message)) {
    const { data } = await db
      .from('media_items')
      .select('id, servers, seasons')
      .eq('tmdb_id', ficha.tmdb_id)
      .eq('type', ficha.type)
      .limit(1);
    const yaEsta: any = data && data[0];
    if (yaEsta) {
      return actualizarFicha(
        { id: String(yaEsta.id), servers: yaEsta.servers || [], seasons: yaEsta.seasons || [] },
        servers[0],
        seasons
      );
    }
  }
  console.log(`   ! ${ficha.id}: ${error.message}`);
  cuenta.errores++;
  return false;
}

/**
 * Le añade el servidor a una ficha que ya existe, SIN PISAR NADA.
 *
 * Es la mitad menos vistosa del importador y la que más fichas toca: 739 películas y 86 series del
 * catálogo ya estaban, y a esas videoapi no les añade un título — les añade una segunda forma de
 * verlas. Justo lo que se pidió al empezar («necesitamos más fuentes»).
 */
async function actualizarFicha(
  fila: { id: string; servers: any[]; seasons: any[] },
  servidor: ServerOption | undefined,
  seasonsNuevas: any[]
): Promise<boolean> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (servidor) update.servers = fusionarServidores(fila.servers, servidor);
  if (seasonsNuevas.length) {
    update.seasons = fusionarTemporadas(fila.seasons || [], seasonsNuevas);
  }
  update.streams_updated_at = new Date().toISOString();
  update.streams_checked_at = new Date().toISOString();
  update.has_streams = true;

  const { error } = await db.from('media_items').update(update).eq('id', fila.id);
  if (error) {
    console.log(`   ! ${fila.id}: ${error.message}`);
    cuenta.errores++;
    return false;
  }
  return true;
}

/** Una película: una petición, una verificación, una escritura. */
async function haremosPelicula(t: Trabajo): Promise<void> {
  const embed = embedDeVideoapi('movie', t.tmdbId);
  const directo = await resolverYVerificar(embed);
  if (!directo) {
    cuenta.sinVideo++;
    return;
  }
  const servidor = servidorDeVideoapi(embed, directo, `${t.tmdbId}`);

  if (t.fila) {
    if (DRY || (await actualizarFicha(t.fila, servidor, []))) cuenta.fichasEnriquecidas++;
    return;
  }

  const ficha = await fichaDesdeTmdb(t.tmdbId, 'movie');
  if (!ficha) {
    cuenta.sinTmdb++;
    return;
  }
  if (DRY || (await insertarFicha(ficha, [servidor], []))) cuenta.fichasNuevas++;
}

/**
 * Una serie: la ficha de TMDB y los capítulos QUE LA FUENTE DICE QUE TIENE.
 *
 * Los capítulos salen de `episodes.txt`, o sea de una lista donde cada línea es un capítulo
 * concreto (`1855_4x26`). A los que no están en esa lista NO SE LES CUELGA NADA — ni el enlace de
 * la serie, ni el de otro capítulo. FUENTES.md llama a eso «el fallo peor sin dar error», y aquí
 * no hace falta defenderse de él con comprobaciones porque la fuente ya distingue.
 */
async function haremosSerie(t: Trabajo, catalogo: CatalogoDeVideoapi): Promise<void> {
  const capitulos = (catalogo.capitulosPorSerie.get(t.tmdbId) || [])
    .slice()
    .sort((a, b) => a.temporada - b.temporada || a.capitulo - b.capitulo);
  if (!capitulos.length) return;

  // La ficha primero: sin metadata de TMDB la serie no se anuncia, así que resolver treinta
  // capítulos de algo que no se va a poder escribir sería tirar treinta peticiones.
  let ficha: MediaItem | null = null;
  if (!t.fila) {
    ficha = await fichaDesdeTmdb(t.tmdbId, 'tvseries');
    if (!ficha) {
      cuenta.sinTmdb++;
      return;
    }
  }

  const pendientes = capitulosPendientes(t.fila, capitulos).slice(0, CAPITULOS_POR_SERIE);
  if (!pendientes.length) return;

  const resueltos: Array<{ c: CapituloDeVideoapi; servidor: ServerOption }> = [];
  for (let i = 0; i < pendientes.length && quedaTiempo(); i += A_LA_VEZ) {
    const tanda = pendientes.slice(i, i + A_LA_VEZ);
    const salidas = await Promise.all(
      tanda.map(async (c) => {
        const embed = embedDeVideoapi(t.clase, t.tmdbId, c.temporada, c.capitulo);
        const directo = await resolverYVerificar(embed);
        return directo
          ? { c, servidor: servidorDeVideoapi(embed, directo, `${t.tmdbId}-${c.temporada}x${c.capitulo}`) }
          : null;
      })
    );
    for (const s of salidas) if (s) resueltos.push(s);
  }

  if (!resueltos.length) {
    cuenta.sinVideo++;
    return;
  }

  // El árbol, en la forma que `fusionarTemporadas` espera. Solo con lo resuelto en esta corrida:
  // la fusión conserva lo que ya hubiera.
  const porTemporada = new Map<number, any[]>();
  const ahora = new Date().toISOString();
  for (const { c, servidor } of resueltos) {
    const lista = porTemporada.get(c.temporada) || [];
    lista.push({ episode_number: c.capitulo, servers: [servidor], checked_at: ahora });
    porTemporada.set(c.temporada, lista);
  }
  const seasons = [...porTemporada.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, episodes]) => ({ season_number: n, episodes: episodes.sort((a, b) => a.episode_number - b.episode_number) }));

  if (DRY) {
    cuenta.capitulos += resueltos.length;
    if (t.fila) cuenta.fichasEnriquecidas++;
    else cuenta.fichasNuevas++;
    return;
  }
  // Los capítulos se apuntan cuando la fila que los contiene se ha escrito de verdad: contarlos
  // antes es como el importador llegó a decir «6 fichas nuevas» con las seis inserciones vetadas
  // por RLS. Lo que no se escribió no cuenta.
  const apuntarCapitulos = () => { cuenta.capitulos += resueltos.length; };

  if (t.fila) {
    if (await actualizarFicha(t.fila, undefined, seasons)) { cuenta.fichasEnriquecidas++; apuntarCapitulos(); }
  } else if (ficha) {
    /**
     * Los capítulos de TMDB primero, y los enlaces encima.
     *
     * `enrichMediaItem` ya trae el árbol rotulado —nombre, sinopsis y fotograma de cada capítulo—
     * y eso es lo que FUENTES.md §4 bis pone como quinto camino a una ficha con metadata ajena:
     * una serie cuyos capítulos se llaman «INVENCIBLE 1x1». Aquí se conserva el rótulo de TMDB y
     * solo se le añaden los servidores.
     */
    const conRotulos = fusionarTemporadas((ficha as any).seasons || [], seasons);
    if (await insertarFicha(ficha, [], conRotulos.length ? conRotulos : seasons)) { cuenta.fichasNuevas++; apuntarCapitulos(); }
  }
}

async function main() {
  const rotulo = (n: number) => (n === SIN_TOPE ? 'sin tope' : String(n));
  console.log(
    `videoapi · limite=${rotulo(LIMITE)} minutos=${rotulo(MINUTOS)} ` +
      `capitulos=${rotulo(CAPITULOS_POR_SERIE)} a-la-vez=${A_LA_VEZ}${DRY ? ' (DRY)' : ''}`
  );

  const catalogo = await listarCatalogo();
  console.log(
    `listas: ${catalogo.peliculas.length} pelis · ${catalogo.series.length} series · ` +
      `${catalogo.anime.length} anime · ${catalogo.capitulosPorSerie.size} series con capítulos`
  );

  const nuestro = await nuestroCatalogo();
  console.log(`catálogo propio: ${nuestro.size} fichas con tmdb_id`);

  const animes = new Set(catalogo.anime);
  const cola: Trabajo[] = [];

  if (!SOLO || SOLO === 'peliculas') {
    for (const tmdbId of catalogo.peliculas) {
      const fila = nuestro.get(`movie:${tmdbId}`);
      if (fila && !REHACER && yaTieneVideoapi(fila.servers)) continue;
      cola.push({ clase: 'movie', tmdbId, type: 'movie', fila });
    }
  }
  if (!SOLO || SOLO === 'series' || SOLO === 'anime') {
    const ids = SOLO === 'anime' ? catalogo.anime : [...catalogo.series, ...catalogo.anime];
    for (const tmdbId of ids) {
      const fila = nuestro.get(`tvseries:${tmdbId}`);
      const capitulos = catalogo.capitulosPorSerie.get(tmdbId) || [];
      // Una serie sin capítulos pendientes no entra en la cola: si entrara, ocuparía un sitio de
      // la tanda para no hacer nada. Ver `capitulosPendientes`.
      if (!capitulosPendientes(fila, capitulos).length) continue;
      cola.push({ clase: claseDeSerie(tmdbId, animes), tmdbId, type: 'tvseries', fila });
    }
  }

  /**
   * LO NUEVO PRIMERO, y es una decisión, no el orden en que salió.
   *
   * Añadirle un segundo servidor a una ficha que ya se ve mejora su fiabilidad; traer una ficha
   * que no existe añade algo que antes no se podía ver. Con el presupuesto de una tanda cubriendo
   * solo una parte de la cola, lo segundo rinde más por petición gastada — y es lo que se pidió.
   */
  cola.sort((a, b) => Number(Boolean(a.fila)) - Number(Boolean(b.fila)));
  const elegidos = TMDB.length ? cola.filter((t) => TMDB.includes(t.tmdbId)) : cola;
  const tanda = elegidos.slice(0, LIMITE);
  console.log(
    `cola: ${cola.length} pendientes (${cola.filter((t) => !t.fila).length} fichas nuevas). ` +
      `Esta corrida: ${tanda.length}\n`
  );

  const peliculas = tanda.filter((t) => t.type === 'movie');
  const series = tanda.filter((t) => t.type === 'tvseries');

  // Las películas van en paralelo: una petición y una verificación cada una, sin estado compartido.
  for (let i = 0; i < peliculas.length && quedaTiempo(); i += A_LA_VEZ) {
    await Promise.all(peliculas.slice(i, i + A_LA_VEZ).map((t) => haremosPelicula(t).catch(() => { cuenta.errores++; })));
    if ((i / A_LA_VEZ) % 10 === 0) {
      console.log(`   … ${i + A_LA_VEZ}/${peliculas.length} películas · ${cuenta.fichasNuevas} nuevas`);
    }
  }

  // Las series de una en una: cada una ya abre `A_LA_VEZ` conexiones por sus capítulos.
  for (const t of series) {
    if (!quedaTiempo()) break;
    await haremosSerie(t, catalogo).catch(() => { cuenta.errores++; });
  }

  /**
   * Y SE RETIRA DEL CACHÉ LO QUE SE HA TOCADO.
   *
   * FUENTES.md lo tiene en su tabla de trampas: la metadata se cachea 6 h y con Redis compartido
   * las claves SOBREVIVEN A LOS DESPLIEGUES. Escribir la fila no basta — la ficha vieja seguiría
   * contestando, y una recién creada ni siquiera aparecería en los listados.
   */
  if (!DRY && (cuenta.fichasNuevas || cuenta.fichasEnriquecidas)) {
    await CatalogService.invalidateListings().catch(() => {});
  }

  console.log(
    `\n${cuenta.fichasNuevas} fichas nuevas · ${cuenta.fichasEnriquecidas} enriquecidas · ` +
      `${cuenta.capitulos} capítulos · ${cuenta.sinVideo} sin vídeo · ${cuenta.sinTmdb} sin ficha TMDB · ` +
      `${cuenta.errores} errores`
  );
  console.log(`Quedan ~${Math.max(0, elegidos.length - tanda.length)} en cola para la próxima vuelta.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
