const axios = require('axios');

async function checkTv10014() {
  const API_KEY = '99b8bc99e85e79fabd52b64513c9780d';
  try {
    const tvRes = await axios.get('https://api.themoviedb.org/3/tv/10014', { params: { api_key: API_KEY, language: 'es-MX' } });
    console.log('TV 10014 data:', tvRes.data);
  } catch (e) {
    console.error('TV 10014 HTTP Error:', e.response?.status, e.message);
  }
}

checkTv10014();
