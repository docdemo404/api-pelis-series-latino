const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://tioplus.app';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function testEpisodeFetch(slug, season, episode) {
  const url = `${BASE}/serie/${slug}/season/${season}/episode/${episode}`;
  console.log(`\n🔍 Obteniendo servidores del episodio: ${url}`);
  try {
    const res = await axios.get(url, { headers: { 'User-Agent': UA, 'Referer': BASE }, timeout: 5000 });
    const $ = cheerio.load(res.data);
    const title = $('h2, h1').first().text().trim();
    const serverTokens = [];
    $('li[data-server], [data-tr]').each((_, el) => {
      const token = $(el).attr('data-server') || $(el).attr('data-tr');
      if (token && !serverTokens.includes(token)) serverTokens.push(token);
    });
    console.log(`   Título: "${title}" | Tokens de servidor: ${serverTokens.length}`, serverTokens);
  } catch (e) {
    console.log(`   Error: ${e.message}`);
  }
}

(async () => {
  await testEpisodeFetch('veinticinco-veintiuno', 1, 1);
  await testEpisodeFetch('la-casa-del-dragon', 1, 1);
  await testEpisodeFetch('profunda-venganza', 1, 1);
})();
