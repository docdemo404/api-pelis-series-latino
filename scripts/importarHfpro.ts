/**
 * IMPORTA EL CATÁLOGO DE HFPRO, Y LO MANTIENE AL DÍA.
 *
 * Es la fuente OPUESTA a lamoviebot: aquella traía identidad de sobra y poco vídeo; esta trae
 * vídeo directo y CERO identidad. Lo único que publica es el nombre del fichero, así que aquí
 * FUENTES.md §1 aplica entero y la identidad la demuestra NUESTRO matcher (`resolveTmdb`),
 * exigiendo `verified`. Lo que solo se parece no se escribe — «matched» significa «el título se
 * parece ≥ 0,6», y adoptar con eso es como se sueldan dos obras distintas (§3).
 *
 * MEDIDO ANTES DE ESCRIBIR ESTO (`diag_hfpro.ts`), que es la disciplina que con lamoviebot me
 * salté y costó una proyección inflada:
 *
 *   inventario (ya sin basura):  100 películas · 789 series · 13.340 episodios
 *   identificables:              83 % de la muestra (50 de 60)
 *   nuevas para nosotros:        39 de 60  →  proyección ~513 series y ~7.193 episodios
 *   reproducen:                  5 de 5, con 1 MB de bytes reales por fichero
 *
 * CÓMO SE VERIFICA AQUÍ, que es más simple que en las fuentes de embeds: no hay reproductor que
 * desempaquetar ni manifiesto que bajar — se pide un RANGO REAL del fichero y se miran los bytes.
 * Un 206 con un mega dentro es la prueba entera. Y pasa igualmente por `esVideoDeMuestra`, porque
 * el 2026-09-20 aprendimos por las malas que un mp4 sanísimo puede ser un clip de prueba de diez
 * segundos haciéndose pasar por la obra.
 *
 * LO QUE SE GUARDA ES LA URL DEL WORKER, y no es pereza: el salto siguiente lleva a una url
 * firmada de AWS que caduca, pero la del worker se vuelve a acuñar sola en cada petición y
 * **NO va atada a IP** (su firma solo lleva `Expires`, sin condición de dirección — medido). Es la
 * misma propiedad que pone a Internet Archive en prioridad 2.
 *
 *   npm run importar:hfpro -- --dry                ← qué entraría, sin escribir
 *   npm run importar:hfpro                         ← una tanda (60 fichas, 25 min)
 *   npm run importar:hfpro -- --solo=peliculas
 *   npm run importar:hfpro -- --carpeta=Mad_Men_2007
 *   npm run importar:hfpro -- --limite=0 --minutos=0   ← todo
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { httpClient } from '../src/utils/httpClient';
import { esVideoDeMuestra } from '../src/scrapers/directStream';
import { TmdbService } from '../src/services/tmdbService';
import { fusionarTemporadas } from '../src/services/catalogService';
import { searchIndexKey } from '../src/utils/text';
import {
  listarPeliculas,
  listarSeries,
  idDeFicha,
  UA_NAVEGADOR,
  PeliculaHfpro,
  SerieHfpro,
  EpisodioHfpro,
} from '../src/scrapers/hfpro';
import { MediaItem, ServerOption, ContentType } from '../src/types';

const db = getSupabaseAdmin();
const argv = process.argv.slice(2);

const bandera = (nombre: string, pordefecto: number): number => {
  const v = argv.find((a) => a.startsWith(`--${nombre}=`));
  if (!v) return pordefecto;
  const n = Number(v.split('=')[1]);
  return Number.isFinite(n) && n >= 0 ? n : pordefecto;
};
const SIN_TOPE = Number.POSITIVE_INFINITY;
const DRY = argv.includes('--dry');
const REHACER = argv.includes('--rehacer');
const REFRESCAR = argv.includes('--refrescar-indice');
const LIMITE = bandera('limite', 60) || SIN_TOPE;
const MINUTOS = bandera('minutos', 25) || SIN_TOPE;
const CAPITULOS_POR_SERIE = bandera('capitulos', 24) || SIN_TOPE;
const SOLO = (argv.find((a) => a.startsWith('--solo=')) || '').split('=')[1] || '';
const CARPETAS = ((argv.find((a) => a.startsWith('--carpeta=')) || '').split('=')[1] || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const fin = Date.now() + (MINUTOS === SIN_TOPE ? 0 : MINUTOS * 60_000);
const quedaTiempo = () => MINUTOS === SIN_TOPE || Date.now() < fin;
const VOLCADO = path.join(process.cwd(), 'data', 'hfpro_indice.json');

const cuenta = {
  fichasNuevas: 0, fichasEnriquecidas: 0, capitulos: 0,
  sinVideo: 0, sinIdentidad: 0, errores: 0,
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// EL ÍNDICE, volcado a disco antes de trabajarlo (misma razón que en lamoviebot: es un Worker
// ajeno y puede desaparecer a mitad; el trabajo pendiente no debe depender de que siga vivo).
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Indice { creado: string; peliculas: PeliculaHfpro[]; series: SerieHfpro[] }

async function obtenerIndice(): Promise<Indice> {
  if (!REFRESCAR && fs.existsSync(VOLCADO)) {
    try {
      const g: Indice = JSON.parse(fs.readFileSync(VOLCADO, 'utf8'));
      const horas = (Date.now() - new Date(g.creado).getTime()) / 3_600_000;
      if (horas < 24 && g.peliculas?.length && g.series?.length) {
        console.log(`Índice del volcado (${Math.round(horas)} h · ${g.peliculas.length} pelis, ${g.series.length} series).`);
        return g;
      }
    } catch {}
  }
  console.log('Bajando sus dos listas…');
  const [peliculas, series] = await Promise.all([listarPeliculas(), listarSeries()]);
  const indice: Indice = { creado: new Date().toISOString(), peliculas, series };
  try {
    fs.mkdirSync(path.dirname(VOLCADO), { recursive: true });
    fs.writeFileSync(VOLCADO, JSON.stringify(indice), 'utf8');
  } catch (e: any) {
    console.log(`  (no se pudo guardar el volcado: ${e?.message})`);
  }
  console.log(`  ${peliculas.length} películas · ${series.length} series · ${series.reduce((a, s) => a + s.episodios.length, 0)} episodios`);
  return indice;
}

/** Lo que ya tenemos, `tmdb_id` → id de fila. Paginado CON `.order()`. */
async function nuestrasFilas(type: ContentType): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await db
      .from('media_items').select('tmdb_id,id').eq('type', type).gt('tmdb_id', 0)
      .order('tmdb_id').range(desde, desde + 999);
    if (error) throw new Error(error.message);
    (data || []).forEach((r: any) => out.set(Number(r.tmdb_id), String(r.id)));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// IDENTIDAD Y VÍDEO
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ¿Sabemos DEMOSTRAR de qué obra es esto?
 *
 * Se exige `verified`, no `matched`. La diferencia no es de grado: `matched` significa que el
 * título se parece, y el catálogo está lleno de homónimos exactos. Sin respaldo independiente —el
 * año, casi siempre, porque es lo único más que publica el nombre de la carpeta— no se adopta la
 * ficha de TMDB, y sin ficha de TMDB no se escribe nada (`veredictoDisponibilidad` no anunciaría
 * la fila y quedaría de basura invisible).
 */
async function identidad(titulo: string, anio: number, type: ContentType): Promise<number> {
  try {
    const m = await TmdbService.resolveTmdb(titulo, type, anio ? String(anio) : undefined);
    return m?.verified && m.id > 0 && m.type === type ? m.id : 0;
  } catch {
    return 0;
  }
}

/**
 * ¿ENTREGA ESTE FICHERO VÍDEO DE VERDAD? Un rango real y se miran los bytes.
 *
 * Aquí no hay reproductor que desempaquetar ni manifiesto que bajar, así que la prueba es directa
 * y corta: 206 con contenido. Se piden 512 KB —bastante para distinguir un vídeo de una página de
 * error, poco para no gastar ancho de banda en 13.000 ficheros— y se pasa por `esVideoDeMuestra`,
 * porque un mp4 impecable puede ser un clip de demostración (lección del 2026-09-20).
 */
async function entregaVideo(url: string): Promise<boolean> {
  if (esVideoDeMuestra(url)) return false;
  try {
    const r = await httpClient.get(url, {
      timeout: 60000,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      headers: { 'User-Agent': UA_NAVEGADOR, Range: 'bytes=0-524287' },
      validateStatus: () => true,
    });
    if (r.status !== 206 && r.status !== 200) return false;
    const bytes = (r.data as ArrayBuffer)?.byteLength || 0;
    if (bytes < 100_000) return false;
    // A dónde acabó tras los saltos: si el CDN nos deja en un fichero de muestra, tampoco vale.
    const destino = String((r as any)?.request?.res?.responseUrl || '');
    return !esVideoDeMuestra(destino);
  } catch {
    return false;
  }
}

function servidorDeHfpro(url: string, etiqueta: string): ServerOption {
  const ahora = new Date().toISOString();
  return {
    id: `srv_hfpro_${etiqueta}`,
    name: 'HFPro [Vídeo directo]',
    quality: '1080p',
    language: 'latino',
    status: 'online',
    source_id: 'hfpro',
    embed_url: url,
    direct_stream: url,
    direct_kind: /\.mkv$/i.test(url) ? 'mkv' : 'mp4',
    direct_mode: 'public',
    last_checked: ahora,
    verified_at: ahora,
  } as unknown as ServerOption;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ESCRITURA
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function fichaDesdeTmdb(tmdbId: number, type: ContentType, id: string): Promise<MediaItem | null> {
  const semilla: MediaItem = {
    id, tmdb_id: tmdbId, imdb_id: null, type,
    title: '', original_title: '', aliases: [], overview: '', rating: 0,
    genres: [], subcategories: [], poster: null, backdrop: null, logo: null,
    trailer: null, cast: [], dubbing_cast: [],
  };
  try {
    const f = await TmdbService.enrichMediaItem(semilla);
    return f && f.tmdb_id > 0 && f.title ? f : null;
  } catch {
    return null;
  }
}

function fusionarServidores(previos: any[], nuevos: ServerOption[]): any[] {
  const out = [...(previos || [])];
  for (const n of nuevos) {
    const i = out.findIndex((s: any) => s?.direct_stream === (n as any).direct_stream || s?.id === n.id);
    if (i >= 0) out[i] = { ...out[i], ...n };
    else out.push(n);
  }
  return out;
}

async function insertarFicha(f: MediaItem, servers: ServerOption[], seasons: any[], paginas: string[]): Promise<boolean> {
  const ahora = new Date().toISOString();
  const { error } = await db.from('media_items').insert({
    id: f.id, tmdb_id: f.tmdb_id, imdb_id: f.imdb_id ?? null, type: f.type,
    title: f.title, original_title: f.original_title || f.title,
    title_normalized: searchIndexKey(f.title, f.original_title, f.aliases),
    aliases: f.aliases || [], tagline: f.tagline || '', overview: f.overview || '',
    rating: f.rating || 0, content_rating: f.content_rating || null,
    release_date: f.release_date || '', genres: f.genres || [], subcategories: f.subcategories || [],
    poster: f.poster, backdrop: f.backdrop, logo: f.logo, trailer: f.trailer,
    cast_data: (f.cast_details?.length ? f.cast_details : f.cast) || [],
    dubbing_cast_data: f.dubbing_cast || [], runtime: f.runtime ?? null,
    director: f.director || (f.created_by || []).join(', ') || null,
    metadata_source: f.metadata_source || 'tmdb',
    servers, seasons,
    total_seasons: f.total_seasons || seasons.length || 0, total_episodes: f.total_episodes || 0,
    source_url: paginas[0] || null, source_urls: paginas,
    has_streams: true, streams_updated_at: ahora, streams_checked_at: ahora, updated_at: ahora,
  });
  if (!error) return true;

  if (/duplicate key/i.test(error.message)) {
    const { data } = await db.from('media_items').select('id')
      .eq('tmdb_id', f.tmdb_id).eq('type', f.type).limit(1);
    const ya: any = data && data[0];
    if (ya) return actualizarFicha(String(ya.id), servers, seasons);
  }
  console.log(`   ! ${f.id}: ${error.message}`);
  cuenta.errores++;
  return false;
}

async function actualizarFicha(id: string, servers: ServerOption[], seasonsNuevas: any[]): Promise<boolean> {
  const columnas = [servers.length ? 'servers' : '', seasonsNuevas.length ? 'seasons' : ''].filter(Boolean).join(',');
  if (!columnas) return false;
  const { data: actual, error: errL } = await db.from('media_items').select(columnas).eq('id', id).maybeSingle();
  if (errL) { console.log(`   ! ${id}: ${errL.message}`); cuenta.errores++; return false; }

  const g: any = actual || {};
  const ahora = new Date().toISOString();
  const update: Record<string, unknown> = {
    updated_at: ahora, streams_updated_at: ahora, streams_checked_at: ahora, has_streams: true,
  };
  if (servers.length) update.servers = fusionarServidores(g.servers || [], servers);
  // `seasons` se FUSIONA, nunca se reemplaza: reemplazar borra capítulos de otras fuentes.
  if (seasonsNuevas.length) update.seasons = fusionarTemporadas(g.seasons || [], seasonsNuevas);

  const { error } = await db.from('media_items').update(update).eq('id', id);
  if (error) { console.log(`   ! ${id}: ${error.message}`); cuenta.errores++; return false; }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// TRABAJO
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function haremosPelicula(p: PeliculaHfpro, yaTenemos: Map<number, string>): Promise<void> {
  const tmdbId = await identidad(p.titulo, p.anio, 'movie');
  if (!tmdbId) {
    cuenta.sinIdentidad++;
    console.log(`   ⊘ "${p.titulo}"${p.anio ? ` (${p.anio})` : ''} — sin respaldo, no se adopta`);
    return;
  }
  /**
   * A la que YA tenemos también se le añade su servidor, y a propósito.
   *
   * Es la mitad menos vistosa de esta fuente y puede que la más valiosa: a una ficha que hoy solo
   * tiene embeds que caducan, hfpro le añade un FICHERO DIRECTO que no caduca ni va atado a IP.
   * No le añade un título — le añade una forma de verla que sigue ahí dentro de un mes.
   */
  const filaExistente = yaTenemos.get(tmdbId);
  if (!(await entregaVideo(p.url))) { cuenta.sinVideo++; return; }
  const server = servidorDeHfpro(p.url, idDeFicha('movie', p.ruta));

  if (DRY) { filaExistente ? cuenta.fichasEnriquecidas++ : cuenta.fichasNuevas++; return; }
  if (filaExistente) {
    if (await actualizarFicha(filaExistente, [server], [])) cuenta.fichasEnriquecidas++;
    return;
  }
  const ficha = await fichaDesdeTmdb(tmdbId, 'movie', idDeFicha('movie', p.ruta));
  if (!ficha) { cuenta.sinIdentidad++; return; }
  if (await insertarFicha(ficha, [server], [], [p.url])) cuenta.fichasNuevas++;
}

async function haremosSerie(s: SerieHfpro, yaTenemos: Map<number, string>): Promise<void> {
  const tmdbId = await identidad(s.titulo, s.anio, 'tvseries');
  if (!tmdbId) {
    cuenta.sinIdentidad++;
    console.log(`   ⊘ "${s.titulo}"${s.anio ? ` (${s.anio})` : ''} — sin respaldo, no se adopta`);
    return;
  }
  const filaExistente = yaTenemos.get(tmdbId);

  let ficha: MediaItem | null = null;
  if (!filaExistente) {
    ficha = await fichaDesdeTmdb(tmdbId, 'tvseries', idDeFicha('tvseries', s.carpeta));
    if (!ficha) { cuenta.sinIdentidad++; return; }
  }

  /**
   * CADA CAPÍTULO CON SU PROPIO FICHERO. Aquí no hay que defenderse de nada: la fuente publica un
   * fichero por episodio y ya se comprobó al parsear que la carpeta `TEMPORADA<n>` y el `SxxEyy`
   * del nombre coinciden. Al que no tenga fichero no se le cuelga nada.
   */
  const aTrabajar = s.episodios.slice(0, CAPITULOS_POR_SERIE === SIN_TOPE ? s.episodios.length : CAPITULOS_POR_SERIE);
  const buenos: EpisodioHfpro[] = [];
  for (const e of aTrabajar) {
    if (!quedaTiempo()) break;
    if (await entregaVideo(e.url)) buenos.push(e);
  }
  if (!buenos.length) { cuenta.sinVideo++; return; }

  const ahora = new Date().toISOString();
  const porTemporada = new Map<number, any[]>();
  for (const e of buenos) {
    const lista = porTemporada.get(e.temporada) || [];
    lista.push({
      episode_number: e.episodio,
      servers: [servidorDeHfpro(e.url, `${idDeFicha('tvseries', s.carpeta)}-${e.temporada}x${e.episodio}`)],
      checked_at: ahora,
    });
    porTemporada.set(e.temporada, lista);
  }
  const seasons = [...porTemporada.entries()].sort((a, b) => a[0] - b[0]).map(([n, episodes]) => ({
    season_number: n,
    episodes: episodes.sort((a, b) => a.episode_number - b.episode_number),
  }));

  if (DRY) {
    cuenta.capitulos += buenos.length;
    filaExistente ? cuenta.fichasEnriquecidas++ : cuenta.fichasNuevas++;
    return;
  }
  const apuntar = () => { cuenta.capitulos += buenos.length; };
  if (filaExistente) {
    if (await actualizarFicha(filaExistente, [], seasons)) { cuenta.fichasEnriquecidas++; apuntar(); }
  } else if (ficha) {
    // Los rótulos de TMDB primero y los enlaces encima: si no, los capítulos se llaman «SERIE 1x1».
    const conRotulos = fusionarTemporadas((ficha as any).seasons || [], seasons);
    if (await insertarFicha(ficha, [], conRotulos.length ? conRotulos : seasons, [s.episodios[0].url])) {
      cuenta.fichasNuevas++; apuntar();
    }
  }
}

async function main() {
  console.log(`IMPORTANDO HFPRO${DRY ? ' (--dry, no escribe)' : ''}\n`);
  const indice = await obtenerIndice();

  const trabajos: Array<() => Promise<void>> = [];

  /**
   * QUÉ HAY YA, ANTES DE ARMAR LA COLA.
   *
   * No se puede saber si una obra está sin preguntarle antes a TMDB quién es —el nombre del
   * fichero no trae `tmdb_id`—, así que aquí no se puede descartar por adelantado como en
   * lamoviebot. Lo que SÍ se puede es tener el mapa a mano para que, cuando la identidad salga, la
   * ficha existente se enriquezca directamente en vez de intentar una inserción que va a chocar
   * contra el UNIQUE `(tmdb_id, type)` y llegar al mismo sitio dando un rodeo.
   */
  const filasPorTmdb = {
    movie: await nuestrasFilas('movie'),
    tvseries: await nuestrasFilas('tvseries'),
  };

  if (!SOLO || SOLO === 'series') {
    for (const s of indice.series) {
      if (CARPETAS.length && !CARPETAS.includes(s.carpeta)) continue;
      trabajos.push(() => haremosSerie(s, filasPorTmdb.tvseries));
    }
  }
  if (!SOLO || SOLO === 'peliculas') {
    for (const p of indice.peliculas) {
      if (CARPETAS.length) continue;
      trabajos.push(() => haremosPelicula(p, filasPorTmdb.movie));
    }
  }

  const tanda = trabajos.slice(0, LIMITE === SIN_TOPE ? trabajos.length : LIMITE);
  console.log(`\nCola: ${trabajos.length} · esta tanda: ${tanda.length}\n`);

  for (const t of tanda) {
    if (!quedaTiempo()) { console.log('\n(se acabó el tiempo de la tanda)'); break; }
    try { await t(); } catch (e: any) { cuenta.errores++; console.log(`   ! ${e?.message}`); }
  }

  console.log(
    `\nRESULTADO${DRY ? ' (simulado)' : ''}\n` +
      `  fichas nuevas:        ${cuenta.fichasNuevas}\n` +
      `  fichas enriquecidas:  ${cuenta.fichasEnriquecidas}\n` +
      `  capítulos:            ${cuenta.capitulos}\n` +
      `  sin vídeo que valga:  ${cuenta.sinVideo}\n` +
      `  SIN IDENTIDAD:        ${cuenta.sinIdentidad}   ← solo se parecía; no se adopta\n` +
      `  errores:              ${cuenta.errores}`
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
