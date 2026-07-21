const axios = require('axios');

(async () => {
  const testKeys = [
    '2d7155705a744f67c332aa9db1b2d72b',
    'b6f705a25617231463b132808c160533',
    '841059f87eab771b9ae69f8a7328d1fc',
    '3fd2be6f0c70a2a598f084dd1fb0648c',
    'f2472732943444284ee14a7ed2ee96ea',
    '15d260044e3514736511304b4764b92b',
    '841059f87eab771b9ae69f8a7328d1fc',
    '79a61f5d10565814d24172ce7bf032b8',
    '0d801e0e84b39b008d3e8e19b0d1e381'
  ];

  for (const k of testKeys) {
    try {
      const url = `https://api.themoviedb.org/3/search/tv?api_key=${k}&query=Avatar&language=es-MX`;
      const res = await axios.get(url);
      console.log(`SUCCESS WITH KEY: ${k}`);
      console.log('Result:', res.data.results[0].name);
      return;
    } catch(e) {
      console.log(`Failed ${k}: ${e.response?.status || e.message}`);
    }
  }
})();
