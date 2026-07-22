const axios = require('axios');

async function test1273221() {
  const API_KEY = '99b8bc99e85e79fabd52b64513c9780d';
  try {
    console.time('TMDB Fetch');
    const res = await axios.get(`https://api.themoviedb.org/3/movie/1273221`, {
      params: { api_key: API_KEY, language: 'es-MX', append_to_response: 'credits,videos' }
    });
    console.timeEnd('TMDB Fetch');
    console.log('TMDB Movie 1273221:', res.data.title);

    console.time('API Vercel Fetch');
    const apiRes = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/media/1273221');
    console.timeEnd('API Vercel Fetch');
    console.log('API Vercel status:', apiRes.status, apiRes.data?.data?.title);
  } catch (e) {
    console.log('Error:', e.message, e.response?.data);
  }
}

test1273221();
