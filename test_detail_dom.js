const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://tioplus.app';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function checkDetailDom(url) {
  console.log(`\n🔍 Inspeccionando DOM de detalle: ${url}`);
  try {
    const res = await axios.get(url, { headers: { 'User-Agent': UA, 'Referer': BASE }, timeout: 6000 });
    const $ = cheerio.load(res.data);

    // Pattern 1: li[data-server]
    const p1 = [];
    $('li[data-server]').each((_, el) => {
      p1.push($(el).attr('data-server'));
    });
    console.log(`   Pattern 1 (li[data-server]): ${p1.length} tokens`);

    // Pattern 2: [data-tr]
    const p2 = [];
    $('[data-tr]').each((_, el) => {
      p2.push($(el).attr('data-tr'));
    });
    console.log(`   Pattern 2 ([data-tr]): ${p2.length} tokens`);

    // Pattern 3: iframe src/data-src
    const p3 = [];
    $('iframe').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && !src.includes('facebook') && !src.includes('disqus')) p3.push(src);
    });
    console.log(`   Pattern 3 (iframe): ${p3.length} URLs`, p3);

    // Pattern 4: li.do-server / button[data-server] / .nav-tabs / .server / .option
    const p4 = [];
    $('.do-server, button[data-server], .nav-tabs li, .server-item, [data-video], [data-url]').each((_, el) => {
      const v = $(el).attr('data-server') || $(el).attr('data-video') || $(el).attr('data-url') || $(el).attr('data-id');
      if (v) p4.push(v);
    });
    console.log(`   Pattern 4 (varios atributos de video): ${p4.length} tokens`, p4.slice(0, 5));

    // Pattern 5: inline script player variables
    const html = typeof res.data === 'string' ? res.data : '';
    const scriptMatches = html.match(/(?:var|const|let)\s+(?:servers|player|options|videoUrl|embeds)\s*=\s*([\[\{][\s\S]*?[\]\}]);/g) || [];
    console.log(`   Pattern 5 (script variables): ${scriptMatches.length} coincidencias`);
    if (scriptMatches.length > 0) {
      console.log('   Script snippet:', scriptMatches[0].substring(0, 150));
    }

  } catch (e) {
    console.log(`   Error inspeccionando: ${e.message}`);
  }
}

(async () => {
  await checkDetailDom('https://tioplus.app/pelicula/avatar');
  await checkDetailDom('https://tioplus.app/pelicula/scary-movie-6');
  await checkDetailDom('https://tioplus.app/pelicula/los-descendientes-viaje-al-mundo-oscuro');
  await checkDetailDom('https://tioplus.app/pelicula/dragon-ball-super-broly');
})();
