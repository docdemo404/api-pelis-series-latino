import 'dotenv/config';
import { mintDirect } from '../../src/services/directResolver';
import { comprobarDestino } from '../../src/services/playbackHealth';
const t = async <T>(n: string, f: () => Promise<T>) => { const i = Date.now(); const r = await f(); console.log(`   ${n.padEnd(28)} ${String(Date.now()-i).padStart(6)} ms`); return r; };
(async () => {
  const e = 'https://vidhideplus.com/v/lnqd9ouzauym';
  const m: any = await t('mintDirect', () => mintDirect(e));
  console.log('   →', m ? `${m.kind} ${String(m.url).slice(0,64)}` : 'null');
  if (!m) return;
  const v: any = await t('comprobarDestino', () => comprobarDestino(m, { entregaLiteral: false, embedUrl: e }));
  console.log('   →', JSON.stringify({ veredicto: v.veredicto, motivo: v.motivo }));
})();
