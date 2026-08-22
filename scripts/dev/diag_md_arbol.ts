import { RealScraperService } from '../../src/services/realScraperService';
import { moviedaysSourceUrl, pedirTemporadasMoviedays } from '../../src/scrapers/moviedays';
(async () => {
  const crudas = await pedirTemporadasMoviedays(82856);
  console.log('seasons.php ->', crudas ? `${crudas.length} temporadas` : 'NULL');
  if (crudas) crudas.forEach((t: any) => console.log('   T' + t.seasonNumber, t.episodes?.length, 'caps'));
  const it = await RealScraperService.scrapeMoviedaysDetail(moviedaysSourceUrl(82856, 'tvseries'));
  const ss = it?.seasons || [];
  console.log('detalle ->', ss.length, 'temporadas,', ss.reduce((n, t) => n + (t.episodes || []).length, 0), 'caps');
  process.exit(0);
})();
