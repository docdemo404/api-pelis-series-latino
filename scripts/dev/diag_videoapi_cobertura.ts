/**
 * ¿Cuánto del catálogo QUE YA TENEMOS cubre videoapi.la?
 *
 * `diag_videoapi.ts` demuestra que la cadena entrega vídeo. Esta contesta la otra mitad: si eso
 * sirve para NUESTRAS fichas o solo para los títulos famosos con los que se probó. Se pregunta
 * por `tmdb_id`, que es como direcciona la fuente, así que no hay emparejamiento por título de
 * por medio y el resultado no puede salir inflado.
 *
 * Para el camino contrario —cuánto tiene ÉL que no tengamos— está `diag_videoapi_solape.ts`,
 * que no estima nada porque la fuente publica su catálogo entero en listas de ids.
 *
 *   npx ts-node --transpile-only scripts/dev/diag_videoapi_cobertura.ts [--n=150]
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { httpClient } from '../../src/utils/httpClient';

const N = Number((process.argv.find((a) => a.startsWith('--n=')) || '').split('=')[1] || 150);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function tieneEmbed(ruta: string): Promise<boolean> {
  try {
    const r = await httpClient.get(`https://videoapi.la/e/${ruta}`, {
      timeout: 20000,
      responseType: 'text',
      headers: { 'User-Agent': UA, Referer: 'https://modocine.com/' },
      validateStatus: () => true,
    });
    return r.status === 200 && /vimeos\.net\/embed-[a-z0-9]+\.html/i.test(String(r.data));
  } catch {
    return false;
  }
}

/** De cuatro en cuatro: la fuente aguanta y no hace falta apretarla más. */
async function enTandas<T>(xs: T[], n: number, f: (x: T) => Promise<boolean>): Promise<boolean[]> {
  const out: boolean[] = [];
  for (let i = 0; i < xs.length; i += n) {
    out.push(...(await Promise.all(xs.slice(i, i + n).map(f))));
  }
  return out;
}

async function main() {
  for (const tipo of ['movie', 'tvseries'] as const) {
    const { data, error } = await supabase
      .from('media_items')
      .select('id, title, tmdb_id, has_streams')
      .eq('type', tipo)
      .gt('tmdb_id', 0)
      .limit(N);
    if (error) {
      console.error(`[${tipo}]`, error.message);
      continue;
    }
    const filas = data || [];
    if (!filas.length) {
      console.log(`[${tipo}] sin filas`);
      continue;
    }

    const ruta = (f: any) => (tipo === 'movie' ? `movie/${f.tmdb_id}` : `tv/${f.tmdb_id}/1/1`);
    const hits = await enTandas(filas, 4, (f) => tieneEmbed(ruta(f)));

    const cubiertos = hits.filter(Boolean).length;
    const sinNada = filas.filter((f, i) => hits[i] && !f.has_streams);
    console.log(
      `\n[${tipo}] ${cubiertos}/${filas.length} cubiertos (${Math.round((cubiertos / filas.length) * 100)} %)` +
        ` — y ${sinNada.length} de ellos HOY NO TIENEN NINGÚN ENLACE.`
    );
    sinNada.slice(0, 12).forEach((f) => console.log(`   · ${f.title} (tmdb ${f.tmdb_id})`));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
