/**
 * ¿SE PUEDE CREER EL `tmdb_id` QUE PUBLICA LAMOVIEBOT? (2026-09-20)
 *
 * La respuesta corta, medida antes de escribir el importador: NO A CIEGAS. Y el caso que lo
 * destapó merece quedar escrito, porque es el fallo exacto que FUENTES.md §1 lleva meses tapando:
 *
 *     ficha «Los Malditos (2025)»  →  dice tmdb 1059010 = «Los malditos» / *I dannati* (2024)
 *     su propio enlace apunta a         tmdb  850439    = «Los condenados» / *The Damned* (2025)
 *
 * Emparejó por título en español y se llevó el homónimo del año equivocado. Es el mismo error que
 * aquí produjo 42 adopciones indebidas en cinco títulos. O sea que el `tmdb_id` de esta fuente NO
 * es un dato publicado por la obra —como sí lo es el de videoapi, que direcciona por él— sino la
 * conjetura de un matcher ajeno, y hay que tratarlo como tal: como una CANDIDATURA que se verifica,
 * no como una identidad que se adopta.
 *
 * Esto mide cuántas veces acierta, con la misma vara que usa `resolveTmdb`: el título original y
 * el año son señales INDEPENDIENTES del nombre regional, que es el que colisiona.
 *
 *   npx ts-node --transpile-only scripts/dev/diag_lamoviebot_identidad.ts
 *   npx ts-node --transpile-only scripts/dev/diag_lamoviebot_identidad.ts --fichas=150 --tipo=series
 */
import 'dotenv/config';
import { httpClient } from '../../src/utils/httpClient';
import { TMDB_API_KEY } from '../../src/services/tmdbService';
import { juzgarIdentidad, VeredictoIdentidad } from '../../src/scrapers/lamoviebot';

const LMB = 'https://lamoviebot.tvymas.workers.dev';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const CUANTAS = Number(process.argv.find((a) => a.startsWith('--fichas='))?.split('=')[1] || 120);
const TIPO = (process.argv.find((a) => a.startsWith('--tipo='))?.split('=')[1] || 'peliculas') as
  | 'peliculas' | 'series' | 'animes';

async function json(url: string): Promise<any> {
  const r = await httpClient.get(url, { timeout: 45000, headers: { 'User-Agent': UA }, validateStatus: () => true });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return r.data;
}

/**
 * El veredicto lo pone `juzgarIdentidad`, importada de la fuente — NO una copia de su escalera.
 *
 * Esta distinción ya costó un arreglo en este repositorio: la lectura de la ficha de datos de
 * FuegoCine vivía en dos sitios, se arregló en uno y el otro siguió tipando mal en vivo durante
 * semanas (FUENTES.md §4). Un diagnóstico que juzga con su propia copia del criterio deja de medir
 * lo que hace el importador en cuanto uno de los dos cambia, y no avisa: sigue dando números.
 */
type Veredicto = VeredictoIdentidad;

async function main() {
  const endpointTmdb = TIPO === 'peliculas' ? 'movie' : 'tv';
  const cabeza = await json(`${LMB}/${TIPO}`);
  const totalPaginas = Number(cabeza.total_pages) || 1;

  const fichas: any[] = [];
  for (let p = 1; fichas.length < CUANTAS && p <= totalPaginas; p++) {
    const pagina = 1 + Math.floor(((p - 1) * totalPaginas) / Math.min(CUANTAS / 24 + 1, totalPaginas));
    try {
      const cuerpo = await json(`${LMB}/${TIPO}?page=${Math.min(pagina, totalPaginas)}`);
      fichas.push(...(cuerpo.movies || cuerpo.series || cuerpo.animes || []));
    } catch {}
  }

  const cuenta: Record<Veredicto, number> = {
    'confirma-original': 0, 'confirma-año': 0, CONTRADICE: 0, 'sin-datos': 0,
  };
  const malos: string[] = [];
  let sinId = 0, noExiste = 0, mirados = 0;

  for (const f of fichas.slice(0, CUANTAS)) {
    const id = Number(f.tmdb_id) || 0;
    if (!id) { sinId++; continue; }
    const r = await httpClient.get(`https://api.themoviedb.org/3/${endpointTmdb}/${id}`, {
      params: { api_key: TMDB_API_KEY, language: 'es-ES' }, validateStatus: () => true, timeout: 15000,
    });
    if (r.status !== 200) { noExiste++; continue; }
    mirados++;
    const v = juzgarIdentidad(
      { original_title: f.original_title, year: f.year, title: f.title },
      {
        original_title: r.data.original_title || r.data.original_name,
        title: r.data.title || r.data.name,
        fecha: r.data.release_date || r.data.first_air_date,
      }
    );
    cuenta[v]++;
    if (v === 'CONTRADICE' && malos.length < 10) {
      malos.push(
        `     · "${f.title}" (${f.year}) [${f.original_title}]\n` +
        `       → dice tmdb ${id} = "${r.data.title || r.data.name}" [${r.data.original_title || r.data.original_name}] ` +
        `${String(r.data.release_date || r.data.first_air_date).slice(0, 4)}`
      );
    }
  }

  console.log(`\n¿ACIERTA EL tmdb_id DE LAMOVIEBOT? · ${TIPO} · ${mirados} fichas comprobadas contra TMDB\n`);
  const ok = cuenta['confirma-original'] + cuenta['confirma-año'];
  console.log(`  respaldado por título original: ${cuenta['confirma-original']}`);
  console.log(`  respaldado solo por el año:     ${cuenta['confirma-año']}`);
  console.log(`  SE CONTRADICE:                  ${cuenta.CONTRADICE}`);
  console.log(`  sin datos con que juzgar:       ${cuenta['sin-datos']}`);
  console.log(`  sin tmdb_id / id inexistente:   ${sinId} / ${noExiste}`);
  console.log(
    `\n  → fiable en el ${mirados ? Math.round((ok / mirados) * 100) : 0} % · ` +
    `MAL en el ${mirados ? Math.round((cuenta.CONTRADICE / mirados) * 100) : 0} %`
  );
  if (malos.length) {
    console.log(`\n  Fichas que adoptarían la obra equivocada si nos fiáramos:\n${malos.join('\n')}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
