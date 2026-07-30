/** ¿Cuántas fichas tienen un tmdb_id que su propia página desmiente, y qué costaría exigir respaldo? */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { TmdbService } from '../../src/services/tmdbService';
import { RealScraperService } from '../../src/services/realScraperService';
import { yearFromSlug } from '../../src/utils/text';
import { ContentType } from '../../src/types';

const db = getSupabaseAdmin();
const N = parseInt(process.argv[2] || '150', 10);

(async () => {
  const { count: total } = await db.from('media_items').select('id', { count: 'exact', head: true });
  const { count: srcMeta } = await db.from('media_items').select('id', { count: 'exact', head: true }).eq('metadata_source', 'source');
  const { count: sinAno } = await db.from('media_items').select('id', { count: 'exact', head: true }).or('release_date.is.null,release_date.eq.');
  const { count: sintetico } = await db.from('media_items').select('id', { count: 'exact', head: true }).lt('tmdb_id', 0);
  console.log(`catálogo=${total} · metadata de la fuente=${srcMeta} · sin año=${sinAno} · tmdb sintético=${sintetico}\n`);

  // Muestra aleatoria de fichas CON metadata de TMDB (las que pueden tener póster ajeno).
  const { data } = await db
    .from('media_items')
    .select('id,tmdb_id,type,title,original_title,release_date,poster,source_url,source_urls,metadata_source')
    .eq('metadata_source', 'tmdb')
    .gt('tmdb_id', 0)
    .limit(3000);
  const pool = (data || []).sort(() => Math.random() - 0.5).slice(0, N);

  let okMismo = 0, cambia = 0, sinRespaldo = 0, sinPagina = 0, sinMatch = 0;
  const ejemplos: string[] = [];

  const CONC = 5;
  for (let i = 0; i < pool.length; i += CONC) {
    await Promise.all(pool.slice(i, i + CONC).map(async (r: any) => {
      const url = r.source_url || (r.source_urls || [])[0];
      if (!url) { sinPagina++; return; }
      const s = await RealScraperService.fetchSourceSignals(url).catch(() => null);
      if (!s || !s.title) { sinPagina++; return; }

      const type: ContentType = r.type === 'tvseries' ? 'tvseries' : 'movie';
      const year = s.year || String(r.release_date || '').slice(0, 4) || yearFromSlug(r.id);
      const m = await TmdbService.resolveTmdb(s.title, type, year || undefined, r.id, {
        originalTitle: s.originalTitle, imageHint: s.imageHint
      }).catch(() => null);
      if (!m || !m.matched) { sinMatch++; return; }

      if (m.id === r.tmdb_id) { okMismo++; if (!m.verified) sinRespaldo++; return; }
      cambia++;
      if (ejemplos.length < 12) {
        const nd = await TmdbService.getTmdbDetails(m.id, m.type).catch(() => null);
        ejemplos.push(
          `${r.id}\n     guardado: "${r.title}" (${String(r.release_date).slice(0, 4)}) tmdb=${r.tmdb_id}` +
          `\n     su página dice: "${s.title}" (${s.year || '?'}) orig "${s.originalTitle || '-'}"` +
          `\n     → debería ser: "${nd?.title || nd?.name}" tmdb=${m.id} (score ${m.score.toFixed(2)}, respaldado=${m.verified})`
        );
      }
    }));
  }

  const revisadas = okMismo + cambia;
  console.log(`Muestra de ${pool.length} fichas con metadata de TMDB:`);
  console.log(`   coinciden con su página:      ${okMismo}`);
  console.log(`   su página dice OTRA ficha:    ${cambia}  ← póster y sinopsis equivocados`);
  console.log(`   sin página legible:           ${sinPagina}`);
  console.log(`   sin match:                    ${sinMatch}`);
  console.log(`   de las que coinciden, SIN respaldo independiente: ${sinRespaldo}`);
  if (revisadas) console.log(`\n   tasa de error ≈ ${((cambia / revisadas) * 100).toFixed(1)}%  → ~${Math.round((cambia / revisadas) * (total || 0))} fichas del catálogo`);
  console.log('\nEjemplos:');
  for (const e of ejemplos) console.log(`   · ${e}`);
})();
