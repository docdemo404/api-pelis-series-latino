/** Simula lo que hará el crawl con la puerta nueva: ¿cuántas fichas pierden la metadata de TMDB? */
import 'dotenv/config';
import { RealScraperService } from '../../src/services/realScraperService';
import { TmdbService } from '../../src/services/tmdbService';
import { MediaItem } from '../../src/types';

async function withSourceSignals(item: MediaItem): Promise<MediaItem> {
  const url: string = (item as any)._tioplus_url || (item as any)._source_url || '';
  if (!url) return item;
  const s = await RealScraperService.fetchSourceSignals(url).catch(() => null);
  if (!s) return item;
  return {
    ...item,
    release_date: s.year || item.release_date,
    original_title: s.originalTitle || item.original_title,
    poster: s.imageHint || item.poster
  };
}

(async () => {
  const N = parseInt(process.argv[2] || '30', 10);
  const items = (await RealScraperService.scrapeLatest('peliculas', N * 2)).slice(0, N);
  console.log(`Simulando el crawl con ${items.length} títulos recién listados...\n`);

  let tmdb = 0, source = 0;
  const perdidas: string[] = [];
  const CONC = 5;
  for (let i = 0; i < items.length; i += CONC) {
    const out = await Promise.all(items.slice(i, i + CONC).map(async it => {
      const conSenales = await withSourceSignals(it);
      return TmdbService.enrichMediaItem(conSenales, { skipSeasons: true }).catch(() => null);
    }));
    for (const e of out) {
      if (!e) continue;
      if (e.metadata_source === 'source' || e.tmdb_id < 0) {
        source++;
        perdidas.push(`"${e.title}" (${e.release_date || '?'}) tmdb=${e.tmdb_id}`);
      } else tmdb++;
    }
  }

  console.log(`   con ficha de TMDB (respaldada): ${tmdb}`);
  console.log(`   con metadata de la fuente:      ${source}`);
  if (perdidas.length) {
    console.log('\n   Se quedan con lo de la fuente:');
    for (const p of perdidas) console.log(`      · ${p}`);
  }
})();
