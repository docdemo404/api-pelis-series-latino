import axios from 'axios';
import * as cheerio from 'cheerio';
import { RealScraperService } from './src/services/realScraperService';

async function testDebugFull() {
  const url = 'https://tioplus.app/serie/loki/season/1/episode/1';
  console.log('Testing full scrapeDetail on:', url);
  try {
    const res = await RealScraperService.scrapeDetail(url);
    console.log('Result:', {
      id: res?.id,
      title: res?.title,
      serversCount: res?.servers?.length,
      servers: res?.servers
    });
  } catch (e: any) {
    console.error('Error in scrapeDetail:', e.message, e.stack);
  }
}

testDebugFull();
