/**
 * Radiografía de la metadata del catálogo: qué campo falta, en cuántas fichas, y
 * cuántas se quedaron rotuladas en inglés.
 *
 *   npx ts-node scripts/dev/diag_metadatos.ts
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';

const PUBLICIDAD = /fuegocine|online gratis|tioplus|cinecalidad|ver .* online/i;

/** Marcadores exclusivos de cada idioma (no comparten ninguno entre sí). */
const ES = /\b(que|de|la|el|los|las|una|con|para|por|su|es|se|del|pero|cuando|más|año|años|película|vida|hombre|mujer)\b/gi;
const EN = /\b(the|and|of|to|in|is|his|her|with|for|from|when|after|their|who|but|about|into|while)\b/gi;

function cuenta(re: RegExp, t: string): number {
  return (t.match(re) || []).length;
}

/** Un texto está en inglés si sus marcadores ingleses ganan claramente a los españoles. */
function enIngles(texto: string | null): boolean {
  const t = (texto || '').trim();
  if (t.length < 40) return false;
  const es = cuenta(ES, t), en = cuenta(EN, t);
  return en >= 3 && en > es * 2;
}

(async () => {
  const rows: any[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('media_items')
      .select('id,tmdb_id,type,title,original_title,overview,logo,poster,backdrop,trailer,runtime,genres,director,content_rating,cast_data,rating,release_date,metadata_source,aliases,total_seasons')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    process.stderr.write(`\r  leídas ${rows.length}`);
    if (data.length < PAGE) break;
  }
  process.stderr.write('\n');

  const n = rows.length;
  const pct = (k: number) => `${String(k).padStart(6)}  ${(k * 100 / n).toFixed(1).padStart(5)}%`;
  const vacio = (v: any) => v === null || v === undefined || v === '' ||
    (Array.isArray(v) && v.length === 0);

  const sinMatch = rows.filter(r => r.tmdb_id < 0);
  const conMatch = rows.filter(r => r.tmdb_id > 0);

  console.log(`\nTOTAL fichas                     ${n}`);
  console.log(`  con id real de TMDB            ${pct(conMatch.length)}`);
  console.log(`  con id SINTÉTICO (sin match)   ${pct(sinMatch.length)}`);

  const fuentes = new Map<string, number>();
  for (const r of rows) fuentes.set(r.metadata_source || 'null', (fuentes.get(r.metadata_source || 'null') || 0) + 1);
  console.log(`\nmetadata_source:`);
  for (const [k, v] of [...fuentes].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(10)} ${pct(v)}`);

  console.log(`\nCAMPOS VACÍOS (todo el catálogo):`);
  const campos: Array<[string, (r: any) => boolean]> = [
    ['logo', r => vacio(r.logo)],
    ['backdrop', r => vacio(r.backdrop)],
    ['poster', r => vacio(r.poster)],
    ['overview', r => vacio(r.overview)],
    ['overview = anuncio de la web', r => !vacio(r.overview) && PUBLICIDAD.test(r.overview)],
    ['trailer', r => vacio(r.trailer)],
    ['runtime', r => !r.runtime],
    ['genres', r => vacio(r.genres)],
    ['director', r => vacio(r.director)],
    ['content_rating', r => vacio(r.content_rating)],
    ['cast_data', r => vacio(r.cast_data)],
    ['rating = 0', r => !r.rating],
    ['release_date', r => vacio(r.release_date)],
    ['aliases', r => vacio(r.aliases)],
  ];
  for (const [nombre, test] of campos) {
    const total = rows.filter(test).length;
    const conId = conMatch.filter(test).length;
    console.log(`  ${nombre.padEnd(28)} ${pct(total)}   (de las que tienen id TMDB: ${conId})`);
  }

  console.log(`\nIDIOMA:`);
  const ovEn = rows.filter(r => enIngles(r.overview));
  console.log(`  sinopsis en inglés             ${pct(ovEn.length)}`);
  const tituloIgualOriginal = rows.filter(r =>
    r.title && r.original_title && r.title.trim().toLowerCase() === r.original_title.trim().toLowerCase());
  console.log(`  title === original_title       ${pct(tituloIgualOriginal.length)}  (candidato a "sin traducir")`);

  console.log(`\nMUESTRA · sinopsis en inglés (20):`);
  for (const r of ovEn.slice(0, 20)) {
    console.log(`  [${r.tmdb_id}] ${r.type} ${r.title} :: ${String(r.overview).slice(0, 70)}…`);
  }
  console.log(`\nMUESTRA · sin logo pero con id TMDB (15):`);
  for (const r of conMatch.filter(r => vacio(r.logo)).slice(0, 15)) {
    console.log(`  [${r.tmdb_id}] ${r.type} ${r.title}`);
  }
  console.log(`\nMUESTRA · sin match en TMDB (15):`);
  for (const r of sinMatch.slice(0, 15)) {
    console.log(`  [${r.tmdb_id}] ${r.type} ${r.title} | orig=${r.original_title}`);
  }
})();
