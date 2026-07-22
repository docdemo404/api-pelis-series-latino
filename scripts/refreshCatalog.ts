/**
 * Job de pre-scrape del catálogo → Supabase (Fase 4.1 del plan de rendimiento).
 *
 * Corre en background (GitHub Actions cada 6 h, o manual):
 *   npm run refresh:catalog          # completo (~180 títulos)
 *   npm run refresh:catalog -- 20    # limitado (pruebas)
 *
 * Con la DB poblada, la API sirve listados (getAll DB-first) y el pase de prefijo
 * de búsqueda desde Postgres en milisegundos, sin scraping dentro del request.
 */
import { RealScraperService } from '../src/services/realScraperService';
import { TmdbService } from '../src/services/tmdbService';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { normalizeTitle } from '../src/utils/text';
import { MediaItem } from '../src/types';

// Con RLS activado en media_items, escribir requiere la SUPABASE_SERVICE_ROLE_KEY
// (secret del workflow / variable de entorno). Sin ella el upsert fallará con RLS.
const db = getSupabaseAdmin();

async function collectCatalog(): Promise<MediaItem[]> {
  const [home, movies, series, animes] = await Promise.all([
    RealScraperService.scrapeHomepage(),
    RealScraperService.scrapeLatest('peliculas', 60),
    RealScraperService.scrapeLatest('series', 60),
    RealScraperService.scrapeLatest('animes', 60)
  ]);
  const seen = new Set<string>();
  return [...home, ...movies, ...series, ...animes].filter(it => {
    if (!it.id || seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  });
}

/** Comprueba si la columna title_normalized ya existe (migración 001 aplicada). */
async function hasNormalizedColumn(): Promise<boolean> {
  const { error } = await db.from('media_items').select('title_normalized').limit(1);
  return !error;
}

function toRow(item: MediaItem, withNormalized: boolean) {
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
    cast_data: item.cast || [],
    dubbing_cast_data: item.dubbing_cast || [],
    total_seasons: item.total_seasons || 0,
    total_episodes: item.total_episodes || 0,
    updated_at: new Date().toISOString()
  };
  if (withNormalized) {
    row.title_normalized = normalizeTitle(item.title).trim();
  }
  return row;
}

async function main() {
  const limitArg = parseInt(process.argv[2] || '', 10);

  console.log('🔎 Recolectando catálogo desde las fuentes...');
  let items = await collectCatalog();
  if (Number.isFinite(limitArg) && limitArg > 0) {
    items = items.slice(0, limitArg);
  }
  console.log(`   ${items.length} títulos recolectados`);

  // La tabla exige tmdb_id UNIQUE NOT NULL: resolver IDs reales y deduplicar por tmdb_id.
  let skipped = 0;
  const byTmdb = new Map<number, MediaItem>();
  for (const item of items) {
    let tmdbId = item.tmdb_id || 0;
    if (!tmdbId) {
      try {
        tmdbId = (await TmdbService.getTmdbId(item.title, item.type)) || 0;
      } catch {
        tmdbId = 0;
      }
    }
    if (!tmdbId) {
      skipped++;
      continue;
    }
    item.tmdb_id = tmdbId;
    if (!byTmdb.has(tmdbId)) byTmdb.set(tmdbId, item);
  }
  console.log(`   TMDB resueltos: ${byTmdb.size} | sin TMDB (omitidos): ${skipped}`);

  const withNormalized = await hasNormalizedColumn();
  if (!withNormalized) {
    console.warn('   ⚠ Columna title_normalized ausente — ejecuta src/db/migrations/001_search_prefix_index.sql para búsqueda por prefijo instantánea.');
  }

  const rows = Array.from(byTmdb.values()).map(it => toRow(it, withNormalized));
  let ok = 0;
  let fail = 0;
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
      if (rowError) {
        fail++;
        console.warn(`   ⚠ ${row.id}: ${rowError.message}`);
      } else {
        ok++;
      }
    }
  }

  console.log(`✅ Refresh completado: ${ok} filas guardadas, ${fail} fallidas`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ refreshCatalog:', err);
    process.exit(1);
  });
