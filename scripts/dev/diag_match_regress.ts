import 'dotenv/config';
import { TmdbService } from '../../src/services/tmdbService';
import { ContentType } from '../../src/types';

/** Regresión del matcher: título de la fuente → ficha que DEBE salir. */
const cases: Array<[string, ContentType, string | undefined, string]> = [
  ['Los Vengadores: Era de Ultrón', 'movie', '2015', 'Avengers 2'],
  ['Gen V Todas Las Temporadas', 'tvseries', '2025', 'Gen V'],
  ['Scary Movie 6', 'movie', undefined, 'Scary Movie'],
  ['Madagascar 3: Los Fugitivos', 'movie', '2012', 'Madagascar 3'],
  ['Spiderman: Sin Camino a Casa', 'movie', '2021', 'Spider-Man'],
  ['Gru 4 Mi Villano Favorito', 'movie', '2024', 'villano favorito'],
  ['La Casa del Dragón', 'tvseries', '2022', 'dragón'],
  ['Loki', 'tvseries', '2021', 'Loki'],
  ['El Padrino', 'movie', '1972', 'padrino'],
  ['Matilda', 'movie', '1996', 'Matilda'],
  ['Naruto', 'tvseries', undefined, 'Naruto'],
  ['Stranger Things', 'tvseries', '2016', 'Stranger Things'],
  ['El Señor de los Anillos: La Comunidad del Anillo', 'movie', '2001', 'anillo'],
  ['Los Increíbles 2', 'movie', '2018', 'ncreíbles 2'],
  // Homónimo de otra época: "El fundador" (The Founder / "Hambre de poder", 2016) NO debe
  // resolverse como "Bonifácio - O Fundador do Brasil" (2018). Ver diag_match.ts para las
  // variantes con título original e imagen de TMDB.
  ['El Fundador', 'movie', '2016', 'poder']
];

(async () => {
  let ok = 0;
  for (const [title, type, year, expect] of cases) {
    const m = await TmdbService.resolveTmdb(title, type, year);
    const d = m.id > 0 ? await TmdbService.getTmdbDetails(m.id, type) : null;
    const got = d ? `${d.title || d.name} (${String(d.release_date || d.first_air_date || '').slice(0, 4)})` : 'SIN MATCH';
    const pass = got.toLowerCase().includes(expect.toLowerCase());
    if (pass) ok++;
    console.log(`${pass ? '✓' : '✗'} ${title} → ${got}  [score ${m.score.toFixed(2)}]`);
  }
  console.log(`\n${ok}/${cases.length} correctos`);
})();
