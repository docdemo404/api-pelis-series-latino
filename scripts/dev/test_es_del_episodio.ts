/**
 * ¿Reconoce el guardarraíl de episodio los rótulos que las fuentes publican DE VERDAD?
 *
 * Existe porque buscaba solo `S01E01`: reconocía el título de TioPlus y NO el de FuegoCine
 * ("Nadie quiere esto 1x1"), que se aceptaba siempre. Y FuegoCine es la fuente cuya URL se
 * adivina —reescribiendo el número de capítulo dentro de la ruta de Blogger—, o sea que el
 * guardarraíl cubría el camino seguro y dejaba suelto el inventado.
 *
 * Los títulos de aquí abajo están copiados de páginas reales tal y como los devuelve
 * `scrapeDetail` (el `h1`), no inventados: si una fuente cambia su plantilla, esta prueba se entera.
 *
 * No sale a la red: son cadenas contra una función pura.
 *
 *   npx tsx scripts/dev/test_es_del_episodio.ts
 */
import { esDelEpisodio, rotuloDelEpisodio } from '../../src/services/realScraperService';

let fallos = 0;
function comprobar(descripcion: string, real: unknown, esperado: unknown): void {
  const ok = JSON.stringify(real) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`   ${ok ? '✓' : '✗'} ${descripcion}${ok ? '' : `\n       esperado ${JSON.stringify(esperado)}, salió ${JSON.stringify(real)}`}`);
}

// Títulos REALES, descargados de las dos fuentes el 2026-08-17.
const TIOPLUS = 'Nadie quiere esto S01 E01 - Piloto';          // h1.slugh1, lo que lee scrapeDetail
const TIOPLUS_TITLE = 'Ver Nadie quiere esto (2024) Temporada 1 Capítulo 1 Online Gratis Español';  // <title>
const FUEGOCINE = 'Nadie quiere esto 1x1';
const CON_SE = 'ONE PIECE S01 E01 - Amanecer de una aventura';

console.log('\n── Reconocer el rótulo');
comprobar('TioPlus h1 "S01 E01"', rotuloDelEpisodio(TIOPLUS), { season: 1, episode: 1 });
comprobar('TioPlus <title> "Temporada 1 Capítulo 1"', rotuloDelEpisodio(TIOPLUS_TITLE), { season: 1, episode: 1 });
comprobar('FuegoCine "1x1" al final', rotuloDelEpisodio(FUEGOCINE), { season: 1, episode: 1 });
comprobar('"S01 E01 - Amanecer"', rotuloDelEpisodio(CON_SE), { season: 1, episode: 1 });
comprobar('"Temporada 2 Capítulo 15"', rotuloDelEpisodio('Serie Temporada 2 Capítulo 15'), { season: 2, episode: 15 });
comprobar('inglés "Season 2 Episode 7"', rotuloDelEpisodio('Show Season 2 Episode 7'), { season: 2, episode: 7 });
comprobar('"Ronaldinho 4x8"', rotuloDelEpisodio('Ronaldinho 4x8'), { season: 4, episode: 8 });
comprobar('sin rótulo → null', rotuloDelEpisodio('Nadie quiere esto'), null);

console.log('\n── Lo que NO debe leerse como un rótulo');
// El falso positivo que se lleva por delante un guardarraíl mal escrito: una resolución de vídeo
// tiene exactamente la forma "NxM".
comprobar('resolución "1920x960" no es 1920ª temporada', rotuloDelEpisodio('Serie X 1920x960'), null);
comprobar('resolución a media frase', rotuloDelEpisodio('Serie 1280x720 Latino'), null);

console.log('\n── Aceptar y rechazar');
comprobar('TioPlus, se pide el 1x1 → acepta', esDelEpisodio(TIOPLUS, 1, 1), true);
comprobar('TioPlus, se pide el 1x3 → RECHAZA', esDelEpisodio(TIOPLUS, 1, 3), false);
comprobar('FuegoCine, se pide el 1x1 → acepta', esDelEpisodio(FUEGOCINE, 1, 1), true);
// EL CASO QUE ANTES SE COLABA. La reescritura del mes de Blogger pide `…-1x3.html` y Blogger puede
// contestar con otro capítulo; el título lo delata y hasta ahora nadie lo miraba.
comprobar('FuegoCine "1x1" cuando se pidió el 1x3 → RECHAZA', esDelEpisodio(FUEGOCINE, 1, 3), false);
comprobar('temporada distinta → RECHAZA', esDelEpisodio(CON_SE, 2, 1), false);

console.log('\n── Sin rótulo: depende de si la ruta se adivinó');
comprobar('ruta derivada de source_urls → acepta', esDelEpisodio('Nadie quiere esto', 1, 1), true);
comprobar('ruta ADIVINADA → no se adopta', esDelEpisodio('Nadie quiere esto', 1, 1, { exigeRotulo: true }), false);
comprobar('ruta adivinada PERO se identifica → acepta', esDelEpisodio(FUEGOCINE, 1, 1, { exigeRotulo: true }), true);
comprobar('ruta adivinada y se identifica como otro → RECHAZA', esDelEpisodio(FUEGOCINE, 2, 5, { exigeRotulo: true }), false);
comprobar('título vacío, ruta adivinada → no se adopta', esDelEpisodio(undefined, 1, 1, { exigeRotulo: true }), false);

console.log(fallos === 0 ? '\n✅ todo correcto\n' : `\n❌ ${fallos} fallo(s)\n`);
process.exit(fallos === 0 ? 0 : 1);
