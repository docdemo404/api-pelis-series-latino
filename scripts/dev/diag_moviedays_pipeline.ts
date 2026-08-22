import 'dotenv/config';
import { RealScraperService } from '../../src/services/realScraperService';
import { TmdbService } from '../../src/services/tmdbService';

(async () => {
  const items = await RealScraperService.scrapeMoviedaysLatest('movie', 3);
  console.log('recolectados:', items.length);
  for (const it of items) {
    console.log(`\n--- ${it.title}`);
    console.log('   _source_url crudo:', it._source_url);
    const enr = await TmdbService.enrichMediaItem(it, { skipSeasons: true });
    console.log('   tras enrich: tmdb=', enr.tmdb_id, 'metadata_source=', enr.metadata_source, 'id=', enr.id);
    console.log('   _source_url tras enrich:', (enr as any)._source_url, '| _tioplus_url:', (enr as any)._tioplus_url);
    const pagina = (enr as any)._tioplus_url || enr._source_url;
    if (!pagina) { console.log('   >>> SE CAE: sin pagina'); continue; }
    const detalle = await RealScraperService.scrapeDetail(pagina).catch((e: any) => { console.log('   scrapeDetail lanzó', e.message); return null; });
    console.log('   detalle:', detalle ? `${detalle.servers?.length || 0} servidores` : 'NULL');
    for (const s of detalle?.servers || []) console.log('      ·', s.name, '| embed=', String(s.embed_url).slice(0, 50), '| direct=', String(s.direct_stream || '-').slice(0, 40));
  }
  process.exit(0);
})();
