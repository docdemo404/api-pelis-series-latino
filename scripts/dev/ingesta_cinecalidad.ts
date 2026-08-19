/**
 * INGESTA DIRECTA DE CINECALIDAD, para no esperar a que el crawl dé su vuelta (3 h).
 *
 * Usa la MISMA puerta de identidad que el crawl (`enrichMediaItem`), así que una ficha que no pueda
 * demostrar qué obra es se queda con la metadata de su fuente y un id sintético — nunca con la de
 * otra. Y cuando la obra ya está en el catálogo, NO crea una segunda ficha: le añade esta página
 * como fuente, que es lo que hace que la ficha existente gane sus servidores.
 *
 *   npx tsx scripts/dev/ingesta_cinecalidad.ts --limit=40           # solo mide
 *   npx tsx scripts/dev/ingesta_cinecalidad.ts --limit=40 --apply   # y escribe
 */
import 'dotenv/config';
import { RealScraperService } from '../../src/services/realScraperService';
import { TmdbService } from '../../src/services/tmdbService';
import { getSupabaseAdmin } from '../../src/services/supabaseService';

const APLICAR = process.argv.includes('--apply');
const N = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 20;

(async () => {
  const db = getSupabaseAdmin();
  const crudas = [
    ...await RealScraperService.scrapeCinecalidadLatest('movie', N).catch(() => []),
    ...await RealScraperService.scrapeCinecalidadLatest('tvseries', N).catch(() => []),
  ];
  console.log(`  ${crudas.length} fichas descubiertas${APLICAR ? '' : ' (dry-run)'}\n`);

  let nuevas = 0, fusionadas = 0, conTmdb = 0, sinRespaldo = 0, fallos = 0;
  for (const cruda of crudas) {
    const url = (cruda as any)._source_url as string;
    const det = await RealScraperService.scrapeDetail(url).catch(() => null);
    const base: any = det || cruda;
    const item = await TmdbService
      .enrichMediaItem({ ...base, id: cruda.id, _source_url: url }, { skipSeasons: true })
      .catch(() => null);
    if (!item) { fallos++; continue; }
    item.tmdb_id > 0 ? conTmdb++ : sinRespaldo++;
    if (!APLICAR) continue;

    const row: Record<string, unknown> = {
      id: item.id, tmdb_id: item.tmdb_id, imdb_id: null, type: item.type,
      title: item.title, original_title: item.original_title || item.title,
      aliases: item.aliases || [], overview: item.overview || '', rating: item.rating || 0,
      release_date: item.release_date || '', genres: item.genres || [],
      subcategories: item.subcategories || [], poster: item.poster, backdrop: item.backdrop,
      logo: item.logo || null, trailer: item.trailer || null, runtime: item.runtime || null,
      total_seasons: item.total_seasons || 0, total_episodes: item.total_episodes || 0,
      servers: base.servers || [], seasons: base.seasons || [],
      source_url: url, source_urls: [url],
      metadata_source: item.metadata_source || 'source',
      updated_at: new Date().toISOString(),
    };

    const { error } = await db.from('media_items').upsert(row, { onConflict: 'id' });
    if (!error) { nuevas++; continue; }
    if (!/duplicate key/i.test(error.message)) { fallos++; continue; }

    // La obra ya está en el catálogo: se le añade esta página como fuente, no se duplica la ficha.
    const { data: ya } = await db.from('media_items')
      .select('id,source_urls').eq('tmdb_id', item.tmdb_id).eq('type', item.type).single();
    if (!ya) { fallos++; continue; }
    const urls = Array.from(new Set([...(((ya as any).source_urls) || []), url]));
    const { error: e2 } = await db.from('media_items').update({ source_urls: urls }).eq('id', (ya as any).id);
    if (e2) { fallos++; continue; }
    fusionadas++;
    console.log(`   + "${item.title}" ya existía — Cinecalidad se le añade como fuente`);
  }

  console.log(`\n  emparejadas con TMDB: ${conTmdb} · sin respaldo: ${sinRespaldo} · fallos: ${fallos}`);
  console.log(`  ${APLICAR ? `fichas nuevas: ${nuevas} · fusionadas: ${fusionadas}` : '(dry-run: repite con --apply)'}`);
})();
