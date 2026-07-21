import { CatalogService } from './src/services/catalogService';

async function testGruFix() {
  console.log('1. Testing "gru-3-mi-villano-favorito"...');
  const res3 = await CatalogService.getById('gru-3-mi-villano-favorito');
  console.log('Result Gru 3:', { id: res3?.id, tmdb_id: res3?.tmdb_id, title: res3?.title, serversCount: res3?.servers?.length });

  console.log('\n2. Testing "gru-4-mi-villano-favorito"...');
  const res4 = await CatalogService.getById('gru-4-mi-villano-favorito');
  console.log('Result Gru 4:', { id: res4?.id, tmdb_id: res4?.tmdb_id, title: res4?.title, serversCount: res4?.servers?.length });
}

testGruFix();
