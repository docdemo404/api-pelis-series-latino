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
import { CatalogService } from '../src/services/catalogService';
import { TmdbService } from '../src/services/tmdbService';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { canonicalTitle, searchIndexKey, yearFromSlug } from '../src/utils/text';
import { mereceRepasoDeExtraccion, hasVolatileToken, canonicalArchiveOrg } from '../src/scrapers/directStream';
import { streamClient } from '../src/utils/httpClient';
import { CacheStore } from '../src/cache/store';
import { MediaItem } from '../src/types';

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

  const columns =
    'id,title,original_title,aliases,release_date,poster,backdrop,logo,overview,runtime,director,source_url,trailer' +
    (opts.withMultiSource ? ',source_urls' : '');

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
      ` comparten tmdb ${tmdbId} pero no son de la misma época`
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

  if (Object.keys(patch).length === 0) return true; // nada que aportar: no es un fallo

  const { error } = await db.from('media_items').update(patch).eq('id', existing.id);
  return !error;
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
    type: signals.type || item.type
  };
}

/** `--verify` / `--verify=N`: cuántas fichas sin comprobar se verifican al final del crawl. */
function parseVerifyFlag(argv: string[]): number {
  const flag = argv.find(a => a === '--verify' || a.startsWith('--verify='));
  if (!flag) return 0;
  const value = flag.includes('=') ? parseInt(flag.split('=')[1], 10) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 500;
}


/** Hosts cuya url ES el fichero de vídeo: se piden y devuelven bytes, sin firma que caduque. */
const FICHERO_PERMANENTE = [
  /pixeldrain\.com\/api\/file\//i,
  /archive\.org\/download\//i,
  /1a-\d+\.com\/video\//i,
  /cdn\.rumble\.cloud\/video\//i,
  /remux\.unlimplay\.com\/remux/i,
  /\.(mp4|mkv|webm)(\?|$)/i,
];

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
async function entregaVideo(url: string): Promise<{ ok: boolean; kbs: number }> {
  const t0 = Date.now();
  try {
    const r = await streamClient.get(url, {
      headers: { Range: 'bytes=0-65535' },
      responseType: 'arraybuffer',
      timeout: 25000,
      validateStatus: () => true,
      maxRedirects: 5,
    });
    if (r.status >= 400) return { ok: false, kbs: 0 };
    if (/text\/html/i.test(String(r.headers['content-type'] || ''))) return { ok: false, kbs: 0 };
    const kb = ((r.data as ArrayBuffer)?.byteLength ?? 0) / 1024;
    if (kb <= 8) return { ok: false, kbs: 0 };
    return { ok: true, kbs: kb / Math.max((Date.now() - t0) / 1000, 0.001) };
  } catch {
    return { ok: false, kbs: 0 };
  }
}

/**
 * TODAS las urls permanentes y funcionales de una lista de servidores, ordenadas de mejor a peor.
 *
 * No se queda con la primera que funcione: una película o un capítulo puede tener varios enlaces
 * buenos, y el cliente los quiere TODOS — el mejor para reproducir y los demás como respaldo, que
 * es lo único que le permite recuperarse solo si uno se cae a mitad.
 */
async function urlsBuenasDe(servidores: any[], fuente: string): Promise<any[]> {
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
    if (!embed) continue;
    // Un mismo servidor puede ofrecer la url por el envoltorio y a pelo: se miran las dos.
    for (const crudo of [urlDentroDelEnvoltorio(embed), embed]) {
      if (!crudo) continue;
      // El enlace de NODO de archive.org (`dn711505.ca.archive.org/0/items/…`) no es permanente y
      // encima le da 500 a este mismo cliente. Se guarda su forma canónica. Ver `canonicalArchiveOrg`.
      const cand = canonicalArchiveOrg(crudo);
      if (!FICHERO_PERMANENTE.some(re => re.test(cand))) continue;
      if (hasVolatileToken(cand)) continue;
      if (vistos.has(cand)) continue;
      vistos.add(cand);
      candidatos.push({ sv, url: cand });
    }
  }
  if (!candidatos.length) return [];

  const medidos = await Promise.all(
    candidatos.map(async c => ({ ...c, medida: await entregaVideo(c.url) }))
  );

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
    }));
}

/**
 * Escribe estas fichas en la base. Es la MISMA escritura de siempre, sacada a una función para
 * poder llamarla por tandas mientras el crawl avanza en vez de solo al terminar (ver
 * `guardarTanda`). No cambia nada de lo que hacía: lote de 50, y si el lote falla se reintenta
 * fila a fila para aislar el conflicto de `tmdb_id` que sí sabe resolverse fusionando.
 */
async function guardarFilas(
  items: MediaItem[],
  banderas: { withNormalized: boolean; withMetadataSource: boolean; withRichMetadata: boolean; withMultiSource: boolean }
): Promise<{ ok: number; fail: number; merged: number }> {
  const { withNormalized, withMetadataSource, withRichMetadata, withMultiSource } = banderas;
  const rows = items.map(it => toRow(it, withNormalized, withMetadataSource, withRichMetadata, withMultiSource));
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

/** De qué web viene la ficha. Se guarda para poder verlo en el panel. */
function fuenteDeLaUrl(url: string): string {
  if (/cinecalidad/i.test(url)) return 'cinecalidad';
  if (/fuegocine|blogfc|repfuegocinefree/i.test(url)) return 'fuegocine';
  return 'tioplus';
}

/**
 * Baja a la página de cada título, saca las urls de fichero, comprueba que entregan vídeo y
 * devuelve SOLO los títulos que se pueden reproducir, ya con sus servidores puestos.
 */
async function quedarseConLoQueReproduce(
  items: MediaItem[],
  /**
   * Se llama con cada tanda que ha DEMOSTRADO reproducir, en cuanto se sabe.
   *
   * Sin esto el trabajo entero se escribía al final y una cancelación del runner —que en este
   * proyecto pasa a menudo— lo tiraba todo. Ver `guardarTanda`.
   */
  alEncontrar?: (lote: MediaItem[]) => Promise<void>
): Promise<MediaItem[]> {
  console.log(`🎬 Extrayendo la url directa de ${items.length} títulos (solo entra lo que reproduzca)...`);
  const buenos: MediaItem[] = [];
  /** Cuántos de `buenos` ya se han entregado a `alEncontrar`. */
  let entregados = 0;
  const CONC = 8;
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
      if (!pagina) return;
      const detalle = await RealScraperService.scrapeDetail(pagina).catch(() => null);
      if (!detalle?.servers?.length) return;

      const fuente = fuenteDeLaUrl(pagina);
      const servidores = await urlsBuenasDe(detalle.servers as any[], fuente);

      /**
       * Y LOS CAPÍTULOS, que es donde vive el vídeo de una serie. Una serie no se reproduce por
       * la ficha: se reproduce por capítulo, así que mirar solo `servers` la dejaría fuera entera
       * aunque tuviera veinte capítulos buenos.
       */
      const temporadas: any[] = [];
      for (const t of ((detalle as any).seasons || [])) {
        const capitulos: any[] = [];
        for (const e of (t?.episodes || [])) {
          const suyos = await urlsBuenasDe(e?.servers || [], fuente);
          if (suyos.length) capitulos.push({ ...e, servers: suyos });
        }
        if (capitulos.length) temporadas.push({ ...t, episodes: capitulos });
      }

      // Una película necesita url propia; una serie, al menos un capítulo con url.
      const hayCapitulos = temporadas.some(t => (t.episodes || []).length > 0);
      if (!servidores.length && !hayCapitulos) return;

      item.servers = servidores;
      if (temporadas.length) (item as any).seasons = temporadas;
      item.has_streams = true;
      buenos.push(item);
    }));
    /**
     * Guardar lo encontrado, cada 40 títulos con vídeo o cuando quedan pocos por mirar.
     *
     * El umbral no es redondo por gusto: escribir de uno en uno multiplica las peticiones a
     * Supabase por nada, y esperar a tener cientos vuelve a dejar mucho trabajo en el aire si el
     * runner se cae. Cuarenta es menos de un minuto de extracción.
     */
    if (alEncontrar && buenos.length - entregados >= 40) {
      const lote = buenos.slice(entregados);
      entregados = buenos.length;
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
        return await TmdbService.enrichMediaItem(await withSourceSignals(item, () => withSignals++), { skipSeasons: true });
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
       * evaporadas con sus páginas dentro. Se ve en la cobertura: de Cinecalidad solo constaba el
       * 62-69 %, y lo que faltaba era justo lo que TioPlus ya traía.
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
  for (const item of fallbacks) {
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
    (noFundidasPorAno ? ` | no fundidas por el año: ${noFundidasPorAno}` : '')
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
  const guardarTanda = async (lote: MediaItem[]) => {
    if (!lote.length) return;
    const r = await guardarFilas(lote, banderas);
    escritas.ok += r.ok;
    escritas.fail += r.fail;
    escritas.merged += r.merged;
    guardadas += lote.length;
    console.log(`   💾 guardadas ${guardadas} (${escritas.ok} ok · ${escritas.merged} fusionadas · ${escritas.fail} fallidas)`);
  };

  const conDirecto = await quedarseConLoQueReproduce(all, guardarTanda);
  console.log(`   ${conDirecto.length}/${all.length} títulos tienen url directa permanente y funcional`);
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
