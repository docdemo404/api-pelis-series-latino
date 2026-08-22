import { RealScraperService } from '../../src/services/realScraperService';
(async () => {
  for (const q of ['matrix', 'breaking bad', 'el conjuro', 'dan da dan']) {
    const t0 = Date.now();
    const r = await RealScraperService.scrapeMoviedaysSearch(q);
    console.log(`${q} -> ${r.length} fichas en ${((Date.now() - t0) / 1000).toFixed(1)}s : ` +
      r.map(x => `${x.title} [${x.tmdb_id}/${x.type}]`).join(' | '));
  }
  process.exit(0);
})();
