import { RealScraperService } from '../../src/services/realScraperService';

/** Comprueba que scrapeDetail adjunta los campos de vídeo directo a cada servidor. */
async function main() {
  const url = process.argv[2] || 'https://tioplus.app/pelicula/arthur-el-soltero-de-oro';
  const detail = await RealScraperService.scrapeDetail(url);
  console.log('titulo:', detail?.title, '| servidores:', detail?.servers?.length || 0);
  for (const s of detail?.servers || []) {
    console.log(' -', String(s.name).slice(0, 30).padEnd(30), (s.direct_mode || 'embed').padEnd(7), (s.direct_kind || '-').padEnd(4), String(s.direct_host || '-').padEnd(20), String(s.embed_url).slice(0, 46));
  }
}
main().then(() => process.exit(0));
