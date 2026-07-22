const axios = require('axios');
const cheerio = require('cheerio');

const API_KEY = '99b8bc99e85e79fabd52b64513c9780d';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function testFullTmdbEnrichment(title, type = 'movie') {
  console.log(`\n=================== ENRICHING: "${title}" (${type}) ===================`);
  const cleanTitle = title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
  const endpoint = type === 'tvseries' ? 'tv' : 'movie';

  // 1. Search TMDB ID
  let tmdbId = null;
  try {
    const searchRes = await axios.get(`https://api.themoviedb.org/3/search/${endpoint}`, {
      params: { api_key: API_KEY, query: cleanTitle, language: 'es-MX' }
    });
    if (searchRes.data?.results?.length > 0) {
      tmdbId = searchRes.data.results[0].id;
    }
  } catch (e) {
    console.log('Search Error:', e.message);
  }

  if (!tmdbId) {
    console.log('TMDB ID not found');
    return;
  }

  console.log('✅ TMDB ID:', tmdbId);

  // 2. Fetch Details with Credits & Videos
  try {
    let detailRes = await axios.get(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}`, {
      params: { api_key: API_KEY, language: 'es-MX', append_to_response: 'credits,videos' }
    });
    let data = detailRes.data;

    // Fallback overview in Spanish Spain if MX is empty
    if (!data.overview) {
      const esRes = await axios.get(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}`, {
        params: { api_key: API_KEY, language: 'es-ES' }
      });
      if (esRes.data?.overview) data.overview = esRes.data.overview;
    }

    // Fallback videos in US if MX videos are empty
    let videos = data.videos?.results || [];
    if (videos.length === 0) {
      const vidRes = await axios.get(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}/videos`, {
        params: { api_key: API_KEY }
      });
      if (vidRes.data?.results) videos = vidRes.data.results;
    }

    const trailerObj = videos.find(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser') && (v.iso_639_1 === 'es' || v.iso_639_1 === 'es-MX'))
      || videos.find(v => v.site === 'YouTube' && v.type === 'Trailer')
      || videos.find(v => v.site === 'YouTube');

    const trailerUrl = trailerObj ? `https://www.youtube.com/watch?v=${trailerObj.key}` : null;

    const enriched = {
      id: String(data.id),
      tmdb_id: data.id,
      title: data.title || data.name,
      original_title: data.original_title || data.original_name,
      tagline: data.tagline || '',
      overview: data.overview || '',
      rating: data.vote_average ? Number(data.vote_average.toFixed(1)) : 0,
      release_date: data.release_date || data.first_air_date || '',
      genres: data.genres?.map(g => g.name) || [],
      poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
      backdrop: data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : null,
      trailer: trailerUrl,
      cast: data.credits?.cast?.slice(0, 10).map(c => ({
        name: c.name,
        character: c.character,
        photo: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null
      })) || []
    };

    console.log('Enriched Result:', JSON.stringify(enriched, null, 2));
  } catch (e) {
    console.log('Detail Error:', e.message);
  }
}

(async () => {
  await testFullTmdbEnrichment('Spider-Man 2', 'movie');
  await testFullTmdbEnrichment('La casa del dragón', 'tvseries');
  await testFullTmdbEnrichment('Naruto', 'tvseries');
  await testFullTmdbEnrichment('Garfield', 'movie');
})();
