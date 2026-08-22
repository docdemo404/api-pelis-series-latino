import 'dotenv/config';
import { RealScraperService } from '../../src/services/realScraperService';
(async () => {
  const t0 = Date.now();
  const pelis = await RealScraperService.scrapeArchiveLatest('movie', 10).catch(e => { console.log('ERR movie', e.message); return []; });
  console.log(`\nPELÍCULAS: ${pelis.length} en ${(Date.now()-t0)/1000}s`);
  for (const p of pelis.slice(0, 10)) console.log(`   ${p.release_date}  ${p.id}  «${p.title}»`);
  const t1 = Date.now();
  const series = await RealScraperService.scrapeArchiveLatest('tvseries', 10).catch(e => { console.log('ERR series', e.message); return []; });
  console.log(`\nSERIES: ${series.length} en ${(Date.now()-t1)/1000}s`);
  for (const p of series.slice(0, 10)) console.log(`   ${p.release_date}  ${p.id}  «${p.title}»`);
})();
