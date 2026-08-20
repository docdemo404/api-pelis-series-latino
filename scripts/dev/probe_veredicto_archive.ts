/**
 * ¿QUÉ VEREDICTO LE DA LA SALUD A UN FICHERO PERMANENTE?
 *
 * Un `?deep=1` contra producción dejó la ficha manual de Shrek con el servidor de archive.org
 * `offline` y SIN `direct_stream`, y le metió tres embeds scrapeados. O sea que algo declaró
 * muerto un mp4 que se descarga sin problema. Esto lo pregunta directamente.
 */
import 'dotenv/config';
import { comprobarEmbed } from '../../src/services/playbackHealth';

const URLS = [
  'https://archive.org/download/shrek3_202506/XDFR.mp4',
];

(async () => {
  for (const u of URLS) {
    const t0 = Date.now();
    const r: any = await comprobarEmbed(u, { limite: Date.now() + 60000 });
    console.log(`${u}\n   veredicto=${r.veredicto} motivo=${r.motivo || '-'} sinVideo=${r.sinVideo} universal=${r.universal} acunado=${r.minted ? r.minted.kind + ' ' + String(r.minted.url).slice(0, 60) : 'NO'}  ${Date.now() - t0}ms`);
  }
})();
