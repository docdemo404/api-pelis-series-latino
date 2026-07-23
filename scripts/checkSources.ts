/**
 * Canario de las fuentes de scraping.
 *
 *   npm run check:sources
 *
 * Comprueba que cada listado sigue devolviendo títulos Y que la paginación avanza de
 * verdad. Existe porque TioPlus cambió su markup (`.title_over span` se quedó vacío) y su
 * patrón de paginación (/peliculas/2 en vez de /peliculas/page/2) sin previo aviso: el
 * crawl siguió terminando "con éxito" durante semanas mientras traía CERO títulos de esa
 * fuente, y el catálogo se quedó viviendo solo de FuegoCine sin que nada lo señalara.
 */
import 'dotenv/config';
import { RealScraperService } from '../src/services/realScraperService';

interface Check {
  name: string;
  run: () => Promise<{ count: number; unique: number; sample?: string }>;
}

/** Pide 3 páginas: si la paginación está rota, solo llegan los ~24 de la primera. */
const PAGES_WORTH = 60;

const checks: Check[] = [
  ...(['peliculas', 'series', 'animes'] as const).map(type => ({
    name: `TioPlus /${type}`,
    run: async () => {
      const items = await RealScraperService.scrapeLatest(type, PAGES_WORTH);
      return {
        count: items.length,
        unique: new Set(items.map(i => i.id)).size,
        sample: items[0]?.title
      };
    }
  })),
  {
    name: 'TioPlus portada',
    run: async () => {
      const items = await RealScraperService.scrapeHomepage();
      return { count: items.length, unique: new Set(items.map(i => i.id)).size, sample: items[0]?.title };
    }
  },
  {
    name: 'FuegoCine feed',
    run: async () => {
      const items = await RealScraperService.scrapeAllFuegocine();
      return { count: items.length, unique: new Set(items.map(i => i.id)).size, sample: items[0]?.title };
    }
  }
];

async function main() {
  console.log('\n══ Salud de las fuentes ══\n');
  let broken = 0;

  for (const check of checks) {
    try {
      const { count, unique, sample } = await check.run();
      // Un listado paginado que devuelve exactamente una página es la firma de la
      // paginación rota; cero títulos es el markup roto.
      const paginated = check.name.startsWith('TioPlus /');
      const ok = count > 0 && (!paginated || unique > 24);

      if (!ok) broken++;
      console.log(`${ok ? '✅' : '❌'} ${check.name.padEnd(22)} ${unique} títulos únicos${sample ? `  · ej. ${sample.slice(0, 45)}` : ''}`);
      if (!ok && count > 0 && unique <= 24) {
        console.log('      ⚠ solo llega la primera página → revisa el patrón de paginación en scrapeLatest');
      }
      if (count === 0) {
        console.log('      ⚠ cero títulos → el markup del sitio cambió; revisa extractCardTitle / los selectores');
      }
    } catch (err: any) {
      broken++;
      console.log(`❌ ${check.name.padEnd(22)} ERROR ${err.message}`);
    }
  }

  console.log(broken === 0
    ? '\n✅ Todas las fuentes responden y paginan.\n'
    : `\n❌ ${broken} fuente(s) rotas: el crawl seguirá "funcionando" pero con el catálogo incompleto.\n`);

  process.exit(broken === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('❌ checkSources:', err.message || err);
  process.exit(1);
});
