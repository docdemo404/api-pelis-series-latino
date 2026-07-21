const axios = require('axios');

async function testRevalidate() {
  try {
    console.log('1. Calling /revalidate to purge backend cache...');
    const rev = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/revalidate');
    console.log('Revalidate result:', rev.data);

    console.log('2. Fetching /media/197929 with cache-busting ?v=fresh ...');
    const freshRes = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/media/197929?v=fresh');
    console.log('Fresh /media/197929 seasons count:', freshRes.data?.data?.seasons?.length);

    console.log('3. Fetching /media/197929/season/1/episode/1 ...');
    const epRes = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/media/197929/season/1/episode/1');
    console.log('Episode 1 status:', epRes.status, epRes.data?.status);
  } catch (e) {
    console.error('Error:', e.message, e.response?.data);
  }
}

testRevalidate();
