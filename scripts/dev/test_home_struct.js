const axios = require('axios');

async function testHomeFeedStructure() {
  try {
    const res = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/feeds/home');
    console.log('Home feed keys:', Object.keys(res.data));
    console.log('Data keys:', Object.keys(res.data.data || {}));
    if (res.data.data?.carousels) {
      console.log('Carousels count:', res.data.data.carousels.length);
      console.log('Sample Carousel 0:', res.data.data.carousels[0].title);
      console.log('Sample Item 0:', res.data.data.carousels[0].items[0]);
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

testHomeFeedStructure();
