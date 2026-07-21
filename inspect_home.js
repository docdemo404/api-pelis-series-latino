const axios = require('axios');

async function inspectHomeFeed() {
  try {
    const res = await axios.get('https://api-pelis-series-latino.vercel.app/api/v1/feeds/home');
    const data = res.data?.data || {};
    const featured = data.featured ? [data.featured] : [];
    const rows = data.rows || [];

    const idTitlePairs = [];

    for (const f of featured) {
      if (f) idTitlePairs.push({ id: String(f.id), tmdb_id: f.tmdb_id, title: f.title, type: f.type });
    }

    for (const row of rows) {
      for (const item of (row.items || [])) {
        idTitlePairs.push({ id: String(item.id), tmdb_id: item.tmdb_id, title: item.title, type: item.type });
      }
    }

    console.log('Total items in home feed:', idTitlePairs.length);
    console.log('\nChecking consistency between home card ID and /media/{id} detail for 25 items...');
    let mismatches = 0;
    for (const item of idTitlePairs.slice(0, 25)) {
      try {
        const detailRes = await axios.get(`https://api-pelis-series-latino.vercel.app/api/v1/media/${item.id}`);
        const detailTitle = detailRes.data?.data?.title;
        const detailType = detailRes.data?.data?.type;
        const match = detailTitle?.toLowerCase().trim() === item.title?.toLowerCase().trim();
        if (!match) mismatches++;
        console.log(`ID ${item.id} (${item.type}): Home Title = "${item.title}" | Detail Title = "${detailTitle}" (${detailType}) -> ${match ? 'OK' : 'MISMATCH!'}`);
      } catch (err) {
        console.error(`ID ${item.id}: Detail fetch error ->`, err.message);
      }
    }
    console.log(`\nTotal mismatches found: ${mismatches} of ${Math.min(25, idTitlePairs.length)} tested.`);
  } catch (e) {
    console.error('Error fetching home feed:', e.message);
  }
}

inspectHomeFeed();
