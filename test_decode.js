const axios = require('axios');
const cheerio = require('cheerio');

async function testDecodeDataServer() {
  const b64 = 'cDI3Q25sMng4M2RlSm00aUR2WmJGaFRNVnFxZnlBWHc5b1RiSjJ0OC92T1lwdW9kdTlZPQ==';
  console.log('Decoded once:', Buffer.from(b64, 'base64').toString('utf-8'));
  const once = Buffer.from(b64, 'base64').toString('utf-8');
  if (once.includes('=')) {
    console.log('Decoded twice:', Buffer.from(once, 'base64').toString('utf-8'));
  }

  // Check script tags on Loki page to see how data-server is handled in JS
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const res = await axios.get('https://tioplus.app/serie/loki/season/1/episode/1', {
    headers: { 'User-Agent': UA }
  });
  const $ = cheerio.load(res.data);
  $('script').each((i, el) => {
    const src = $(el).attr('src');
    if (src && (src.includes('app') || src.includes('main') || src.includes('player'))) {
      console.log('Script src:', src);
    }
  });
}

testDecodeDataServer();
