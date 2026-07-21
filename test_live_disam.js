const axios = require('axios');

async function testLiveDisambiguation() {
  try {
    const res94997 = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/media/94997?v=disam');
    console.log('GET /media/94997 Title:', res94997.data.data?.title, 'Type:', res94997.data.data?.type);

    const res60625 = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/media/60625?v=disam');
    console.log('GET /media/60625 Title:', res60625.data.data?.title, 'Type:', res60625.data.data?.type);
  } catch (e) {
    console.error('Error:', e.message);
  }
}

testLiveDisambiguation();
