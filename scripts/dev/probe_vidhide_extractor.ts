/**
 * Por qué `extractDirect` no saca la URL de vidhideplus cuando el packer SÍ la trae.
 * Compara, sobre la misma página: lo que ve el extractor de producción y lo que hay de verdad.
 */
import 'dotenv/config';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';
import { extractDirect, unpackPacker } from '../../src/scrapers/directStream';

const EMBEDS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'https://vidhideplus.com/v/1u3pe5hpri0n',
      'https://vidhideplus.com/v/hdnargs9f6wq',
      'https://vidhideplus.com/v/tj9sguuner7l',
      'https://vidhideplus.com/v/2sv357ypfcbu',
    ];

(async () => {
  for (const embed of EMBEDS) {
    console.log(`\n===== ${embed}`);
    const r = await httpClient.get(embed, {
      headers: { 'User-Agent': USER_AGENT, Referer: 'https://tioplus.app/' },
      timeout: 25000, responseType: 'text',
      transformResponse: [(d: unknown) => d], validateStatus: () => true, maxRedirects: 5,
    });
    const html = String(r.data || '');
    console.log(`  http=${r.status} bytes=${html.length}`);
    if (/no longer available|File was deleted|not found/i.test(html)) { console.log('  BORRADO'); continue; }

    const hayPacker = /eval\(function\(p,a,c,k,e/.test(html);
    const abierto = hayPacker ? (unpackPacker(html) || '') : '';
    console.log(`  packer=${hayPacker} desempaquetado=${abierto.length} B`);

    const links = abierto.match(/var links\s*=\s*(\{[\s\S]*?\})\s*[;,]/)?.[1] || html.match(/var links\s*=\s*(\{[\s\S]*?\})\s*[;,]/)?.[1];
    console.log(`  var links: ${links ? links.slice(0, 220) : 'NO'}`);

    const directo = await extractDirect(embed, html, { allowNetwork: false });
    console.log(`  extractDirect → ${directo ? `${directo.kind} ${directo.url.slice(0, 100)}` : 'NULL'}`);

    // Qué habría sacado una lectura directa de `links`.
    if (links) {
      try {
        const obj = JSON.parse(links);
        for (const [k, v] of Object.entries(obj)) console.log(`     links.${k} = ${String(v).slice(0, 110)}`);
      } catch (e: any) { console.log(`     (links no es JSON puro: ${e.message.slice(0, 60)})`); }
    }
  }
})();
