const axios = require('axios');

async function testSearchSpeed() {
  console.time('Fast Search Test');
  try {
    const res = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/search?q=matrix');
    console.timeEnd('Fast Search Test');
    console.log('Results count:', res.data.count, 'Status:', res.data.status);
  } catch (e) {
    console.error('Error:', e.message);
  }
}

testSearchSpeed();
