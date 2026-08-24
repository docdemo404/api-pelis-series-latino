/**
 * ¿Cuántas fichas del catálogo llevan metadata que NO viene de TMDB, y de qué fuente son?
 *
 * Una fila con `metadata_source='source'` (o tmdb_id ≤ 0) es una ficha que `enrichMediaItem`
 * no pudo respaldar: se quedó con el título, la sinopsis y la carátula que publicó la web.
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';

function fuenteDe(row: any): string {
  const urls: string[] = [String(row.source_url || ''), ...((row.source_urls || []) as string[])].filter(Boolean);
  const u = urls.join(' ');
  if (/fuegocine|blogfc|repfuegocinefree/i.test(u)) return 'fuegocine';
  if (/archive\.org/i.test(u)) return 'archive';
  if (/cinecalidad/i.test(u)) return 'cinecalidad';
  if (/moviedays|zonaaps/i.test(u)) return 'moviedays';
  if (/tioplus/i.test(u)) return 'tioplus';
  if (/^\d{4}-\d{2}-.+-html$/.test(String(row.id || ''))) return 'fuegocine';
  return u ? 'otra' : 'sin-pagina';
}

(async () => {
  const cols = 'id,tmdb_id,type,title,overview,poster,release_date,metadata_source,source_url,source_urls,has_streams';
  const filas: any[] = [];
  const PAGE = 1000;
  for (let desde = 0; ; desde += PAGE) {
    const { data, error } = await supabase.from('media_items')
      .select(cols).order('id', { ascending: true }).range(desde, desde + PAGE - 1);
    if (error) { console.log('ERROR', error.message); break; }
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < PAGE) break;
  }
  console.log(`filas totales: ${filas.length}`);

  const sinTmdb = filas.filter(r => r.metadata_source === 'source' || !r.tmdb_id || r.tmdb_id <= 0);
  console.log(`sin metadata de TMDB: ${sinTmdb.length}  (${(sinTmdb.length / (filas.length || 1) * 100).toFixed(1)}%)`);

  const porFuente: Record<string, { total: number; sin: number; conStreams: number }> = {};
  for (const r of filas) {
    const f = fuenteDe(r);
    porFuente[f] ||= { total: 0, sin: 0, conStreams: 0 };
    porFuente[f].total++;
    if (r.metadata_source === 'source' || !r.tmdb_id || r.tmdb_id <= 0) {
      porFuente[f].sin++;
      if (r.has_streams) porFuente[f].conStreams++;
    }
  }
  console.log('\nfuente            total   sin-tmdb   de esas, con servidores');
  for (const [f, v] of Object.entries(porFuente).sort((a, b) => b[1].sin - a[1].sin)) {
    console.log(`  ${f.padEnd(14)} ${String(v.total).padStart(6)} ${String(v.sin).padStart(10)} ${String(v.conStreams).padStart(12)}`);
  }

  const conSinopsisDeFuente = filas.filter(r => /FuegoCine|online gratis|TioPlus|Cinecalidad/i.test(String(r.overview || '')));
  console.log(`\nfichas con sinopsis publicitaria de la web: ${conSinopsisDeFuente.length}`);
  for (const r of conSinopsisDeFuente.slice(0, 15)) {
    console.log(`   ${r.id} | tmdb=${r.tmdb_id} | "${r.title}" ${r.release_date} | meta=${r.metadata_source}`);
    console.log(`      ${String(r.overview).slice(0, 110)}`);
  }
})();
