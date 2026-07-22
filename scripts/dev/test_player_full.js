const axios = require('axios');

async function printPlayerFull() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const dataServer = 'cDI3Q25sMng4M2RlSm00aUR2WmJGaFRNVnFxZnlBWHc5b1RiSjJ0OC92T1lwdW9kdTlZPQ==';
  const b1 = Buffer.from(dataServer).toString('base64');

  const res1 = await axios.get(`https://tioplus.app/player/${b1}`, { headers: { 'User-Agent': UA } });
  console.log('Full HTML:', res1.data);
}

printPlayerFull();
