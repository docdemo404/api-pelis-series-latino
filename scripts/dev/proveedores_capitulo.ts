import 'dotenv/config';
import { pedirMoviedays } from '../../src/scrapers/moviedays';

/**
 * TODO lo que moviedays ofrece para un capítulo, sin filtrar por proveedor.
 *
 * El catálogo solo publica `vimeus` porque el otro proveedor no es alcanzable desde un datacenter.
 * Eso significa que lo que ve alguien en la web de moviedays y lo que entrega esta API pueden ser
 * ficheros DISTINTOS — y si uno de los dos está mal rotulado en origen, cada uno ve una cosa.
 *
 *   proveedores_capitulo.ts <tmdbId> <temporada> <capitulo>
 */
(async () => {
  const tmdbId = Number(process.argv[2]) || 456;
  const season = Number(process.argv[3]) || 1;
  const episode = Number(process.argv[4]) || 1;

  const payload: any = await pedirMoviedays(tmdbId, 'tvseries', season, episode);
  if (!payload) { console.log('la fuente no contesta'); process.exit(0); }

  console.log(`tmdb ${tmdbId} · ${season}x${episode} · «${payload.title || payload.name || '?'}»`);
  const listas = ['servers', 'sources', 'links', 'embeds', 'players'];
  for (const clave of listas) {
    const arr = payload[clave];
    if (!Array.isArray(arr) || !arr.length) continue;
    console.log(`\n  ${clave}: ${arr.length}`);
    for (const s of arr) {
      console.log(`    provider=${String(s?.provider || s?.name || '?').padEnd(12)} ` +
        `lang=${String(s?.language || s?.lang || '?').padEnd(10)} ` +
        `url=${String(s?.url || s?.link || s?.file || '').slice(0, 90)}`);
    }
  }
  const otras = Object.keys(payload).filter(k => !listas.includes(k));
  console.log(`\n  (otras claves del payload: ${otras.join(', ')})`);
  process.exit(0);
})();
