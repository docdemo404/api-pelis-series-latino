const { CatalogService } = require('./dist/services/catalogService');

async function testLocalGetById() {
  console.log('Testing 94997...');
  const res94997 = await CatalogService.getById('94997');
  console.log('94997 Title:', res94997?.title, 'Type:', res94997?.type);

  console.log('Testing 60625...');
  const res60625 = await CatalogService.getById('60625');
  console.log('60625 Title:', res60625?.title, 'Type:', res60625?.type);
}

testLocalGetById();
