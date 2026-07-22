import axios from 'axios';
import * as cheerio from 'cheerio';
import { RealScraperService } from './src/services/realScraperService';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function testTraceScrapeDetail() {
  const url = 'https://tioplus.app/serie/loki/season/1/episode/1';
  console.log('Tracing scrapeDetail for:', url);

  const res = await axios.get(url, { headers: { 'User-Agent': UA } });
  const html = typeof res.data === 'string' ? res.data : '';
  const $ = cheerio.load(html);

  const h1 = $('h1.slugh1').first().text().trim() 
    || $('.single-title, .title_over h1, h1, h2').first().text().trim()
    || $('title').text().replace(/^Ver\s+/i, '').replace(/\s*-.*$/, '').trim();

  const title = h1.replace(/\s*\(\d{4}\)\s*$/, '').trim();
  const slug = url.split('/').filter(Boolean).pop() || title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  console.log('h1:', h1);
  console.log('title:', title);
  console.log('slug:', slug);

  const fullRes = await RealScraperService.scrapeDetail(url);
  console.log('Full res:', fullRes);
}

testTraceScrapeDetail();
