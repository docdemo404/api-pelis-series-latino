/**
 * ¿Hasta dónde llega el fondo de videoapi.la, por tramos?
 *
 * El porcentaje global miente: lo que decide si una fuente sirve es si cubre el cine viejo y el
 * poco visto, no si tiene los estrenos. Esta sonda pregunta por tramos de TMDB (décadas, idioma,
 * número de votos) para ver dónde se acaba de verdad.
 *
 * Nota: `diag_videoapi_solape.ts` da la cifra exacta a partir de las listas de ids que la propia
 * fuente publica. Esta sirve para lo que aquella no dice: CÓMO está repartido lo que tiene.
 *
 *   npx ts-node --transpile-only scripts/dev/diag_videoapi_fondo.ts
 */
import { httpClient } from '../../src/utils/httpClient';
import { TMDB_API_KEY } from '../../src/services/tmdbService';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

interface Tramo {
  nombre: string;
  ruta: 'movie' | 'tv';
  params: Record<string, string | number>;
}

const TRAMOS: Tramo[] = [
  { nombre: 'Estrenos 2026',            ruta: 'movie', params: { 'primary_release_year': 2026, sort_by: 'popularity.desc' } },
  { nombre: 'Populares de siempre',     ruta: 'movie', params: { sort_by: 'popularity.desc' } },
  { nombre: 'Años 90',                  ruta: 'movie', params: { 'primary_release_date.gte': '1990-01-01', 'primary_release_date.lte': '1999-12-31', sort_by: 'popularity.desc' } },
  { nombre: 'Años 70 y 80',             ruta: 'movie', params: { 'primary_release_date.gte': '1970-01-01', 'primary_release_date.lte': '1989-12-31', sort_by: 'popularity.desc' } },
  { nombre: 'Cine en español',          ruta: 'movie', params: { with_original_language: 'es', sort_by: 'popularity.desc' } },
  { nombre: 'Poco vistas (100-400 votos)', ruta: 'movie', params: { 'vote_count.gte': 100, 'vote_count.lte': 400, sort_by: 'popularity.desc' } },
  { nombre: 'Casi desconocidas (<50 votos)', ruta: 'movie', params: { 'vote_count.lte': 50, 'vote_count.gte': 5, sort_by: 'popularity.desc' } },
  { nombre: 'Series populares',         ruta: 'tv',    params: { sort_by: 'popularity.desc' } },
  { nombre: 'Series poco vistas',       ruta: 'tv',    params: { 'vote_count.gte': 50, 'vote_count.lte': 200, sort_by: 'popularity.desc' } },
];

async function idsDeTmdb(t: Tramo, pagina: number): Promise<{ id: number; nombre: string }[]> {
  const r = await httpClient.get(`https://api.themoviedb.org/3/discover/${t.ruta}`, {
    timeout: 20000,
    params: { api_key: TMDB_API_KEY, language: 'es-ES', page: pagina, ...t.params },
    validateStatus: () => true,
  });
  if (r.status !== 200) return [];
  return (r.data?.results || []).map((x: any) => ({ id: x.id, nombre: x.title || x.name || '?' }));
}

async function tieneEmbed(t: Tramo, id: number): Promise<boolean> {
  const ruta = t.ruta === 'movie' ? `movie/${id}` : `tv/${id}/1/1`;
  try {
    const r = await httpClient.get(`https://videoapi.la/e/${ruta}`, {
      timeout: 20000,
      responseType: 'text',
      headers: { 'User-Agent': UA },
      validateStatus: () => true,
    });
    return r.status === 200 && /vimeos\.net\/embed-[a-z0-9]+\.html/i.test(String(r.data));
  } catch {
    return false;
  }
}

async function main() {
  console.log('tramo                        cubierto   ejemplo de lo que NO tiene');
  console.log('─'.repeat(88));
  for (const t of TRAMOS) {
    // Dos páginas: 40 títulos por tramo, suficiente para separar 90 % de 30 % y barato de correr.
    const titulos = [...(await idsDeTmdb(t, 1)), ...(await idsDeTmdb(t, 3))];
    if (!titulos.length) { console.log(`${t.nombre.padEnd(28)} — TMDB no contestó`); continue; }

    const hits: boolean[] = [];
    for (let i = 0; i < titulos.length; i += 4) {
      hits.push(...(await Promise.all(titulos.slice(i, i + 4).map((x) => tieneEmbed(t, x.id)))));
    }
    const n = hits.filter(Boolean).length;
    const falta = titulos.find((_, i) => !hits[i]);
    const pct = Math.round((n / titulos.length) * 100);
    console.log(
      `${t.nombre.padEnd(28)} ${String(n).padStart(2)}/${titulos.length}  ${String(pct).padStart(3)} %   ${falta ? falta.nombre.slice(0, 34) : '(los tiene todos)'}`
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
