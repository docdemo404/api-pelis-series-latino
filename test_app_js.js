const axios = require('axios');

async function inspectAppJs() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const res = await axios.get('https://tioplus.app/css/app.js?1', {
    headers: { 'User-Agent': UA }
  });
  console.log('App JS length:', res.data.length);
  const text = res.data;
  const matches = text.match(/(?:data-server|data-tr|data-url|\/r\.php|\/player|\/embed|atob|btoa|crypto|ajax|fetch)[^;{}]{1,200}/gi);
  console.log('Matches in app.js:');
  (matches || []).slice(0, 20).forEach(m => console.log('-', m));
}

inspectAppJs();
