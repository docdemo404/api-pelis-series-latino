/**
 * TRAE AL CATÁLOGO LO QUE NETMIRROR REPRODUCE Y NOSOTROS NO TENÍAMOS — empezando por Prime Video.
 *
 * Hasta ahora NetMirror solo se pegaba como servidor a fichas que YA existían: `scanNetmirror.ts`
 * recorre `media_items` y pregunta título a título. Lo que ninguna otra fuente hubiera traído no
 * entraba nunca, aunque NetMirror lo tuviera. Este script hace el camino contrario: parte de un
 * catálogo AJENO y mete lo que falte.
 *
 * ─── De dónde sale la lista ─────────────────────────────────────────────────────────────────
 *
 * NetMirror tiene una sección de Prime Video (`/mobile/pv/`) además de la de Netflix, pero su
 * buscador no sirve para enumerar: contesta como mucho 50 títulos por consulta, busca por
 * subcadena y ordena por año, así que barrerlo a golpe de prefijos es lento y siempre incompleto.
 * Y aunque diera la lista entera, daría títulos con año — no ids de TMDB — y habría que emparejar
 * a mano, que es justo lo que este repositorio prohíbe hacer sin respaldo.
 *
 * La lista se pide a TMDB: `discover/movie` con el proveedor Prime Video en cada región que se
 * mira (India, que es el catálogo que NetMirror espeja; México y España, que es lo que ve quien
 * usa la app; Estados Unidos, el más grande). TMDB devuelve ids, y con el id se le pregunta a
 * NetMirror por su API `embed-tmdb/{tmdb}` si lo tiene. No hay emparejado: la identidad viene
 * dada de los dos lados. Medido sobre la primera página de India: 16 de 20 los tiene.
 *
 * ─── Solo películas, y no es prudencia ──────────────────────────────────────────────────────
 *
 * La API de NetMirror devuelve el MISMO mp4 para todos los capítulos de una serie (ver la nota en
 * `serverDeNetmirror`), y el catálogo ya no anuncia NetMirror para series por eso. Traer series
 * de Prime con NetMirror como única fuente sería anunciar temporadas enteras que reproducen el
 * piloto. Se quedan fuera hasta que la API lo arregle.
 *
 * ─── Cada ficha entra con su enlace demostrado ──────────────────────────────────────────────
 *
 * Igual que `importarVideoapi.ts`: no se guarda porque la API diga «ok». Se comprueba que el año
 * que NetMirror declara es el de TMDB, y se pasa el mp4 por `puedeAbrirse` — la misma prueba de
 * arranque que usa el verificador— con la cabecera Referer que su CDN exige. Lo que no arranca no
 * se escribe. Y lo que NetMirror dice no tener se apunta en `netmirror_cache`, que es donde
 * `scanNetmirror.ts` y la apertura de ficha ya miran antes de preguntar.
 *
 * El servidor que se guarda es EL MISMO que fabrica la apertura (`servidorDePelicula`): apunta a
 * nuestra ruta estable `/api/v1/netmirror/stream/<tmdb>?mode=redirect`, que reacuña el mp4 en
 * cada play, así que guardarlo no guarda nada que caduque. Su sello vale 30 días
 * (`VERIFICADO_VIGENTE_MS`); las corridas siguientes lo renuevan antes de que venza.
 *
 * ─── «No lo tiene» y «no contesta» son cosas distintas, y aquí costó verlo ──────────────────
 *
 * La primera corrida desde GitHub escribió 105 «no» en diez minutos y ni una ficha. NetMirror no
 * atiende a la IP de los runners, y el scraper devolvía `null` igual para un 403 que para un
 * título que no existe — así que el importador apuntaba cada bloqueo como «no lo tiene» durante
 * dos semanas. Hubo que borrarlos a mano. Desde entonces:
 *
 *   · el scraper contesta `tiene` / `no` / `sin-respuesta`, y solo el `no` se apunta;
 *   · antes de tocar nada se pregunta por una película que NetMirror SÍ tiene («El Origen»,
 *     27205); si no contesta `tiene`, la corrida se para con código 1 y sin escribir;
 *   · veinte `sin-respuesta` seguidos a mitad de corrida también la paran;
 *   · y con `--via=api` NetMirror se consulta a través de nuestra API en Vercel
 *     (`/api/v1/netmirror/probe/<tmdb>`), desde donde sí contesta. Es lo que usa el workflow.
 *
 *   npm run importar:netmirror -- --dry                    ← qué haría, sin escribir
 *   npm run importar:netmirror                             ← una tanda (300 fichas, 40 min)
 *   npm run importar:netmirror -- --regiones=IN,MX         ← solo estas regiones de TMDB
 *   npm run importar:netmirror -- --proveedor=netflix      ← la sección Netflix, mismo camino
 *   npm run importar:netmirror -- --tmdb=27205,155         ← solo estos, para probar un caso
 *   npm run importar:netmirror -- --via=api                ← preguntar a través de nuestra API
 *   npm run importar:netmirror -- --limite=0 --minutos=0   ← todo, de una sentada
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { consultarPelicula, servidorDePelicula, ConsultaNetmirror, FuenteNetmirror } from '../src/scrapers/netmirror';
import { puedeAbrirse, Arranque } from '../src/services/arranqueMp4';
import { TmdbService, TMDB_API_KEY } from '../src/services/tmdbService';
import { CatalogService } from '../src/services/catalogService';
import { searchIndexKey } from '../src/utils/text';
import { MediaItem, ServerOption } from '../src/types';

const db = getSupabaseAdmin();

const argv = process.argv.slice(2);
/** Un número de la línea de órdenes, donde CERO SIGNIFICA SIN TOPE (ver `importarVideoapi.ts`). */
const bandera = (nombre: string, pordefecto: number): number => {
  const v = argv.find((a) => a.startsWith(`--${nombre}=`));
  if (!v) return pordefecto;
  const n = Number(v.split('=')[1]);
  return Number.isFinite(n) && n >= 0 ? n : pordefecto;
};
const texto = (nombre: string, pordefecto: string): string =>
  (argv.find((a) => a.startsWith(`--${nombre}=`)) || '').split('=')[1] || pordefecto;

const SIN_TOPE = Number.POSITIVE_INFINITY;
const DRY = argv.includes('--dry');
const REHACER = argv.includes('--rehacer');
const LIMITE = bandera('limite', 300) || SIN_TOPE;
const MINUTOS = bandera('minutos', 40) || SIN_TOPE;
/** Páginas de `discover` por región. TMDB no deja pasar de la 500 (10.000 títulos). */
const PAGINAS = Math.min(bandera('paginas', 500) || 500, 500);
/**
 * Tres a la vez contra NetMirror. `scanNetmirror.ts` ya midió que con más, la API contesta
 * `noSource` a títulos que sí tiene — un rate-limit disfrazado de «no lo tengo» que dejaría
 * fichas fuera sin que nadie se entere.
 */
const A_LA_VEZ = bandera('a-la-vez', 3);
const REGIONES = texto('regiones', 'IN,MX,ES,US').split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);
const PROVEEDOR = texto('proveedor', 'prime').toLowerCase();
const TMDB = texto('tmdb', '').split(',').map(Number).filter((n) => n > 0);
/**
 * Por dónde se le pregunta a NetMirror. `directo` va a su API; `api` pasa por la nuestra en
 * Vercel, para las máquinas a las que NetMirror no atiende (los runners de GitHub). La URL de la
 * API sale de `API_PELIS_URL` o, si no está, de la de producción.
 */
const VIA = texto('via', 'directo').toLowerCase();
const API_PELIS = (process.env.API_PELIS_URL || 'https://api-catalogo-latino.vercel.app').replace(/\/$/, '');
/** Una película que NetMirror tiene seguro, para saber si desde aquí contesta antes de empezar. */
const PELICULA_TESTIGO = 27205; // El Origen (2010)
/** Tantos «no contesta» seguidos ya no son mala suerte: es que dejó de atendernos. */
const SIN_RESPUESTA_PARA_PARAR = 20;
/**
 * Antes de que el sello cumpla los 30 días se vuelve a comprobar y resellar. Veinte deja margen
 * para dos corridas perdidas: si el importador no corre en diez días seguidos, algo más grave
 * está pasando y se verá en el panel.
 */
const RESELLAR_TRAS_DIAS = 20;
/** Un «no lo tiene» de NetMirror vale dos semanas, el mismo plazo que usa `scanNetmirror.ts`. */
const NO_VALE_DIAS = 14;

/**
 * Los ids de proveedor de TMDB. Prime Video tiene DOS: el 9 es el de Estados Unidos y el 119 el
 * del resto del mundo (India, México, España…). Pedir el 9 en India devuelve cero, medido.
 */
const PROVEEDORES: Record<string, (region: string) => number> = {
  prime: (region) => (region === 'US' ? 9 : 119),
  netflix: () => 8,
};

const fin = MINUTOS === SIN_TOPE ? SIN_TOPE : Date.now() + MINUTOS * 60_000;
const quedaTiempo = () => Date.now() < fin;

const cuenta = {
  fichasNuevas: 0,
  fichasEnriquecidas: 0,
  reselladas: 0,
  noLoTiene: 0,
  sinRespuesta: 0,
  noArranca: 0,
  otraObra: 0,
  sinTmdb: 0,
  errores: 0,
};

interface Candidata {
  tmdbId: number;
  titulo: string;
  anio: string;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1. La lista: TMDB discover, por región, con el proveedor pedido
// ═══════════════════════════════════════════════════════════════════════════════════════════════

async function tmdb(ruta: string, params: Record<string, string | number>): Promise<any | null> {
  const q = new URLSearchParams({ api_key: TMDB_API_KEY, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  for (let intento = 0; intento < 3; intento++) {
    try {
      const r = await fetch(`https://api.themoviedb.org/3/${ruta}?${q}`, { signal: AbortSignal.timeout(15_000) });
      if (r.status === 429) {
        await new Promise((res) => setTimeout(res, 1500 * (intento + 1)));
        continue;
      }
      if (!r.ok) return null;
      return await r.json();
    } catch {
      /* siguiente intento */
    }
  }
  return null;
}

async function descubrir(): Promise<Map<number, Candidata>> {
  const proveedor = PROVEEDORES[PROVEEDOR];
  if (!proveedor) throw new Error(`proveedor desconocido: ${PROVEEDOR} (vale: ${Object.keys(PROVEEDORES).join(', ')})`);

  const lista = new Map<number, Candidata>();
  for (const region of REGIONES) {
    const primera = await tmdb('discover/movie', {
      with_watch_providers: proveedor(region),
      watch_region: region,
      sort_by: 'popularity.desc',
      page: 1,
    });
    if (!primera) {
      console.log(`   ${region}: TMDB no contestó`);
      continue;
    }
    const paginas = Math.min(Number(primera.total_pages) || 1, PAGINAS);
    const anotar = (j: any) => {
      for (const m of j?.results || []) {
        const id = Number(m?.id);
        if (!(id > 0) || lista.has(id)) continue;
        lista.set(id, { tmdbId: id, titulo: String(m.title || ''), anio: String(m.release_date || '').slice(0, 4) });
      }
    };
    anotar(primera);
    // Cuatro páginas a la vez: TMDB admite bastante más, pero no hay prisa y no hay que darle
    // motivos para contestar 429 a medio barrido.
    for (let p = 2; p <= paginas; p += 4) {
      const tanda = [];
      for (let k = p; k < p + 4 && k <= paginas; k++) {
        tanda.push(tmdb('discover/movie', { with_watch_providers: proveedor(region), watch_region: region, sort_by: 'popularity.desc', page: k }));
      }
      for (const j of await Promise.all(tanda)) anotar(j);
    }
    console.log(`   ${region}: ${primera.total_results} títulos en ${paginas} páginas → ${lista.size} distintos acumulados`);
  }
  return lista;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. Lo que ya tenemos, preguntado a vistas — nunca bajándose el catálogo
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** Películas nuestras con tmdb_id, por tmdb → id de fila. Tres columnas, paginado con orden. */
async function nuestrasPeliculas(): Promise<Map<number, string>> {
  const idx = new Map<number, string>();
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await db
      .from('media_items')
      .select('id,tmdb_id')
      .eq('type', 'movie')
      .gt('tmdb_id', 0)
      .order('id')
      .range(desde, desde + 999);
    if (error) throw new Error(error.message);
    for (const f of (data || []) as any[]) idx.set(Number(f.tmdb_id), String(f.id));
    if (!data || data.length < 1000) break;
  }
  console.log(`   catálogo propio: ${idx.size} películas con tmdb_id`);
  return idx;
}

/**
 * Qué fichas ya llevan el servidor de NetMirror y de cuándo es su sello. Se le pregunta a la
 * vista `servidores_publicados` filtrando por nuestra ruta: unos KB, no la columna `servers`
 * entera de cada fila.
 */
async function selladasPorNetmirror(): Promise<Map<string, number>> {
  const sello = new Map<string, number>();
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await db
      .from('servidores_publicados')
      .select('media_id,verified_at')
      .like('embed_url', '/api/v1/netmirror/stream/%')
      .is('season_number', null)
      .order('media_id')
      .range(desde, desde + 999);
    if (error) throw new Error(`no se pudo leer servidores_publicados: ${error.message}`);
    for (const f of (data || []) as any[]) {
      const t = f.verified_at ? Date.parse(f.verified_at) : 0;
      const id = String(f.media_id);
      sello.set(id, Math.max(sello.get(id) || 0, Number.isFinite(t) ? t : 0));
    }
    if (!data || data.length < 1000) break;
  }
  console.log(`   ya con NetMirror: ${sello.size} fichas`);
  return sello;
}

/** Los tmdb que NetMirror dijo NO tener hace menos de dos semanas: no se le vuelve a preguntar. */
async function descartadosRecientes(): Promise<Set<number>> {
  const desde = new Date(Date.now() - NO_VALE_DIAS * 86_400_000).toISOString();
  const no = new Set<number>();
  for (let off = 0; ; off += 1000) {
    const { data, error } = await db
      .from('netmirror_cache')
      .select('tmdb_id')
      .eq('temporada', 0)
      .eq('episodio', 0)
      .eq('disponible', false)
      .gt('comprobado_at', desde)
      .order('tmdb_id')
      .range(off, off + 999);
    if (error) throw new Error(error.message);
    for (const f of (data || []) as any[]) no.add(Number(f.tmdb_id));
    if (!data || data.length < 1000) break;
  }
  console.log(`   descartadas hace menos de ${NO_VALE_DIAS} días: ${no.size}`);
  return no;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 3. Comprobar y escribir
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * La consulta, por el camino que toque. La respuesta tiene la misma forma por los dos, salvo que
 * por la API viene ADEMÁS el veredicto de arranque del mp4: la CDN de NetMirror tampoco atiende a
 * los runners de GitHub, así que desde allí no se puede probar el fichero — se prueba desde
 * Vercel, que es desde donde se sirve, y se trae el resultado.
 */
type Consulta = ConsultaNetmirror & { arranque?: Arranque };

async function consultar(tmdbId: number, conArranque = false): Promise<Consulta> {
  if (VIA !== 'api') return consultarPelicula(tmdbId);
  try {
    const r = await fetch(`${API_PELIS}/api/v1/netmirror/probe/${tmdbId}${conArranque ? '?arranque=1' : ''}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (r.status === 404) return { estado: 'no' };
    if (!r.ok) return { estado: 'sin-respuesta', detalle: `API HTTP ${r.status}` };
    const j = (await r.json()) as { data?: FuenteNetmirror; arranque?: Arranque };
    if (!j?.data?.mp4) return { estado: 'sin-respuesta', detalle: 'API sin fuente' };
    return { estado: 'tiene', fuente: j.data, arranque: j.arranque };
  } catch (e: any) {
    return { estado: 'sin-respuesta', detalle: e?.name === 'TimeoutError' ? 'timeout' : e?.message || String(e) };
  }
}

let sinRespuestaSeguidos = 0;
let parar = false;

async function anotarCache(tmdbId: number, disponible: boolean, resolucion: number | null): Promise<void> {
  if (DRY) return;
  try {
    await db.from('netmirror_cache').upsert(
      { tmdb_id: tmdbId, temporada: 0, episodio: 0, disponible, resolucion, comprobado_at: new Date().toISOString() },
      { onConflict: 'tmdb_id,temporada,episodio' }
    );
  } catch {
    /* la caché es un ahorro, no un requisito */
  }
}

/**
 * ¿Lo tiene, es la misma obra y arranca? Devuelve el servidor listo para guardar, o null.
 *
 * El año se compara con tolerancia de uno: TMDB fecha por estreno mundial y NetMirror por lo que
 * diga su origen, y una película estrenada en diciembre cambia de año según a quién se le
 * pregunte. Dos o más de diferencia ya no es eso — es otra obra con el mismo número, y se apunta
 * para verlo, no se guarda.
 */
async function resolverYVerificar(c: Candidata): Promise<ServerOption | null> {
  const consulta = await consultar(c.tmdbId, true);
  if (consulta.estado === 'sin-respuesta') {
    cuenta.sinRespuesta++;
    if (++sinRespuestaSeguidos >= SIN_RESPUESTA_PARA_PARAR && !parar) {
      parar = true;
      console.log(`   ✗ NetMirror lleva ${sinRespuestaSeguidos} consultas sin contestar (${consulta.detalle}); se para aquí.`);
    }
    return null;
  }
  sinRespuestaSeguidos = 0;
  if (consulta.estado === 'no') {
    cuenta.noLoTiene++;
    await anotarCache(c.tmdbId, false, null);
    return null;
  }
  const fuente = consulta.fuente;
  const anioNm = Number(fuente.meta.year) || 0;
  const anioTmdb = Number(c.anio) || 0;
  if (anioNm && anioTmdb && Math.abs(anioNm - anioTmdb) > 1) {
    console.log(`   ? ${c.tmdbId} «${c.titulo}» (${anioTmdb}): NetMirror dice «${fuente.meta.title}» (${anioNm}) — no se guarda`);
    cuenta.otraObra++;
    return null;
  }
  const arranque = consulta.arranque ?? (await puedeAbrirse(fuente.mp4, { Referer: fuente.referer }));
  if (!arranque.ok) {
    // Un tope agotado no condena (ver `arranqueMp4.ts`), pero tampoco se escribe: el importador
    // vuelve a pasar por aquí en la siguiente vuelta y lo que hoy fue lento entra mañana.
    cuenta.noArranca++;
    if (!arranque.sinVeredicto) console.log(`   ✗ ${c.tmdbId} «${c.titulo}»: ${arranque.causa} (${arranque.detalle})`);
    return null;
  }
  await anotarCache(c.tmdbId, true, Number(fuente.meta.resolution) || null);
  return servidorDePelicula(c.tmdbId, fuente);
}

/**
 * La ficha completa a partir del `tmdb_id`, sin pasar por el matcher: `enrichMediaItem` toma el
 * id tal cual cuando viene positivo. Es el mismo camino que usa `importarVideoapi.ts`.
 */
async function fichaDesdeTmdb(tmdbId: number): Promise<MediaItem | null> {
  const semilla: MediaItem = {
    id: `nm-${tmdbId}`,
    tmdb_id: tmdbId,
    imdb_id: null,
    type: 'movie',
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
    const ficha = await TmdbService.enrichMediaItem(semilla, { skipSeasons: true });
    // Sin ficha de TMDB no se anuncia nada (`veredictoDisponibilidad`), así que tampoco se escribe.
    if (!ficha || !(ficha.tmdb_id > 0) || !ficha.title) return null;
    return ficha;
  } catch {
    return null;
  }
}

/** Sin pisar los que ya estaban, y sin duplicarse a sí mismo. Delante, como hace la apertura. */
function fusionarServidores(previos: any[], nuevo: ServerOption): any[] {
  const resto = (previos || []).filter(
    (s) => String(s?.source_id || '').toLowerCase() !== 'netmirror' && String(s?.embed_url || '') !== nuevo.embed_url
  );
  return [nuevo, ...resto];
}

/** Escribe una ficha nueva con id `nm-<tmdb>`. Las columnas son las de `importarVideoapi.ts`. */
async function insertarFicha(ficha: MediaItem, servidor: ServerOption): Promise<boolean> {
  const ahora = new Date().toISOString();
  const fila: Record<string, unknown> = {
    id: ficha.id,
    tmdb_id: ficha.tmdb_id,
    imdb_id: ficha.imdb_id ?? null,
    type: 'movie',
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
    director: ficha.director || null,
    metadata_source: ficha.metadata_source || 'tmdb',
    servers: [servidor],
    seasons: [],
    total_seasons: 0,
    total_episodes: 0,
    source_url: servidor.embed_url,
    source_urls: [servidor.embed_url],
    has_streams: true,
    streams_updated_at: ahora,
    streams_checked_at: ahora,
    updated_at: ahora,
  };

  const { error } = await db.from('media_items').insert(fila);
  if (!error) return true;

  // Choque de `(tmdb_id, type)`: otra fuente la trajo entre que se leyó el índice y se llegó
  // aquí. Es una ficha que ya existe a la que hay que AÑADIRLE el servidor, nunca sustituirla.
  if (/duplicate key|UNIQUE constraint/i.test(error.message)) {
    const { data } = await db.from('media_items').select('id').eq('tmdb_id', ficha.tmdb_id).eq('type', 'movie').limit(1);
    const yaEsta: any = data && data[0];
    if (yaEsta) return actualizarFicha(String(yaEsta.id), servidor);
  }
  console.log(`   ! ${ficha.id}: ${error.message}`);
  cuenta.errores++;
  return false;
}

/**
 * Le añade (o le renueva) el servidor a una ficha que ya existe. Se lee `servers` AQUÍ, justo
 * antes de fusionar, y solo esa columna: lo guardado no se pisa, y `seasons` ni se toca.
 */
async function actualizarFicha(id: string, servidor: ServerOption): Promise<boolean> {
  const { data: actual, error: errLectura } = await db.from('media_items').select('servers').eq('id', id).maybeSingle();
  if (errLectura) {
    console.log(`   ! ${id}: ${errLectura.message}`);
    cuenta.errores++;
    return false;
  }
  const ahora = new Date().toISOString();
  const { error } = await db
    .from('media_items')
    .update({
      servers: fusionarServidores((actual as any)?.servers || [], servidor),
      streams_updated_at: ahora,
      streams_checked_at: ahora,
      has_streams: true,
      updated_at: ahora,
    })
    .eq('id', id);
  if (error) {
    console.log(`   ! ${id}: ${error.message}`);
    cuenta.errores++;
    return false;
  }
  return true;
}

interface Trabajo {
  candidata: Candidata;
  /** La fila que ya existe, si existe. */
  filaId?: string;
  /** Cierto cuando la fila ya tiene el servidor y solo hay que renovarle el sello. */
  resellar?: boolean;
}

async function trabajar(t: Trabajo): Promise<void> {
  const servidor = await resolverYVerificar(t.candidata);
  if (!servidor) return;

  if (t.filaId) {
    if (DRY || (await actualizarFicha(t.filaId, servidor))) {
      if (t.resellar) cuenta.reselladas++;
      else cuenta.fichasEnriquecidas++;
    }
    return;
  }

  const ficha = await fichaDesdeTmdb(t.candidata.tmdbId);
  if (!ficha) {
    cuenta.sinTmdb++;
    return;
  }
  if (DRY || (await insertarFicha(ficha, servidor))) {
    cuenta.fichasNuevas++;
    console.log(`   + ${ficha.id} «${ficha.title}» (${(ficha.release_date || '').slice(0, 4)}) ${servidor.quality}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════

async function main() {
  const rotulo = (n: number) => (n === SIN_TOPE ? 'sin tope' : String(n));
  console.log(
    `netmirror · proveedor=${PROVEEDOR} regiones=${REGIONES.join(',')} paginas=${PAGINAS} ` +
      `limite=${rotulo(LIMITE)} minutos=${rotulo(MINUTOS)} a-la-vez=${A_LA_VEZ}${DRY ? ' (DRY)' : ''}`
  );

  // Primero, ¿NetMirror nos contesta desde aquí? Si no, no hay nada que importar y sí mucho
  // que estropear. Ver la cabecera.
  const testigo = await consultar(PELICULA_TESTIGO);
  if (testigo.estado !== 'tiene') {
    console.error(
      `NetMirror no contesta «tiene» para la película testigo ${PELICULA_TESTIGO} por la vía «${VIA}»: ` +
        (testigo.estado === 'no' ? 'dice que no la tiene' : testigo.detalle) +
        '. No se importa nada. Prueba con --via=api.'
    );
    process.exit(1);
  }
  console.log(`NetMirror contesta por la vía «${VIA}» (testigo ${PELICULA_TESTIGO}: ${testigo.fuente.meta.title} ${testigo.fuente.meta.year})`);

  const lista = await descubrir();
  console.log(`lista: ${lista.size} películas de TMDB con ${PROVEEDOR}`);

  const nuestras = await nuestrasPeliculas();
  const selladas = REHACER ? new Map<string, number>() : await selladasPorNetmirror();
  const descartadas = REHACER ? new Set<number>() : await descartadosRecientes();

  const cola: Trabajo[] = [];
  const vence = Date.now() - RESELLAR_TRAS_DIAS * 86_400_000;
  let alDia = 0;
  for (const c of lista.values()) {
    if (TMDB.length && !TMDB.includes(c.tmdbId)) continue;
    const filaId = nuestras.get(c.tmdbId);
    if (filaId) {
      const sello = selladas.get(filaId) || 0;
      if (sello > vence) {
        alDia++;
        continue;
      }
      cola.push({ candidata: c, filaId, resellar: sello > 0 });
      continue;
    }
    if (descartadas.has(c.tmdbId)) continue;
    cola.push({ candidata: c });
  }
  // Lo nuevo delante: es lo que hace crecer el catálogo. Lo que solo necesita sello va después,
  // y dentro de cada grupo se respeta la popularidad con la que TMDB lo dio.
  cola.sort((a, b) => Number(Boolean(a.filaId)) - Number(Boolean(b.filaId)));
  const tanda = cola.slice(0, LIMITE);
  console.log(
    `cola: ${cola.length} pendientes (${cola.filter((t) => !t.filaId).length} fichas nuevas, ` +
      `${cola.filter((t) => t.resellar).length} por resellar) · ${alDia} al día. Esta corrida: ${tanda.length}\n`
  );

  for (let i = 0; i < tanda.length && quedaTiempo() && !parar; i += A_LA_VEZ) {
    await Promise.all(tanda.slice(i, i + A_LA_VEZ).map((t) => trabajar(t).catch(() => { cuenta.errores++; })));
    if ((i / A_LA_VEZ) % 20 === 0 && i > 0) {
      console.log(`   … ${i}/${tanda.length} · ${cuenta.fichasNuevas} nuevas · ${cuenta.noLoTiene} no las tiene`);
    }
  }

  if (!DRY && (cuenta.fichasNuevas || cuenta.fichasEnriquecidas)) {
    await CatalogService.invalidateListings().catch(() => {});
  }

  console.log(
    `\n${cuenta.fichasNuevas} fichas nuevas · ${cuenta.fichasEnriquecidas} enriquecidas · ${cuenta.reselladas} reselladas · ` +
      `${cuenta.noLoTiene} no las tiene · ${cuenta.sinRespuesta} sin respuesta · ${cuenta.noArranca} no arrancan · ${cuenta.otraObra} otra obra · ` +
      `${cuenta.sinTmdb} sin ficha TMDB · ${cuenta.errores} errores`
  );
  console.log(`Quedan ~${Math.max(0, cola.length - tanda.length)} en cola para la próxima vuelta.`);
  // Parar por falta de respuesta es un fallo de la corrida, no un resultado: que el workflow lo
  // enseñe en rojo.
  if (parar) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
