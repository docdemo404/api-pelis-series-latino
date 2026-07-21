const axios = require('axios');

const API_KEY = '99b8bc99e85e79fabd52b64513c9780d';

async function testTmdbKey() {
  try {
    const res = await axios.get(`https://api.themoviedb.org/3/search/movie`, {
      params: { api_key: API_KEY, query: 'Spider-Man 2', language: 'es-MX' }
    });
    console.log('Search status:', res.status);
    console.log('Results count:', res.data.results.length);
    const first = res.data.results[0];
    console.log('First item:', first.id, first.title);

    // Detail with credits and videos
    const detail = await axios.get(`https://api.themoviedb.org/3/movie/${first.id}`, {
      params: { api_key: API_KEY, language: 'es-MX', append_to_response: 'credits,videos' }
    });
    console.log('\nMovie Detail:');
    console.log('Title:', detail.data.title);
    console.log('Overview:', detail.data.overview);
    console.log('Poster:', detail.data.poster_path);
    console.log('Genres:', detail.data.genres);
    console.log('Cast:', detail.data.credits?.cast?.slice(0, 3));
    console.log('Videos:', detail.data.videos?.results);
  } catch (e) {
    console.error('Error:', e.message, e.response?.data);
  }
}

testTmdbKey();
