const axios = require('axios');

async function testIds() {
  const API_KEY = '99b8bc99e85e79fabd52b64513c9780d';
  
  const testList = [94997, 60625, 10014];

  for (const id of testList) {
    const [movieRes, tvRes] = await Promise.allSettled([
      axios.get(`https://api.themoviedb.org/3/movie/${id}`, { params: { api_key: API_KEY, language: 'es-MX' } }),
      axios.get(`https://api.themoviedb.org/3/tv/${id}`, { params: { api_key: API_KEY, language: 'es-MX' } })
    ]);

    const movie = movieRes.status === 'fulfilled' ? movieRes.value.data : null;
    const tv = tvRes.status === 'fulfilled' ? tvRes.value.data : null;

    console.log(`--- TMDB ID ${id} ---`);
    if (movie) console.log(`Movie: "${movie.title}" (Votes: ${movie.vote_count})`);
    if (tv) console.log(`TV: "${tv.name}" (Votes: ${tv.vote_count})`);
  }
}

testIds();
