const axios = require('axios');
const cheerio = require('cheerio');

async function inspectLokiElements() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const res = await axios.get('https://tioplus.app/serie/loki/season/1/episode/1', {
    headers: { 'User-Agent': UA }
  });
  const $ = cheerio.load(res.data);

  console.log('--- IFRAMES ---');
  $('iframe').each((_, el) => console.log($(el).attr('src') || $(el).attr('data-src')));

  console.log('--- ALL ATTRS CONTAINING http or embed or video ---');
  $('*').each((_, el) => {
    const attribs = el.attribs;
    for (const k in attribs) {
      if (attribs[k] && (attribs[k].includes('http') || attribs[k].includes('embed') || attribs[k].includes('player') || attribs[k].includes('vidhide'))) {
        console.log(`${el.name}.${k} = ${attribs[k]}`);
      }
    }
  });

  console.log('--- SCRIPTS ---');
  $('script').each((_, el) => {
    const text = $(el).html() || '';
    if (text.includes('player') || text.includes('iframe') || text.includes('http') || text.includes('sources')) {
      console.log('Script text:', text.substring(0, 300));
    }
  });
}

inspectLokiElements();
