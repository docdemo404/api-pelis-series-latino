/**
 * Round-trip búsqueda → detalle: el id que devuelve /search DEBE resolver en /media/:id.
 *   npx ts-node scripts/dev/test_id_roundtrip.ts madagascar
 */
import 'dotenv/config';
import { CatalogService } from '../../src/services/catalogService';

async function main() {
  const query = process.argv[2] || 'madagascar';
  const { items, total } = await CatalogService.searchPaged(query, 1, 5);
  console.log(`🔎 "${query}" → ${total} resultados\n`);

  for (const item of items) {
    const detail = await CatalogService.getById(item.id);
    const servers = detail?.servers?.length || 0;
    const seasons = detail?.seasons?.length || 0;
    console.log(
      `${detail ? '✔' : '✘ 404'} id="${item.id}" (${item.title})` +
      (detail ? ` → servers=${servers} seasons=${seasons}` : '')
    );
  }

  // Ids "legacy" derivados del título, como los que devolvía la búsqueda antes del fix.
  const legacy = process.argv[3] || 'madagascar-3-los-fugitivos';
  const legacyDetail = await CatalogService.getById(legacy);
  console.log(
    `\n${legacyDetail ? '✔' : '✘ 404'} legacy id="${legacy}"` +
    (legacyDetail ? ` → "${legacyDetail.title}" servers=${legacyDetail.servers?.length || 0}` : '')
  );
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
