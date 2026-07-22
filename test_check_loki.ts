import { RealScraperService } from './src/services/realScraperService';

async function checkLokiEp() {
  const ep = await RealScraperService.scrapeEpisodeDetail('loki', 1, 1);
  console.log('Loki S1:E1 result:', ep);

  const detail = await RealScraperService.scrapeDetail('https://tioplus.app/serie/loki');
  console.log('Loki detail result:', { title: detail?.title, seasons: detail?.seasons?.length, servers: detail?.servers?.length });
}

checkLokiEp();
