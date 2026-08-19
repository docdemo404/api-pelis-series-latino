import 'dotenv/config';
import { CatalogService } from '../../src/services/catalogService';
(async () => {
  const t = Date.now();
  const e = await CatalogService.estadoDelCatalogo();
  console.log(JSON.stringify(e, null, 2));
  console.log(`\nmedido en ${Date.now() - t} ms`);
})();
