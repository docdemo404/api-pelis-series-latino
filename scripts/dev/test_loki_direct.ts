import { RealScraperService } from './src/services/realScraperService';

async function testLokiDirect() {
  console.log('Testing direct scrape of Loki S1:E1...');
  const res = await RealScraperService.scrapeDetail('https://tioplus.app/serie/loki/season/1/episode/1');
  console.log('Full res Loki S1:E1:', res);
}

testLokiDirect();
