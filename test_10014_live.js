const axios = require('axios');

async function test10014() {
  try {
    const res = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/media/10014?v=fresh10014');
    console.log('GET /media/10014 Title:', res.data.data?.title, 'Type:', res.data.data?.type);
  } catch (e) {
    console.error('Error:', e.message);
  }
}

test10014();
