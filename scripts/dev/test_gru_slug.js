const axios = require('axios');

async function testGruSlug() {
  const API_KEY = '99b8bc99e85e79fabd52b64513c9780d';

  const res = await axios.get('https://api.themoviedb.org/3/search/movie', {
    params: { api_key: API_KEY, query: 'gru 3 mi villano favorito', language: 'es-MX' }
  });
  console.log('Search "gru 3 mi villano favorito":');
  res.data.results.slice(0, 5).forEach(r => console.log(`- ID ${r.id}: "${r.title}" (${r.release_date})`));
}

testGruSlug();
