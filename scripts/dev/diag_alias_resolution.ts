/**
 * Diagnóstico de la resolución de alias/slug → fila canónica del catálogo.
 *
 * Reproduce el reporte de desalineación de ids (slugs cortos de TioPlus apuntando a la
 * ficha equivocada) ejecutando el resolutor REAL de CatalogService contra la DB.
 *
 *   npx ts-node --transpile-only scripts/dev/diag_alias_resolution.ts
 */
import 'dotenv/config';
import { CatalogService } from '../../src/services/catalogService';

// slug pedido → id canónico esperado en media_items
const CASES: Array<[string, string]> = [
  ['shrek', '2025-04-shrek-2001-html'],
  ['shrek-2', '2025-04-shrek-2-2004-html'],
  ['shrek-tercero', '2025-04-shrek-tercero-2007-html'],
  ['shrek-4-para-siempre', '2025-04-shrek-4-para-siempre-2010-html'],
  ['2025-04-shrek-2001-html', '2025-04-shrek-2001-html'],
  ['shrek-especial-de-halloween', 'shrek-especial-de-halloween'],
  ['2025-07-scarface-1983-html', '2025-07-scarface-1983-html']
];

(async () => {
  let failures = 0;

  for (const [slug, expected] of CASES) {
    const match = await (CatalogService as any).findDbRowScored(slug);
    const gotId = match?.row?.id || null;
    const score = match?.score ?? 0;
    const ok = gotId === expected;
    if (!ok) failures++;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${slug.padEnd(30)} → ${String(gotId).padEnd(40)} (score ${score}) ${
        ok ? '' : `[esperado ${expected}]`
      }`
    );
  }

  console.log(`\n${CASES.length - failures}/${CASES.length} casos correctos.`);
  process.exit(failures === 0 ? 0 : 1);
})();
