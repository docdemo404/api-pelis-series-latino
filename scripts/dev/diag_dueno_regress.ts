/**
 * Regresión de `duenoDeLaPagina`: la llave 0 de FUENTES.md §1 tiene que seguir cazando los cruces
 * de verdad después de haberle quitado los falsos por coincidencia de slug entre webs distintas.
 */
import { duenoDeLaPagina } from '../../src/services/catalogService';

type Fila = { id: string; type: string; tmdb_id: number; title: string };
const filas: Fila[] = [
  { id: 'sakamoto-days',              type: 'tvseries', tmdb_id: 207332,  title: 'Sakamoto Days (serie, tioplus)' },
  { id: 'ver-pelicula-sakamoto-days', type: 'movie',    tmdb_id: 1548708, title: 'SAKAMOTO DAYS (peli, cinecalidad)' },
  { id: 'gintama',                    type: 'movie',    tmdb_id: 432985,  title: 'Gintama (peli, tioplus)' },
  { id: 'ver-serie-gintama',          type: 'tvseries', tmdb_id: 57041,   title: 'Gintama (serie, cinecalidad)' },
  { id: 'mo',                         type: 'tvseries', tmdb_id: 138502,  title: 'Mo (serie, tioplus)' },
  { id: 'carrie-1976',                type: 'movie',    tmdb_id: 10600,   title: 'Carrie 1976' },
  { id: 'carrie-2013',                type: 'movie',    tmdb_id: 76757,   title: 'Carrie 2013' },
];
const porId = new Map(filas.map(f => [f.id, f]));

const casos: Array<[string, string, string | null]> = [
  // La coincidencia de slug entre dos webs NO hace dueño a nadie ajeno.
  ['https://www.cinecalidad.am/ver-pelicula/sakamoto-days/', 'colisión entre webs', 'ver-pelicula-sakamoto-days'],
  ['https://tioplus.app/anime/sakamoto-days',                'colisión entre webs', 'sakamoto-days'],
  ['https://www.cinecalidad.am/ver-serie/gintama/',          'colisión de clase',   'ver-serie-gintama'],
  ['https://tioplus.app/pelicula/gintama',                   'colisión de clase',   'gintama'],
  // EL CRUCE DE VERDAD: "Moon Knight" apuntando a la página propia de la serie "Mo".
  ['https://tioplus.app/serie/mo',                           'cruce real',          'mo'],
  // Homónimos de distinto año: cada página es de su ficha y de ninguna otra.
  ['https://tioplus.app/pelicula/carrie-1976',               'homónimos',           'carrie-1976'],
  ['https://tioplus.app/pelicula/carrie-2013',               'homónimos',           'carrie-2013'],
  // Una página de nadie no inventa dueño.
  ['https://tioplus.app/pelicula/no-existe',                 'sin dueño',           null],
];

let fallos = 0;
for (const [url, clase, esperado] of casos) {
  const d = duenoDeLaPagina(url, porId);
  const ok = (d?.id ?? null) === esperado;
  if (!ok) fallos++;
  console.log(`  ${ok ? '✓' : '✗'} [${clase.padEnd(19)}] ${url}\n      dueño = ${d?.id ?? 'ninguno'}${ok ? '' : `   ESPERADO ${esperado ?? 'ninguno'}`}`);
}
console.log(`\n${casos.length - fallos}/${casos.length} correctos`);
process.exit(fallos ? 1 : 0);
