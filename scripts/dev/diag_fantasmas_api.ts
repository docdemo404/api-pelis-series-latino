import 'dotenv/config';
import axios from 'axios';

/**
 * ¿CUÁNTO DE LO QUE SE ANUNCIA NO TIENE NADA DETRÁS? — contado contra la API de verdad.
 *
 * Mide lo único que le importa al espectador: coge lo que la portada, el catálogo y el buscador
 * están enseñando AHORA MISMO y le pide a cada título sus enlaces. Lo que conteste con cero
 * servidores es una ficha fantasma: una tarjeta que al pulsarla no lleva a ninguna parte.
 *
 * No sirve mirarlo en la base de datos —se probó— porque ahí casi todo parece correcto: el
 * veredicto guardado dice que sí y solo se descubre que no al sondear en el momento de servir.
 * De ahí que esta sonda pase por la API y no por Postgres.
 *
 *   npx ts-node scripts/dev/diag_fantasmas_api.ts
 *   npx ts-node scripts/dev/diag_fantasmas_api.ts http://localhost:3000
 */

const BASE = process.argv[2] || 'https://api-pelis-series-latino.vercel.app';

async function get(path: string) {
  const r = await axios.get(`${BASE}${path}`, { timeout: 60000, validateStatus: () => true });
  return r.data;
}

async function comprobar(items: Array<{ id: string; title: string; type?: string }>, etiqueta: string) {
  let vacios = 0; const malos: string[] = [];
  const lote = 6;
  for (let i = 0; i < items.length; i += lote) {
    await Promise.all(items.slice(i, i + lote).map(async it => {
      try {
        const d = await get(`/api/v1/media/${encodeURIComponent(it.id)}/streams`);
        const srv = d?.data?.servers || [];
        const eps = (d?.data?.seasons || []).flatMap((s: any) => s.episodes || []);
        const epsConSrv = eps.filter((e: any) => (e.servers || []).length > 0).length;
        const ok = srv.length > 0 || epsConSrv > 0;
        if (!ok) { vacios++; if (malos.length < 15) malos.push(`${it.type || '?'}\t${it.title}\t(${it.id})`); }
      } catch (e: any) { vacios++; if (malos.length < 15) malos.push(`${it.title} ERROR ${e.message}`); }
    }));
  }
  console.log(`\n${etiqueta}: ${items.length} ítems → SIN FUENTE ${vacios} (${((vacios / Math.max(1, items.length)) * 100).toFixed(1)}%)`);
  malos.forEach(m => console.log('   ✗ ' + m));
}

async function main() {
  console.log('BASE =', BASE);

  const home = await get('/api/v1/feeds/home?limit=12');
  const filas = home?.data?.rows || [];
  const spot = (home?.data?.spotlight || []).map((s: any) => ({ id: s.id, title: s.title, type: s.type }));
  console.log(`home: ${filas.length} filas, spotlight ${spot.length}`);
  const deHome: any[] = [...spot];
  for (const f of filas.slice(0, 4)) for (const it of (f.items || []).slice(0, 6)) deHome.push({ id: it.id, title: it.title, type: it.type });
  const unicos = [...new Map(deHome.map(i => [i.id, i])).values()];
  await comprobar(unicos, 'HOME (spotlight + 4 filas)');

  const cat = await get('/api/v1/discover?page=1&limit=25');
  await comprobar((cat?.data?.results || []).map((i: any) => ({ id: i.id, title: i.title, type: i.type })), 'CATÁLOGO /discover p1');

  const cat3 = await get('/api/v1/discover?page=5&limit=25');
  await comprobar((cat3?.data?.results || []).map((i: any) => ({ id: i.id, title: i.title, type: i.type })), 'CATÁLOGO /discover p5');

  for (const q of ['el', 'la', 'batman', 'amor']) {
    const s = await get(`/api/v1/search?q=${encodeURIComponent(q)}&limit=15`);
    await comprobar((s?.results || []).map((i: any) => ({ id: i.id, title: i.title, type: i.type })), `BÚSQUEDA "${q}" (total=${s?.total_results})`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
