/**
 * ¿MERECE LA PENA ESTA WEB? — la comprobación que va ANTES de escribir un scraper (FUENTES.md §6 bis).
 *
 * El número de títulos de una web candidata no dice nada. Lo que decide es en qué reproductores
 * publica: una fuente con 10.000 películas alojadas en hosts con captcha no añade catálogo, añade
 * carátulas que no reproducen. Y para el modelo actual hace falta más todavía — que la url sea un
 * FICHERO permanente, sin firma ni caducidad.
 *
 * Esto abre la portada, sigue unos cuantos enlaces a fichas, y saca los hosts de vídeo que
 * aparecen, marcando cuáles serían utilizables.
 *
 *   npx ts-node -T scripts/dev/probe_fuente_nueva.ts https://zonaaps.com/ [fichas]
 */
import 'dotenv/config';
import * as cheerio from 'cheerio';
import { httpClient } from '../../src/utils/httpClient';
import { hasVolatileToken } from '../../src/scrapers/directStream';

const SITIO = process.argv[2] || 'https://zonaaps.com/';
const FICHAS = Number(process.argv[3]) || 6;

const NAV = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
};

const get = (u: string, ref = SITIO) =>
  httpClient.get(u, {
    headers: { ...NAV, Referer: ref }, timeout: 25000, responseType: 'text',
    transformResponse: [(d: unknown) => d], validateStatus: () => true, maxRedirects: 5,
  } as any);

/** Un fichero permanente: la url ES el vídeo y no lleva firma. */
const FICHERO = [
  /pixeldrain\.com\/api\/file\//i, /archive\.org\/download\//i, /1a-\d+\.com\/video\//i,
  /cdn\.rumble\.cloud\/video\//i, /\.(mp4|mkv|webm)(\?|$)/i,
];

const hostDe = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '?'; } };

(async () => {
  console.log(`Mirando ${SITIO}\n`);
  const portada = String((await get(SITIO)).data || '');
  const $ = cheerio.load(portada);

  // Enlaces que parecen fichas: los que repiten un molde de ruta con slug.
  const enlaces = Array.from(new Set(
    $('a[href]').map((_, a) => String($(a).attr('href') || '')).get()
      .map(h => { try { return new URL(h, SITIO).toString(); } catch { return ''; } })
      .filter(h => h.startsWith(new URL(SITIO).origin))
      .filter(h => /\/(pelicula|serie|movie|ver|watch|episodio|capitulo)[s]?[\/-]/i.test(h))
  )).slice(0, FICHAS);

  console.log(`enlaces de ficha encontrados en portada: ${enlaces.length}`);
  if (!enlaces.length) {
    console.log('   (no se reconoce su molde de urls; habría que mirar la portada a mano)');
    console.log(`   muestra de enlaces: ${Array.from(new Set($('a[href]').map((_, a) => String($(a).attr('href'))).get())).slice(0, 12).join('\n                       ')}`);
    return;
  }

  const hosts: Record<string, { veces: number; permanente: boolean }> = {};
  for (const url of enlaces) {
    const html = String((await get(url)).data || '');
    const $$ = cheerio.load(html);
    const candidatos = new Set<string>();
    // Los tres sitios donde una plantilla suele poner el reproductor.
    $$('iframe[src]').each((_, el) => candidatos.add(String($$(el).attr('src') || '')));
    $$('[data-option], [data-src], [data-video]').each((_, el) => {
      for (const a of ['data-option', 'data-src', 'data-video']) {
        const v = String($$(el).attr(a) || ''); if (v) candidatos.add(v);
      }
    });
    for (const m of html.matchAll(/https?:\/\/[\w./:%?=&+~-]+\.(?:mp4|mkv|m3u8)[\w./:%?=&+~-]*/gi)) candidatos.add(m[0]);

    for (const c of candidatos) {
      if (!c || !/^https?:\/\//i.test(c)) continue;
      const h = hostDe(c);
      if (h === hostDe(SITIO) || h === '?') continue;
      const permanente = FICHERO.some(re => re.test(c)) && !hasVolatileToken(c);
      hosts[h] ??= { veces: 0, permanente: false };
      hosts[h].veces++;
      if (permanente) hosts[h].permanente = true;
    }
    console.log(`   ${url.slice(0, 78)}  →  ${candidatos.size} candidatos`);
  }

  console.log(`\n${'host de vídeo'.padEnd(32)} veces  ¿url permanente?`);
  for (const [h, v] of Object.entries(hosts).sort((a, b) => b[1].veces - a[1].veces)) {
    console.log(`${h.padEnd(32)} ${String(v.veces).padStart(5)}  ${v.permanente ? 'SÍ — sirve' : 'no'}`);
  }
  const utiles = Object.values(hosts).filter(v => v.permanente).length;
  console.log(`\n  ${utiles} de ${Object.keys(hosts).length} hosts darían url permanente.`);
  console.log(utiles ? '  → merece la pena escribirle un scraper.' : '  → con el modelo actual (solo urls permanentes) no aportaría nada.');
})();
