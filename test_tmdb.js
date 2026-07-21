const axios = require('axios');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function fetchTmdbIdWeb(query, type = 'movie') {
  try {
    const cleanQuery = query.replace(/\s*\(\d{4}\)\s*$/, '').trim();
    const targetType = type === 'tvseries' ? 'tv' : 'movie';
    const url = `https://www.themoviedb.org/search/${targetType}?query=${encodeURIComponent(cleanQuery)}&language=es-MX`;

    const res = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html' },
      timeout: 4000
    });

    const $ = cheerio.load(res.data);
    const firstLink = $('a[data-id], .card.style_1 a[href*="/movie/"], .card.style_1 a[href*="/tv/"], .results .item a[href*="/movie/"], .results .item a[href*="/tv/"]').first();
    const href = firstLink.attr('href') || '';
    const match = href.match(/\/(movie|tv)\/(\d+)/);

    if (match) {
      return parseInt(match[2]);
    }
  } catch (e) {}
  return 0;
}

(async () => {
  console.log('TMDB ID Spider-Man 2:', await fetchTmdbIdWeb('Spider-Man 2', 'movie'));
})();
