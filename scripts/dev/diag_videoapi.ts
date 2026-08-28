/**
 * ¿Entrega vídeo videoapi.la? La cadena entera, de un id de TMDB a bytes.
 *
 * videoapi.la NO es una web que haya que crawlear: es un proveedor de embeds con documentación
 * pública (https://videoapi.la/api) que direcciona POR TMDB ID. modocine.com, por donde se llegó
 * a él, es solo uno de sus clientes — una portada pintada encima. Se le pregunta al proveedor.
 *
 * Como direcciona por id, la trampa que FUENTES.md §1 documenta como origen de casi todos los
 * destrozos del catálogo —adoptar la ficha de un homónimo— aquí no existe: o contesta por esa
 * obra o no contesta. Lo único que queda por medir es si sale vídeo.
 *
 *   tmdb id → videoapi.la/e/movie/{id} → vimeos.net/embed-XXXX.html → extractDirect → m3u8 → bytes
 *
 * `vimeos.net` ya se extrae (directStream, `mereceRepasoDeExtraccion`) y tiene perfil medido en
 * hostPolicy, así que esta sonda no escribe extractor: usa el que ya hay.
 *
 *   npx ts-node --transpile-only scripts/dev/diag_videoapi.ts [id,id,…]
 *   ORIGEN=https://videoapp.zip npx ts-node --transpile-only scripts/dev/diag_videoapi.ts
 */
import { httpClient } from '../../src/utils/httpClient';
import { extractDirect } from '../../src/scrapers/directStream';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const PELIS = [1124, 27205, 550, 155, 603, 680, 13, 129, 372058, 1084736, 447273, 1160956, 872585, 1029575, 634492];

async function traer(url: string, referer: string): Promise<string | null> {
  try {
    const r = await httpClient.get(url, {
      timeout: 25000,
      responseType: 'text',
      headers: referer ? { 'User-Agent': UA, Referer: referer } : { 'User-Agent': UA },
      validateStatus: () => true,
    });
    return r.status === 200 ? String(r.data) : null;
  } catch {
    return null;
  }
}

/** ¿El m3u8 entrega de verdad, desde ESTA ip? Se pide el maestro y su primera variante. */
async function reproduce(url: string, referer: string): Promise<string> {
  try {
    const r = await httpClient.get(url, {
      timeout: 25000,
      responseType: 'text',
      headers: { 'User-Agent': UA, Referer: referer, Origin: new URL(referer).origin },
      validateStatus: () => true,
    });
    if (r.status !== 200) return `HTTP ${r.status}`;
    const cuerpo = String(r.data);
    if (!cuerpo.startsWith('#EXTM3U')) return `no es m3u8 (${cuerpo.slice(0, 40)})`;
    const variantes = cuerpo.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    return `m3u8 ok, ${variantes.length} entradas`;
  } catch (e: any) {
    return `error ${e?.code || e?.message}`;
  }
}

async function main() {
  const ids = process.argv[2] ? process.argv[2].split(',').map(Number) : PELIS;
  let conVimeos = 0;
  let conDirecto = 0;
  let reproducen = 0;

  for (const id of ids) {
    const shell = await traer(`${process.env.ORIGEN || 'https://videoapi.la'}/e/movie/${id}`, '');
    const embed = shell?.match(/https:\/\/vimeos\.net\/embed-[a-z0-9]+\.html/i)?.[0] || null;
    if (!embed) {
      console.log(`${id}\tsin vimeos`);
      continue;
    }
    conVimeos++;

    const pagina = await traer(embed, 'https://videoapp.zip/');
    if (!pagina) {
      console.log(`${id}\t${embed}\tembed no responde`);
      continue;
    }

    const directo = await extractDirect(embed, pagina, { allowNetwork: true });
    if (!directo) {
      console.log(`${id}\t${embed}\tsin directo`);
      continue;
    }
    conDirecto++;

    const veredicto = await reproduce(directo.url, 'https://vimeos.net/');
    if (veredicto.startsWith('m3u8 ok')) reproducen++;
    console.log(`${id}\t${directo.kind}\t${veredicto}\t${directo.url.slice(0, 110)}`);
  }

  console.log(
    `\nDe ${ids.length}: ${conVimeos} con embed, ${conDirecto} con url directa, ${reproducen} reproducen.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
