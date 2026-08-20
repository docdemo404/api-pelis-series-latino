/**
 * ¿POR QUÉ RECHAZA NUESTRO CLIENTE UN FICHERO QUE curl SE BAJA?
 *
 * `anadirFichaManual` rechazó la url de archive.org de Shrek —«ninguna url entregó vídeo»— y curl
 * la descarga con 206 y `video/mp4`. La diferencia tiene que estar en el cliente, y saberlo no es
 * cosa de una ficha: `entregaVideo()` del crawl usa el mismo patrón, así que si archive.org le
 * dice que no a nuestro axios, la fuente entera queda inservible sin que nadie sepa por qué.
 */
import 'dotenv/config';
import { httpClient, streamClient } from '../../src/utils/httpClient';

const URLS = [
  'https://dn711505.ca.archive.org/0/items/shrek3_202506/XDFR.mp4',
  'https://archive.org/download/shrek3_202506/XDFR.mp4',
];

(async () => {
  for (const cliente of [['httpClient', httpClient], ['streamClient', streamClient]] as const) {
    for (const url of URLS) {
      const t0 = Date.now();
      try {
        const r = await (cliente[1] as any).get(url, {
          headers: { Range: 'bytes=0-65535' },
          responseType: 'arraybuffer',
          timeout: 25000,
          validateStatus: () => true,
          maxRedirects: 5,
        });
        const bytes = (r.data as ArrayBuffer)?.byteLength ?? 0;
        console.log(`${cliente[0].padEnd(12)} ${url.slice(8, 48).padEnd(42)} http=${r.status} tipo=${r.headers['content-type']} bytes=${bytes} ${Date.now() - t0}ms`);
      } catch (e: any) {
        console.log(`${cliente[0].padEnd(12)} ${url.slice(8, 48).padEnd(42)} EXCEPCIÓN: ${e?.code || ''} ${String(e?.message).slice(0, 80)} ${Date.now() - t0}ms`);
      }
    }
  }
})();
