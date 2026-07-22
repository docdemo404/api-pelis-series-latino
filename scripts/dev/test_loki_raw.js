const axios = require('axios');

async function checkLokiRaw() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  try {
    const res = await axios.get('https://tioplus.app/serie/loki/season/1/episode/1', {
      headers: { 'User-Agent': UA }
    });
    console.log('Status:', res.status);
    console.log('HTML length:', res.data.length);
    console.log('HTML snippet:', res.data.substring(0, 500));
  } catch (e) {
    console.error('Error:', e.response?.status, e.message);
  }
}

checkLokiRaw();
