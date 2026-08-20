import 'dotenv/config';
import { streamClient } from '../../src/utils/httpClient';
const DESDE = 1_000_000;
const URLS = [
  'https://files.eintim.me/content/cdn/IpQexNpEuFDB.mp4',
  'https://files.eintim.me/content/cdn/NTWbsfAWKMdF.mp4',
  'https://archive.org/download/shrek3_202506/XDFR.mp4',
  'https://remux.unlimplay.com/remux?id=1308767',
];
(async () => {
  for (const u of URLS) {
    try {
      const r = await streamClient.get(u, {
        headers: { Range: `bytes=${DESDE}-${DESDE + 65535}` },
        responseType: 'arraybuffer', timeout: 20000, validateStatus: () => true, maxRedirects: 5,
      } as any);
      const kb = ((r.data as ArrayBuffer)?.byteLength ?? 0) / 1024;
      const veredicto = r.status === 206 && kb > 8 ? 'SE PUEDE ADELANTAR' : `RECHAZADO (http ${r.status})`;
      console.log(`${veredicto.padEnd(26)} ${String(r.headers['content-range'] || '-').padEnd(34)} ${u.slice(8, 62)}`);
    } catch (e: any) {
      console.log(`${'SIN VEREDICTO'.padEnd(26)} ${String(e?.code || 'error').padEnd(34)} ${u.slice(8, 62)}`);
    }
  }
})();
