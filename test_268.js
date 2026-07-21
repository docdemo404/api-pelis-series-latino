const axios = require('axios');

async function test268() {
  try {
    const res = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/media/268');
    console.log('ID 268 Title:', res.data.data?.title);
    console.log('ID 268 Servers count:', res.data.data?.servers?.length);
    console.log('ID 268 Servers:', res.data.data?.servers);
  } catch (e) {
    console.error('Error:', e.message);
  }
}

test268();
