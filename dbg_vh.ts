import 'dotenv/config';
import { mintDirect } from './src/services/directResolver';
import { streamClient } from './src/utils/httpClient';
(async () => {
  const m = await mintDirect('https://vidhideplus.com/v/ncax76r9n4d7', { fresh: true });
  if (!m) { console.log('no se pudo acuñar'); return; }
  console.log('maestro:', m.url.slice(0, 90));
  const master = await streamClient.get(m.url, { headers: { Referer: m.referer }, responseType: 'text', timeout: 20000, validateStatus: () => true });
  const uris = String(master.data).split(/\r?\n/).map(l=>l.trim()).filter(l=>l && !l.startsWith('#'));
  const varUrl = new URL(uris[0], m.url).toString();
  const variante = await streamClient.get(varUrl, { headers: { Referer: m.referer }, responseType: 'text', timeout: 20000, validateStatus: () => true });
  const segs = String(variante.data).split(/\r?\n/).map(l=>l.trim()).filter(l=>l && !l.startsWith('#')).slice(0, 4);
  console.log(`\n4 segmentos pedidos DIRECTAMENTE al CDN desde esta máquina:`);
  for (const s of segs) {
    const u = new URL(s, varUrl).toString();
    const t0 = Date.now();
    try {
      const r = await streamClient.get(u, { headers: { Referer: m.referer }, responseType: 'arraybuffer', timeout: 45000, validateStatus: () => true });
      console.log(`   HTTP ${r.status} · ${(r.data as any).byteLength} bytes · ${((Date.now()-t0)/1000).toFixed(2)}s`);
    } catch (e: any) {
      console.log(`   ERROR ${e.code || e.message} · ${((Date.now()-t0)/1000).toFixed(2)}s`);
    }
  }
})();
