import axios from 'axios';
import { inspectEmbed } from '../../src/scrapers/embedHealth';
import { extractDirect, unwrapRedirector, describeDirect } from '../../src/scrapers/directStream';
import { USER_AGENT } from '../../src/utils/httpClient';

/**
 * Diagnóstico de cobertura de extracción directa por host.
 *
 * Sin argumentos recorre una muestra fija de embeds reales (uno por familia de host, de las
 * dos fuentes) y reporta qué se consigue extraer. Con argumentos, prueba esas URLs.
 *
 *   npx ts-node scripts/dev/diag_direct.ts
 *   npx ts-node scripts/dev/diag_direct.ts https://vidhideplus.com/v/30wr0gu38qsb
 */

const SAMPLE = [
  // tioplus
  'https://vidhideplus.com/v/30wr0gu38qsb',
  'https://pelisplus.upns.pro/#swto1',
  'https://waaw.to/e/mfz0Ai0izCNP',
  'https://listeamed.net/e/3Q0lxBb9prmxj1J',
  // fuegocine (el primero es el redirector de Blogger, a propósito)
  'https://blogfc13.blogspot.com/?m=1.html?r=Ly9nc2Nkbi5jYW0vdmlkZW8vZW1iZWQvczNtYWw0ZzlnZHF2',
  'https://dropload.co/e/36de67pbkl7x',
  'https://ok.ru/videoembed/8812862769808',
];

async function main() {
  const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : SAMPLE;
  let ok = 0;

  for (const original of targets) {
    const embedUrl = unwrapRedirector(original);
    const unwrapped = embedUrl !== original;

    let line = '';
    try {
      const { status, html } = await inspectEmbed(embedUrl);
      const direct = await extractDirect(embedUrl, html, { allowNetwork: true });
      if (direct) {
        // Misma decisión que toma el scraper, para que el diagnóstico no mienta.
        const mode = describeDirect(embedUrl, direct).direct_mode || 'proxy';
        // Extraer una URL no sirve de nada si luego no reproduce: se comprueba de verdad.
        // El Referer tiene que ser el del EMBED, no el del propio CDN: dropload devuelve 403
        // sin él. Es la misma cabecera que el endpoint /stream/direct enviará al reproducir.
        const probe = await axios.get(direct.url, {
          headers: {
            'User-Agent': USER_AGENT,
            Range: 'bytes=0-2047',
            Referer: `${new URL(embedUrl).origin}/`,
            Origin: new URL(embedUrl).origin,
          },
          timeout: 15000,
          validateStatus: () => true,
        });
        const playable = probe.status >= 200 && probe.status < 300;
        if (playable) ok++;
        line = `${playable ? 'OK  ' : 'MUDO'} ${direct.kind.padEnd(3)} ${mode.padEnd(6)} ` +
          `HTTP ${probe.status} ${String(probe.headers['content-type'] || '?').slice(0, 28).padEnd(28)} ` +
          `${direct.quality || '-'} ${direct.url.slice(0, 70)}`;
      } else {
        line = `--   sin extracción (embed ${status}, ${html.length} bytes)`;
      }
    } catch (err: any) {
      line = `ERR  ${err.message}`;
    }

    console.log(`\n${new URL(embedUrl).hostname}${unwrapped ? '  (redirector decodificado)' : ''}`);
    console.log(`  ${line}`);
  }

  console.log(`\n=== ${ok}/${targets.length} embeds con vídeo directo REPRODUCIBLE ===`);
  console.log('"proxy" = la URL caduca o va atada a la IP que la pidió, así que se acuña en');
  console.log('cada reproducción y NO se persiste. "MUDO" = se extrajo pero el CDN no la sirve.');
}

main().then(() => process.exit(0));
