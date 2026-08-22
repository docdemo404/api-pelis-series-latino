import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';

/**
 * QUÉ SERIES NO SE ANUNCIAN POR NO TENER FICHA OFICIAL DE TMDB.
 *
 * En la app solo salen obras oficiales: `veredictoDisponibilidad` esconde toda ficha cuyo
 * `tmdb_id` no sea positivo, por muchos capítulos con vídeo que tenga. Una serie mal emparejada
 * no «se ve peor»: no se ve. Y no aparece en ningún recuento de disponibilidad, así que sin este
 * listado el catálogo parece sano mientras la mitad de sus series está escondida.
 *
 * Es como se encontró el agujero de las series agrupadas de FuegoCine: 37 de sus 59 series
 * guardadas con id sintético —«El Pingüino», «Invencible», «IT: Bienvenidos a Derry»— porque su
 * página de origen es la de un capítulo y nadie le pasaba al matcher de qué capítulo era.
 *
 * Se arreglan con:  npm run repair:catalog -- --verify --apply --ids=<los de aquí>
 */
(async () => {
  const db = getSupabaseAdmin();
  const filas: any[] = [];
  for (let desde = 0; ; desde += 500) {
    // Con `.order()`: paginar sin él en Postgres se salta filas y repite otras.
    const { data, error } = await db
      .from('media_items')
      .select('id,title,tmdb_id,type,release_date,metadata_source,source_url,seasons')
      .eq('type', 'tvseries').order('id').range(desde, desde + 499);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 500) break;
  }

  const capitulos = (r: any) => (r.seasons || []).reduce((n: number, t: any) => n + (t?.episodes || []).length, 0);
  const conVideo = (r: any) => (r.seasons || []).reduce(
    (n: number, t: any) => n + (t?.episodes || []).filter((e: any) => (e?.servers || []).length).length, 0);
  const sinFicha = filas.filter(r => !(r.tmdb_id > 0));

  console.log(`series en el catálogo: ${filas.length}`);
  console.log(`sin ficha oficial de TMDB (escondidas): ${sinFicha.length}` +
    ` · ${sinFicha.reduce((n, r) => n + conVideo(r), 0)} capítulos con vídeo que nadie puede ver\n`);
  for (const r of sinFicha) {
    console.log(`  ${r.id}  tmdb=${r.tmdb_id}  «${r.title}»  ${conVideo(r)}/${capitulos(r)} capítulos con vídeo`);
    console.log(`      ${r.source_url || 'sin página de origen'}`);
  }
  if (sinFicha.length) console.log(`\nids: ${sinFicha.map(r => r.id).join(',')}`);
})();
