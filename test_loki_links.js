const axios = require('axios');
const cheerio = require('cheerio');

async function inspectLokiPage() {
  const res = await axios.get('https://tioplus.app/serie/loki');
  const $ = cheerio.load(res.data);
  console.log('Episode links:');
  $('a[href*="/episode/"], a[href*="/episodio/"], a[href*="season"]').each((_, el) => {
    console.log($(el).attr('href'));
  });
}

inspectLokiPage();
