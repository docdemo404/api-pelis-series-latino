/**
 * ¿Está el catálogo partido en dos por el esquema de identificador?
 *
 * El scraper devuelve hoy `ver-pelicula-<slug>` / `ver-serie-<slug>`; en la base conviven filas
 * con ese prefijo y filas con el slug pelado. Si el mismo título está en las dos formas, el crawl
 * escribe en una y la verificación acumula en la otra.
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';

const pelar = (id: string) => id.replace(/^ver-(pelicula|serie|anime|dorama)-/, '').replace(/-\d+$/, '');

(async () => {
  let ultimoId = '';
  const filas: any[] = [];
  for (;;) {
    const { data, error } = await supabase.from('media_items')
      .select('id,title,type,has_streams,source_url,updated_at').gt('id', ultimoId).order('id').limit(1000);
    if (error) { console.error(error.message); break; }
    if (!data?.length) break;
    ultimoId = data[data.length - 1].id;
    filas.push(...data);
    process.stderr.write(`  …${filas.length}\r`);
  }

  const conPrefijo = filas.filter(r => /^ver-(pelicula|serie|anime|dorama)-/.test(r.id));
  const fc = filas.filter(r => /^fc-|^\d{4}-\d{2}-/.test(r.id));
  console.log(`\nTotal filas              ${filas.length}`);
  console.log(`  con prefijo ver-…      ${conPrefijo.length}`);
  console.log(`  de FuegoCine           ${fc.length}`);
  console.log(`  slug pelado (tioplus)  ${filas.length - conPrefijo.length - fc.length}`);

  // Parejas: mismo slug pelado, ids distintos
  const porSlug: Record<string, any[]> = {};
  for (const r of filas) {
    if (/^fc-|^\d{4}-\d{2}-/.test(r.id)) continue;
    const k = `${r.type}:${pelar(r.id)}`;
    (porSlug[k] ??= []).push(r);
  }
  const parejas = Object.entries(porSlug).filter(([, v]) => v.length > 1);
  console.log(`\nGRUPOS con más de una fila para el mismo slug: ${parejas.length}`);
  const filasImplicadas = parejas.reduce((a, [, v]) => a + v.length, 0);
  console.log(`  filas implicadas: ${filasImplicadas}`);

  let partidos = 0;
  for (const [k, v] of parejas) {
    const buenas = v.filter(r => r.has_streams === true).length;
    if (buenas > 0 && buenas < v.length) partidos++;
  }
  console.log(`  grupos donde UNA reproduce y otra no (el duplicado tapa a la buena): ${partidos}`);

  console.log(`\nEjemplos:`);
  for (const [k, v] of parejas.slice(0, 12)) {
    console.log(`  ${k}`);
    for (const r of v) console.log(`      ${r.id.padEnd(52)} has_streams=${String(r.has_streams).padEnd(5)} act=${String(r.updated_at).slice(0, 10)}  «${r.title}»`);
  }
})();
