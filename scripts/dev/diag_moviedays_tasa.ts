/** Tasa REAL de reproducción de la fuente moviedays, extrayendo con el código de esta API. */
import { RealScraperService } from '../../src/services/realScraperService';
import { extractDirect } from '../../src/scrapers/directStream';
import { ServerOption } from '../../src/types';

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36';

async function reproduce(sv: ServerOption): Promise<boolean> {
  let url = sv.direct_stream || '';
  try {
    if (url.startsWith('/')) {
      const e = new URL(url, 'https://x').searchParams.get('e') || '';
      const embed = Buffer.from(e, 'base64').toString('utf8');
      const html = await fetch(embed, { headers: { 'User-Agent': UA, Referer: 'https://moviedays.lat/' } }).then(r => r.text());
      const d = await extractDirect(embed, html, { allowNetwork: true });
      if (!d) return false;
      url = d.url;
    }
    if (!url) return false;
    const r = await fetch(url, { headers: { 'User-Agent': UA, Range: 'bytes=0-65535' } });
    return r.ok && (await r.arrayBuffer()).byteLength > 1000;
  } catch { return false; }
}

(async () => {
  const N = Number(process.argv[2]) || 30;

  const pelis = await RealScraperService.scrapeMoviedaysLatest('movie', N);
  let ok = 0;
  for (const p of pelis) {
    const abre = (await Promise.all((p.servers || []).map(reproduce))).some(Boolean);
    if (abre) ok++;
    console.log(`  ${abre ? 'ABRE' : 'NO  '} ${p.title.slice(0, 40)}`);
  }
  console.log(`\nPELICULAS: ${pelis.length} fichas con servidor · ${ok} reproducen (${Math.round(ok * 100 / Math.max(1, pelis.length))}%)`);

  const series = await RealScraperService.scrapeMoviedaysLatest('tvseries', 10);
  let okEp = 0, total = 0;
  for (const s of series) {
    // Un capítulo del medio, no el 1x1 con el que se sondeó: es donde se ve si la serie está entera.
    const se = Math.min(2, s.total_seasons || 1);
    for (const ep of [1, 5]) {
      total++;
      const r = await RealScraperService.scrapeEpisodeDetail(String(s.tmdb_id), se, ep, { tmdbId: s.tmdb_id });
      const abre = r ? (await Promise.all(r.servers.map(reproduce))).some(Boolean) : false;
      if (abre) okEp++;
      console.log(`  ${abre ? 'ABRE' : 'NO  '} ${s.title.slice(0, 34)} T${se}E${ep} (${r?.servers.length || 0} srv)`);
    }
  }
  console.log(`\nCAPITULOS: ${total} probados · ${okEp} reproducen (${Math.round(okEp * 100 / Math.max(1, total))}%)`);
  process.exit(0);
})();
