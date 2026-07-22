const axios = require('axios');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function testFuegocineIntegration(query) {
  console.log(`\n🔍 Buscando "${query}" en FuegoCine...`);
  const feedUrl = `https://www.fuegocine.com/feeds/posts/summary?q=${encodeURIComponent(query)}&alt=json&max-results=5`;
  try {
    const res = await axios.get(feedUrl, { headers: { 'User-Agent': UA } });
    const entries = res.data?.feed?.entry || [];
    console.log(`Encontrados ${entries.length} resultados en FuegoCine:`);

    for (const e of entries) {
      const title = e.title?.$t;
      const link = e.link?.find(l => l.rel === 'alternate')?.href;
      console.log(`   - Título: "${title}" | URL: ${link}`);

      if (link) {
        console.log(`     Inspeccionando detalle de FuegoCine: ${link}`);
        const detailRes = await axios.get(link, { headers: { 'User-Agent': UA } });
        const html = typeof detailRes.data === 'string' ? detailRes.data : '';

        const svMatch = html.match(/const\s+_SV_LINKS\s*=\s*(\[[\s\S]*?\]);/);
        if (svMatch) {
          const arrayText = svMatch[1];
          const objectRegex = /lang:\s*["']([^"']+)["'][\s\S]*?name:\s*["']([^"']+)["'][\s\S]*?quality:\s*["']([^"']+)["'][\s\S]*?url:\s*["']([^"']+)["']/g;
          const servers = [];
          let m;
          while ((m = objectRegex.exec(arrayText)) !== null) {
            servers.push({ name: m[2].replace(/&#9989;/g, ' (Verificado)').trim(), url: m[4] });
          }
          console.log(`     Servidores extraídos (${servers.length}):`, servers);
        }
      }
    }
  } catch (e) {
    console.log('Error:', e.message);
  }
}

(async () => {
  await testFuegocineIntegration('spiderman');
  await testFuegocineIntegration('avatar');
})();
