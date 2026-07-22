const axios = require('axios');

async function testLiveGruFix() {
  try {
    const res3 = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/media/gru-3-mi-villano-favorito?v=freshgru3');
    console.log('Live Gru 3:', {
      id: res3.data.data?.id,
      tmdb_id: res3.data.data?.tmdb_id,
      title: res3.data.data?.title,
      serversCount: res3.data.data?.servers?.length
    });

    const res4 = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/media/gru-4-mi-villano-favorito?v=freshgru4');
    console.log('Live Gru 4:', {
      id: res4.data.data?.id,
      tmdb_id: res4.data.data?.tmdb_id,
      title: res4.data.data?.title,
      serversCount: res4.data.data?.servers?.length
    });
  } catch (e) {
    console.error('Error:', e.message);
  }
}

testLiveGruFix();
