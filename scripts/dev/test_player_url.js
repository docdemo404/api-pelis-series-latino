const axios = require('axios');

async function testPlayerUrl() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const dataServer = 'cDI3Q25sMng4M2RlSm00aUR2WmJGaFRNVnFxZnlBWHc5b1RiSjJ0OC92T1lwdW9kdTlZPQ==';
  
  const b1 = Buffer.from(dataServer).toString('base64');
  const b2 = Buffer.from(b1).toString('base64');

  console.log('Testing url 1:', `https://tioplus.app/player/${b1}`);
  try {
    const res1 = await axios.get(`https://tioplus.app/player/${b1}`, { headers: { 'User-Agent': UA } });
    console.log('Res1 status:', res1.status, 'HTML length:', res1.data.length, 'iframe/video:', res1.data.substring(0, 300));
  } catch (e) {
    console.log('Res1 error:', e.message);
  }

  console.log('Testing url 2:', `https://tioplus.app/player/${b2}`);
  try {
    const res2 = await axios.get(`https://tioplus.app/player/${b2}`, { headers: { 'User-Agent': UA } });
    console.log('Res2 status:', res2.status, 'HTML length:', res2.data.length, 'iframe/video:', res2.data.substring(0, 300));
  } catch (e) {
    console.log('Res2 error:', e.message);
  }
}

testPlayerUrl();
