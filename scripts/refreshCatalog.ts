/**
 * Job de pre-scrape del catálogo → Supabase (Fase 4.1 del plan de rendimiento).
 *
 * Corre en background (GitHub Actions, o manual):
 *   npm run refresh:catalog                     # crawl COMPLETO del catálogo (miles de títulos)
 *   npm run refresh:catalog -- 20               # limitado (pruebas)
 *   npm run refresh:catalog -- --streams=300    # además pre-resuelve enlaces del home
 *   npm run refresh:catalog -- --verify=500     # además comprueba disponibilidad real
 *   npm run direct:catalog                      # solo extrae el vídeo directo de lo guardado
 *   npm run verify:catalog                      # SOLO comprobar disponibilidad (sin crawl)
 *
 * Con la DB poblada, la API sirve listados (getAll DB-first) y el pase de prefijo
 * de búsqueda desde Postgres en milisegundos, sin scraping dentro del request.
 * Con --streams, además, las fichas del home abren con los enlaces ya listos.
 * Con --verify, las fichas que ninguna fuente puede reproducir quedan marcadas
 * (`has_streams = false`) y dejan de anunciarse en el home y en la búsqueda.
 */
import 'dotenv/config';
import { RealScraperService } from '../src/services/realScraperService';
import { CatalogService, fusionarTemporadas } from '../src/services/catalogService';
import { TmdbService } from '../src/services/tmdbService';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { canonicalTitle, searchIndexKey, yearFromSlug } from '../src/utils/text';
import { mereceRepasoDeExtraccion, hasVolatileToken, canonicalArchiveOrg, esUrlDeFicheroPermanente, extractDirect } from '../src/scrapers/directStream';
import { inspectEmbed } from '../src/scrapers/embedHealth';
import { externalProxyEnabled } from '../src/utils/externalProxy';
import { calentarIndices } from './calentarIndices';
import { bajarManifiesto, segmentoDescargable } from '../src/services/manifestHealth';
import { streamClient } from '../src/utils/httpClient';
import { CacheStore } from '../src/cache/store';
import { paraElCliente } from '../src/services/streamSorter';
import { MediaItem } from '../src/types';
import { noMorirPorUnCorteDeRed } from '../src/utils/seguirVivo';

// Un socket que se muere no puede llevarse por delante el barrido entero. Ver ahi.
noMorirPorUnCorteDeRed();


// Con RLS activado en media_items, escribir requiere la SUPABASE_SERVICE_ROLE_KEY
// (secret del workflow / variable de entorno). Sin ella el upsert fallará con RLS.
const db = getSupabaseAdmin();

/**
 * De dónde salen los títulos de esta pasada.
 *
 * Por defecto, crawl COMPLETO: todas las categorías de tioplus paginadas hasta agotar + todo
 * FuegoCine. Es lo que da recuperación total y scroll infinito en la búsqueda.
 *
 * `--solo=<fuente>` lo recorta a una web (`fuegocine`, `peliculas`, `series`, `animes`). Se
 * añadió para poder dedicarle una pasada entera a FuegoCine, que es la única web probada que
 * publica ficheros PERMANENTES: de las 961 urls sin caducidad que llegó a tener el catálogo, 708
 * eran del CDN de Rumble y 145 de archive.org, y las 853 llegaron por su envoltorio `?link=`. En
 * el crawl completo comparte las horas con otras tres webs y solo se le rasca por encima.
 *
 * Lo que viene después es EL MISMO CAMINO —TMDB, `quedarseConLoQueReproduce`, la escritura—, así
 * que esto no es un scraper aparte que pueda desincronizarse: es la misma pasada con otra puerta.
 */
async function collectCatalog(): Promise<MediaItem[]> {
  const solo = (process.argv.find(a => a.startsWith('--solo=')) || '').split('=')[1];
  if (solo) console.log(`   (solo «${solo}»)`);
  return RealScraperService.crawlFullCatalog(solo || undefined);
}

/** Comprueba si una columna opcional ya existe (migración aplicada). */
async function hasColumn(column: string): Promise<boolean> {
  const { error } = await db.from('media_items').select(column).limit(1);
  return !error;
}

function toRow(item: MediaItem, withNormalized: boolean, withMetadataSource: boolean, withRichMetadata: boolean, withMultiSource = false) {
  const row: Record<string, unknown> = {
    id: item.id,
    tmdb_id: item.tmdb_id,
    imdb_id: item.imdb_id ?? null,
    type: item.type,
    title: item.title,
    original_title: item.original_title || item.title,
    aliases: item.aliases || [],
    tagline: item.tagline || '',
    overview: item.overview || '',
    rating: item.rating || 0,
    content_rating: item.content_rating || null,
    release_date: item.release_date || '',
    genres: item.genres || [],
    subcategories: item.subcategories || [],
    poster: item.poster,
    backdrop: item.backdrop,
    logo: item.logo,
    trailer: item.trailer,
    cast_data: (item.cast_details && item.cast_details.length ? item.cast_details : item.cast) || [],
    dubbing_cast_data: item.dubbing_cast || [],
    /**
     * LOS ENLACES SE ESCRIBEN AQUÍ, con la ficha, y no en una pasada posterior.
     *
     * `toRow` no los guardaba: la fila se creaba con metadata y los servidores llegaban después,
     * en otro barrido. Eso es exactamente lo que llenaba el catálogo de títulos anunciados sin
     * vídeo — la ficha existía desde el minuto uno y su enlace no aparecía nunca.
     *
     * Ahora el scraper ya trae la url directa comprobada (ver `quedarseConLoQueReproduce`), así
     * que se guarda con ella o no se guarda: sin esta línea, todo lo extraído se tiraba al
     * escribir y la fila nacía muda otra vez.
     */
    servers: item.servers || [],
    seasons: (item as any).seasons || [],
    has_streams: item.has_streams === true,
    streams_updated_at: new Date().toISOString(),
    streams_checked_at: new Date().toISOString(),
    total_seasons: item.total_seasons || 0,
    total_episodes: item.total_episodes || 0,
    updated_at: new Date().toISOString()
  };
  if (withNormalized) {
    // Incluye título original y alias: así "vengadores" encuentra "Avengers 2: Era de Ultrón".
    row.title_normalized = searchIndexKey(item.title, item.original_title, item.aliases);
  }
  if (withMetadataSource) {
    row.metadata_source = item.metadata_source || 'tmdb';
  }
  if (hayColumnaDeFuentes) {
    // Solo lo PRESTADO. Una ficha entera de TMDB guarda `{}`, que es lo correcto: la ausencia de
    // anotación es la que dice «este campo es suyo».
    row.metadata_fuentes = item.metadata_fuentes || {};
  }
  if (withRichMetadata) {
    row.runtime = item.runtime ?? null;
    row.director = item.director || (item.created_by || []).join(', ') || null;
    // URL exacta del detalle en la fuente: con ella la API resuelve los enlaces con UN
    // solo scrapeDetail en vez de una búsqueda por título (migración 004).
    row.source_url = (item as any)._tioplus_url || item._source_url || null;
  }
  if (withMultiSource) {
    /**
     * TODAS sus páginas, no solo la principal.
     *
     * Cuando dos fuentes traen la misma obra, la copia descartada cede aquí su página (ver el
     * índice `byTmdb` más abajo). Si esa lista no se escribiera, la absorción se perdería en
     * memoria: `mergeIntoExisting` solo parchea `source_urls` de filas que YA existen, y una
     * ficha nueva se guardaría con la página de una sola web.
     *
     * Sin su página, los servidores exclusivos de esa fuente son inalcanzables desde la ficha
     * unificada (migración 005).
     */
    const paginas = new Set([
      ...(item._source_urls || []),
      (item as any)._tioplus_url || item._source_url,
    ].filter(Boolean) as string[]);
    if (paginas.size) row.source_urls = Array.from(paginas);
  }
  return row;
}

/** El upsert chocó contra el UNIQUE de tmdb_id: la película ya está, con otro id de fuente. */
function isTmdbIdConflict(message: string): boolean {
  return /duplicate key/i.test(message) && /tmdb_id/i.test(message);
}

/**
 * La misma película existe en las DOS fuentes con slugs distintos, pero `tmdb_id` es UNIQUE,
 * así que la segunda copia no puede insertarse. En vez de descartarla (eran ~2.000 títulos
 * por crawl), se aprovecha para COMPLETAR la ficha que ya está: se rellenan solo los huecos
 * (póster, sinopsis, duración, y sobre todo la url de origen si faltaba), sin pisar nunca
 * datos buenos ni cambiar el id de la fila existente.
 *
 * Además se ABSORBE lo que solo la copia aporta, que es justo lo que antes se tiraba:
 *   · su página de origen, en `source_urls` — sin ella los servidores exclusivos de esa
 *     fuente quedaban inalcanzables desde la ficha unificada (migración 005);
 *   · sus alias, para que la búsqueda encuentre el título por CUALQUIERA de sus nombres
 *     ("Minions: El origen de Gru" y "Minions: Nace un villano" son la misma película).
 *
 * Y NO se funde nada sin comprobar el año: compartir tmdb_id es solo lo que CREE el matcher, y
 * cuando se equivoca esto suelda dos películas distintas en una fila para siempre. Ver abajo.
 */
async function mergeIntoExisting(
  row: Record<string, unknown>,
  opts: { withNormalized: boolean; withMultiSource: boolean }
): Promise<boolean> {
  const tmdbId = row.tmdb_id as number;
  if (!tmdbId) return false;

  // Incluye `seasons` y `servers`: es lo que la ficha absorbida APORTA de verdad (ver `volcarFilaEn`).
  const columns = opts.withMultiSource
    ? COLUMNAS_DE_LA_QUE_RECIBE
    : COLUMNAS_DE_LA_QUE_RECIBE.replace(',source_urls', '');

  // El tipo forma parte de la identidad de la ficha: TMDB numera películas y series por
  // separado y el mismo número designa títulos distintos (movie 108291 "Road Dogz" frente a
  // tv 108291 "Snowdrop"). Sin filtrar por él, un choque entre catálogos se resolvía volcando
  // la ficha dentro de una desconocida que solo compartía el número.
  const { data } = await db
    .from('media_items')
    .select(columns)
    .eq('tmdb_id', tmdbId)
    .eq('type', row.type as string)
    .limit(1);

  const existing: any = data && data[0];
  if (!existing) return false;

  return volcarFilaEn(existing, row, opts);
}

/** Las columnas de la ficha que RECIBE. Se leen juntas porque `volcarFilaEn` las mira todas. */
const COLUMNAS_DE_LA_QUE_RECIBE =
  'id,tmdb_id,type,title,original_title,aliases,release_date,poster,backdrop,logo,overview,' +
  'runtime,director,source_url,trailer,seasons,servers,has_streams,source_urls';

/**
 * VUELCA UNA FILA ENTRANTE DENTRO DE LA FICHA QUE YA EXISTE.
 *
 * Es el cuerpo que `mergeIntoExisting` tenía dentro, sacado aparte porque hay DOS formas de
 * descubrir que la entrante es la misma obra —el choque de `tmdb_id` y el de la PÁGINA, ver
 * `duenosDeLasPaginas`— y las dos tienen que volcar exactamente lo mismo. Copiarlo habría sido
 * el camino más corto a que una de las dos se olvidara de los capítulos, que es el campo que en
 * este proyecto ya ha desaparecido tres veces.
 */
async function volcarFilaEn(
  existing: any,
  row: Record<string, unknown>,
  opts: { withNormalized: boolean; withMultiSource: boolean }
): Promise<boolean> {
  // SEGUNDA LLAVE ANTES DE FUNDIR: que las dos se estrenaran a la vez.
  //
  // El tmdb_id no lo pone la fuente, lo DEDUCE el matcher, y cuando se equivoca esta función
  // suelda dos películas distintas en una sola fila para siempre: la absorbida entrega aquí su
  // página de origen —o sea sus servidores— y sus alias, y la ficha resultante acaba sirviendo
  // el vídeo de la otra. Es de aquí de donde salió que "Sin salida" (No Exit, 2022) tuviera
  // apuntada como fuente propia la página de "13 Minutes" (2021).
  //
  // El año es lo único independiente del matcher que hay a mano, así que decide: con más de un
  // año de diferencia (el desfase de distribución habitual) no se funde nada. La copia se
  // descarta como antes de existir la fusión, que es el comportamiento seguro.
  const yearOfRow = (r: Record<string, unknown>) => Number(String(r.release_date || '').slice(0, 4)) || 0;
  const incomingYear = yearOfRow(row);
  const existingYear = yearOfRow(existing);
  if (incomingYear && existingYear && Math.abs(incomingYear - existingYear) > 1) {
    console.warn(
      `   ⚠ no se funde "${row.title}" (${incomingYear}) en "${existing.title}" (${existingYear}):` +
      ` se habían tomado por la misma obra pero no son de la misma época`
    );
    return false;
  }

  const patch: Record<string, unknown> = {};
  const fillIfEmpty = (field: string) => {
    const current = existing[field];
    const incoming = row[field];
    const isEmpty = current === null || current === undefined || current === '';
    if (isEmpty && incoming) patch[field] = incoming;
  };

  ['poster', 'backdrop', 'logo', 'overview', 'runtime', 'director', 'source_url', 'trailer'].forEach(fillIfEmpty);

  // Página de origen de la fuente absorbida (se conserva junto a la que ya estaba).
  if (opts.withMultiSource) {
    const current: string[] = existing.source_urls || [];
    const merged = Array.from(
      new Set([...current, existing.source_url, row.source_url].filter(Boolean) as string[])
    );
    if (merged.length > current.length) patch.source_urls = merged;
  }

  // Alias de la otra fuente. Alimentan title_normalized, que es la única columna sobre la
  // que busca el RPC: sin reindexar, el nombre absorbido no encontraría la ficha.
  const currentAliases: string[] = existing.aliases || [];
  const mergedAliases = Array.from(
    new Set([...currentAliases, ...((row.aliases as string[]) || [])].filter(Boolean))
  );
  if (mergedAliases.length > currentAliases.length) {
    patch.aliases = mergedAliases;
    if (opts.withNormalized) {
      patch.title_normalized = searchIndexKey(existing.title, existing.original_title, mergedAliases);
    }
  }

  /**
   * Y AHORA LO QUE DE VERDAD TRAÍA LA FICHA ABSORBIDA: SUS CAPÍTULOS Y SUS ENLACES.
   *
   * Hasta aquí esta función solo rellenaba huecos de metadata, apuntaba la página de origen y
   * sumaba alias. Todo lo demás de la fila entrante —los servidores que acababan de demostrar que
   * reproducen, y el árbol de capítulos entero— se descartaba en silencio. O sea que cuando dos
   * fuentes traen la misma obra, la segunda solo aportaba su nombre.
   *
   * Se ve entero con "La casa del dragón": moviedays la tiene por tmdb 94997 y FuegoCine publica
   * los posts de sus capítulos. En cuanto el matcher empareja bien la de FuegoCine, choca con la
   * que ya está, entra por aquí… y sus 24 capítulos con vídeo comprobado se iban a la basura.
   * Esa es justo la promesa que el `source_urls` de la migración 005 dejó escrita en el esquema:
   * «unificar los servidores de TioPlus y FuegoCine bajo un único registro».
   *
   * Los capítulos se FUSIONAN, nunca se reemplazan —`fusionarTemporadas`, la misma que usa el
   * crawl al escribir—: la ficha que se queda conserva todo lo suyo, los capítulos que solo tenía
   * la absorbida se añaden y los que están en las dos acumulan los servidores de ambas. Reemplazar
   * es como en este proyecto han desaparecido capítulos tres veces.
   *
   * Solo se escribe si SUMA. Un `update` que deja la columna igual no es gratis: reescribe un
   * JSON enorme y mueve `updated_at`, que es por donde ordenan los feeds.
   */
  const capitulosEntrantes = Array.isArray(row.seasons) ? (row.seasons as any[]) : [];
  if (capitulosEntrantes.length) {
    const previas = Array.isArray(existing.seasons) ? existing.seasons : [];
    // Cuenta capítulos Y servidores: añadir un enlace a un capítulo que ya estaba también suma.
    const bultoDe = (temps: any[]) => temps.reduce(
      (n: number, t: any) => n + (t?.episodes || []).reduce(
        (m: number, e: any) => m + 1 + (e?.servers || []).length, 0), 0);
    const fusionadas = fusionarTemporadas(previas, capitulosEntrantes);
    if (bultoDe(fusionadas) > bultoDe(previas)) patch.seasons = fusionadas;
  }

  // Y los servidores de la ficha (una película, o el respaldo de ficha de una serie): los de la
  // absorbida se añaden detrás de los que ya estaban, sin repetir url. Quién va primero lo decide
  // después `sortServersBySourcePriority`, que es el único sitio donde se ordena para el cliente.
  const enlacesEntrantes = Array.isArray(row.servers) ? (row.servers as any[]) : [];
  if (enlacesEntrantes.length) {
    const actuales: any[] = Array.isArray(existing.servers) ? existing.servers : [];
    const urlDe = (sv: any) => String(sv?.direct_stream || sv?.embed_url || '');
    const yaEstan = new Set(actuales.map(urlDe));
    const nuevos = enlacesEntrantes.filter(sv => urlDe(sv) && !yaEstan.has(urlDe(sv)));
    if (nuevos.length) patch.servers = [...actuales, ...nuevos];
  }

  /**
   * Si lo absorbido REPRODUCE, la ficha que se queda deja de estar escondida.
   *
   * `has_streams` es lo que gobierna si una ficha sale en portada y en el buscador. La fila
   * entrante solo llega aquí con `true` después de haber demostrado vídeo (`quedarseConLoQueRepro-
   * duce`), así que una ficha marcada como fantasma que acaba de recibir esos enlaces ya no lo es.
   */
  if (row.has_streams === true && existing.has_streams !== true
    && (patch.seasons || patch.servers)) {
    patch.has_streams = true;
  }

  if (Object.keys(patch).length === 0) return true; // nada que aportar: no es un fallo

  const { error } = await db.from('media_items').update(patch).eq('id', existing.id);
  return !error;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ¿ESTA PÁGINA YA ES LA FUENTE DE UNA FICHA DEL CATÁLOGO?
 *
 * Una ficha que se queda SIN identidad en TMDB entra con un `tmdb_id` sintético, y un sintético
 * no choca con nada: `mergeIntoExisting` nunca se entera y la fila se escribe como una obra
 * nueva. Si la obra ya estaba —traída por otra fuente— el catálogo acaba con DOS fichas de lo
 * mismo, la buena y una escondida (sin `tmdb_id` positivo no se anuncia) con sus enlaces dentro.
 *
 * Pasó con «Stranger Things» y «La casa del dragón» el 2026-08-24: las dos estaban ya fundidas
 * en su ficha de moviedays —`md-66732` y `md-94997` listaban la página de FuegoCine entre sus
 * fuentes— y aun así una corrida en la que la identificación por fotograma no salió adelante
 * (basta que FuegoCine tarde o que TMDB corte) volvió a crearlas como `fc-stranger-things` y
 * `fc-la-casa-del-drag-n`.
 *
 * La página es la llave. No es el título —eso está prohibido en esta casa (`FUENTES.md` §3)— es
 * que ESA MISMA URL ya figura en `source_urls` de una ficha: si es su fuente, es su obra. Cuesta
 * una consulta por cada 40 fallbacks y se paga solo en el camino en que ya se ha renunciado a
 * TMDB.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
async function duenosDeLasPaginas(paginas: string[]): Promise<Map<string, any>> {
  const duenos = new Map<string, any>();
  const limpias = Array.from(new Set(paginas.filter(Boolean)));
  if (!limpias.length) return duenos;

  const TANDA = 40;
  for (let i = 0; i < limpias.length; i += TANDA) {
    const lote = limpias.slice(i, i + TANDA);
    const { data, error } = await db
      .from('media_items')
      .select(COLUMNAS_DE_LA_QUE_RECIBE)
      .overlaps('source_urls', lote);
    // Sin la columna `source_urls` (migración 005) no hay nada que preguntar: se sigue como antes.
    if (error) return duenos;
    for (const fila of (data as any[]) || []) {
      for (const u of (fila.source_urls || [])) if (lote.includes(u)) duenos.set(u, fila);
    }
  }
  return duenos;
}

/**
 * Pre-calentado de enlaces: resuelve los servidores de los títulos que alimentan el home
 * y los deja persistidos, de modo que la primera persona que abra la ficha ya los
 * encuentre listos (`streams.status: "ready"`) sin esperar a ningún scraping.
 */
async function prewarmStreams(items: MediaItem[], max: number): Promise<void> {
  const targets = items.slice(0, max);
  if (targets.length === 0) return;

  console.log(`🔥 Pre-resolviendo enlaces de ${targets.length} títulos del home...`);
  const CONCURRENCY = 8;
  let ok = 0;

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const chunk = targets.slice(i, i + CONCURRENCY);
    const resolved = await Promise.all(
      chunk.map(item =>
        // deep: fusión multifuente completa. Aquí sí compensa el coste, porque se hace
        // una vez al día y fuera del camino de ninguna request.
        CatalogService.getStreams(item.id, item.type, { deep: true }).catch(() => null)
      )
    );
    ok += resolved.filter(r => r && r.servers && r.servers.length > 0).length;
  }

  console.log(`   ${ok}/${targets.length} títulos con enlaces persistidos`);

  /**
   * Y de las SERIES, su primer capítulo.
   *
   * Precalentar la ficha de una serie no sirve para reproducir: en una serie se reproduce por
   * episodio, y la ficha del episodio se resolvía entera en el momento en que alguien le daba a
   * Reproducir — 7 s medidos la primera vez que se abre uno, porque hay que scrapear su página y
   * sondear sus servidores. El capítulo 1 de la temporada 1 es por donde entra casi todo el mundo,
   * así que se deja resuelto y cacheado de antemano. Los demás capítulos siguen costando la
   * primera apertura: son miles y no se pueden precalentar todos.
   */
  const series = targets.filter(i => i.type === 'tvseries');
  if (series.length === 0) return;

  console.log(`🔥 Pre-resolviendo el capítulo 1 de ${series.length} series...`);
  let eps = 0;
  for (let i = 0; i < series.length; i += CONCURRENCY) {
    const chunk = series.slice(i, i + CONCURRENCY);
    const resueltos = await Promise.all(
      chunk.map(s => CatalogService.getEpisode(s.id, 1, 1).catch(() => null))
    );
    eps += resueltos.filter(r => r && r.servers && r.servers.length > 0).length;
  }
  console.log(`   ${eps}/${series.length} primeros capítulos listos`);
}

/**
 * Comprobación de DISPONIBILIDAD sobre las fichas que nunca se han verificado.
 *
 * El catálogo se puebla con metadata de TMDB sin saber todavía si alguna fuente tiene
 * enlaces, así que hay títulos indexados que no se pueden reproducir. Esta pasada los
 * resuelve a fondo (fusión multifuente) y deja anotado el veredicto en `has_streams`,
 * que es lo que el home, el discover y la búsqueda usan para dejar de anunciarlos.
 *
 * Se prioriza lo NO comprobado y se avanza por lotes: pensada para ejecutarse a diario
 * y ir cubriendo el catálogo, no para verificarlo entero de una sentada.
 */
/**
 * `--verify[=N]`: resuelve las fichas que todavía no se han mirado.
 *
 * SE ELIGEN POR «NUNCA SE RESOLVIÓ», NO POR «NO TIENE VEREDICTO», y esa es toda la corrección.
 *
 * Antes pedía `has_streams IS NULL`, o sea «nadie ha dictado todavía si esta ficha reproduce».
 * Suena bien y dejaba fuera justo a las que más falta hacía mirar, porque en este catálogo el
 * veredicto se escribe por OTRO camino: `repairCatalog --sin-directo` recorre el catálogo entero
 * y marca `has_streams = false` a todo lo que no tiene vídeo directo. Una ficha recién crawleada,
 * con su página y sus enlaces esperando y sin que nadie los haya ido a buscar, no tiene vídeo
 * directo — así que la condena, con razón formal y sin haber mirado nada. Y a partir de ahí:
 *
 *   · `--verify` ya no la coge, porque su `has_streams` ha dejado de ser NULL;
 *   · `--direct-only` tampoco, porque salta las de `servers: []` («son trabajo de --verify»);
 *   · y `--sin-directo` vuelve a confirmarle la condena en cada vuelta.
 *
 * Nadie vuelve nunca. Medido el 2026-08-19: 2.434 fichas —el 16 % del catálogo— condenadas sin
 * haberse resuelto una sola vez, y `--verify` alcanzaba a CUATRO. Entre ellas, Transformers,
 * Akira, Aladdin o Bee Movie; sobre 8 muestras de FuegoCine, el scraper les saca hoy entre 3 y 5
 * servidores a las 8. No era contenido muerto: era contenido sin abrir.
 *
 * `streams_updated_at IS NULL` es la señal exacta: la escribe `persistStreams` cada vez que se
 * resuelve una ficha, así que su ausencia significa «aquí no ha entrado nadie todavía» — un hecho,
 * no una opinión. Es la misma regla que ya está escrita en `veredictoDisponibilidad`: no
 * encontrar algo solo basta para decir que no si de verdad se ha mirado.
 *
 * Primero las nunca resueltas y después las que no tienen veredicto, porque las primeras son las
 * que pueden APARECER en el catálogo y las segundas solo confirman lo que ya se sabe.
 */
async function verifyAvailability(max: number): Promise<void> {
  const { data, error } = await db
    .from('media_items')
    .select('id,type,title')
    .or('streams_updated_at.is.null,has_streams.is.null')
    .order('streams_updated_at', { ascending: true, nullsFirst: true })
    .limit(max);

  if (error) {
    console.warn(`   ⚠ No se puede verificar disponibilidad: ${error.message}`);
    console.warn('     Ejecuta src/db/migrations/005_multisource_and_availability.sql en Supabase.');
    return;
  }
  if (!data || data.length === 0) {
    console.log('✔ No quedan fichas sin comprobar.');
    return;
  }

  console.log(`🔍 Comprobando disponibilidad de ${data.length} fichas sin verificar...`);
  const CONCURRENCY = 8;
  let withStreams = 0;
  let ghosts = 0;

  for (let i = 0; i < data.length; i += CONCURRENCY) {
    const chunk = data.slice(i, i + CONCURRENCY);
    // getStreams(deep) escribe él mismo el veredicto (CatalogService.persistStreams).
    const resolved = await Promise.all(
      chunk.map(r => CatalogService.getStreams(r.id, r.type, { deep: true }).catch(() => null))
    );
    resolved.forEach((item, idx) => {
      const ok = Boolean(item && item.has_streams);
      if (ok) withStreams++;
      else {
        ghosts++;
        console.log(`   ␀ sin enlaces: ${chunk[idx].id} — "${chunk[idx].title}"`);
      }
    });
  }

  console.log(`   ${withStreams} con enlaces · ${ghosts} fichas fantasma retiradas de los feeds`);
}

/**
 * `--direct[=N]`: rellena el vídeo directo de las fichas ya guardadas.
 *
 * Las que se resolvieron antes de existir la extracción solo tienen `embed_url`. Se vuelven a
 * resolver a fondo para que cada servidor gane su `direct_stream`, que es lo que el cliente
 * reproduce antes de recurrir al iframe. Es una pasada de una sola vez por ficha: después,
 * la frescura normal de 24 h se encarga.
 *
 * Se atacan primero las MÁS ANTIGUAS, que son justamente las que no pasaron nunca por el
 * extractor, y se avanza por lotes para poder repetirlo hasta cubrir el catálogo.
 */
async function fillDirectStreams(max: number): Promise<void> {
  // Solo fichas que YA tienen enlaces resueltos: son las únicas a las que se les puede añadir
  // el vídeo directo. Las de `servers: []` no se han resuelto nunca y son trabajo de --verify.
  /**
   * SE RECORRE EL CATÁLOGO ENTERO, no las primeras N fichas.
   *
   * Antes se pedían las `max` más antiguas por `streams_updated_at` y se filtraban ahí. Con el
   * catálogo por encima de esa cifra, la consulta devolvía SIEMPRE la misma cabecera de la lista:
   * en cuanto esas quedaban resueltas, el repaso contestaba "todas las fichas revisadas ya tienen
   * su vídeo directo resuelto" y no llegaba nunca al resto. Sonaba a trabajo terminado y era una
   * ventana que no se movía.
   *
   * Se notó midiendo: 2.343 servidores seguían sin vídeo directo en hosts que SÍ sabemos extraer,
   * mientras el repaso se declaraba al día ronda tras ronda. Ahora se leen todas las fichas con
   * enlaces (paginando), se filtran las que de verdad tienen algo pendiente y solo entonces se
   * aplica el tope — que pasa a limitar el TRABAJO, no la búsqueda.
   */
  const filas: any[] = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await db
      .from('media_items')
      .select('id,type,title,servers')
      .not('servers', 'is', null)
      .neq('servers', '[]')
      .order('streams_updated_at', { ascending: true, nullsFirst: false })
      .range(desde, desde + 999);
    if (error) {
      console.warn(`   ⚠ No se pueden leer las fichas: ${error.message}`);
      return;
    }
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 1000) break;
  }
  const data = filas;

  // Interesan las que no tienen NINGÚN vídeo directo, y también aquellas donde un servidor
  // que HOY sabemos resolver se quedó sin él: pasa cada vez que se añade un extractor nuevo,
  // y también con upns, que responde 429 si se le insiste y deja el servidor sin resolver.
  const candidatas = data.filter(row => {
    if (!Array.isArray(row.servers) || row.servers.length === 0) return false;
    const servers = row.servers as any[];
    return servers.some(s => s?.embed_url && !s.direct_stream && mereceRepasoDeExtraccion(s.embed_url));
  });

  // El tope acota el TRABAJO de esta pasada, no la búsqueda: las que sobren salen en la
  // siguiente, y como se ordena por antigüedad se avanza siempre.
  const pending = candidatas.slice(0, max);
  console.log(`   ${candidatas.length} fichas con algo extraíble pendiente en todo el catálogo`);

  if (pending.length === 0) {
    console.log('✔ Todas las fichas revisadas ya tienen su vídeo directo resuelto.');
    return;
  }

  console.log(`🎬 Extrayendo vídeo directo de ${pending.length} fichas (de ${data?.length || 0} revisadas)...`);
  const CONCURRENCY = 6;
  let conDirecto = 0;
  let servidoresDirectos = 0;

  /**
   * SE PARA SOLA ANTES DE QUE LA MATEN.
   *
   * El tope de fichas no controla el tiempo: cuánto tarda una depende de cuántos servidores
   * tenga y de lo que respondan sus hosts, así que elegir el N correcto es adivinar. El
   * 2026-08-19 se lanzó con 3.000 y el runner la canceló a los 170 minutos a medio camino —y,
   * peor, su trabajo siguiente se quedó ocupando el grupo de concurrencia casi siete horas, así
   * que la extracción NO VOLVIÓ A CORRER en todo ese rato y el catálogo se quedó plano.
   *
   * Lo que se pierde al morir así no es el trabajo hecho —`getStreams` escribe ficha a ficha—,
   * es el tiempo de la cola: mientras un trabajo agoniza, el siguiente espera.
   *
   * Con un presupuesto propio, pasarse en el N deja de ser un error: se hace lo que cabe, se dice
   * cuánto quedó fuera y el trabajo termina LIMPIO, liberando la cola. El valor por defecto deja
   * media hora de margen bajo los 170 minutos del trabajo `extraer` (reproducible.yml).
   */
  const minutosTope = Number((process.argv.find(a => a.startsWith('--direct-minutos=')) || '').split('=')[1]) || 140;
  const limite = Date.now() + minutosTope * 60_000;
  let procesadas = 0;

  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    if (Date.now() > limite) {
      console.log(`   ⏱ agotado el presupuesto de ${minutosTope} min: ${procesadas}/${pending.length} hechas.`);
      console.log(`      Las ${pending.length - procesadas} restantes salen en la próxima corrida (se ordena por antigüedad, así que se avanza).`);
      break;
    }
    const chunk = pending.slice(i, i + CONCURRENCY);
    const resolved = await Promise.all(
      chunk.map(r => CatalogService.getStreams(r.id, r.type, { deep: true }).catch(() => null))
    );
    for (const item of resolved) {
      const directos = (item?.servers || []).filter(s => s.direct_stream).length;
      if (directos > 0) conDirecto++;
      servidoresDirectos += directos;
    }
    procesadas = Math.min(i + CONCURRENCY, pending.length);
    console.log(`   ${procesadas}/${pending.length}…`);
  }

  console.log(`   ${conDirecto}/${procesadas} fichas con vídeo directo · ${servidoresDirectos} servidores directos en total`);
}

/** `--direct` / `--direct=N`: cuántas fichas guardadas se repasan para extraerles el vídeo. */
function parseDirectFlag(argv: string[]): number {
  const flag = argv.find(a => a === '--direct' || a.startsWith('--direct='));
  if (!flag) return 0;
  const value = flag.includes('=') ? parseInt(flag.split('=')[1], 10) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 200;
}

/**
 * `--streams` / `--streams=N`: cuántos títulos del home llevan sus enlaces pre-resueltos.
 * Sin el flag no se pre-calienta nada (crawl igual de rápido que antes).
 */
function parseStreamsFlag(argv: string[]): number {
  const flag = argv.find(a => a === '--streams' || a.startsWith('--streams='));
  if (!flag) return 0;
  const value = flag.includes('=') ? parseInt(flag.split('=')[1], 10) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 300;
}

/**
 * Completa un título recolectado con las señales de SU PÁGINA antes de emparejarlo con TMDB.
 *
 * Los listados dan el título y poco más: cuando el markup de la tarjeta falla, el año se pierde
 * (el `alt` de la imagen no lo lleva) y el emparejado se hace a ciegas de época, que es como
 * "Solo en casa" acabó guardada como "Gambling House" (1950). La ficha de detalle sí publica
 * siempre el año, el título original y un `og:image` que apunta a una ficha concreta de TMDB.
 *
 * Cuesta una petición ligera por título (`fetchSourceSignals` no resuelve servidores). Si la
 * página no responde se sigue con lo que dio el listado: ninguna ficha se pierde por esto.
 */
async function withSourceSignals(item: MediaItem, onHit: () => void): Promise<MediaItem> {
  const url: string = (item as any)._tioplus_url || (item as any)._source_url || '';
  if (!url) return item;

  const signals = await RealScraperService.fetchSourceSignals(url).catch(() => null);
  if (!signals) return item;
  onHit();

  return {
    ...item,
    // Nunca se pisa un dato bueno del listado con uno vacío del detalle.
    release_date: signals.year || item.release_date,
    original_title: signals.originalTitle || item.original_title,
    poster: signals.imageHint || item.poster,
    // La CLASE también sale de la página cuando la declara. El listado la deduce del título del
    // post, y eso falla en cuanto no lleva la palabra "serie": la miniserie "Eric" (2024) se
    // recolectaba como película, buscaba en el catálogo de películas de TMDB y acababa con la
    // ficha de un especial de monólogos. La página sí publica sus temporadas y episodios.
    type: signals.type || item.type,
    /**
     * Y DE QUÉ CAPÍTULO ES ESTA PÁGINA, que para una serie agrupada de FuegoCine es la única
     * prueba de identidad que va a haber: sus posts de episodio no publican año ni título
     * original, solo el fotograma del capítulo. `fetchSourceSignals` ya lo leía del título del
     * post y aquí se tiraba, así que el matcher nunca podía usarlo por el camino del crawl.
     */
    _episode_hint: signals.episode || item._episode_hint || null
  };
}

/**
 * SEGUNDA OPORTUNIDAD PARA UNA SERIE QUE SE HA QUEDADO SIN FICHA: preguntar a otro capítulo.
 *
 * Una serie de FuegoCine solo se puede identificar por el fotograma de un capítulo, y no todas
 * sus páginas sirven: que el fotograma esté registrado en TMDB depende de lo que haya subido la
 * gente. Medido sobre «Stranger Things», página a página, 35 de sus 42 capítulos valen como
 * prueba — y la que quedó como página de origen de la ficha, la del último publicado (5x8), es
 * una de las 7 que no. Resultado: la serie entraba con id sintético, o sea escondida, teniendo la
 * prueba en las otras 35 páginas. Con una sola página, cada serie se juega su ficha a un 17 % de
 * fallo; con tres intentos, al 0,5 %.
 *
 * Solo se paga cuando la primera no bastó, y solo para series con páginas propias por capítulo.
 * Lo que exige para adoptar la ficha no cambia ni un ápice: `identidadPorFotograma` devuelve
 * únicamente lo RESPALDADO por el hash de una imagen, que no admite parecidos.
 */
async function segundaOportunidadDeSerie(conSeñales: MediaItem, enriquecida: MediaItem): Promise<MediaItem> {
  if (enriquecida.type !== 'tvseries' || enriquecida.tmdb_id > 0) return enriquecida;

  const paginas = RealScraperService.paginasDeCapitulos(
    (conSeñales as any).seasons,
    (conSeñales as any)._tioplus_url || conSeñales._source_url
  );
  if (!paginas.length) return enriquecida;

  const identidad = await RealScraperService.identidadPorFotograma(paginas).catch(() => null);
  if (!identidad) return enriquecida;

  // Con el id ya PROBADO, `enrichMediaItem` no vuelve a emparejar: se limita a traer la ficha.
  const conFicha = await TmdbService.enrichMediaItem(
    { ...conSeñales, tmdb_id: identidad.match.id }, { skipSeasons: true }
  ).catch(() => enriquecida);
  if (conFicha.tmdb_id > 0) {
    console.log(`   ↻ «${conSeñales.title}» se identificó con otro capítulo: tmdb ${conFicha.tmdb_id}`);
  }
  return conFicha;
}

/**
 * `--sin-complemento`: no tapar con Wikidata/Wikipedia/Fanart lo que TMDB deje vacío.
 *
 * El complemento va ENCENDIDO por defecto en el crawl, que es donde tiene que estar: un título
 * entra una vez en su vida y esa es la ocasión de completarlo. La bandera existe para la pasada en
 * que lo que importa es el volumen —recuperar un catálogo entero, medir cuánto cunde una fuente
 * nueva— y un segundo por ficha sí se nota. No se toca en el barrido normal.
 */
function complementoEncendido(argv: string[]): boolean {
  return !argv.includes('--sin-complemento');
}
const COMPLEMENTAR = complementoEncendido(process.argv);

/**
 * Si la columna `metadata_fuentes` existe (migracion 012). Se resuelve una vez, al empezar a
 * escribir, y `toRow` la lee de aqui: anadirla como parametro obligaria a tocar los seis sitios
 * que ya se pasan banderas de columna a mano.
 */
let hayColumnaDeFuentes = false;

/** `--verify` / `--verify=N`: cuántas fichas sin comprobar se verifican al final del crawl. */
function parseVerifyFlag(argv: string[]): number {
  const flag = argv.find(a => a === '--verify' || a.startsWith('--verify='));
  if (!flag) return 0;
  const value = flag.includes('=') ? parseInt(flag.split('=')[1], 10) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 500;
}


/** Hosts cuya url ES el fichero de vídeo: se piden y devuelven bytes, sin firma que caduque. */

/** La dirección real que un envoltorio lleva dentro de sus parámetros (`?link=…`). */
function urlDentroDelEnvoltorio(embed: string): string | null {
  try {
    for (const [, v] of new URL(embed).searchParams) {
      if (!v) continue;
      if (/^https?:\/\//i.test(v)) return v;
      if (/^[\w.-]+\.[a-z]{2,}\//i.test(v)) return `https://${v}`;
    }
  } catch { /* no es una url con parámetros */ }
  return null;
}

/**
 * ¿Devuelve bytes de vídeo, y a qué velocidad? 64 KB bastan para ver la cabecera del contenedor.
 *
 * Devuelve los KB/s además del sí/no porque con eso se ORDENAN los respaldos: una ficha puede
 * tener varios enlaces buenos y el cliente debe recibir primero el que mejor va. No se descarta a
 * nadie por lento —este proyecto ya se tumbó entero con una regla así, y `goodstream` tarda 26 s
 * y reproduce—: se ordena, que es distinto de condenar.
 */
async function entregaVideo(url: string): Promise<{ ok: boolean; kbs: number; total: number }> {
  const t0 = Date.now();
  const pedir = (rango: string) => streamClient.get(url, {
    headers: { Range: rango },
    responseType: 'arraybuffer',
    timeout: 25000,
    validateStatus: () => true,
    maxRedirects: 5,
  });

  const kbDe = (r: any) => ((r.data as ArrayBuffer)?.byteLength ?? 0) / 1024;
  const esHtml = (r: any) => /text\/html/i.test(String(r.headers['content-type'] || ''));
  const velocidad = (kb: number) => kb / Math.max((Date.now() - t0) / 1000, 0.001);
  /**
   * EL TAMAÑO TOTAL VIENE GRATIS EN LA RESPUESTA, y hace falta para saber si el fichero se puede
   * ver de verdad. `Content-Range: bytes 1000000-1065535/1181412452` — el número de después de la
   * barra es el fichero entero. Con eso y la duración se sabe cuánto ancho de banda PIDE, que es
   * la mitad que faltaba: hasta ahora se medía lo que el host DA y no había con qué compararlo.
   */
  const totalDe = (r: any) => {
    const m = /\/(\d+)\s*$/.exec(String(r.headers['content-range'] || ''));
    if (m) return Number(m[1]);
    return Number(r.headers['content-length']) || 0;
  };

  try {
    /**
     * SE PIDE UN TROZO DE EN MEDIO, no los primeros 64 KB. Ver la nota de `sigueVivo` en
     * scripts/verificarPermanentes.ts: un `200` a un rango que empieza en cero es HTTP válido y
     * no demuestra nada, así que exigirle 206 rechazaría ficheros buenos. Desde el medio, o
     * contesta 206 o no sabe hacer rangos — y sin rangos no se puede adelantar.
     */
    const r = await pedir(`bytes=${DESDE_MEDIO}-${DESDE_MEDIO + 65535}`);

    // Más corto que el offset: es un fichero pequeño, no un fallo.
    if (r.status === 416) {
      const chico = await pedir('bytes=0-65535');
      if (chico.status >= 400 || esHtml(chico)) return { ok: false, kbs: 0, total: 0 };
      const kb = kbDe(chico);
      if (kb <= 8) return { ok: false, kbs: 0, total: 0 };
      return { ok: true, kbs: velocidad(kb), total: totalDe(chico) };
    }

    if (r.status >= 400) return { ok: false, kbs: 0, total: 0 };
    if (esHtml(r)) return { ok: false, kbs: 0, total: 0 };
    if (r.status !== 206) return { ok: false, kbs: 0, total: 0 };
    const kb = kbDe(r);
    if (kb <= 8) return { ok: false, kbs: 0, total: 0 };
    return { ok: true, kbs: velocidad(kb), total: totalDe(r) };
  } catch {
    return { ok: false, kbs: 0, total: 0 };
  }
}

/** Desde dónde se pide el trozo de prueba. Ver `entregaVideo`. */
const DESDE_MEDIO = 1000000;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ¿ESTE MANIFIESTO ES PERMANENTE POR DENTRO?
 *
 * Un `.mp4` se juzga por su forma y ya está: si la url no lleva firma, mañana sigue sirviendo el
 * mismo fichero. Un `.m3u8` NO se puede juzgar así, y esa es toda la razón de que esta función
 * exista. El manifiesto puede estar limpio y apuntar a segmentos firmados, y entonces la url dura
 * y el vídeo no — que es exactamente la promesa rota que la regla de permanencia vino a evitar.
 *
 * Así que hay que abrirlo y mirar lo de dentro. Tres cosas, en este orden:
 *
 *   1. Ninguna url del manifiesto lleva firma ni caducidad (`hasVolatileToken`).
 *   2. Si es un MAESTRO, se baja un escalón y se repite — las variantes de turboviplay viven en
 *      OTRO host (`cdn4.turboviplay.com` manda a `g246.turbosplayer.com`), así que un maestro
 *      limpio no dice nada de sus hijas.
 *   3. Y un segmento de verdad entrega vídeo, con la MISMA prueba que se le pide a un mp4:
 *      `entregaVideo`. No basta con que el manifiesto responda 200; un índice de texto siempre
 *      responde 200.
 *
 * NO SE USA `segmentoDescargable` DE `manifestHealth`, aunque haga casi esto. Su regla es
 * «devuelve true cuando no hay nada que comprobar», y es la regla correcta ALLÍ: ese código
 * decide qué se BORRA, y no condenar lo que no se ha podido medir es la norma de la casa. Aquí se
 * decide qué ENTRA, y ahí la carga de la prueba va al revés: lo que no se ha podido comprobar no
 * es permanente. La misma duda, dos respuestas opuestas, según a quién le toque perder.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
async function entregaHls(
  url: string,
  referer: string
): Promise<{ ok: boolean; kbs: number; total: number; kbpsNecesarios?: number }> {
  const NADA = { ok: false, kbs: 0, total: 0 };

  const manifiesto = await bajarManifiesto(url, referer);
  if (!manifiesto) return NADA;

  const dentro = urisDeManifiesto(manifiesto, url);
  if (!dentro.length) return NADA;
  if (dentro.some(hasVolatileToken)) return NADA;

  let listaDeSegmentos = manifiesto;
  let baseDeSegmentos = url;
  let kbpsNecesarios: number | undefined = anchoDeBandaDeclarado(manifiesto);

  // Un maestro no tiene segmentos: tiene variantes. Se sigue la mejor, que es la que se va a ver.
  const variantes = dentro.filter(u => /\.m3u8(\?|$)/i.test(u));
  if (variantes.length) {
    const mejor = mejorVariante(manifiesto, url) || variantes[0];
    if (hasVolatileToken(mejor)) return NADA;
    const hija = await bajarManifiesto(mejor, referer);
    if (!hija) return NADA;
    const dentroHija = urisDeManifiesto(hija, mejor);
    if (!dentroHija.length) return NADA;
    if (dentroHija.some(hasVolatileToken)) return NADA;
    // Tres niveles no se persiguen: a estas alturas ya no es un empaquetado normal.
    if (dentroHija.some(u => /\.m3u8(\?|$)/i.test(u))) return NADA;
    listaDeSegmentos = hija;
    baseDeSegmentos = mejor;
  }

  const segmentos = urisDeManifiesto(listaDeSegmentos, baseDeSegmentos)
    .filter(u => !/\.m3u8(\?|$)/i.test(u));
  if (!segmentos.length) return NADA;

  /*
   * Se mide UN segmento y no el primero: el primero de una película suele ser el logo del
   * distribuidor y en algunos empaquetados pesa una décima parte del resto, así que su velocidad
   * no representa nada. Se coge uno del medio, por lo mismo que `DESDE_MEDIO` en el mp4.
   */
  const medida = await entregaVideo(segmentos[Math.floor(segmentos.length / 2)]);
  if (!medida.ok) return NADA;

  return { ok: true, kbs: medida.kbs, total: 0, kbpsNecesarios };
}

/**
 * Con qué `Referer` se le pide el vídeo a este servidor.
 *
 * No es cortesía: hay CDN que devuelven 403 sin él, y el catálogo ya guarda por servidor las
 * cabeceras que su host exige (`headers`, casi siempre un Referer). Se usa esa si está; si no, la
 * página del reproductor, que es de donde el navegador lo pediría de verdad.
 *
 * Sin ninguna de las dos se manda cadena vacía y que decida el host. Inventarse un Referer sería
 * peor que no ponerlo: un origen que no es el suyo es justo lo que algunos bloquean.
 */
function refererDe(sv: any): string {
  const cabeceras = sv?.headers || {};
  for (const [clave, valor] of Object.entries(cabeceras)) {
    if (/^referer$/i.test(clave) && valor) return String(valor);
  }
  return String(sv?.embed_url || '');
}

/** Las urls de un manifiesto, absolutas. Las líneas que empiezan por `#` son directivas. */
function urisDeManifiesto(manifiesto: string, base: string): string[] {
  const salida: string[] = [];
  for (const linea of manifiesto.split(/\r?\n/)) {
    const l = linea.trim();
    if (!l || l.startsWith('#')) continue;
    try {
      salida.push(new URL(l, base).toString());
    } catch { /* una línea que no es una url no es una url */ }
  }
  return salida;
}

/**
 * La variante de más calidad de un maestro.
 *
 * `#EXT-X-STREAM-INF:...BANDWIDTH=1205600` y la url viene en la línea SIGUIENTE — así está
 * definido el formato, y por eso esto no se puede resolver mirando las urls por su cuenta.
 */
function mejorVariante(maestro: string, base: string): string | null {
  const lineas = maestro.split(/\r?\n/).map(l => l.trim());
  let mejor: { url: string; ancho: number } | null = null;
  for (let i = 0; i < lineas.length - 1; i++) {
    if (!lineas[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const ancho = Number(/BANDWIDTH=(\d+)/i.exec(lineas[i])?.[1] || 0);
    const cruda = lineas[i + 1];
    if (!cruda || cruda.startsWith('#')) continue;
    try {
      const url = new URL(cruda, base).toString();
      if (!mejor || ancho > mejor.ancho) mejor = { url, ancho };
    } catch { /* siguiente */ }
  }
  return mejor?.url || null;
}

/**
 * Lo que el manifiesto DICE que necesita, en KB/s.
 *
 * `BANDWIDTH` va en bits por segundo y es propiedad del empaquetado, no de la red del momento:
 * es justo lo que `kbps_necesarios` quiere decir. En un mp4 ese dato hay que deducirlo del tamaño
 * y la duración; aquí viene escrito.
 */
function anchoDeBandaDeclarado(maestro: string): number | undefined {
  let mayor = 0;
  for (const m of maestro.matchAll(/BANDWIDTH=(\d+)/gi)) {
    mayor = Math.max(mayor, Number(m[1]) || 0);
  }
  return mayor > 0 ? Math.round(mayor / 8 / 1024) : undefined;
}

/**
 * TODAS las urls permanentes y funcionales de una lista de servidores, ordenadas de mejor a peor.
 *
 * No se queda con la primera que funcione: una película o un capítulo puede tener varios enlaces
 * buenos, y el cliente los quiere TODOS — el mejor para reproducir y los demás como respaldo, que
 * es lo único que le permite recuperarse solo si uno se cae a mitad.
 */
async function urlsBuenasDe(servidores: any[], fuente: string, minutos?: number): Promise<any[]> {
  /**
   * PRIMERO SE ARMA LA LISTA DE CANDIDATOS, que no cuesta red, y LUEGO SE MIDEN TODOS A LA VEZ.
   *
   * Antes se recorrían los servidores en serie y se esperaba a cada uno antes de mirar el
   * siguiente. Cada candidato muerto cuesta el timeout entero —25 s—, así que una ficha con diez
   * servidores y dos candidatos por servidor podía tardar ocho minutos en decidir que no servía
   * ninguno. Medido en la primera pasada real de FuegoCine: 45 minutos de presupuesto dieron para
   * SOLO 16 TÍTULOS de los 400 previstos, unos 2,8 min cada uno.
   *
   * (Y de esos 16, cuatro tenían url permanente y funcional: el 25 %. O sea que el rendimiento de
   * la fuente era el esperado y lo que fallaba era el reloj.)
   *
   * En paralelo, el coste de una ficha deja de ser la SUMA de sus timeouts y pasa a ser el PEOR de
   * ellos. No se descarta a nadie por lento —esa regla no se toca, `goodstream` tarda 26 s y
   * reproduce—: se miden a la vez y se ordenan por velocidad, que es distinto de condenar.
   */
  const candidatos: Array<{ sv: any; url: string }> = [];
  const vistos = new Set<string>();

  for (const sv of servidores || []) {
    const embed = String(sv?.embed_url || '');
    /**
     * Y EL `direct_stream` TAMBIÉN, que es donde el scraper deja lo que YA resolvió.
     *
     * Esto solo miraba el `embed_url` y sus envoltorios, así que tiraba el trabajo hecho: cuando
     * `scrapeDetail` ya había sacado el fichero de dentro del reproductor, esa url no se miraba
     * NUNCA. Y en FuegoCine es el caso normal — su `embed_url` es la página del reproductor
     * (`repfuegocinefree.blogspot.com/?player=…`), que jamás va a parecer un fichero permanente,
     * mientras el fichero de verdad cuelga al lado:
     *
     *     embed_url      https://repfuegocinefree.blogspot.com/?player=…   → no permanente
     *     direct_stream  https://hugh.cdn.rumble.cloud/video/…/X.mp4       → SÍ permanente
     *
     * Medido en la tanda del 22-08: `2/300 títulos tienen url directa permanente y funcional`.
     * No es que FuegoCine no publique ficheros: es que se miraba el envoltorio y no lo de dentro.
     *
     * Las guardas siguientes no se relajan: lo que venga por aquí pasa por
     * `esUrlDeFicheroPermanente` y `hasVolatileToken` igual que el resto, así que las urls
     * acuñadas al vuelo y las de nuestro propio proxy (`/api/v1/stream/direct/…`) se caen solas.
     */
    const directo = String(sv?.direct_stream || '');
    if (!embed && !directo) continue;
    // Un mismo servidor puede ofrecer la url ya resuelta, por el envoltorio y a pelo: las tres.
    for (const crudo of [directo, urlDentroDelEnvoltorio(embed), embed]) {
      if (!crudo) continue;
      // El enlace de NODO de archive.org (`dn711505.ca.archive.org/0/items/…`) no es permanente y
      // encima le da 500 a este mismo cliente. Se guarda su forma canónica. Ver `canonicalArchiveOrg`.
      const cand = canonicalArchiveOrg(crudo);
      if (!esUrlDeFicheroPermanente(cand)) continue;
      if (hasVolatileToken(cand)) continue;
      if (vistos.has(cand)) continue;
      vistos.add(cand);
      candidatos.push({ sv, url: cand });
    }
  }
  if (!candidatos.length) return [];

  /**
   * En paralelo, pero CON TECHO. Y el techo no es cortesía con los hosts: es supervivencia.
   *
   * La primera versión medía todos los candidatos de una ficha con un `Promise.all` a pelo. Como
   * el crawl mira varios títulos a la vez, eso llegaba a ochenta conexiones salientes abiertas de
   * golpe — y ahí GitHub CANCELA el runner. Medido: las tandas de FuegoCine mueren siempre poco
   * después de arrancar la extracción, mientras que el barrido de permanentes, con 8 a la vez,
   * corre entero. La diferencia es la ráfaga, no el total.
   *
   * Con cuatro por ficha el coste sigue siendo el PEOR de los timeouts y no la suma, que es lo
   * que se ganó al dejar de ir en serie; solo se le quita el pico.
   */
  const POR_FICHA = 4;
  type Medida = { ok: boolean; kbs: number; total: number; kbpsNecesarios?: number };
  const medidos: Array<{ sv: any; url: string; medida: Medida }> = [];
  for (let i = 0; i < candidatos.length; i += POR_FICHA) {
    const lote = candidatos.slice(i, i + POR_FICHA);
    medidos.push(...await Promise.all(lote.map(async c => ({
      /*
       * CADA CLASE CON SU PRUEBA. Un mp4 se comprueba pidiéndole un trozo; a un manifiesto eso no
       * se le puede hacer, porque lo que devuelve es un índice de texto de medio kilobyte — la
       * guarda de `entregaVideo` que exige más de 8 KB lo suspendería siempre, teniendo el vídeo
       * detrás. Ver `entregaHls`, que abre el manifiesto y mide un segmento de verdad.
       */
      ...c,
      medida: /\.m3u8(\?|$)/i.test(c.url)
        ? await entregaHls(c.url, refererDe(c.sv))
        : await entregaVideo(c.url),
    }))));
  }

  // El mejor primero; los demás quedan detrás como respaldo.
  return medidos
    .filter(m => m.medida.ok)
    .sort((a, b) => b.medida.kbs - a.medida.kbs)
    .map(m => ({
      ...m.sv,
      direct_stream: m.url,
      direct_mode: 'public',
      direct_kind: /\.m3u8(\?|$)/i.test(m.url) ? 'hls' : 'mp4',
      status: 'online',
      verified_at: new Date().toISOString(),
      source_id: fuente,
      /**
       * LO QUE SE MIDIÓ AL COMPROBARLA, EN KB/s, GUARDADO.
       *
       * Aquí se ordenaba por velocidad y ese orden se perdía enseguida:
       * `sortServersBySourcePriority` reordena por prioridad de FUENTE, así que un archive.org
       * —que va a ~1 MB/s— se ponía delante de un CDN tres veces más rápido solo por venir de
       * una fuente mejor colocada. La prioridad de fuente dice de quién te puedes fiar; no dice
       * cuál va a llegar antes.
       *
       * Guardándolo, el ordenador puede usarlo. Es una foto del momento en que se comprobó, no
       * una promesa — por eso desempata, no manda.
       */
      kbps: Math.round(m.medida.kbs),
      /**
       * CUÁNTO ANCHO DE BANDA PIDE ESTE FICHERO, en KB/s, para compararlo con lo que el host da.
       *
       * Tamaño entre duración. Es la pieza que faltaba: se medía la velocidad del host y no había
       * con qué contrastarla, así que un archive.org a 1,1 MB/s parecía igual de bueno sirviendo
       * un mp4 de 835 MB que un mkv de 3.312 — y con el segundo se corta.
       *
       * Solo se guarda cuando se conoce la duración; sin ella no se inventa nada y el ordenador
       * usa el criterio siguiente. `runtime` viene de TMDB y ya está resuelto cuando corre esta
       * fase, así que casi siempre está.
       */
      /*
       * En HLS este dato NO se deduce: el manifiesto lo declara en `BANDWIDTH` y es propiedad del
       * empaquetado. Se prefiere al cálculo por tamaño/duración, que en un manifiesto ni siquiera
       * se puede hacer —no hay un fichero con un tamaño—.
       */
      kbps_necesarios: m.medida.kbpsNecesarios ?? (
        minutos && minutos > 0 && m.medida.total > 0
          ? Math.round(m.medida.total / 1024 / (minutos * 60))
          : undefined
      ),
    }));
}

/**
 * LO QUE REPRODUCE AHORA AUNQUE SU URL NO SEA PERMANENTE — la puerta de moviedays.
 *
 * `urlsBuenasDe` exige que el embed SEA ya un fichero permanente (`esUrlDeFicheroPermanente`), y
 * esa regla es la que mantiene el catálogo en un 96 % de reproducción: solo entra lo que va a
 * seguir estando mañana. Pero deja fuera a toda fuente cuyo vídeo se sirva por un CDN que firma la
 * url con caducidad, que es exactamente el caso de moviedays (`vimeos.net`) — y por eso su primera
 * pasada recolectó 33 títulos y guardó 0.
 *
 * Aquí la promesa es otra, y no es más débil: NO SE GUARDA LA URL DEL CDN, se guarda el embed. El
 * `direct_stream` que ve el cliente es una ruta de esta misma API (`/api/v1/stream/direct?e=…`),
 * permanente y sin token, que vuelve a acuñar la url del CDN en CADA reproducción — que es
 * literalmente para lo que existe esa ruta y toda la maquinaria de `hostPolicy`. Lo que caduca es
 * un detalle interno; lo que se guarda no caduca.
 *
 * Y la prueba que se exige es MÁS fuerte que la de `urlsBuenasDe`, no más débil: allí basta con que
 * la url tenga forma de fichero permanente y entregue bytes; aquí hay que extraer el vídeo del
 * reproductor Y bajarse un trozo. Un servidor que no llegue hasta el final no se guarda.
 *
 * Está acotada a moviedays a propósito. Abrirla a las otras cuatro fuentes cambiaría de golpe qué
 * entra en el catálogo, y ese es justo el cambio que hay que medir antes de hacer, no de paso.
 */
const REFERER_MOVIEDAYS = 'https://moviedays.lat/';

async function urlsQueReproducenAhora(servidores: any[], fuente: string): Promise<any[]> {
  const candidatos = (servidores || []).filter(sv => sv?.embed_url && sv?.direct_stream);
  if (!candidatos.length) return [];

  const POR_FICHA = 4;
  const buenos: any[] = [];
  for (let i = 0; i < candidatos.length; i += POR_FICHA) {
    const lote = candidatos.slice(i, i + POR_FICHA);
    const medidos = await Promise.all(lote.map(async sv => {
      try {
        const { html } = await inspectEmbed(String(sv.embed_url), REFERER_MOVIEDAYS);
        const directo = await extractDirect(String(sv.embed_url), html, { allowNetwork: true });
        if (!directo?.url) return null;

        /**
         * Y LA PRUEBA SE ELIGE SEGÚN LO QUE SEA, porque `entregaVideo` no vale para un m3u8.
         *
         * `entregaVideo` pide un trozo desde el byte 1.000.000 y exige más de 8 KB: está pensada
         * para un fichero de vídeo, y con eso mide de paso la velocidad del host. Un manifiesto
         * HLS ocupa dos kilobytes, así que contesta 416, cae al respaldo de los primeros 64 KB y
         * lo tira por pequeño. O sea que TODO el vídeo HLS —que es el de esta fuente— salía
         * reprobado por la forma de la prueba, no por su estado. Ese fue el motivo real de que la
         * primera pasada recolectara 34 títulos y guardara cero.
         *
         * Para HLS la prueba correcta ya existe en la casa: bajar el manifiesto y comprobar que un
         * SEGMENTO se descarga (`segmentoDescargable`), que es justo lo que hace un reproductor y
         * lo que exige `arranque-mp4-antes-de-anunciar`: un 206 no prueba que abra.
         */
        const esHls = /\.m3u8(\?|$)/i.test(directo.url) || directo.kind === 'hls';
        if (esHls) {
          const manifiesto = await bajarManifiesto(directo.url, REFERER_MOVIEDAYS);
          if (!manifiesto) return null;
          if (!(await segmentoDescargable(manifiesto, directo.url, REFERER_MOVIEDAYS))) return null;
          return { ...sv, status: 'online', verified_at: new Date().toISOString(), source_id: fuente };
        }

        const medida = await entregaVideo(directo.url);
        if (!medida.ok) return null;
        return {
          ...sv,
          status: 'online',
          verified_at: new Date().toISOString(),
          source_id: fuente,
          kbps: Math.round(medida.kbs),
        };
      } catch {
        return null;
      }
    }));
    buenos.push(...medidos.filter(Boolean));
  }
  // El más rápido primero, igual que en `urlsBuenasDe`.
  return buenos.sort((a, b) => (b.kbps || 0) - (a.kbps || 0));
}

/**
 * Escribe estas fichas en la base. Es la MISMA escritura de siempre, sacada a una función para
 * poder llamarla por tandas mientras el crawl avanza en vez de solo al terminar (ver
 * `guardarTanda`). No cambia nada de lo que hacía: lote de 50, y si el lote falla se reintenta
 * fila a fila para aislar el conflicto de `tmdb_id` que sí sabe resolverse fusionando.
 */
/**
 * LO QUE YA ESTABA SOBREVIVE AL CRAWL. Antes no.
 *
 * `upsert` reemplaza la fila entera, y `servers` es una columna: lo que el crawl acaba de scrapear
 * PISA lo que hubiera guardado. Para las cuatro webs eso es correcto —lo que vale es lo último que
 * se comprobó—, pero la fuente propia no se scrapea: sus urls las pega una persona en el panel y no
 * hay ninguna pasada que las vuelva a descubrir. Así que cada crawl que tocaba una ficha con url
 * manual se la llevaba por delante, en silencio.
 *
 * Se veía exactamente así: de todo lo añadido a mano solo sobrevivía «Shrek 4», y sobrevivía por un
 * accidente —era el único título que NO estaba ya en el catálogo, así que se guardó en su propia
 * fila `manual-…` que ningún crawl vuelve a tocar—. Todo lo demás se fusionó dentro de fichas de
 * otras fuentes y ahí duró hasta la siguiente pasada.
 *
 * Es la misma idea que ya defiende `DEFAULT_SOURCES` al poner la fuente propia la primera: lo que
 * puso una persona es lo que más probabilidades tiene de seguir bueno mañana, y desde luego no es
 * algo que un scraper deba poder borrar sin decir nada.
 */
async function conservarLoQueYaEstaba(rows: Array<Record<string, any>>): Promise<void> {
  const ids = rows.map(r => String(r.id)).filter(Boolean);
  if (!ids.length) return;

  const esManual = (sv: any) => String(sv?.source_id || '').toLowerCase() === 'manual';
  const guardadas = new Map<string, { servers: any[]; seasons: any[] }>();

  const TANDA = 50;
  for (let i = 0; i < ids.length; i += TANDA) {
    const { data } = await db
      .from('media_items')
      .select('id,servers,seasons')
      .in('id', ids.slice(i, i + TANDA));
    for (const fila of (data as any[]) || []) {
      guardadas.set(String(fila.id), {
        servers: Array.isArray(fila.servers) ? fila.servers : [],
        seasons: Array.isArray(fila.seasons) ? fila.seasons : [],
      });
    }
  }
  if (!guardadas.size) return;

  for (const row of rows) {
    const previa = guardadas.get(String(row.id));
    if (!previa) continue;

    // A nivel de ficha: los manuales vuelven, y DELANTE, que es su prioridad.
    const manuales = previa.servers.filter(esManual);
    if (manuales.length) {
      const nuevos: any[] = Array.isArray(row.servers) ? row.servers : [];
      const yaEstan = new Set(nuevos.map((x: any) => String(x?.direct_stream || x?.embed_url || '')));
      const rescatados = manuales.filter(m => !yaEstan.has(String(m?.direct_stream || m?.embed_url || '')));
      if (rescatados.length) row.servers = [...rescatados, ...nuevos];
    }

    /**
     * Y EL ÁRBOL DE CAPÍTULOS SE FUSIONA ENTERO, no solo lo manual.
     *
     * Aquí había un agujero mucho más grande que el de las urls a mano, y se midió: una pasada
     * `--solo=moviedays` sobre 50 títulos se llevó por delante 42 servidores de capítulos en 8
     * series. Ninguno era manual — eran capítulos que resolvieron pasadas ANTERIORES.
     *
     * La razón es que una pasada no resuelve la serie entera: mira unos pocos capítulos y arma un
     * árbol con esos. Al escribir `seasons` —que es una columna, y se reemplaza entera— lo que
     * traía la pasada de hoy borraba lo que aprendieron las de ayer. Así una serie nunca podía
     * acumular capítulos: cada crawl la devolvía a los cuatro o cinco de esa corrida.
     *
     * Es la misma asimetría que hay entre `servers` y `seasons`, y por eso solo se toca el
     * segundo: a nivel de ficha el crawl SÍ vuelve a mirar todo lo que había, así que quedarse
     * con lo último comprobado es correcto. A nivel de capítulo no mira ni la décima parte, así
     * que reemplazar es tirar información sin haberla contradicho.
     *
     * Se reutiliza `fusionarTemporadas`, que es la que ya sabe hacer esto en el otro lado del
     * proyecto — lo que se copia se desincroniza; lo que se llama, no.
     */
    const previasConManuales = previa.seasons.map((t: any) => ({ ...t, episodes: [...(t?.episodes || [])] }));
    row.seasons = fusionarTemporadas(previasConManuales, Array.isArray(row.seasons) ? row.seasons : []);
  }

  /**
   * Y LOS CAPÍTULOS QUE SE QUEDAN, ROTULADOS POR TMDB.
   *
   * `enrichMediaItem` ya rotula lo que ENTRA, pero la fusión de arriba conserva lo que había —«la
   * metadata que ya estaba no se pisa», que es lo que impide que un crawl parcial borre capítulos—
   * así que las filas guardadas antes de esta regla se quedarían con el rótulo de la web para
   * siempre: nadie las vuelve a mirar. Aquí se arreglan solas al pasar el crawl por ellas.
   *
   * No cuesta peticiones en el caso normal: `rotularEpisodiosConTmdb` mira primero si el árbol
   * huele a rotulado por la web y, si no, devuelve el mismo objeto sin preguntar nada.
   */
  for (const row of rows) {
    const tmdbId = Number(row.tmdb_id);
    if (!(tmdbId > 0) || !Array.isArray(row.seasons) || !row.seasons.length) continue;
    row.seasons = await TmdbService.rotularEpisodiosConTmdb(tmdbId, row.seasons, row.poster || null)
      .catch(() => row.seasons);
  }
}

async function guardarFilas(
  items: MediaItem[],
  banderas: { withNormalized: boolean; withMetadataSource: boolean; withRichMetadata: boolean; withMultiSource: boolean }
): Promise<{ ok: number; fail: number; merged: number }> {
  const { withNormalized, withMetadataSource, withRichMetadata, withMultiSource } = banderas;
  const rows = items.map(it => toRow(it, withNormalized, withMetadataSource, withRichMetadata, withMultiSource));
  await conservarLoQueYaEstaba(rows);
  let ok = 0, fail = 0, merged = 0;
  const BATCH = 50;

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await db.from('media_items').upsert(chunk, { onConflict: 'id' });
    if (!error) {
      ok += chunk.length;
      continue;
    }
    // Reintento fila a fila para aislar conflictos puntuales (p.ej. tmdb_id ya usado por otro id)
    for (const row of chunk) {
      const { error: rowError } = await db.from('media_items').upsert(row, { onConflict: 'id' });
      if (!rowError) { ok++; continue; }

      if (isTmdbIdConflict(rowError.message)) {
        if (await mergeIntoExisting(row, { withNormalized, withMultiSource })) { merged++; continue; }
      }

      fail++;
      console.warn(`   ⚠ ${row.id}: ${rowError.message}`);
    }
  }
  return { ok, fail, merged };
}

/**
 * De qué web viene la ficha. Se guarda para poder verlo en el panel y para ORDENAR.
 *
 * No es solo etiqueta: `sortServersBySourcePriority` decide con este valor qué servidor intenta
 * primero el cliente, así que una fuente mal atribuida hereda la prioridad de otra.
 *
 * archive.org faltaba, y como el `return` final es `tioplus`, sus 14 fichas se guardaron con los
 * servidores rotulados «tioplus» — la fuente que el panel enseña la última y que además publica
 * urls que caducan, justo lo contrario de lo que archive.org es.
 */
function fuenteDeLaUrl(url: string): string {
  if (/videoapi\.la|videoapp\.zip/i.test(url)) return 'videoapi';
  if (/moviedays\.lat/i.test(url)) return 'moviedays';
  if (/archive\.org/i.test(url)) return 'archive';
  if (/fuegocine|blogfc|repfuegocinefree/i.test(url)) return 'fuegocine';
  return 'tioplus';
}

/**
 * Baja a la página de cada título, saca las urls de fichero, comprueba que entregan vídeo y
 * devuelve SOLO los títulos que se pueden reproducir, ya con sus servidores puestos.
 */
/**
 * RESUELVE LOS CAPÍTULOS DE UNA SERIE QUE TRAE SUS PROPIOS ENLACES, uno por uno.
 *
 * Es el caso de FuegoCine: no publica página de serie, así que su ficha se arma agrupando los
 * posts de cada episodio y cada uno guarda su url en `_fuegocine_url`. Sin esto, el crawl
 * resolvía UN capítulo y colgaba sus servidores de la ficha, donde una serie no los busca nunca.
 *
 * Devuelve el árbol en la MISMA forma que `scrapeDetail`, con los servidores en crudo: quien
 * llama sigue siendo el que decide cuáles reproducen (`urlsBuenasDe`). Repartir esa decisión en
 * dos sitios es como este proyecto acaba con dos criterios que se desincronizan.
 *
 * Dos frenos, y los dos por lo mismo —que lo que tumba al runner es la RÁFAGA de conexiones, no
 * el total—: de dos en dos, y un tope de capítulos por serie y pasada. Lo que no entre hoy entra
 * en la siguiente corrida, igual que en el resto de pasadas de este proyecto.
 */
const CAPITULOS_POR_SERIE_Y_PASADA = 24;

async function resolverCapitulosPropios(item: MediaItem, limite: number): Promise<any[]> {
  const temporadas = ((item as any).seasons || []) as any[];
  let pedidos = 0;

  const salida: any[] = [];
  for (const t of temporadas) {
    const capitulos: any[] = [];
    const eps = (t?.episodes || []) as any[];

    for (let i = 0; i < eps.length; i += 2) {
      /**
       * Al agotarse el cupo NO se corta la lista: los que quedan se devuelven tal cual, con sus
       * servidores vacíos y su url intacta. Cortarlos aquí los borraría de la ficha y la serie no
       * se podría terminar nunca — ver la nota de la poda en `quedarseConLoQueReproduce`.
       */
      if (Date.now() > limite || pedidos >= CAPITULOS_POR_SERIE_Y_PASADA) {
        capitulos.push(...eps.slice(i).map((e: any) => ({ ...e, servers: e?.servers || [] })));
        break;
      }

      const tanda = eps.slice(i, i + 2);
      const resueltos = await Promise.all(tanda.map(async (e: any) => {
        const url = e?._fuegocine_url;
        if (!url) return { ...e, servers: e?.servers || [] };
        pedidos++;
        const det = await RealScraperService.scrapeDetail(url).catch(() => null);
        return { ...e, servers: (det?.servers || []) as any[] };
      }));
      capitulos.push(...resueltos);
    }

    if (capitulos.length) salida.push({ ...t, episodes: capitulos });
  }
  return salida;
}

async function quedarseConLoQueReproduce(
  items: MediaItem[],
  /**
   * Se llama con cada tanda que ha DEMOSTRADO reproducir, en cuanto se sabe.
   *
   * Sin esto el trabajo entero se escribía al final y una cancelación del runner —que en este
   * proyecto pasa a menudo— lo tiraba todo. Ver `guardarTanda`.
   */
  alEncontrar?: (lote: MediaItem[]) => Promise<void>,
  /**
   * Se rellena con los títulos que SE MIRARON y no dieron vídeo. Los que se quedan sin mirar por
   * presupuesto no entran aquí: no se sabe nada de ellos. Ver `anotarDescartes`.
   */
  descartados?: string[]
): Promise<MediaItem[]> {
  console.log(`🎬 Extrayendo la url directa de ${items.length} títulos (solo entra lo que reproduzca)...`);
  const buenos: MediaItem[] = [];
  /** Cuántos de `buenos` ya se han entregado a `alEncontrar`. */
  let entregados = 0;
  /** Cuándo se entregó la última tanda, para el disparo por tiempo. */
  let ultimoGuardado = Date.now();
  /**
   * Cuántos títulos a la vez. Bajó de 8 a 4 por la misma razón que el techo de
   * `urlsBuenasDe`: lo que tumba al runner es la RÁFAGA de conexiones salientes, y 8
   * títulos x 4 candidatos ya son 32 en vuelo. Menos pico, más corridas que llegan al final.
   */
  const CONC = 4;
  /**
   * Presupuesto: el trabajo tiene 6 h y el crawl ya gastó las suyas. Lo que no dé tiempo a
   * comprobar sale en la corrida siguiente, igual que en el resto de pasadas de este proyecto.
   *
   * Ajustable con `--minutos=`: una pasada `--solo=fuegocine` no gasta horas recolectando cuatro
   * webs, así que puede dedicar mucho más tiempo a lo caro, que es bajarse un trozo de cada
   * fichero para comprobar que reproduce.
   */
  const minutos = Number((process.argv.find(a => a.startsWith('--minutos=')) || '').split('=')[1]) || 200;
  const limite = Date.now() + minutos * 60_000;
  let mirados = 0;

  for (let i = 0; i < items.length; i += CONC) {
    if (Date.now() > limite) {
      console.log(`   ⏱ agotado el presupuesto: ${mirados}/${items.length} mirados.`);
      break;
    }
    await Promise.all(items.slice(i, i + CONC).map(async item => {
      mirados++;
      const pagina = (item as any)._tioplus_url || item._source_url;
      if (!pagina) { descartados?.push(item.id); return; }
      const detalle = await RealScraperService.scrapeDetail(pagina).catch(() => null);
      /**
       * UNA SERIE NO TIENE SERVIDORES EN LA FICHA: LOS TIENE EN SUS CAPÍTULOS.
       *
       * Esta guarda pedía `detalle.servers.length` y ahí se moría TODA serie de archive.org, que
       * devuelve la ficha con `servers: []` y el vídeo colgando de cada capítulo. Treinta líneas
       * más abajo hay un bucle que recorre las temporadas con todo el cuidado del mundo — y nunca
       * se llegaba a ejecutar. Por eso el catálogo tenía 108 películas de archive.org y CERO
       * series, con «Nano» (44 capítulos), «Collar de Esmeraldas» (65) o «Encadenados» (176)
       * esperando ahí fuera, comprobados uno a uno: sus capítulos entregan vídeo (206 y 256 KB
       * en menos de dos segundos).
       *
       * Es la misma trampa que FUENTES.md §4: dar por hecho que una serie se parece a una
       * película con más metadata. No se parece — el vídeo vive en otro sitio.
       */
      const capitulosConVideo = ((detalle as any)?.seasons || [])
        .some((t: any) => (t?.episodes || []).some((e: any) => (e?.servers || []).length > 0));
      if (!detalle || (!detalle.servers?.length && !capitulosConVideo)) { descartados?.push(item.id); return; }

      const fuente = fuenteDeLaUrl(pagina);
      // Moviedays no publica ficheros permanentes: su vídeo se acuña en cada reproducción. Ver
      // `urlsQueReproducenAhora`, que exige la prueba completa (extraer + bajar un trozo).
      const servidores = fuente === 'moviedays'
        ? await urlsQueReproducenAhora(detalle.servers as any[], fuente)
        : await urlsBuenasDe(detalle.servers as any[], fuente, (item as any).runtime);

      /**
       * Y LOS CAPÍTULOS, que es donde vive el vídeo de una serie. Una serie no se reproduce por
       * la ficha: se reproduce por capítulo, así que mirar solo `servers` la dejaría fuera entera
       * aunque tuviera veinte capítulos buenos.
       */
      /**
       * DE DÓNDE SALEN LAS TEMPORADAS: DEL DETALLE, O DEL PROPIO ITEM SI ÉL YA LAS TRAE.
       *
       * FuegoCine no tiene página de serie: cada capítulo es un post suelto, y la serie se arma
       * agrupando los posts. Por eso su ficha llega con `_source_url` apuntando a UN capítulo, y
       * `scrapeDetail` sobre esa url devuelve lo que hay allí — los servidores de ESE capítulo y
       * `seasons: 0`. Medido:
       *
       *     «Silo»  27 capítulos recolectados
       *     página que se resuelve: .../silo-3x7.html
       *     detalle: servers=3  seasons=0
       *
       * Con `seasons` vacío, el bucle de abajo no daba una vuelta, `hayCapitulos` era falso y los
       * servidores del capítulo acababan colgados de la FICHA — que es justo donde una serie no
       * los tiene (FUENTES.md §4). Resultado medido en la base: 263 películas de FuegoCine y
       * CERO series, con «Silo», «X-Men '97», «Avatar: La leyenda de Aang» o «Invencible»
       * esperando fuera con sus capítulos ya enumerados.
       *
       * El parser ya dejaba el enlace de cada capítulo en `_fuegocine_url`, y hasta ahora NADIE
       * lo leía: se escribía y ahí se quedaba. Esto lo usa.
       */
      const traeSusCapitulos = ((item as any).seasons || [])
        .some((t: any) => (t?.episodes || []).some((e: any) => e?._fuegocine_url));
      const arbol = ((detalle as any).seasons || []).length
        ? (detalle as any).seasons
        : (traeSusCapitulos ? await resolverCapitulosPropios(item, limite) : []);

      const temporadas: any[] = [];
      for (const t of (arbol || [])) {
        const capitulos: any[] = [];
        for (const e of (t?.episodes || [])) {
          const suyos = fuente === 'moviedays'
            ? await urlsQueReproducenAhora(e?.servers || [], fuente)
            : await urlsBuenasDe(e?.servers || [], fuente, (item as any).runtime);
          /**
           * LOS CAPÍTULOS SIN ENLACE SE TIRAN... SALVO EN MOVIEDAYS, donde tirarlos borra la serie.
           *
           * La poda es correcta para las otras fuentes: su página de serie trae los servidores de
           * TODOS los capítulos, así que un capítulo sin enlace es un capítulo que se comprobó y no
           * tiene nada. En moviedays no: sus capítulos se resuelven UNO A UNO al abrirlos, y la
           * ficha solo llega con los del capítulo con el que se sondeó la serie. Podarla dejaba
           * «The Mandalorian» guardado con una temporada y un episodio de los 24 que tiene.
           *
           * Y no es que se anuncie nada sin comprobar: el tipo `Episode` ya distingue las dos
           * cosas con `checked_at` —ausente significa «todavía no se ha mirado», y esos se siguen
           * anunciando a propósito—, y quien abre el capítulo dispara la resolución de verdad. Lo
           * que sí se exige para que la SERIE entre en el catálogo no cambia: al menos un capítulo
           * con vídeo demostrado (`hayCapitulos`).
           */
          /**
           * Y FUEGOCINE TAMBIÉN CONSERVA LOS QUE AÚN NO SE HAN MIRADO, por lo mismo que moviedays.
           *
           * La poda es correcta para una fuente cuya página de serie trae los servidores de TODOS
           * los capítulos: allí un capítulo sin enlace es uno que se comprobó y no tiene nada. En
           * FuegoCine no hay página de serie —cada capítulo es un post— y esta pasada resuelve
           * como mucho `CAPITULOS_POR_SERIE_Y_PASADA`. Podando, los que no dio tiempo a mirar
           * DESAPARECÍAN de la ficha, y con ellos la única forma de terminarla después:
           * `completarSeries` elige por `sinResolver`, y lo que no está guardado no cuenta como
           * pendiente. Silo entraba con 24 capítulos y se quedaba en 24 para siempre.
           *
           * Guardándolos vacíos, la serie entra con lo que ya se ve y el completado la remata en
           * las corridas siguientes. Lo que se exige para que la serie ENTRE no cambia: sigue
           * haciendo falta al menos un capítulo con vídeo demostrado (`hayCapitulos`).
           *
           * Se conserva el episodio ENTERO —`...e`— y eso incluye su `_fuegocine_url`, que es la
           * página exacta de ese capítulo. Sin ella habría que adivinar la ruta a partir de la de
           * otro, y en Blogger el mes va en la ruta: los capítulos de una serie se publican en
           * meses distintos, así que adivinar falla justo en los que faltan.
           */
          if (suyos.length) capitulos.push({ ...e, servers: suyos });
          else if (fuente === 'moviedays' || fuente === 'fuegocine') capitulos.push({ ...e, servers: [] });
        }
        if (capitulos.length) temporadas.push({ ...t, episodes: capitulos });
      }

      // Una película necesita url propia; una serie, al menos un capítulo con url DEMOSTRADA.
      // Se mira `servers`, no la mera presencia del capítulo: desde que moviedays conserva sus
      // capítulos sin resolver, «tiene capítulos» ya no significa «alguno reproduce».
      const hayCapitulos = temporadas.some(t => (t.episodes || []).some((e: any) => (e.servers || []).length > 0));
      if (!servidores.length && !hayCapitulos) { descartados?.push(item.id); return; }

      item.servers = servidores;
      if (temporadas.length) (item as any).seasons = temporadas;
      item.has_streams = true;
      buenos.push(item);
    }));
    /**
     * Guardar lo encontrado: cada 5 títulos con vídeo, O CADA TRES MINUTOS si hay algo pendiente.
     *
     * El umbral por cantidad empezó en 40, bajó a 15, y seguía sin servir. La medición: una tanda
     * en GitHub aguanta unos once minutos de extracción antes de que cancelen el runner, y en ese
     * rato se miran ~20 títulos, de los que ~6 tienen url permanente. Con el umbral en 15 la
     * corrida moría sin escribir NADA — que es exactamente el fallo que este guardado vino a
     * arreglar, repetido dos veces por no ajustar el número a lo medido.
     *
     * Por eso hay ADEMÁS un disparo por tiempo. Un umbral por cantidad depende del rendimiento de
     * la fuente, que es lo que no se controla: una web con pocos ficheros permanentes nunca junta
     * la cuenta y se pierde igual todo lo que midió. El reloj no depende de nada.
     */
    const haceMuchoQueNoSeGuarda = buenos.length > entregados && Date.now() - ultimoGuardado > 3 * 60_000;
    if (alEncontrar && (buenos.length - entregados >= 5 || haceMuchoQueNoSeGuarda)) {
      const lote = buenos.slice(entregados);
      entregados = buenos.length;
      ultimoGuardado = Date.now();
      await alEncontrar(lote);
    }

    if ((i + CONC) % 400 < CONC) {
      console.log(`   ${Math.min(i + CONC, items.length)}/${items.length} · ${buenos.length} con vídeo`);
      await latir('extrayendo y comprobando urls directas', Math.min(i + CONC, items.length), items.length);
    }
  }

  // Lo que quede sin entregar al salir del bucle —por presupuesto agotado o por terminar—.
  if (alEncontrar && buenos.length > entregados) {
    await alEncontrar(buenos.slice(entregados));
  }
  return buenos;
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LO QUE YA SE MIRÓ Y NO REPRODUCÍA, para que la corrida siguiente no repita el mismo trabajo.
 *
 * `--saltar-guardados` salta lo que está EN LA BASE, y eso deja fuera justo a los que más
 * estorban: un título que se miró y no dio vídeo no se guarda, así que la tanda siguiente vuelve
 * a recolectarlo, vuelve a bajarse su página y vuelve a medir sus ficheros. Con un presupuesto de
 * 18 minutos por tanda —unos treinta títulos— eso significa que las tandas se pasan la vida
 * midiendo los mismos treinta cadáveres y nunca alcanzan al número treinta y uno. Medido en
 * archive.org: siete tandas seguidas, «0/N con url directa», cero filas guardadas.
 *
 * Se recuerdan en Redis, que es donde el crawl ya escribe (`crawl:latido`), así que no hace falta
 * ninguna credencial nueva ni ninguna tabla. Sin Redis esto no hace nada y las tandas se
 * comportan como antes: es una ayuda, no una dependencia.
 *
 * CADUCAN A LOS 14 DÍAS. Un fichero puede volver —lo resubieron, el host se recuperó—, así que
 * esto no es una condena: es no preguntar dos veces la misma semana. Y solo entra lo que se MIRÓ;
 * lo que se quedó sin mirar por presupuesto no se sabe si reproduce.
 * ══════════════════════════════════════════════════════════════════════════════════════════
 */
/**
 * El `v2` NO es decoración: la primera tanda con memoria de descartes corrió con la guarda de
 * `servers` rota, así que apuntó como «sin vídeo» a las series de archive.org, que sí lo tienen.
 * Cambiar el nombre de la clave tira ese recuerdo equivocado en vez de arrastrarlo catorce días.
 * Quien cambie lo que significa un descarte, que suba el número.
 */
const CLAVE_DESCARTES = 'crawl:descartes:v2';
const DIAS_DESCARTE = 14;
/** Tope de la lista, para que el blob no crezca sin fin. Se van los más antiguos. */
const MAX_DESCARTES = 20000;

async function descartesVigentes(): Promise<Set<string>> {
  const vigentes = new Set<string>();
  try {
    const guardado = await CacheStore.get<Record<string, number>>(CLAVE_DESCARTES);
    const ahora = Date.now();
    for (const [id, caduca] of Object.entries(guardado || {})) {
      if (caduca > ahora) vigentes.add(id);
    }
  } catch { /* sin memoria de descartes se trabaja igual, solo que repitiendo */ }
  return vigentes;
}

async function anotarDescartes(ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    const guardado = (await CacheStore.get<Record<string, number>>(CLAVE_DESCARTES)) || {};
    const ahora = Date.now();
    const caduca = ahora + DIAS_DESCARTE * 24 * 3600_000;
    // Se limpian de paso los que ya caducaron: si no, el blob solo crece.
    const vivos: Array<[string, number]> = Object.entries(guardado).filter(([, c]) => c > ahora);
    for (const id of ids) vivos.push([id, caduca]);

    // Si sobra, se van los que caducan antes, que son los más viejos.
    vivos.sort((a, b) => b[1] - a[1]);
    const mapa: Record<string, number> = {};
    for (const [id, c] of vivos.slice(0, MAX_DESCARTES)) mapa[id] = c;

    await CacheStore.set(CLAVE_DESCARTES, mapa, (DIAS_DESCARTE + 1) * 24 * 3600);
    console.log(`   🧠 ${ids.length} títulos mirados sin vídeo: no se repetirán en ${DIAS_DESCARTE} días (${Object.keys(mapa).length} recordados)`);
  } catch { /* nunca puede tumbar la corrida */ }
}

/**
 * EL LATIDO DEL CRAWL, para que el panel pueda decir si está trabajando.
 *
 * Hacía falta porque el avance NO se puede deducir de la base: este trabajo recolecta, enriquece
 * y comprueba durante horas, y solo escribe AL FINAL. Mientras tanto el panel veía cero filas y
 * cero actividad, que es indistinguible de «no está corriendo nadie» — y eso fue justo lo que se
 * reportó al mirar el panel con la base recién vaciada.
 *
 * Se deja en Redis, que es donde el crawl ya escribe, así que no hace falta ninguna credencial
 * nueva ni preguntarle nada a la API de GitHub. Y caduca solo: si el trabajo muere, el latido se
 * apaga en 20 minutos y el panel deja de decir que hay algo en marcha, en vez de mentir para
 * siempre.
 */
const CLAVE_LATIDO = 'crawl:latido';

async function latir(fase: string, hechos?: number, total?: number): Promise<void> {
  try {
    await CacheStore.set(CLAVE_LATIDO, {
      fase,
      hechos: hechos ?? null,
      total: total ?? null,
      actualizado: new Date().toISOString(),
      empezado: INICIO_DEL_CRAWL,
    }, 20 * 60);
  } catch { /* el latido nunca puede tumbar el crawl */ }
}


/**
 * COMPLETAR UNA SERIE ENTERA ANTES DE PASAR A LA SIGUIENTE.
 *
 * Hasta ahora ninguna pasada terminaba una serie. El crawl deja resuelto el 1x01 —por donde entra
 * casi todo el mundo— y los demás capítulos solo se resolvían cuando alguien los abría en la app.
 * Medido sobre «Breaking Bad»: 62 capítulos guardados, 12 con servidor, 51 sin mirar nunca. Y los
 * 12 no eran los 12 primeros, eran los que alguien había abierto: 1x1, 1x6, 2x3, 2x11, 3x3… Una
 * serie así no se puede ver de principio a fin, que es como se ve una serie.
 *
 * Esta pasada va POR SERIES, no por capítulos: coge una y no la suelta hasta terminarla. Es lo
 * contrario de repartir el tiempo entre todas, y es a propósito — una serie entera sirve para algo
 * y veinte series a un cuarto no sirven para nada. El presupuesto de tiempo se mira ENTRE series,
 * nunca dentro: la que se empieza se acaba.
 *
 * No resuelve nada por su cuenta: llama a `CatalogService.getEpisode`, que es el camino que ya
 * usa la app. Eso trae gratis todo lo que ese camino sabe —comprobar que el servidor reproduce de
 * verdad antes de sellarlo, guardar capítulo a capítulo, tirar el caché de la ficha— y evita tener
 * dos maneras distintas de resolver un capítulo, que en este proyecto siempre acaba en que una se
 * arregla y la otra no.
 *
 * Como guarda capítulo a capítulo, que la maten a medias no pierde el trabajo hecho.
 */
async function completarSeries(opts: { soloId?: string; cuantasSeries: number; minutos: number }): Promise<void> {
  const filas: any[] = [];
  for (let desde = 0; ; desde += 500) {
    // Con `.order()`: paginar sin él en Postgres se salta filas y repite otras.
    const { data, error } = await db
      .from('media_items')
      .select('id,title,type,seasons')
      .eq('type', 'tvseries')
      .order('id')
      .range(desde, desde + 499);
    if (error) { console.warn(`   ⚠ no se pueden leer las series: ${error.message}`); return; }
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 500) break;
  }

  let series = filas;
  if (opts.soloId) {
    series = filas.filter(r => r.id === opts.soloId);
    if (!series.length) { console.log(`   no hay ninguna serie con id ${opts.soloId}`); return; }
  } else {
    /**
     * Primero las que MÁS CERCA están de terminarse, no las más vacías.
     *
     * Rematar una serie a la que le faltan tres capítulos deja una serie completa; empezar una de
     * sesenta deja otra a medias. Con el tiempo siempre corto, terminar es lo que hay que premiar.
     * Las que no tienen ni un capítulo resuelto van al final: esas son trabajo del crawl.
     */
    const pendientes = (r: any) => contarCapitulos(r).sinResolver;
    series = filas
      .filter(r => contarCapitulos(r).resueltos > 0 && pendientes(r) > 0)
      .sort((a, b) => pendientes(a) - pendientes(b));
  }

  const limite = Date.now() + opts.minutos * 60_000;
  const aTrabajar = series.slice(0, opts.cuantasSeries);
  console.log(`📺 Completar ${aTrabajar.length} serie(s), una entera cada vez (presupuesto ${opts.minutos} min entre series)`);

  let terminadas = 0, capitulosNuevos = 0;
  for (const serie of aTrabajar) {
    if (Date.now() > limite) {
      console.log(`   ⏱ se acabó el presupuesto; ${terminadas} serie(s) terminadas. El resto, en la siguiente corrida.`);
      break;
    }
    capitulosNuevos += await completarUnaSerie(serie);
    terminadas++;
  }
  console.log(`✅ ${terminadas} serie(s) recorridas de principio a fin · ${capitulosNuevos} capítulos nuevos con vídeo`);
}

/**
 * TERMINAR UNA SERIE NO ES QUE TODOS SUS CAPÍTULOS SE VEAN.
 *
 * Es que de todos se sepa algo. Hay capítulos que la fuente sencillamente no tiene, y tratarlos
 * como trabajo pendiente convierte esa serie en una que no se acaba nunca: cada corrida vuelve a
 * preguntar por los mismos veinte, gasta el presupuesto y no llega nunca a la siguiente serie.
 *
 * Pero «no se ve» esconde DOS situaciones que no merecen el mismo trato, y confundirlas se paga
 * de las dos maneras posibles:
 *
 *   · LA FUENTE NO LO TIENE (se preguntó y no dio ni una url). Volver a preguntar mañana es tirar
 *     el presupuesto: la respuesta va a ser la misma. Siete días, que es el borde con el que este
 *     proyecto ya da por caducado lo aprendido.
 *   · LA FUENTE LO TIENE Y HOY NO FUNCIONÓ (hay url, pero no llegó a demostrar que reproduce, o
 *     su host acaba de quedar condenado). Eso NO es una respuesta estable: los hosts van y vienen
 *     —tres capítulos de «Breaking Bad» pasaron de verse a no verse en una hora, porque sus
 *     embeds dejaron de entregar segmentos—. Un día, para que una corrida diaria los reintente
 *     sin quedarse a vivir en ellos.
 *
 * Un capítulo del que nunca se ha preguntado está pendiente siempre: eso es trabajo sin hacer.
 */
const REINTENTO_SIN_FUENTE_MS = 7 * 24 * 60 * 60 * 1000;
const REINTENTO_FALLO_MS = 24 * 60 * 60 * 1000;

function capituloPendiente(e: any): boolean {
  if (paraElCliente(e?.servers).length > 0) return false;
  if (!e?.checked_at) return true;
  const cuando = Date.parse(e.checked_at);
  if (!Number.isFinite(cuando)) return true;
  const plazo = (e?.servers || []).length ? REINTENTO_FALLO_MS : REINTENTO_SIN_FUENTE_MS;
  return Date.now() - cuando > plazo;
}

/** Cuántos capítulos tiene una serie guardados, cuántos se ven y cuántos quedan por mirar. */
function contarCapitulos(fila: any): { total: number; resueltos: number; sinResolver: number } {
  let total = 0, resueltos = 0, pendientes = 0;
  for (const t of (fila.seasons || [])) {
    for (const e of (t?.episodes || [])) {
      total++;
      if (paraElCliente(e?.servers).length > 0) resueltos++;
      if (capituloPendiente(e)) pendientes++;
    }
  }
  return { total, resueltos, sinResolver: pendientes };
}

/**
 * Una serie, entera, capítulo a capítulo.
 *
 * Se salta los que ya se anuncian: `getEpisode` sabe no volver a scrapear lo fresco, pero
 * preguntárselo 62 veces cuesta 62 lecturas de caché para nada. Lo que no se salta es un capítulo
 * resuelto hace tiempo — de eso decide `getEpisode`, que es quien tiene la regla.
 */
async function completarUnaSerie(fila: any): Promise<number> {
  const pendientes: Array<{ season: number; episode: number }> = [];
  for (const t of (fila.seasons || [])) {
    for (const e of (t?.episodes || [])) {
      if (!capituloPendiente(e)) continue;
      pendientes.push({ season: Number(t.season_number), episode: Number(e.episode_number) });
    }
  }

  const antes = contarCapitulos(fila);
  if (!pendientes.length) {
    const sinFuente = antes.total - antes.resueltos;
    console.log(
      `   «${fila.title}»: nada que mirar (${antes.resueltos}/${antes.total} se ven` +
      (sinFuente > 0 ? `; ${sinFuente} ya preguntados sin resultado` : '') + ')');
    return 0;
  }
  console.log(`   «${fila.title}» (${fila.id}): ${antes.resueltos}/${antes.total} anunciables, faltan ${pendientes.length}`);

  /**
   * De tres en tres. Cada capítulo sondea hasta ocho servidores, así que tres a la vez ya son
   * veinticuatro conexiones en vuelo — el techo que este proyecto ya aprendió a respetar: lo que
   * tumba al runner es la RÁFAGA, no el rato.
   */
  const CONC = 3;
  let logrados = 0, mirados = 0;
  for (let i = 0; i < pendientes.length; i += CONC) {
    await Promise.all(pendientes.slice(i, i + CONC).map(async cap => {
      mirados++;
      try {
        const r = await CatalogService.getEpisode(fila.id, cap.season, cap.episode);
        const n = (r?.servers || []).length;
        if (n > 0) {
          logrados++;
          console.log(`      ✓ ${cap.season}x${cap.episode} — ${n} servidor(es)`);
        }
      } catch (e: any) {
        console.log(`      ✗ ${cap.season}x${cap.episode} — ${e?.message || e}`);
      }
    }));
  }

  // Se relee de la base para contar lo que de verdad quedó guardado, no lo que se creyó resolver.
  const { data } = await db.from('media_items').select('id,title,seasons').eq('id', fila.id).maybeSingle();
  const despues = contarCapitulos(data || fila);
  const sinFuente = despues.total - despues.resueltos - despues.sinResolver;
  console.log(
    `   «${fila.title}»: ${despues.resueltos}/${despues.total} anunciables ` +
    `(${logrados} nuevos de ${mirados} mirados)` +
    (sinFuente > 0 ? ` · ${sinFuente} que la fuente no tiene` : '') +
    (despues.resueltos === despues.total
      ? '  ← COMPLETA'
      : despues.sinResolver === 0
        ? '  ← TERMINADA (lo que falta no está en la fuente)'
        : ''));
  return logrados;
}

/**
 * REGLA DEL CRAWL: UNA SERIE QUE ENTRA, ENTRA ENTERA.
 *
 * El crawl descubría la serie, le dejaba resuelto el 1x01 y se iba al título siguiente. Los demás
 * capítulos solo aparecían si alguien los abría en la app, así que el catálogo se llenó de series
 * que no se pueden ver de principio a fin: medido el 2026-08-22, 23 de 26 series a medias y 1.792
 * capítulos que no se habían mirado nunca. Un catálogo con veintiséis series al 14 % no son
 * veintiséis series.
 *
 * Va aquí, colgado de la escritura, y no dentro de `quedarseConLoQueReproduce`, porque completar
 * exige que la fila EXISTA: `getEpisode` resuelve contra la ficha guardada. La tanda se escribe y
 * acto seguido se terminan sus series.
 *
 * El presupuesto se mira ENTRE series, nunca dentro: la que se empieza se acaba. Y como
 * `getEpisode` guarda capítulo a capítulo, que maten la corrida no tira el trabajo hecho — solo
 * deja el resto para la siguiente.
 */
async function completarSeriesDeLaTanda(lote: MediaItem[], limite: number): Promise<void> {
  const series = lote.filter(it => it.type === 'tvseries');
  if (!series.length) return;

  for (const it of series) {
    if (Date.now() > limite) {
      console.log('   ⏱ sin presupuesto para completar más series en esta corrida.');
      return;
    }

    /**
     * Se relee por id y, si no aparece, por identidad: `mergeIntoExisting` pudo volcar esta ficha
     * dentro de otra que ya tenía su `tmdb_id`, y entonces el id de la tanda no existe en la tabla.
     */
    let fila: any = null;
    const porId = await db.from('media_items').select('id,title,type,seasons').eq('id', it.id).maybeSingle();
    fila = porId.data;
    if (!fila && it.tmdb_id) {
      const porIdentidad = await db
        .from('media_items').select('id,title,type,seasons')
        .eq('tmdb_id', it.tmdb_id).eq('type', 'tvseries').maybeSingle();
      fila = porIdentidad.data;
    }
    if (!fila) continue;

    await completarUnaSerie(fila);
  }
}

const INICIO_DEL_CRAWL = new Date().toISOString();

async function main() {
  const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const limitArg = parseInt(positional[0] || '', 10);
  const streamsLimit = parseStreamsFlag(process.argv);
  const verifyLimit = parseVerifyFlag(process.argv);
  const directLimit = parseDirectFlag(process.argv);

  // `--verify-only`: comprobar disponibilidad SIN volver a crawlear. Es la forma práctica
  // de ir limpiando fichas fantasma del catálogo ya poblado, sin pagar el crawl entero.
  if (process.argv.includes('--verify-only')) {
    await verifyAvailability(verifyLimit || 500);
    return;
  }

  // `--direct-only`: extraer el vídeo directo de lo ya guardado, sin crawlear.
  if (process.argv.includes('--direct-only')) {
    await fillDirectStreams(directLimit || 200);
    return;
  }

  /**
   * `--completar-series`: terminar series enteras, sin crawlear nada nuevo.
   *
   * `--serie=<id>` para una concreta; `--series=<n>` cuántas como mucho; `--minutos=<n>` el
   * presupuesto, que se mira ENTRE series — la que se empieza se acaba.
   */
  if (process.argv.includes('--completar-series')) {
    const bandera = (nombre: string) =>
      Number((process.argv.find(a => a.startsWith(`--${nombre}=`)) || '').split('=')[1]) || 0;
    await completarSeries({
      soloId: (process.argv.find(a => a.startsWith('--serie=')) || '').split('=')[1] || undefined,
      cuantasSeries: bandera('series') || 5,
      minutos: bandera('minutos') || 120,
    });
    return;
  }

  await latir('recolectando los títulos de las webs');
  console.log('🔎 Recolectando catálogo desde las fuentes...');
  let items = await collectCatalog();
  console.log(`   ${items.length} títulos recolectados`);

  /**
   * `--saltar-guardados`: no volver a trabajar lo que ya está en la base.
   *
   * Existe porque el runner se muere SIEMPRE por el mismo sitio. Dos pasadas
   * `--solo=fuegocine` seguidas, medidas enteras: las dos recolectaron 3.219 títulos, las dos
   * los enriquecieron al 100 %, y a las dos las cancelaron a los 16 min y medio —16m30s y
   * 16m36s— cinco minutos después de empezar a extraer urls. No es un tope de GitHub (el crawl
   * completo ha llegado a correr 3h44m); es que esta pasada aprieta la red mucho más.
   *
   * Sin esto, cada corrida vuelve a empezar por el mismo título y no se avanza nunca por muchas
   * veces que se lance. Con esto, más un tope por corrida, cada lanzamiento coge un tramo nuevo
   * y el archivo entero se recorre en varias vueltas — que es como ya funcionan las demás
   * pasadas largas de este proyecto.
   */
  if (process.argv.includes('--saltar-guardados')) {
    const yaEstan = new Set<string>();
    let ultimo = '';
    for (;;) {
      const { data } = await db.from('media_items').select('id').gt('id', ultimo).order('id').limit(1000);
      if (!data?.length) break;
      for (const fila of data as any[]) yaEstan.add(fila.id);
      ultimo = (data[data.length - 1] as any).id;
    }
    const antes = items.length;
    items = items.filter(it => !yaEstan.has(it.id));
    console.log(`   ${antes - items.length} ya estaban guardados; quedan ${items.length} por trabajar`);

    // Y lo que se miró hace poco y no tenía vídeo, que no está en la base y por eso volvía cada
    // media hora a comerse el presupuesto de la tanda. Ver `descartesVigentes`.
    const descartes = await descartesVigentes();
    if (descartes.size) {
      const conDescartes = items.length;
      items = items.filter(it => !descartes.has(it.id));
      console.log(`   ${conDescartes - items.length} se miraron hace poco y no tenían vídeo; quedan ${items.length}`);
    }
  }

  if (Number.isFinite(limitArg) && limitArg > 0) {
    items = items.slice(0, limitArg);
    console.log(`   tope de esta corrida: ${items.length}`);
  }
  await latir('enriqueciendo con TMDB', 0, items.length);

  // Enriquecer con TMDB (géneros, rating, sinopsis, póster/backdrop, tráiler, cast con fotos)
  // y resolver el tmdb_id real, con concurrencia ACOTADA. skipSeasons: no bajamos temporadas
  // (no se guardan en el catálogo y triplicarían las llamadas).
  //
  // COBERTURA 100%: los títulos SIN match fiable en TMDB ya no se descartan; se guardan con la
  // metadata del sitio de origen (póster + sinopsis del scraping) y un tmdb_id sintético
  // NEGATIVO, que nunca colisiona con un id real. Como ese fallback sí puede repetir un título
  // ya presente, se deduplica por título canónico + tipo y cede siempre ante la ficha de TMDB.
  const CONCURRENCY = 10;
  /**
   * ÍNDICE POR TIPO **Y** TMDB_ID, no por tmdb_id a secas.
   *
   * TMDB numera películas y series por separado y los números se repiten: medido sobre este
   * catálogo, 76 identificadores los usan a la vez una película y una serie (el 194 es «Amélie»
   * y «NYPD Blue»; el 246, «Zatoichi» y «Avatar: La leyenda de Aang»). Con la clave a secas, la
   * segunda obra que llegara desaparecía de la tanda de escritura sin dejar rastro — y la tabla
   * sí distingue las dos, porque su UNIQUE es (tmdb_id, type). Es la misma regla que FUENTES.md §1
   * pone por delante de todo: la clase forma parte de la identidad.
   */
  const byTmdb = new Map<string, MediaItem>();
  const claveDeFicha = (it: MediaItem) => `${it.type}:${it.tmdb_id}`;
  let absorbidas = 0;
  let noFundidasPorAno = 0;
  const fallbacks: MediaItem[] = [];
  let withSignals = 0;
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const chunk = items.slice(i, i + CONCURRENCY);
    const enriched = await Promise.all(chunk.map(async (item) => {
      try {
        const conSeñales = await withSourceSignals(item, () => withSignals++);
        const enriquecida = await TmdbService.enrichMediaItem(conSeñales, { skipSeasons: true, complementar: COMPLEMENTAR });
        return await segundaOportunidadDeSerie(conSeñales, enriquecida);
      } catch {
        return TmdbService.fromSourceMetadata(item);
      }
    }));
    for (const item of enriched) {
      if (item.metadata_source === 'source' || !item.tmdb_id || item.tmdb_id < 0) {
        fallbacks.push(item);
        continue;
      }
      const clave = claveDeFicha(item);
      const yaEstaba = byTmdb.get(clave);
      if (!yaEstaba) {
        byTmdb.set(clave, item);
        continue;
      }
      /**
       * LA COPIA NO SE TIRA: SE LE QUITA LA PÁGINA ANTES.
       *
       * Aquí llega la MISMA obra traída por otra fuente. Quedarse con una sola fila es lo
       * correcto —la tabla tiene UNIQUE (tmdb_id, type)— pero descartar la otra entera se lleva
       * por delante lo único que aportaba: SU página de origen, que es de donde salen sus
       * servidores. Sin ella, la ficha unificada nunca ve los enlaces de esa web.
       *
       * `mergeIntoExisting` ya sabía hacer esto, pero corre al ESCRIBIR y solo para filas que
       * chocan contra la base; una copia descartada aquí no llega nunca hasta allí. Medido en la
       * corrida del 2026-08-19: 17.767 títulos recolectados y 14.791 escritos — casi 3.000 copias
       * evaporadas con sus páginas dentro. Se vio en la cobertura de una de las webs: solo constaba
       * el 62-69 %, y lo que faltaba era justo lo que TioPlus ya traía.
       *
       * Y NO SE FUNDE NADA SIN COMPROBAR EL AÑO, la misma llave que exige `mergeIntoExisting`: el
       * tmdb_id no lo publica la fuente, lo DEDUCE el matcher, y cuando se equivoca esto pegaría
       * la página de una película a la ficha de otra. Con más de un año de diferencia se descarta
       * como antes, que es el comportamiento seguro.
       */
      const anoDe = (x: MediaItem) => Number(String(x.release_date || '').slice(0, 4)) || 0;
      const a = anoDe(yaEstaba);
      const b = anoDe(item);
      if (a && b && Math.abs(a - b) > 1) {
        noFundidasPorAno++;
        continue;
      }
      const pagina = (item as any)._tioplus_url || item._source_url;
      if (pagina) {
        const paginas = new Set([
          ...(yaEstaba._source_urls || []),
          (yaEstaba as any)._tioplus_url || yaEstaba._source_url,
          pagina,
        ].filter(Boolean) as string[]);
        if (paginas.size > (yaEstaba._source_urls || []).length) {
          yaEstaba._source_urls = Array.from(paginas);
          absorbidas++;
        }
      }
      // Y sus nombres, que alimentan `title_normalized`: sin ellos la ficha unificada no se
      // encuentra por el título con el que la publica la otra web.
      const alias = new Set([...(yaEstaba.aliases || []), ...(item.aliases || [])].filter(Boolean));
      if (alias.size > (yaEstaba.aliases || []).length) yaEstaba.aliases = Array.from(alias);
    }
    if (i > 0 && i % 500 === 0) {
      console.log(`   ...enriquecidos ${i}/${items.length} (${withSignals} con señales de su página)`);
      await latir('enriqueciendo con TMDB', i, items.length);
    }
  }

  // Índice de títulos ya cubiertos por TMDB, para no duplicarlos con una ficha de fallback.
  //
  // El AÑO forma parte de la clave: sin él, dos películas distintas que se llaman igual y no
  // tienen match en TMDB se agrupaban en una sola ficha —quedándose con el póster y la sinopsis
  // de una de las dos—, y una que sí tuviera match tapaba a su homónima de otra época. El
  // catálogo está lleno de casos ("Sin salida" son cuatro, "Carrie" tres).
  const key = (it: MediaItem) =>
    `${it.type}:${canonicalTitle(it.title)}:${(it.release_date || '').slice(0, 4) || yearFromSlug(it.id) || ''}`;
  const covered = new Set(Array.from(byTmdb.values()).map(key));
  const byFallback = new Map<string, MediaItem>();
  let droppedDupes = 0;
  let sinIdentidad = 0;

  /**
   * Antes de escribir una sola ficha sin identidad, se mira si su página ya es de otra. Va aquí y
   * no dentro del bucle para preguntarlo de 40 en 40 en vez de una vez por título.
   */
  const paginaDe = (it: MediaItem) => String((it as any)._tioplus_url || it._source_url || '');
  /**
   * TODAS sus páginas, no solo la de la ficha. Una serie de FuegoCine toma como página propia la
   * del capítulo que el feed devuelve primero —el último publicado—, así que ESA cambia en cuanto
   * la serie estrena un capítulo, y con ella cambiaría la única url por la que se la reconoce.
   * Sus 40 páginas de capítulo, en cambio, no se mueven: basta con que UNA figure como fuente de
   * una ficha para saber que la obra ya está.
   */
  const PAGINAS_POR_FALLBACK = 40;
  const paginasDe = (it: MediaItem) => [
    paginaDe(it),
    ...RealScraperService.paginasDeCapitulos((it as any).seasons, null).slice(0, PAGINAS_POR_FALLBACK),
  ].filter(Boolean);

  const duenos = await duenosDeLasPaginas(fallbacks.flatMap(paginasDe)).catch(() => new Map<string, any>());
  const banderasDeFusion = {
    withNormalized: await hasColumn('title_normalized'),
    withMultiSource: await hasColumn('source_urls'),
  };
  // `source_url` va aparte: `volcarFilaEn` lo lee de la fila entrante, y si la columna no existe
  // el parche que lo llevara dentro haría fallar el update entero.
  const conPaginaDeOrigen = await hasColumn('source_url');
  let devueltasASuFicha = 0;

  for (const item of fallbacks) {
    /**
     * ══════════════════════════════════════════════════════════════════════════════════════
     * EN ARCHIVE.ORG, SIN TMDB NO HAY FICHA. El fallback de metadata no vale para esta fuente.
     *
     * El fallback existe para webs que publican un TÍTULO: si el matcher no da con la obra, la
     * ficha se guarda con lo que publicó la web y se pierde poco. En archive.org no hay título —
     * hay el nombre que le puso quien subió el fichero. Guardar eso como si fuera una obra mete
     * en el catálogo cosas como «Bob Esponja Parodia La Película Luisjefe1», «CINESAURIO -
     * 2025 10 23 - CARTELERA DE ESTRENOS», «Видео Violeta Se Fue A Los Cielos OK. RU 2» o
     * «Tom y Jerry: La Pelicula Version 4:3 SD para Television, VHS, DVD,»: 20 de las 109 fichas
     * que la fuente había traído, todas sin carátula y con un tmdb_id sintético.
     *
     * Es el mismo razonamiento por el que esta fuente ya exige año y etiqueta de clase (ver el
     * bloque de `anioDeArchive`): su metadata la escribe quien sube, así que hace falta un
     * árbitro externo. Ese árbitro es TMDB, y si TMDB no reconoce la obra, la obra no entra.
     * Cuesta contenido y es el precio de no inventar fichas.
     *
     * Solo archive.org. Las demás fuentes publican títulos de verdad y su fallback se queda.
     * ══════════════════════════════════════════════════════════════════════════════════════
     */
    const paginaDeLaFicha = String((item as any)._tioplus_url || item._source_url || '');
    const esDeArchive = String(item.id || '').startsWith('archive-')
      || (paginaDeLaFicha && fuenteDeLaUrl(paginaDeLaFicha) === 'archive');
    if (esDeArchive) {
      sinIdentidad++;
      continue;
    }
    /**
     * SU PÁGINA YA ES LA FUENTE DE OTRA FICHA: es la misma obra y NO se crea una segunda fila.
     * Lo que trae —sus capítulos, sus enlaces y sus alias— se vuelca en la que ya está, con el
     * mismo `volcarFilaEn` que usa el choque de `tmdb_id`; descartarla a secas tiraría los
     * enlaces que esta corrida acaba de comprobar.
     */
    const dueno = paginasDe(item).map(u => duenos.get(u)).find(Boolean);
    if (dueno) {
      const fila = toRow(
        item,
        banderasDeFusion.withNormalized,
        false,
        conPaginaDeOrigen,
        banderasDeFusion.withMultiSource
      );
      const volcada = await volcarFilaEn(dueno, fila, banderasDeFusion).catch(() => false);
      if (volcada) {
        devueltasASuFicha++;
        continue;
      }
      // Si el volcado falla NO se escribe una segunda ficha de la misma obra: se descarta, que
      // es lo que hacía el catálogo antes de que existiera la fusión.
      droppedDupes++;
      continue;
    }

    const k = key(item);
    if (!canonicalTitle(item.title)) continue;
    if (covered.has(k)) {
      droppedDupes++;
      continue;
    }
    const existing = byFallback.get(k);
    if (!existing) {
      byFallback.set(k, item);
      continue;
    }
    droppedDupes++;
    // Entre dos fallbacks del mismo título nos quedamos con el que trae más metadata.
    if (!existing.poster && item.poster) byFallback.set(k, item);
  }

  const all = [...byTmdb.values(), ...byFallback.values()];
  const withoutPoster = all.filter(it => !it.poster).length;
  console.log(
    `   Con metadata TMDB: ${byTmdb.size} | con metadata de la fuente: ${byFallback.size} | ` +
    `duplicados descartados: ${droppedDupes} | sin póster: ${withoutPoster} | ` +
    `páginas absorbidas de otra fuente: ${absorbidas}` +
    (noFundidasPorAno ? ` | no fundidas por el año: ${noFundidasPorAno}` : '') +
    (sinIdentidad ? ` | archive.org sin identidad en TMDB (fuera): ${sinIdentidad}` : '') +
    (devueltasASuFicha ? ` | devueltas a la ficha dueña de su página: ${devueltasASuFicha}` : '')
  );
  console.log(`   Cobertura de metadata: ${all.length}/${all.length} (100%) — ${(byTmdb.size / (all.length || 1) * 100).toFixed(1)}% desde TMDB`);

  const withNormalized = await hasColumn('title_normalized');
  if (!withNormalized) {
    console.warn('   ⚠ Columna title_normalized ausente — ejecuta src/db/migrations/001_search_prefix_index.sql para búsqueda por prefijo instantánea.');
  }
  const withMetadataSource = await hasColumn('metadata_source');
  if (!withMetadataSource) {
    console.warn('   ⚠ Columna metadata_source ausente — ejecuta src/db/migrations/003_metadata_source.sql para auditar el origen de la metadata.');
  }
  const withRichMetadata = await hasColumn('source_url');
  if (!withRichMetadata) {
    console.warn('   ⚠ Columnas source_url/runtime/director ausentes — ejecuta src/db/migrations/004_streams_and_rich_metadata.sql para fichas instantáneas.');
  }
  hayColumnaDeFuentes = await hasColumn('metadata_fuentes');
  if (!hayColumnaDeFuentes) {
    console.warn('   ⚠ Columna metadata_fuentes ausente — ejecuta src/db/migrations/012_metadata_fuentes.sql para saber qué campo vino prestado.');
  }
  const withMultiSource = await hasColumn('source_urls');
  if (!withMultiSource) {
    console.warn('   ⚠ Columnas source_urls/has_streams ausentes — ejecuta src/db/migrations/005_multisource_and_availability.sql para unificar fuentes y ocultar fichas sin enlaces.');
  }

  /**
   * ═════════════════════════════════════════════════════════════════════════════════════════
   * SOLO ENTRA LO QUE TIENE URL DIRECTA Y FUNCIONA.
   *
   * Antes el crawl guardaba la ficha y los enlaces venían después, en otras pasadas. Eso es lo
   * que llenaba el catálogo de títulos que se anunciaban y al abrirlos no reproducían: la ficha
   * existía desde el minuto uno y su vídeo no aparecía nunca.
   *
   * Ahora el scraper baja a la página de cada título, le saca la url del fichero, COMPRUEBA que
   * devuelve vídeo, y solo entonces se escribe la fila. Lo que no pasa, no entra en la base — no
   * se esconde con un filtro: no existe.
   *
   * Se exige que la url sea PERMANENTE (sin firma ni caducidad dentro). Las urls firmadas de
   * vidhideplus y compañía —`?e=129600`, `?expires=…`— no se pueden guardar: a las pocas horas
   * devuelven 403 aunque el fichero siga ahí, y son las que obligaban a acuñar y resellar cada
   * seis horas. Aquí la url que se guarda es la que el reproductor pide, hoy y dentro de un mes.
   *
   * El precio, dicho claro: el catálogo será mucho más pequeño. Es lo pedido — menos contenido,
   * pero que funcione seguro.
   * ═════════════════════════════════════════════════════════════════════════════════════════
   */
  /**
   * SE ESCRIBE POR EL CAMINO, no al final. Esto no es una optimización: es lo que decide si una
   * corrida sirve de algo.
   *
   * Medido el 2026-08-20 en la primera pasada `--solo=fuegocine`: recolectó 3.219 títulos, los
   * enrichó al 100 % con TMDB en 12 minutos, empezó a extraer urls… y a los 4 minutos GitHub
   * canceló el runner. Se perdió TODO — las tres horas de trabajo previstas y también los doce
   * minutos ya hechos—, porque la escritura estaba después del bucle entero.
   *
   * Los runners de este proyecto mueren solos con regularidad, así que la regla es la del resto
   * de pasadas largas: escribir lo aprendido antes de morir. Ahora cada tanda que demuestra
   * reproducir se guarda en cuanto se sabe, y una cancelación cuesta como mucho la tanda en
   * curso.
   */
  const banderas = { withNormalized, withMetadataSource, withRichMetadata, withMultiSource };
  const escritas = { ok: 0, fail: 0, merged: 0 };
  let guardadas = 0;
  /**
   * Cuánto tiempo puede gastar esta corrida en terminar series. Se mira entre series, no dentro.
   * `--sin-completar-series` lo apaga para una pasada que solo quiera abarcar mucho.
   */
  const completarMinutos = Number(
    (process.argv.find(a => a.startsWith('--completar-minutos=')) || '').split('=')[1]) || 45;
  const completarSeriesAlVuelo = !process.argv.includes('--sin-completar-series');
  const limiteCompletar = Date.now() + completarMinutos * 60_000;

  const guardarTanda = async (lote: MediaItem[]) => {
    if (!lote.length) return;
    const r = await guardarFilas(lote, banderas);
    escritas.ok += r.ok;
    escritas.fail += r.fail;
    escritas.merged += r.merged;
    guardadas += lote.length;
    console.log(`   💾 guardadas ${guardadas} (${escritas.ok} ok · ${escritas.merged} fusionadas · ${escritas.fail} fallidas)`);
    // Y antes de seguir con más títulos, las series de esta tanda se terminan. Ver la función.
    if (completarSeriesAlVuelo) await completarSeriesDeLaTanda(lote, limiteCompletar);
  };

  const sinVideo: string[] = [];
  const conDirecto = await quedarseConLoQueReproduce(all, guardarTanda, sinVideo);
  console.log(`   ${conDirecto.length}/${all.length} títulos tienen url directa permanente y funcional`);
  await anotarDescartes(sinVideo);
  all.length = 0;
  all.push(...conDirecto);

  console.log(
    `✅ Refresh completado: ${escritas.ok} filas guardadas` +
    (escritas.merged > 0 ? `, ${escritas.merged} fusionadas con la ficha existente` : '') +
    `, ${escritas.fail} fallidas`
  );

  if (streamsLimit > 0) {
    if (!withRichMetadata) {
      console.warn('   ⚠ Sin la migración 004 los enlaces no se pueden persistir: se omite el pre-calentado.');
    } else {
      // El orden de `all` es el mismo que alimenta el home (frescura), así que los
      // primeros N son justo los que más se van a abrir.
      await prewarmStreams(all, streamsLimit);
    }
  }

  if (verifyLimit > 0) {
    if (!withMultiSource) {
      console.warn('   ⚠ Sin la migración 005 no hay dónde anotar el veredicto: se omite la comprobación.');
    } else {
      await verifyAvailability(verifyLimit);
    }
  }

  if (directLimit > 0) {
    await fillDirectStreams(directLimit);
  }

  /*
   * Y AL FINAL, DEJAR EL INDICE DE CADA PELICULA EN LA CACHE.
   *
   * Es lo que convierte «arreglar peliculas» en «arreglar el problema». Todo lo demas hace la
   * reproduccion mas rapida, pero alguien sigue pagando el arranque en frio: el PRIMERO que abre
   * cada pelicula. Y con archive.org ese primero muchas veces no llega — esta medido que 6 de 21
   * fichas fallaban porque traer el indice tardaba mas de los 25 s que el reproductor aguanta.
   *
   * Ese trabajo no tiene por que hacerlo un espectador, y aqui no hay ninguna prisa: este barrido
   * ya recorre el catalogo entero y corre sin nadie mirando una pantalla. Es idempotente, asi que
   * lo que ya este en la cache no se vuelve a pedir.
   *
   * Solo si hay Worker: sin el, `cacheUrlFor` devuelve null, no hay ninguna cache que calentar y
   * esto seria una vuelta al catalogo para no hacer nada.
   */
  if (externalProxyEnabled()) {
    await calentarIndices().catch(e =>
      console.warn('   ⚠ No se pudo calentar el índice:', e?.message || e)
    );
  } else {
    console.log('   ℹ Sin Worker configurado: no hay caché que calentar.');
  }
}

/**
 * Cierre del proceso. Supabase deja sockets HTTP cerrándose; llamar a process.exit() en el
 * mismo turno del bucle de eventos aborta libuv en Windows ("UV_HANDLE_CLOSING") y convierte
 * una ejecución correcta en un fallo — se nota en cuanto un modo termina rápido, como
 * --verify-only sin fichas pendientes. El timer sin ref no retiene el proceso: si el bucle
 * se vacía antes, sale solo con este código; si algo lo mantiene vivo, fuerza la salida.
 */
function exitWhenSettled(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 250).unref();
}

main()
  .then(() => exitWhenSettled(0))
  .catch(err => {
    console.error('❌ refreshCatalog:', err);
    exitWhenSettled(1);
  });
