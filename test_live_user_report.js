const axios = require('axios');

async function testLiveDeduplicationAndTV() {
  console.log('--- 1. Testing Live Deduplication for "Zootopia" ---');
  const zooRes = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/search?q=Zootopia&v=freshzoo');
  console.log('Live Zootopia count:', zooRes.data.data?.length);
  zooRes.data.data?.forEach(r => console.log(`- ID: ${r.id} | TMDB: ${r.tmdb_id} | Title: "${r.title}" | Servers: ${r.servers?.length || 0}`));

  console.log('\n--- 2. Testing Live Deduplication for "Mi villano favorito" ---');
  const gruRes = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/search?q=Mi%20villano%20favorito&v=freshgru');
  console.log('Live Gru count:', gruRes.data.data?.length);
  gruRes.data.data?.forEach(r => console.log(`- ID: ${r.id} | TMDB: ${r.tmdb_id} | Title: "${r.title}" | Servers: ${r.servers?.length || 0}`));

  console.log('\n--- 3. Testing Live TV Series Loki (84958) S1:E1 Episode Servers ---');
  const lokiRes = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/media/84958?v=freshloki');
  const lokiEp1 = lokiRes.data.data?.seasons?.[0]?.episodes?.[0];
  console.log('Loki S1:E1 Servers Count:', lokiEp1?.servers?.length || 0);
  console.log('Loki S1:E1 Servers:', lokiEp1?.servers);
}

testLiveDeduplicationAndTV();
