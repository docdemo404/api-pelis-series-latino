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
import { juzgarIdentidad, VeredictoIdentidad, detalle, embedsDe, ClaseLamoviebot } from '../../src/scrapers/lamoviebot';
import { datosDeLaUrl } from '../../src/scrapers/videoapi';

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
 * SE JUZGA SOBRE EL DETALLE, NO SOBRE EL LISTADO — y esto costó una alarma falsa.
 *
 * Los dos endpoints NO dicen lo mismo. Para `amor-y-compasion-2015` el listado publica
 * `original_title: "Love & Mercy"` y el detalle `"Love! Valour! Compassion!"`, que es el que
 * coincide exacto con su `tmdb_id` (64802) y con la fecha de TMDB. Midiendo sobre el listado salía
 * un desmentido donde el importador —que lee el detalle— ve una confirmación legítima.
 *
 * O sea que la primera versión de esto medía una fuente de datos que el importador no usa. Es la
 * misma trampa que FUENTES.md §4 describe con FuegoCine (la misma página parseada en dos sitios,
 * arreglada en uno solo): un diagnóstico que no lee lo que lee el código que vigila no mide nada,
 * y encima da un número creíble.
 *
 * Cuesta una petición por ficha. Es lo que vale saber si la guarda que protege el catálogo
 * funciona.
 */

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
    'confirma-segundo-voto': 0, 'confirma-original': 0, 'confirma-año': 0, CONTRADICE: 0, 'sin-datos': 0,
  };
  const malos: string[] = [];
  let sinId = 0, noExiste = 0, mirados = 0;

  for (const fLista of fichas.slice(0, CUANTAS)) {
    // El detalle manda: es lo que lee el importador. El listado solo sirve para saber qué pedir.
    let f: any = fLista;
    try {
      f = { ...fLista, ...(await detalle(TIPO as ClaseLamoviebot, fLista.slug)) };
    } catch {
      // Si el detalle no contesta, el importador tampoco escribiría la ficha: no se cuenta.
      continue;
    }
    const id = Number(f.tmdb_id) || 0;
    if (!id) { sinId++; continue; }
    const r = await httpClient.get(`https://api.themoviedb.org/3/${endpointTmdb}/${id}`, {
      params: { api_key: TMDB_API_KEY, language: 'es-ES' }, validateStatus: () => true, timeout: 15000,
    });
    if (r.status !== 200) { noExiste++; continue; }
    mirados++;
    const v = juzgarIdentidad(
      {
        year: f.year,
        title: f.title,
        slug: f.slug,
        idsDeEmbeds: embedsDe(f)
          .map((e) => datosDeLaUrl(e.link))
          .filter(Boolean)
          .map((x) => (x as any).tmdbId as number),
      },
      {
        id,
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
  const ok = cuenta['confirma-segundo-voto'] + cuenta['confirma-original'] + cuenta['confirma-año'];
  console.log(`  respaldado por SEGUNDO VOTO:    ${cuenta['confirma-segundo-voto']}   ← el fuerte`);
  console.log(`  respaldado por el slug:         ${cuenta['confirma-original']}`);
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
