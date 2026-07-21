const axios = require('axios');

async function test1084244() {
  try {
    const res = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/media/1084244?v=testbug');
    console.log('Returned ID:', res.data.data?.id);
    console.log('Returned TMDB ID:', res.data.data?.tmdb_id);
    console.log('Returned Title:', res.data.data?.title);
  } catch (e) {
    console.error('Error:', e.message);
  }
}

test1084244();
