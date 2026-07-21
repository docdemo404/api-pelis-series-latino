const axios = require('axios');

async function testLiveCast() {
  try {
    console.log('--- Testing search?q=spiderman ---');
    const res1 = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/search?q=spiderman');
    res1.data.results?.slice(0, 3).forEach((item, i) => {
      console.log(`Item #${i} (${item.title}):`);
      console.log('  Cast:', item.cast);
    });

    console.log('\n--- Testing series/el-chavo-animado/season/1/episode/3 ---');
    const res2 = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/series/la-casa-del-dragon/season/1/episode/1');
    console.log('Episode Cast:', res2.data?.data?.cast);

    console.log('\n--- Testing media/94997 ---');
    const res3 = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/media/94997');
    console.log('Media 94997 Cast:', res3.data?.data?.cast);

  } catch (e) {
    console.error('Error:', e.message);
  }
}

testLiveCast();
