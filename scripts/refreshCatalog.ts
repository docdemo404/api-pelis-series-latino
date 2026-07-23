/**
 * Job de pre-scrape del catálogo → Supabase (Fase 4.1 del plan de rendimiento).
 *
 * Corre en background (GitHub Actions, o manual):
 *   npm run refresh:catalog                    # crawl COMPLETO del catálogo (miles de títulos)
 *   npm run refresh:catalog -- 20              # limitado (pruebas)
 *   npm run refresh:catalog -- --streams=300   # además pre-resuelve enlaces del home
 *
 * Con la DB poblada, la API sirve listados (getAll DB-first) y el pase de prefijo
 * de búsqueda desde Postgres en milisegundos, sin scraping dentro del request.
 * Con --streams, además, las fichas del home abren con los enlaces ya listos.
 */
import 'dotenv/config';
import { RealScraperService } from '../src/services/realScraperService';
import { CatalogService } from '../src/services/catalogService';
import { TmdbService } from '../src/services/tmdbService';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { canonicalTitle, searchIndexKey } from '../src/utils/text';
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
 */
async function mergeIntoExisting(row: Record<string, unknown>): Promise<boolean> {
  const tmdbId = row.tmdb_id as number;
  if (!tmdbId) return false;

  const { data } = await db
    .from('media_items')
    .select('id,poster,backdrop,logo,overview,runtime,director,source_url,trailer')
    .eq('tmdb_id', tmdbId)
    .limit(1);

  const existing = data && data[0];
  if (!existing) return false;

  const patch: Record<string, unknown> = {};
  const fillIfEmpty = (field: string) => {
    const current = (existing as any)[field];
    const incoming = row[field];
    const isEmpty = current === null || current === undefined || current === '';
    if (isEmpty && incoming) patch[field] = incoming;
  };

  ['poster', 'backdrop', 'logo', 'overview', 'runtime', 'director', 'source_url', 'trailer'].forEach(fillIfEmpty);
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
 * `--streams` / `--streams=N`: cuántos títulos del home llevan sus enlaces pre-resueltos.
 * Sin el flag no se pre-calienta nada (crawl igual de rápido que antes).
 */
function parseStreamsFlag(argv: string[]): number {
  const flag = argv.find(a => a === '--streams' || a.startsWith('--streams='));
  if (!flag) return 0;
  const value = flag.includes('=') ? parseInt(flag.split('=')[1], 10) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 300;
}

async function main() {
  const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const limitArg = parseInt(positional[0] || '', 10);
  const streamsLimit = parseStreamsFlag(process.argv);

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
        const merged = await mergeIntoExisting(row);
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
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ refreshCatalog:', err);
    process.exit(1);
  });
