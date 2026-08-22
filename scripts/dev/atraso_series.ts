import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { paraElCliente } from '../../src/services/streamSorter';

/**
 * CUÁNTAS SERIES ESTÁN A MEDIAS, y por qué.
 *
 * Distingue tres cosas que no son lo mismo y que se confunden mirando solo «le faltan capítulos»:
 *   · SIN MIRAR      — nadie ha preguntado nunca por ese capítulo. Es trabajo pendiente.
 *   · MIRADO Y VACÍO — se preguntó y la fuente no dio nada. No es trabajo, es que no está.
 *   · MIRADO SIN SELLO — dio una url que no llegó a demostrar que reproduce. Se reintenta.
 */
(async () => {
  const db = getSupabaseAdmin();
  const filas: any[] = [];
  for (let desde = 0; ; desde += 500) {
    const { data, error } = await db
      .from('media_items').select('id,title,seasons').eq('type', 'tvseries')
      .order('id').range(desde, desde + 499);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 500) break;
  }

  let completas = 0, aMedias = 0, vacias = 0;
  let capTotal = 0, capOk = 0, capSinMirar = 0, capVacio = 0, capSinSello = 0;
  const peores: Array<{ id: string; title: string; ok: number; total: number; sinMirar: number }> = [];

  for (const r of filas) {
    let total = 0, ok = 0, sinMirar = 0, vacio = 0, sinSello = 0;
    for (const t of (r.seasons || [])) {
      for (const e of (t?.episodes || [])) {
        total++;
        if (paraElCliente(e?.servers).length) { ok++; continue; }
        if (!e?.checked_at) sinMirar++;
        else if (!(e?.servers || []).length) vacio++;
        else sinSello++;
      }
    }
    capTotal += total; capOk += ok; capSinMirar += sinMirar; capVacio += vacio; capSinSello += sinSello;
    if (!total || !ok) vacias++;
    else if (ok === total) completas++;
    else { aMedias++; peores.push({ id: r.id, title: r.title, ok, total, sinMirar }); }
  }

  console.log(`series en el catálogo: ${filas.length}`);
  console.log(`  completas (todos los capítulos se ven): ${completas}`);
  console.log(`  a medias:                               ${aMedias}`);
  console.log(`  sin ningún capítulo que se vea:         ${vacias}`);
  console.log(`\ncapítulos: ${capTotal} · se ven ${capOk} · sin mirar ${capSinMirar} · mirados y vacíos ${capVacio} · con url sin sellar ${capSinSello}`);
  console.log(`\nlas que más lejos están de terminarse:`);
  peores.sort((a, b) => b.sinMirar - a.sinMirar).slice(0, 15)
    .forEach(p => console.log(`  ${p.id.padEnd(12)} ${String(p.ok + '/' + p.total).padEnd(8)} sin mirar: ${String(p.sinMirar).padEnd(4)} «${p.title}»`));
  process.exit(0);
})();
