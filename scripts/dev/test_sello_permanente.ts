/**
 * ¿PUEDE EL QUE SIRVE SELLAR UN FICHERO PERMANENTE SIN ESPERAR AL BARRIDO?
 *
 * Es lo único que hacía falta para que la fuente propia no desapareciera entre vuelta y vuelta de
 * `verificarPermanentes`. Se le pasa a `revisarServidores` la url manual real del 1x01 de
 * «Breaking Bad» SIN sello y se comprueba que vuelve sellada y publicable.
 *
 *   npx tsx scripts/dev/test_sello_permanente.ts
 */
import 'dotenv/config';
import { revisarServidores } from '../../src/services/playbackHealth';
import { paraElCliente } from '../../src/services/streamSorter';
import { ServerOption } from '../../src/types';

const URL_MANUAL = 'https://video.gumlet.io/6a8a793acad008e012b93b62/6a8a7990cad008e012b93c49/main.m3u8';

const manualSinSello = {
  id: 'manual-breaking-bad-2008_s1e1_manual_0',
  name: 'Manual 1',
  quality: '', language: '',
  status: 'online',
  source_id: 'manual',
  direct_kind: 'hls',
  direct_mode: 'public',
  embed_url: URL_MANUAL,
  direct_stream: URL_MANUAL,
  // verified_at: ausente a propósito — es el estado en que se quedaba en la fila
} as unknown as ServerOption;

(async () => {
  console.log(`ANTES   sello=${(manualSinSello as any).verified_at || 'NO'}  publicable=${paraElCliente([manualSinSello]).length === 1}`);

  const t0 = Date.now();
  const [tras] = await revisarServidores([manualSinSello], { presupuestoMs: 8000, maximo: 8, objetivoSellados: 3 });
  const ms = Date.now() - t0;

  const publicable = paraElCliente([tras]).length === 1;
  console.log(`DESPUÉS sello=${tras.verified_at || 'NO'}  status=${tras.status}  publicable=${publicable}  (${ms} ms)`);

  // La url se conserva intacta: sellar no puede reescribir a dónde apunta.
  const mismaUrl = String((tras as any).direct_stream) === URL_MANUAL;
  console.log(`url intacta: ${mismaUrl}`);

  const ok = publicable && Boolean(tras.verified_at) && mismaUrl && ms < 8000;
  console.log(ok ? '\nOK — el que sirve ya puede sellar un fichero permanente' : '\nFALLA');
  process.exit(ok ? 0 : 1);
})();
