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
import { canonicalTitle, searchIndexKey } from '../src/utils/text';
import { canExtractWithoutFetch } from '../src/scrapers/directStream';
import { MediaItem } from '../src/types';

// Con RLS activado en media_items, escribir requiere la SUPABASE_SERVICE_ROLE_KEY
// (secret del workflow / variable de entorno). Sin ella el upsert fallará con RLS.
const db = getSupabaseAdmin();

async function collectCatalog(): Promise<MediaItem[]> {
  // Crawl COMPLETO (todas las categorías de tioplus paginadas hasta agotar + todo FuegoCine),
  // no solo home/últimos. Es lo que da recuperación total y scroll infinito en la búsqueda.
  return RealScraperService.crawlFullCatalog();
}

/** Comprueba si una columna opcional ya existe (migración aplicada). */
async function hasColumn(column: string): Promise<boolean> {
  const { error } = await db.from('media_items').select(column).limit(1);
  return !error;
}

function toRow(item: MediaItem, withNormalized: boolean, withMetadataSource: boolean, withRichMetadata: boolean) {
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
 */
async function mergeIntoExisting(
  row: Record<string, unknown>,
  opts: { withNormalized: boolean; withMultiSource: boolean }
): Promise<boolean> {
  const tmdbId = row.tmdb_id as number;
  if (!tmdbId) return false;

  const columns =
    'id,title,original_title,aliases,poster,backdrop,logo,overview,runtime,director,source_url,trailer' +
    (opts.withMultiSource ? ',source_urls' : '');

  const { data } = await db.from('media_items').select(columns).eq('tmdb_id', tmdbId).limit(1);

  const existing: any = data && data[0];
  if (!existing) return false;

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
async function verifyAvailability(max: number): Promise<void> {
  const { data, error } = await db
    .from('media_items')
    .select('id,type,title')
    .is('has_streams', null)
    .order('updated_at', { ascending: false })
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
  const { data, error } = await db
    .from('media_items')
    .select('id,type,title,servers')
    .not('servers', 'is', null)
    .neq('servers', '[]')
    .order('streams_updated_at', { ascending: true, nullsFirst: false })
    .limit(max);

  if (error) {
    console.warn(`   ⚠ No se pueden leer las fichas: ${error.message}`);
    return;
  }

  // Interesan las que no tienen NINGÚN vídeo directo, y también aquellas donde un servidor
  // que HOY sabemos resolver se quedó sin él: pasa cada vez que se añade un extractor nuevo,
  // y también con upns, que responde 429 si se le insiste y deja el servidor sin resolver.
  const pending = (data || []).filter(row => {
    if (!Array.isArray(row.servers) || row.servers.length === 0) return false;
    const servers = row.servers as any[];
    if (!servers.some(s => s?.direct_stream)) return true;
    return servers.some(s => s?.embed_url && !s.direct_stream && canExtractWithoutFetch(s.embed_url));
  });

  if (pending.length === 0) {
    console.log('✔ Todas las fichas revisadas ya tienen su vídeo directo resuelto.');
    return;
  }

  console.log(`🎬 Extrayendo vídeo directo de ${pending.length} fichas (de ${data?.length || 0} revisadas)...`);
  const CONCURRENCY = 6;
  let conDirecto = 0;
  let servidoresDirectos = 0;

  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const chunk = pending.slice(i, i + CONCURRENCY);
    const resolved = await Promise.all(
      chunk.map(r => CatalogService.getStreams(r.id, r.type, { deep: true }).catch(() => null))
    );
    for (const item of resolved) {
      const directos = (item?.servers || []).filter(s => s.direct_stream).length;
      if (directos > 0) conDirecto++;
      servidoresDirectos += directos;
    }
    console.log(`   ${Math.min(i + CONCURRENCY, pending.length)}/${pending.length}…`);
  }

  console.log(`   ${conDirecto}/${pending.length} fichas con vídeo directo · ${servidoresDirectos} servidores directos en total`);
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

/** `--verify` / `--verify=N`: cuántas fichas sin comprobar se verifican al final del crawl. */
function parseVerifyFlag(argv: string[]): number {
  const flag = argv.find(a => a === '--verify' || a.startsWith('--verify='));
  if (!flag) return 0;
  const value = flag.includes('=') ? parseInt(flag.split('=')[1], 10) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 500;
}

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

  console.log('🔎 Recolectando catálogo desde las fuentes...');
  let items = await collectCatalog();
  if (Number.isFinite(limitArg) && limitArg > 0) {
    items = items.slice(0, limitArg);
  }
  console.log(`   ${items.length} títulos recolectados`);

  // Enriquecer con TMDB (géneros, rating, sinopsis, póster/backdrop, tráiler, cast con fotos)
  // y resolver el tmdb_id real, con concurrencia ACOTADA. skipSeasons: no bajamos temporadas
  // (no se guardan en el catálogo y triplicarían las llamadas).
  //
  // COBERTURA 100%: los títulos SIN match fiable en TMDB ya no se descartan; se guardan con la
  // metadata del sitio de origen (póster + sinopsis del scraping) y un tmdb_id sintético
  // NEGATIVO, que nunca colisiona con un id real. Como ese fallback sí puede repetir un título
  // ya presente, se deduplica por título canónico + tipo y cede siempre ante la ficha de TMDB.
  const CONCURRENCY = 10;
  const byTmdb = new Map<number, MediaItem>();
  const fallbacks: MediaItem[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const chunk = items.slice(i, i + CONCURRENCY);
    const enriched = await Promise.all(chunk.map(async (item) => {
      try {
        return await TmdbService.enrichMediaItem(item, { skipSeasons: true });
      } catch {
        return TmdbService.fromSourceMetadata(item);
      }
    }));
    for (const item of enriched) {
      if (item.metadata_source === 'source' || !item.tmdb_id || item.tmdb_id < 0) {
        fallbacks.push(item);
        continue;
      }
      if (!byTmdb.has(item.tmdb_id)) byTmdb.set(item.tmdb_id, item);
    }
    if (i > 0 && i % 500 === 0) console.log(`   ...enriquecidos ${i}/${items.length}`);
  }

  // Índice de títulos ya cubiertos por TMDB, para no duplicarlos con una ficha de fallback.
  const key = (it: MediaItem) => `${it.type}:${canonicalTitle(it.title)}`;
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
    `duplicados descartados: ${droppedDupes} | sin póster: ${withoutPoster}`
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

  const rows = all.map(it => toRow(it, withNormalized, withMetadataSource, withRichMetadata));
  let ok = 0;
  let fail = 0;
  let mergedCount = 0;
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
      if (!rowError) {
        ok++;
        continue;
      }

      if (isTmdbIdConflict(rowError.message)) {
        const merged = await mergeIntoExisting(row, { withNormalized, withMultiSource });
        if (merged) {
          mergedCount++;
          continue;
        }
      }

      fail++;
      console.warn(`   ⚠ ${row.id}: ${rowError.message}`);
    }
  }

  console.log(
    `✅ Refresh completado: ${ok} filas guardadas` +
    (mergedCount > 0 ? `, ${mergedCount} fusionadas con la ficha existente` : '') +
    `, ${fail} fallidas`
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
