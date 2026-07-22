const axios = require('axios');

async function test197929() {
  const API_KEY = '99b8bc99e85e79fabd52b64513c9780d';
  try {
    const res = await axios.get('https://api.themoviedb.org/3/tv/197929', {
      params: { api_key: API_KEY, language: 'es-MX', append_to_response: 'credits,videos' }
    });
    console.log('TMDB TV 197929:', res.data.name, 'Seasons count:', res.data.number_of_seasons);

    const s1Res = await axios.get('https://api.themoviedb.org/3/tv/197929/season/1', {
      params: { api_key: API_KEY, language: 'es-MX' }
    });
    console.log('Season 1 episodes count:', s1Res.data?.episodes?.length);
    if (s1Res.data?.episodes?.[0]) {
      console.log('Ep 1 sample:', s1Res.data.episodes[0].name);
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

test197929();
