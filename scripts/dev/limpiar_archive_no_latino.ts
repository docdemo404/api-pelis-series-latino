/**
 * RETIRAR LAS FICHAS DE ARCHIVE.ORG QUE NO ESTÁN EN ESPAÑOL LATINO.
 *
 * El scraper de archive.org entró sin filtro de idioma y se colaron películas rusas —«Brat 2»,
 * «Приключения Буратино»—. El filtro ya está puesto (`esEnEspanolLatino`), pero lo que se guardó
 * antes sigue guardado: un filtro nuevo no limpia el pasado.
 *
 * Se le vuelve a preguntar a archive.org por cada ficha `archive-*` y se aplica la MISMA función
 * que usa el scraper. Así no hay dos criterios que puedan separarse: lo que hoy no entraría,
 * hoy sale.
 *
 *   npx ts-node -T scripts/dev/limpiar_archive_no_latino.ts [--apply]
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { httpClient } from '../../src/utils/httpClient';
import { esEnEspanolLatino } from '../../src/services/realScraperService';
import { CatalogService } from '../../src/services/catalogService';

const db = getSupabaseAdmin();
const apply = process.argv.includes('--apply');

(async () => {
  const { data, error } = await db
    .from('media_items').select('id,title,type').like('id', 'archive-%');
  if (error) { console.error('no se pudo leer:', error.message); return; }

  const filas = (data || []) as any[];
  console.log(`${filas.length} fichas de archive.org${apply ? '' : ' (ENSAYO)'}\n`);

  const fuera: Array<{ id: string; title: string; type: string; motivo: string }> = [];

  for (const fila of filas) {
    const identifier = String(fila.id).replace(/^archive-/, '');
    let md: any = null;
    try {
      const r = await httpClient.get(`https://archive.org/metadata/${encodeURIComponent(identifier)}`,
        { timeout: 20000, validateStatus: () => true } as any);
      md = r.status < 400 ? (r.data as any)?.metadata : null;
    } catch { /* sin respuesta */ }

    if (!md) {
      // No se pudo preguntar: NO se retira. Un fallo nuestro no es una baja suya.
      console.log(`   ? ${String(fila.title).slice(0, 44).padEnd(44)} sin respuesta de archive.org, se deja`);
      continue;
    }

    if (esEnEspanolLatino(md)) {
      console.log(`   ✓ ${String(fila.title).slice(0, 44).padEnd(44)} idioma=${String(md.language || '(no declara)')}`);
      continue;
    }
    fuera.push({
      id: fila.id, title: fila.title, type: fila.type,
      motivo: `idioma=${String(md.language || '(no declara)')}`,
    });
    console.log(`   ✗ ${String(fila.title).slice(0, 44).padEnd(44)} ${`idioma=${String(md.language || '(no declara)')}`}`);
  }

  console.log(`\n${fuera.length} ficha(s) no cumplen la regla de idioma.`);
  if (!fuera.length) return;

  if (!apply) { console.log('   (ensayo — con --apply se borran)'); return; }

  for (const f of fuera) {
    const { error: e } = await db.from('media_items').delete().eq('id', f.id);
    if (e) { console.warn(`   ⚠ ${f.id}: ${e.message}`); continue; }
    await CatalogService.invalidateItem({ id: f.id, type: f.type } as any).catch(() => {});
  }
  await CatalogService.invalidateListings().catch(() => {});
  console.log(`   ${fuera.length} borradas y caché purgado.`);
})();
