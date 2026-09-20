/**
 * ¿CUÁNTO APORTARÍA CADA FUENTE CANDIDATA? (2026-09-20)
 *
 * Esto se escribe ANTES que cualquier importador, y el motivo está en `src/config/sources.ts`:
 * cinecalidad se retiró por REDUNDANTE —cero fichas y cero servidores sobre 8.524 filas— después
 * de haberla escrito entera. La pregunta «¿aporta algo?» cuesta un script; responderla tarde
 * cuesta un scraper, sus moldes de url y su reparto de cupo.
 *
 * Mide dos candidatas, y cada una con la vara que le corresponde:
 *
 *   · LAMOVIEBOT publica `tmdb_id` en su JSON, así que el solape se CALCULA, no se estima: las dos
 *     partes hablan en ids de TMDB y no hay emparejamiento por título de por medio. Se muestrean
 *     páginas repartidas por todo el índice (no las primeras, que son los estrenos y son justo las
 *     que más probabilidad tienen de faltarnos: medir solo ahí infla el aporte).
 *
 *   · HFPRO no publica identidad ninguna — solo nombres de fichero—, así que aquí NO se calcula
 *     solape: se cuenta el inventario y se enseña qué nombres salen, que es lo que decide si el
 *     matcher tendría con qué trabajar.
 *
 *   npx ts-node --transpile-only scripts/dev/diag_fuentes_candidatas.ts
 *   npx ts-node --transpile-only scripts/dev/diag_fuentes_candidatas.ts --paginas=40
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { httpClient } from '../../src/utils/httpClient';

const LMB = 'https://lamoviebot.tvymas.workers.dev';
const HFPRO = 'https://hfprolatam.cursolatamsrc.workers.dev';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const PAGINAS = Number(process.argv.find((a) => a.startsWith('--paginas='))?.split('=')[1] || 30);

async function json(url: string, timeout = 60000): Promise<any> {
  const r = await httpClient.get(url, {
    timeout,
    headers: { 'User-Agent': UA },
    validateStatus: () => true,
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status} en ${url}`);
  return r.data;
}

/**
 * Los tmdb_id que ya tenemos, paginando CON `.order()`.
 *
 * Sin ordenar, `.range()` se salta filas y devuelve recuentos falsos —y estables, que es lo que lo
 * hace traicionero: se repite el número y parece confirmado. Está documentado en el repositorio y
 * el diagnóstico de videoapi todavía lo hace mal.
 */
async function nuestrosIds(tipo: 'movie' | 'tvseries'): Promise<Set<number>> {
  const out = new Set<number>();
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await supabase
      .from('media_items')
      .select('tmdb_id')
      .eq('type', tipo)
      .gt('tmdb_id', 0)
      .order('tmdb_id')
      .range(desde, desde + 999);
    if (error) throw new Error(error.message);
    (data || []).forEach((r: any) => out.add(Number(r.tmdb_id)));
    if (!data || data.length < 1000) break;
  }
  return out;
}

interface Ficha {
  tmdb_id: number;
  title: string;
  year: string;
  original_title?: string;
}

function fichasDe(cuerpo: any): Ficha[] {
  const lista = cuerpo.movies || cuerpo.series || cuerpo.animes || cuerpo.results || cuerpo.items || [];
  return (Array.isArray(lista) ? lista : [])
    .map((m: any) => ({
      tmdb_id: Number(m.tmdb_id) || 0,
      title: String(m.title || ''),
      year: String(m.year || '').slice(0, 4),
      original_title: m.original_title ? String(m.original_title) : undefined,
    }))
    .filter((f: Ficha) => f.title);
}

async function medirLamoviebot(ruta: 'peliculas' | 'series' | 'animes', tipo: 'movie' | 'tvseries') {
  const cabeza = await json(`${LMB}/${ruta}`);
  const totalPaginas = Number(cabeza.total_pages) || 1;
  const totalFichas = Number(cabeza.total_results) || 0;

  // Repartidas por todo el índice, no las primeras: los estrenos son los que más nos faltan y
  // medir solo ahí daría un aporte inflado que luego no aparece.
  const cuantas = Math.min(PAGINAS, totalPaginas);
  const paso = Math.max(1, Math.floor(totalPaginas / cuantas));
  const paginas = Array.from({ length: cuantas }, (_, i) => 1 + i * paso).filter((p) => p <= totalPaginas);

  const muestra: Ficha[] = [];
  for (const p of paginas) {
    try {
      muestra.push(...fichasDe(await json(`${LMB}/${ruta}?page=${p}`)));
    } catch (e: any) {
      console.log(`   (página ${p} falló: ${e.message})`);
    }
  }

  const nuestros = await nuestrosIds(tipo);
  const conId = muestra.filter((f) => f.tmdb_id > 0);
  const sinId = muestra.length - conId.length;
  const nuevas = conId.filter((f) => !nuestros.has(f.tmdb_id));
  const unicos = new Set(conId.map((f) => f.tmdb_id));

  console.log(`\n── LAMOVIEBOT · ${ruta.toUpperCase()} ──`);
  console.log(`  su catálogo:      ${totalFichas} fichas en ${totalPaginas} páginas`);
  console.log(`  muestra leída:    ${muestra.length} fichas (${paginas.length} páginas repartidas)`);
  console.log(`  con tmdb_id:      ${conId.length}  ·  SIN tmdb_id: ${sinId}`);
  console.log(`  nuestro catálogo: ${nuestros.size} ids de este tipo`);
  const pct = conId.length ? Math.round((nuevas.length / conId.length) * 100) : 0;
  console.log(`  ya las tenemos:   ${conId.length - nuevas.length}`);
  console.log(`  NUEVAS:           ${nuevas.length}  (${pct} % de la muestra)`);
  console.log(`  proyección:       ~${Math.round((pct / 100) * totalFichas)} fichas nuevas sobre su catálogo entero`);
  console.log(`  (ids distintos en la muestra: ${unicos.size} — si es mucho menor, su paginación repite)`);

  console.log(`  muestra de lo que entraría:`);
  for (const f of nuevas.slice(0, 8)) {
    console.log(`     · tmdb ${f.tmdb_id}  ${f.title} (${f.year})${f.original_title ? `  [${f.original_title}]` : ''}`);
  }
  return nuevas;
}

/** `Avatar_3_Fuego_y_Cenizas_DUAL_2025.mkv` → título "Avatar 3 Fuego y Cenizas", año 2025. */
const RUIDO = new Set([
  'DUAL', 'LAT', 'LATINO', 'CAST', 'SUB', 'ESP', 'ENG', 'HD', 'FHD', 'UHD', '4K',
  '1080P', '720P', '2160P', 'WEB', 'WEBRIP', 'BLURAY', 'BRRIP', 'HDRIP', 'REMUX', 'EXTENDED',
]);

function nombreDeFichero(ruta: string): { titulo: string; anio: string } {
  const base = (ruta.split('/').pop() || '').replace(/\.(mkv|mp4|avi|m4v)$/i, '');
  const trozos = base.split('_').filter(Boolean);
  let anio = '';
  const limpios: string[] = [];
  for (const t of trozos) {
    if (/^(19|20)\d{2}$/.test(t)) { anio = t; continue; }
    if (RUIDO.has(t.toUpperCase())) continue;
    limpios.push(t);
  }
  return { titulo: limpios.join(' ').trim(), anio };
}

async function medirHfpro() {
  const texto = async (u: string) =>
    String((await httpClient.get(u, { timeout: 120000, responseType: 'text', headers: { 'User-Agent': UA } })).data);

  const pelis = await texto(`${HFPRO}/?gatesccn`);
  const series = await texto(`${HFPRO}/?gatesccn2`);

  const rutasPelis = pelis.split('\n').filter((l) => l.startsWith('#EXTINF:')).map((l) => l.split(',').slice(1).join(','));
  const rutasSeries = series.split('\n').filter((l) => l.startsWith('#EXTINF:')).map((l) => l.split(',').slice(1).join(','));

  const conAnio = rutasPelis.map(nombreDeFichero).filter((x) => x.anio);
  // El nombre de la carpeta de la serie, que es donde vive su año: SERIES/…/33_Dias_2026/TEMPORADA1/…
  const carpetas = new Set(rutasSeries.map((r) => r.split('/').slice(0, 3).join('/')));

  console.log(`\n── HFPRO (ficheros directos, sin identidad publicada) ──`);
  console.log(`  películas:        ${rutasPelis.length} ficheros`);
  console.log(`  …con año legible: ${conAnio.length}  (${Math.round((conAnio.length / Math.max(1, rutasPelis.length)) * 100)} %)`);
  console.log(`  episodios:        ${rutasSeries.length} ficheros`);
  console.log(`  series distintas: ${carpetas.size}`);
  console.log(`  ejemplos de nombre (esto es TODO lo que el matcher tendría):`);
  for (const x of conAnio.slice(0, 8)) console.log(`     · "${x.titulo}" (${x.anio})`);
  const sinAnio = rutasPelis.map(nombreDeFichero).filter((x) => !x.anio);
  if (sinAnio.length) {
    console.log(`  y los que NO traen año (${sinAnio.length}) — estos no se pueden respaldar:`);
    for (const x of sinAnio.slice(0, 5)) console.log(`     · "${x.titulo}"`);
  }
}

async function main() {
  console.log('Midiendo qué aportaría cada candidata ANTES de escribir su importador.');
  await medirLamoviebot('peliculas', 'movie');
  await medirLamoviebot('series', 'tvseries');
  await medirLamoviebot('animes', 'tvseries');
  await medirHfpro();
}

main().catch((e) => { console.error(e); process.exit(1); });
