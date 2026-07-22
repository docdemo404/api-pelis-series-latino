const { RealScraperService } = require('./dist/services/realScraperService');

async function testLokiDirect() {
  console.log('Testing direct scrape of Loki S1:E1...');
  const res = await RealScraperService.scrapeDetail('https://tioplus.app/serie/loki/season/1/episode/1');
  console.log('Scrape result Loki S1:E1:', {
    title: res?.title,
    serversCount: res?.servers?.length,
    servers: res?.servers
  });
}

testLokiDirect();
