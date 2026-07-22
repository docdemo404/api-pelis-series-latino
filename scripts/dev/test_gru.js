const axios = require('axios');

async function testGru() {
  const API_KEY = '99b8bc99e85e79fabd52b64513c9780d';

  const res3 = await axios.get('https://api.themoviedb.org/3/search/movie', {
    params: { api_key: API_KEY, query: 'Mi villano favorito 3', language: 'es-MX' }
  });
  console.log('Search "Mi villano favorito 3":');
  res3.data.results.slice(0, 5).forEach(r => console.log(`- ID ${r.id}: "${r.title}" (${r.release_date})`));

  const res4 = await axios.get('https://api.themoviedb.org/3/search/movie', {
    params: { api_key: API_KEY, query: 'Mi villano favorito 4', language: 'es-MX' }
  });
  console.log('\nSearch "Mi villano favorito 4":');
  res4.data.results.slice(0, 5).forEach(r => console.log(`- ID ${r.id}: "${r.title}" (${r.release_date})`));
}

testGru();
