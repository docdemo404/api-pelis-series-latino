import axios from 'axios';
import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function debugScrapeDetail(tioplusUrl: string) {
  const res = await axios.get(tioplusUrl, { headers: { 'User-Agent': UA }, validateStatus: () => true });
  const html = typeof res.data === 'string' ? res.data : '';

  if (res.status === 404 || /404\s*not\s*found/i.test(html) || /página\s*no\s*encontrada/i.test(html)) {
    console.log('Returned null at check 1 (404)');
    return null;
  }

  const $ = cheerio.load(html);

  if ($('.error-404, .not-found, .error404, body.error404').length > 0) {
    console.log('Returned null at check 2 (error-404 class)');
    return null;
  }

  const h1 = $('h1.slugh1').first().text().trim() 
    || $('.single-title, .title_over h1, h1, h2').first().text().trim()
    || $('title').text().replace(/^Ver\s+/i, '').replace(/\s*-.*$/, '').trim();
  
  console.log('Extracted h1:', h1);
  if (!h1 || h1.toLowerCase().includes('404') || h1.toLowerCase().includes('no encontrada')) {
    console.log('Returned null at check 3 (h1 empty or 404)');
    return null;
  }

  console.log('Reached end of debug successfully!');
}

debugScrapeDetail('https://tioplus.app/serie/loki/season/1/episode/1');
