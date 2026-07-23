/**
 * Verificación end-to-end de los dos problemas reportados por el cliente:
 *   1. slugs cortos que devolvían la ficha equivocada en /api/v1/media/:id
 *   2. `servers: []` en el detalle aunque /streams sí devolviera reproductores
 *
 *   npx ts-node --transpile-only scripts/dev/diag_detail_contract.ts [baseUrl]
 */
import axios from 'axios';

const BASE = process.argv[2] || 'http://localhost:3000';

async function get(path: string): Promise<any> {
  const { data } = await axios.get(`${BASE}${path}`, { timeout: 60000, validateStatus: () => true });
  return data;
}

async function main() {
  let failures = 0;
  const expect = (label: string, ok: boolean, detail: string) => {
    if (!ok) failures++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: ${detail}`);
  };

  // --- 1. Alineación de slug → ficha canónica -----------------------------------------
  const aliasCases: Array<[string, string]> = [
    ['shrek', 'Shrek'],
    ['shrek-2', 'Shrek 2'],
    ['shrek-tercero', 'Shrek Tercero'],
    ['shrek-4-para-siempre', 'Shrek 4: Para Siempre']
  ];

  for (const [slug, expectedTitle] of aliasCases) {
    const res = await get(`/api/v1/media/${slug}`);
    const title = res?.data?.title;
    expect(`/media/${slug}`, title === expectedTitle, `title="${title}" id=${res?.data?.id}`);
  }

  // --- 2. Enlaces en el detalle --------------------------------------------------------
  const id = '2025-07-scarface-1983-html';

  const fast = await get(`/api/v1/media/${id}?streams=fast`);
  const fastServers = (fast?.data?.servers || []).length;
  expect(`/media/${id}?streams=fast`, fastServers > 0, `${fastServers} servidores, status=${fast?.data?.streams?.status}`);

  const plain = await get(`/api/v1/media/${id}`);
  const plainServers = (plain?.data?.servers || []).length;
  expect(
    `/media/${id} (tras resolver)`,
    plainServers > 0 && plain?.data?.streams?.status === 'ready',
    `${plainServers} servidores, status=${plain?.data?.streams?.status}`
  );

  const streams = await get(`/api/v1/media/${id}/streams`);
  const subServers = (streams?.data?.servers || []).length;
  expect(`/media/${id}/streams`, subServers > 0, `${subServers} servidores`);
  expect('detalle y /streams coinciden', plainServers === subServers, `${plainServers} vs ${subServers}`);

  console.log(failures === 0 ? '\nTodo correcto.' : `\n${failures} comprobaciones fallidas.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
