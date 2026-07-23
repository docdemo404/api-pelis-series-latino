import 'dotenv/config';
import { CatalogService } from '../../src/services/catalogService';
import { FeedService } from '../../src/services/feedService';

/** Humo de los caminos tocados por las correcciones de duplicados, fantasmas e imágenes. */
(async () => {
  const home = await FeedService.getHomeFeed('CL');
  const heroOk = home.spotlight.every((s: any) => s.backdrop && s.poster);
  console.log(`HOME     filas=${home.rows.length} spotlight=${home.spotlight.length} hero_con_ambas_imagenes=${heroOk}`);

  const search = await CatalogService.searchPaged('shrek', 1, 5);
  console.log(`SEARCH   "shrek" total=${search.total}`);
  for (const it of search.items.map(CatalogService.toSearchItem)) {
    const f = (u: any) => String(u || 'NULL').replace('https://image.tmdb.org/t/p/', '');
    const crossed = it.poster && f(it.poster).split('/').pop() === f(it.backdrop).split('/').pop();
    console.log(`   ${it.title}\n      poster=${f(it.poster)}\n      backdrop=${f(it.backdrop)}${crossed ? '   <-- CRUZADAS' : ''}`);
  }

  const disc = await FeedService.getDiscover(1, 5, 'movie');
  console.log(`DISCOVER total=${disc.total_results} devueltos=${disc.results.length}`);
})();
