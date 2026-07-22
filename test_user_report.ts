import { CatalogService } from './src/services/catalogService';

async function testUserReportedIssues() {
  console.log('--- 1. Testing Search Deduplication for "Zootopia" ---');
  const zootopiaResults = await CatalogService.search('Zootopia');
  console.log(`Found ${zootopiaResults.length} Zootopia results:`);
  zootopiaResults.forEach(r => console.log(`- ID: ${r.id} | TMDB: ${r.tmdb_id} | Title: "${r.title}" | Servers: ${r.servers?.length || 0}`));

  console.log('\n--- 2. Testing Search Deduplication for "Mi villano favorito" ---');
  const gruResults = await CatalogService.search('Mi villano favorito');
  console.log(`Found ${gruResults.length} Gru results:`);
  gruResults.forEach(r => console.log(`- ID: ${r.id} | TMDB: ${r.tmdb_id} | Title: "${r.title}" | Servers: ${r.servers?.length || 0}`));

  console.log('\n--- 3. Testing TV Series Episodes Servers for Loki (84958), El Inmortal (197929), Goblin (67915) ---');
  const seriesIds = ['84958', '197929', '67915'];
  for (const sId of seriesIds) {
    const sItem = await CatalogService.getById(sId);
    const ep1 = sItem?.seasons?.[0]?.episodes?.[0];
    console.log(`Series ${sId} ("${sItem?.title}"): Season 1 Ep 1 Servers Count = ${ep1?.servers?.length || 0}`);
  }
}

testUserReportedIssues();
