const axios = require('axios');
const cheerio = require('cheerio');

async function inspectLokiEp1() {
  const res = await axios.get('https://tioplus.app/serie/loki/season/1/episode/1');
  const $ = cheerio.load(res.data);
  console.log('Title:', $('h1').text().trim());
  console.log('Iframes count:', $('iframe').length);
  $('iframe').each((i, el) => console.log(`iframe ${i}:`, $(el).attr('src') || $(el).attr('data-src')));
  console.log('Player buttons count:', $('.opt-btn, [data-url], li[onclick*="iframe"]').length);
  $('[data-url], .options li, .player-options li, li[data-target]').each((i, el) => {
    console.log(`btn ${i}:`, $(el).text().trim(), $(el).attr('data-url') || $(el).attr('onclick') || $(el).attr('data-src'));
  });
}

inspectLokiEp1();
