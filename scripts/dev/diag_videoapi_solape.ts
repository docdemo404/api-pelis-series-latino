/**
 * ¿Cuánto de videoapi.la es CONTENIDO NUEVO para nosotros?
 *
 * videoapi.la publica su catálogo entero como listas de ids de TMDB
 * (`/api/v1/public/wordpress/ids/*.txt`), así que el solape no se estima: se calcula. Y como las
 * dos partes hablan en ids de TMDB, no hay emparejamiento por título de por medio — el número que
 * sale es exacto, no una aproximación optimista.
 *
 *   npx ts-node --transpile-only scripts/dev/diag_videoapi_solape.ts
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { httpClient } from '../../src/utils/httpClient';
import { TMDB_API_KEY } from '../../src/services/tmdbService';

const BASE = 'https://videoapi.la/api/v1/public/wordpress/ids';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function listaDeIds(fichero: string): Promise<number[]> {
  const r = await httpClient.get(`${BASE}/${fichero}.txt`, {
    timeout: 90000,
    responseType: 'text',
    headers: { 'User-Agent': UA },
  });
  return String(r.data)
    .split('\n')
    .map((l) => Number(l.trim().split('_')[0]))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** Los tmdb_id que ya tenemos, paginando: supabase corta en 1000 por consulta. */
async function nuestrosIds(tipo: 'movie' | 'tvseries'): Promise<Set<number>> {
  const out = new Set<number>();
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await supabase
      .from('media_items')
      .select('tmdb_id')
      .eq('type', tipo)
      .gt('tmdb_id', 0)
      .range(desde, desde + 999);
    if (error) throw new Error(error.message);
    (data || []).forEach((r: any) => out.add(Number(r.tmdb_id)));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function comparar(rotulo: string, ficheros: string[], tipo: 'movie' | 'tvseries') {
  const suyos = new Set<number>();
  for (const f of ficheros) (await listaDeIds(f)).forEach((n) => suyos.add(n));
  const nuestros = await nuestrosIds(tipo);

  const nuevos = [...suyos].filter((id) => !nuestros.has(id));
  const compartidos = suyos.size - nuevos.length;
  console.log(
    `\n${rotulo}\n` +
      `  ellos:      ${suyos.size}\n` +
      `  nosotros:   ${nuestros.size}\n` +
      `  compartido: ${compartidos}\n` +
      `  NUEVO:      ${nuevos.length}  (${Math.round((nuevos.length / suyos.size) * 100)} % de lo suyo)`
  );
  return nuevos;
}

async function main() {
  const pelisNuevas = await comparar('PELÍCULAS', ['movies'], 'movie');
  await comparar('SERIES Y ANIME', ['tvshows', 'anime'], 'tvseries');

  // Que los ids nuevos sean ids DE VERDAD: se le preguntan diez a TMDB y se enseñan.
  console.log('\nMuestra de lo que entraría (comprobado contra TMDB):');
  for (const id of pelisNuevas.slice(0, 10)) {
    const r = await httpClient.get(`https://api.themoviedb.org/3/movie/${id}`, {
      timeout: 15000,
      params: { api_key: TMDB_API_KEY, language: 'es-ES' },
      validateStatus: () => true,
    });
    const t = r.status === 200 ? `${r.data.title} (${String(r.data.release_date).slice(0, 4)})` : `HTTP ${r.status}`;
    console.log(`   · ${id}  ${t}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
