/**
 * ¿RETIRA LA API UN TÍTULO AL INSTANTE CUANDO EL REPRODUCTOR DICE QUE NO SE VE?
 *
 * Simula lo que hace la app cuando agota todas las fuentes (`outcome: failed`) y comprueba, por
 * producción y sin tocar la base a mano, que la ficha deja de anunciarse. Se mide ANTES y DESPUÉS
 * para que el resultado no dependa de suponer nada.
 *
 *   npx ts-node -T scripts/dev/diag_retirada_instantanea.ts <id-de-la-ficha>
 */
import 'dotenv/config';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';
import { supabase } from '../../src/services/supabaseService';

const API = 'https://api-pelis-series-latino-gilt.vercel.app';
const ID = process.argv[2] || 'el-show-de-truman-una-vida-en-directo';

const get = (u: string) => httpClient.get(u, {
  headers: { 'User-Agent': USER_AGENT }, timeout: 45000, responseType: 'text',
  transformResponse: [(d: unknown) => d], validateStatus: () => true, maxRedirects: 5,
} as any);

async function estado(etiqueta: string) {
  const { data } = await supabase.from('media_items')
    .select('has_streams,servers').eq('id', ID).maybeSingle();
  const sellados = ((data as any)?.servers ?? []).filter((s: any) => s?.verified_at).length;
  const total = ((data as any)?.servers ?? []).length;

  const r = await get(`${API}/api/v1/media/${encodeURIComponent(ID)}/streams`);
  let publicados = 0;
  try { const j = JSON.parse(String(r.data || '{}')); publicados = (j?.data?.servers ?? j?.servers ?? []).length; } catch {}

  console.log(`${etiqueta}`);
  console.log(`   has_streams        ${(data as any)?.has_streams}`);
  console.log(`   servidores sellados ${sellados}/${total}`);
  console.log(`   la API publica      ${publicados} servidor(es)`);
  return { has: (data as any)?.has_streams, sellados, publicados };
}

(async () => {
  console.log(`Ficha: ${ID}\n`);
  const antes = await estado('── ANTES del aviso');

  console.log('\n── se manda el aviso que manda la app al agotar todas las fuentes');
  const r = await httpClient.post(`${API}/api/v1/report`, {
    item_id: ID, outcome: 'failed', reason: 'all_sources_failed', app_version: 'diag',
  }, { timeout: 60000, validateStatus: () => true } as any);
  console.log(`   POST /api/v1/report → http=${r.status} ${JSON.stringify(r.data)}`);

  console.log('');
  const despues = await estado('── DESPUÉS del aviso');

  console.log('\n──────────────────────────────');
  const ok = despues.publicados === 0 && despues.sellados === 0;
  console.log(ok
    ? `   ✓ retirada instantánea: de ${antes.publicados} servidor(es) publicados a 0, sin esperar a ningún barrido`
    : `   ✗ sigue publicando ${despues.publicados} servidor(es)`);
  console.log('   (los embeds NO se borran: --verificar los sellará otra vez si vuelven a entregar)');
})();
