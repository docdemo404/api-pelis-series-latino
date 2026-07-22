const axios = require('axios');
const cheerio = require('cheerio');

async function printPlayerContainer() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const res = await axios.get('https://tioplus.app/serie/loki/season/1/episode/1', {
    headers: { 'User-Agent': UA }
  });
  const $ = cheerio.load(res.data);
  console.log('#player-tr html:', $('#player-tr').html());
  console.log('.player-options html:', $('.player-options, .options, .player, ul.options').html());
}

printPlayerContainer();
