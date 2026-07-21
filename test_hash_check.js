const axios = require('axios');

async function testHashApis(url) {
  const hashMatch = url.match(/https?:\/\/([^\/#]+)\/.*?#([a-zA-Z0-9_-]+)/);
  if (!hashMatch) {
    console.log(`No es una URL con hash: ${url}`);
    return;
  }
  const domain = hashMatch[1];
  const hashId = hashMatch[2];
  const apiUrl = `https://${domain}/api/v1/info?id=${hashId}`;
  console.log(`\nInspeccionando hash embed: Domain=${domain}, Hash=${hashId}`);

  try {
    const res = await axios.get(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': url
      },
      timeout: 4000,
      validateStatus: () => true
    });

    console.log(`   API Status: ${res.status}`);
    const dataStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    console.log(`   Response length: ${dataStr.length}`);

    // Si responde 404, 410, o mensaje de error JSON -> OFFLINE
    if (res.status >= 400 || dataStr.includes('error') || dataStr.includes('not found') || dataStr.includes('invalid')) {
      console.log(`   ❌ API del reproductor reporta OFFLINE`);
      return 'offline';
    }

    console.log(`   ✅ API del reproductor reporta ONLINE`);
    return 'online';
  } catch (e) {
    console.log(`   ❌ Error al consultar API de reproductor: ${e.message}`);
    return 'offline';
  }
}

(async () => {
  await testHashApis('https://pelisplus.upns.pro/#msey8f');
  await testHashApis('https://pelisplus.upns.pro/#INVALID_HASH_999');
  await testHashApis('https://pelisplus.rpmstream.live/#mo9to5');
  await testHashApis('https://pelisplus.strp2p.com/#os9dn5');
  await testHashApis('https://pelisplusto.4meplayer.pro/#yrjpc');
})();
