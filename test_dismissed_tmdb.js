const axios = require('axios');

async function testDismissedTmdb() {
  const API_KEY = '99b8bc99e85e79fabd52b64513c9780d';
  const tvRes = await axios.get('https://api.themoviedb.org/3/search/tv', { params: { api_key: API_KEY, query: 'Dismissed', language: 'es-MX' } });
  console.log('Search TV "Dismissed":', tvRes.data.results?.map(r => ({ id: r.id, name: r.name, first_air_date: r.first_air_date })));

  const movieRes = await axios.get('https://api.themoviedb.org/3/search/movie', { params: { api_key: API_KEY, query: 'Dismissed', language: 'es-MX' } });
  console.log('Search Movie "Dismissed":', movieRes.data.results?.map(r => ({ id: r.id, title: r.title, release_date: r.release_date })));
}

testDismissedTmdb();
