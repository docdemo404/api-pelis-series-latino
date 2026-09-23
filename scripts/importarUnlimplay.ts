/**
 * IMPORTA UNLIMPLAY: fichas nuevas y servidores de más para las que ya tenemos.
 *
 * UnlimPlay no publica un índice: se le pregunta por un `tmdb_id`. Así que la cola sale de dos
 * sitios, y en este orden (traer lo que no se puede ver rinde más que reforzar lo que ya se ve):
 *
 *   1. NUEVAS — lo popular en TMDB (es-MX) que no está en el catálogo.
 *   2. EXISTENTES — nuestras fichas, en vuelta por `tmdb_id`. Por dónde va la vuelta se guarda en
 *      la tabla `esquema` (`unlimplay_cursor_movie` / `_tv`), porque el runner no conserva nada.
 *
 * Cada servidor se escribe con su vídeo DEMOSTRADO (resolver, manifiesto, un segmento real), como
 * en lamoviebot. Lo que no reproduce no se escribe. Las series se trabajan por capítulo: cada url
 * de UnlimPlay es de un capítulo concreto, así que nunca se cuelga en uno el vídeo de otro.
 *
 *   npm run importar:unlimplay -- --dry
 *   npm run importar:unlimplay                       ← una tanda (300 títulos, 40 min)
 *   npm run importar:unlimplay -- --solo=peliculas
 *   npm run importar:unlimplay -- --tmdb=550,1399    ← solo esos (película o serie, se prueban ambas)
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { getDb } from '../src/db/libsql';
import { httpClient } from '../src/utils/httpClient';
import { extractDirect, esVideoDeMuestra } from '../src/scrapers/directStream';
import { bajarManifiesto, segmentoDescargable } from '../src/services/manifestHealth';
import { TmdbService, TMDB_API_KEY } from '../src/services/tmdbService';
import { fusionarTemporadas } from '../src/services/catalogService';
import { searchIndexKey } from '../src/utils/text';
import {
  servidoresPorIdioma,
  embedsLatinos,
  urlDeEmbed,
  idDeFicha,
  EmbedUnlimplay,
  UA_NAVEGADOR,
  REFERER_UNLIMPLAY,
} from '../src/scrapers/unlimplay';
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
const LIMITE = bandera('limite', 300) || SIN_TOPE;
const MINUTOS = bandera('minutos', 40) || SIN_TOPE;
const PAGINAS_TMDB = bandera('paginas', 15);
const DESDE_TMDB = Math.min(500, Math.max(1, bandera('desde', 1)));
const CAPITULOS_POR_SERIE = bandera('capitulos', 8) || SIN_TOPE;
const TITULOS_A_LA_VEZ = 3;
const SOLO = (argv.find((a) => a.startsWith('--solo=')) || '').split('=')[1] || '';
const TMDB_IDS = ((argv.find((a) => a.startsWith('--tmdb=')) || '').split('=')[1] || '')
  .split(',')
  .map(Number)
  .filter((n) => n > 0);

const fin = Date.now() + (MINUTOS === SIN_TOPE ? 0 : MINUTOS * 60_000);
const quedaTiempo = () => MINUTOS === SIN_TOPE || Date.now() < fin;

const cuenta = { fichasNuevas: 0, fichasEnriquecidas: 0, capitulos: 0, sinLatino: 0, sinVideo: 0, sinTmdb: 0, errores: 0 };

// ── la cola ─────────────────────────────────────────────────────────────────────────────────────

/** `tmdb_id` → id de fila. Paginado CON `.order()`: sin él, `.range()` se salta filas. */
async function nuestrasFilas(type: ContentType): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await db
      .from('media_items')
      .select('tmdb_id,id')
      .eq('type', type)
      .gt('tmdb_id', 0)
      .order('tmdb_id')
      .range(desde, desde + 999);
    if (error) throw new Error(error.message);
    (data || []).forEach((r: any) => out.set(Number(r.tmdb_id), String(r.id)));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function popularesTmdb(tipo: 'movie' | 'tv'): Promise<number[]> {
  const ids: number[] = [];
  for (let p = DESDE_TMDB; p < DESDE_TMDB + PAGINAS_TMDB && p <= 500; p++) {
    try {
      const { data } = await httpClient.get(`https://api.themoviedb.org/3/discover/${tipo}`, {
        params: { api_key: TMDB_API_KEY, language: 'es-MX', sort_by: 'vote_count.desc', page: p },
        timeout: 15000,
      });
      ids.push(...(data.results || []).map((r: any) => Number(r.id)).filter((n: number) => n > 0));
    } catch {
      break;
    }
  }
  return [...new Set(ids)];
}

/**
 * Las fichas cuyo ÚNICO origen es VideoAPI: si su CDN se atasca, la app no tiene a dónde saltar.
 * Van primero porque un respaldo ahí vale más que un tercer servidor en otra. En series se mira
 * el texto de `seasons` (aproximado: basta con que no aparezca ninguna otra fuente).
 */
async function soloVideoapi(type: ContentType): Promise<Set<number>> {
  const sql = type === 'movie'
    ? `SELECT tmdb_id FROM media_items WHERE type='movie' AND tmdb_id>0 AND json_array_length(servers)>0
         AND NOT EXISTS (SELECT 1 FROM json_each(servers) WHERE coalesce(json_extract(value,'$.source_id'),'') <> 'videoapi')`
    : `SELECT tmdb_id FROM media_items WHERE type<>'movie' AND tmdb_id>0 AND seasons LIKE '%videoapi%'
         AND seasons NOT LIKE '%unlimplay%' AND seasons NOT LIKE '%"source_id":"hfpro"%' AND seasons NOT LIKE '%lamoviebot%'`;
  const r = await getDb().execute(sql);
  return new Set(r.rows.map((f) => Number(f[0])));
}

const claveCursor = (type: ContentType) => `unlimplay_cursor_${type === 'movie' ? 'movie' : 'tv'}`;

async function leerCursor(type: ContentType): Promise<number> {
  const { data } = await db.from('esquema').select('valor').eq('clave', claveCursor(type)).maybeSingle();
  return Number((data as any)?.valor) || 0;
}

async function guardarCursor(type: ContentType, tmdb: number): Promise<void> {
  if (DRY || !tmdb) return;
  const { error } = await db.from('esquema').upsert({ clave: claveCursor(type), valor: String(tmdb) }, { onConflict: 'clave' });
  if (error) console.log(`   ! cursor ${type}: ${error.message}`);
}

/** Nuestras fichas a partir del cursor, dando la vuelta al llegar al final. */
function enVuelta(filas: Map<number, string>, cursor: number): Array<[number, string]> {
  const todas = [...filas.entries()].sort((a, b) => a[0] - b[0]);
  const i = todas.findIndex(([tmdb]) => tmdb > cursor);
  return i <= 0 ? todas : [...todas.slice(i), ...todas.slice(0, i)];
}

// ── vídeo ───────────────────────────────────────────────────────────────────────────────────────

async function resolverYVerificar(embedUrl: string): Promise<{ url: string; kind: 'hls' | 'mp4'; host: string } | null> {
  try {
    const r = await httpClient.get(embedUrl, {
      timeout: 20000,
      responseType: 'text',
      transformResponse: [(d: unknown) => d],
      headers: { 'User-Agent': UA_NAVEGADOR, Referer: REFERER_UNLIMPLAY },
      validateStatus: () => true,
    });
    if (r.status !== 200) return null;
    const directo = await extractDirect(embedUrl, String(r.data), { allowNetwork: true });
    if (!directo || esVideoDeMuestra(directo.url)) return null;
    if (directo.kind === 'hls') {
      const manifiesto = await bajarManifiesto(directo.url, embedUrl);
      if (!manifiesto || !(await segmentoDescargable(manifiesto, directo.url, embedUrl))) return null;
    }
    let host = '';
    try {
      host = new URL(directo.url).hostname;
    } catch {}
    return { url: directo.url, kind: directo.kind, host };
  } catch {
    return null;
  }
}

function servidorDeUnlimplay(embed: EmbedUnlimplay, directo: { url: string; kind: 'hls' | 'mp4'; host: string }, etiqueta: string): ServerOption {
  const ahora = new Date().toISOString();
  const nombre = embed.server.replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    id: `unlimplay-${etiqueta}-${embed.server.replace(/\W+/g, '-')}`,
    name: `UnlimPlay · ${nombre}`,
    quality: '1080p',
    language: 'latino',
    embed_url: embed.link,
    direct_stream: directo.url,
    direct_kind: directo.kind,
    direct_host: directo.host,
    headers: { Referer: REFERER_UNLIMPLAY, 'User-Agent': UA_NAVEGADOR },
    status: 'online',
    last_checked: ahora,
    verified_at: ahora,
    source_id: 'unlimplay',
  } as ServerOption;
}

/** Los servidores que reproducen de una url de UnlimPlay; `null` = la página no contestó. */
async function servidoresDe(url: string, etiqueta: string, tope: number): Promise<ServerOption[] | null> {
  const porIdioma = await servidoresPorIdioma(url);
  if (!porIdioma) return null;
  const embeds = embedsLatinos(porIdioma);
  if (!embeds.length) return [];
  const salidas = await Promise.all(
    embeds.map(async (e) => {
      const d = await resolverYVerificar(e.link);
      return d ? servidorDeUnlimplay(e, d, etiqueta) : null;
    })
  );
  return salidas.filter((s): s is ServerOption => !!s).slice(0, tope);
}

// ── escritura (mismo patrón que importarLamoviebot: se añade, nunca se pisa) ────────────────────

async function fichaDesdeTmdb(tmdbId: number, type: ContentType): Promise<MediaItem | null> {
  const semilla: MediaItem = {
    id: idDeFicha(type === 'movie' ? 'movie' : 'tvseries', tmdbId),
    tmdb_id: tmdbId,
    imdb_id: null,
    type,
    title: '',
    original_title: '',
    aliases: [],
    overview: '',
    rating: 0,
    genres: [],
    subcategories: [],
    poster: null,
    backdrop: null,
    logo: null,
    trailer: null,
    cast: [],
    dubbing_cast: [],
  };
  try {
    const ficha = await TmdbService.enrichMediaItem(semilla);
    return ficha && ficha.tmdb_id > 0 && ficha.title ? ficha : null;
  } catch {
    return null;
  }
}

function fusionarServidores(previos: any[], nuevos: ServerOption[]): any[] {
  const fuera = [...(previos || [])];
  for (const nuevo of nuevos) {
    const i = fuera.findIndex((s: any) => s?.embed_url === nuevo.embed_url || s?.id === nuevo.id);
    if (i >= 0) fuera[i] = { ...fuera[i], ...nuevo };
    else fuera.push(nuevo);
  }
  return fuera;
}

async function insertarFicha(ficha: MediaItem, servers: ServerOption[], seasons: any[], pagina: string): Promise<boolean> {
  const ahora = new Date().toISOString();
  const { error } = await db.from('media_items').insert({
    id: ficha.id,
    tmdb_id: ficha.tmdb_id,
    imdb_id: ficha.imdb_id ?? null,
    type: ficha.type,
    title: ficha.title,
    original_title: ficha.original_title || ficha.title,
    title_normalized: searchIndexKey(ficha.title, ficha.original_title, ficha.aliases),
    aliases: ficha.aliases || [],
    tagline: ficha.tagline || '',
    overview: ficha.overview || '',
    rating: ficha.rating || 0,
    content_rating: ficha.content_rating || null,
    release_date: ficha.release_date || '',
    genres: ficha.genres || [],
    subcategories: ficha.subcategories || [],
    poster: ficha.poster,
    backdrop: ficha.backdrop,
    logo: ficha.logo,
    trailer: ficha.trailer,
    cast_data: (ficha.cast_details && ficha.cast_details.length ? ficha.cast_details : ficha.cast) || [],
    dubbing_cast_data: ficha.dubbing_cast || [],
    runtime: ficha.runtime ?? null,
    director: ficha.director || (ficha.created_by || []).join(', ') || null,
    metadata_source: ficha.metadata_source || 'tmdb',
    servers,
    seasons,
    total_seasons: ficha.total_seasons || seasons.length || 0,
    total_episodes: ficha.total_episodes || 0,
    source_url: pagina,
    source_urls: [pagina],
    has_streams: true,
    streams_updated_at: ahora,
    streams_checked_at: ahora,
    updated_at: ahora,
  });
  if (!error) return true;
  if (/duplicate key|UNIQUE/i.test(error.message)) {
    const { data } = await db.from('media_items').select('id').eq('tmdb_id', ficha.tmdb_id).eq('type', ficha.type).limit(1);
    const yaEsta: any = data && data[0];
    if (yaEsta) return actualizarFicha(String(yaEsta.id), servers, seasons);
  }
  console.log(`   ! ${ficha.id}: ${error.message}`);
  cuenta.errores++;
  return false;
}

async function actualizarFicha(id: string, servers: ServerOption[], seasonsNuevas: any[]): Promise<boolean> {
  const columnas = [servers.length ? 'servers' : '', seasonsNuevas.length ? 'seasons' : ''].filter(Boolean).join(',');
  if (!columnas) return false;
  // Se lee JUSTO antes de fusionar: otro escritor pudo añadir capítulos entretanto.
  const { data: actual, error: errLectura } = await db.from('media_items').select(columnas).eq('id', id).maybeSingle();
  if (errLectura) {
    console.log(`   ! ${id}: ${errLectura.message}`);
    cuenta.errores++;
    return false;
  }
  const guardado: any = actual || {};
  const ahora = new Date().toISOString();
  const update: Record<string, unknown> = { updated_at: ahora, streams_updated_at: ahora, streams_checked_at: ahora, has_streams: true };
  if (servers.length) update.servers = fusionarServidores(guardado.servers || [], servers);
  if (seasonsNuevas.length) update.seasons = fusionarTemporadas(guardado.seasons || [], seasonsNuevas);
  const { error } = await db.from('media_items').update(update).eq('id', id);
  if (error) {
    console.log(`   ! ${id}: ${error.message}`);
    cuenta.errores++;
    return false;
  }
  return true;
}

// ── trabajo ─────────────────────────────────────────────────────────────────────────────────────

interface Trabajo {
  type: ContentType;
  tmdb: number;
  filaExistente?: string;
}

async function pelicula(t: Trabajo): Promise<void> {
  const url = urlDeEmbed('movie', t.tmdb);
  const servers = await servidoresDe(url, String(t.tmdb), 3);
  if (servers === null) {
    cuenta.errores++;
    return;
  }
  if (!servers.length) {
    cuenta.sinVideo++;
    return;
  }
  if (DRY) {
    t.filaExistente ? cuenta.fichasEnriquecidas++ : cuenta.fichasNuevas++;
    return;
  }
  if (t.filaExistente) {
    if (await actualizarFicha(t.filaExistente, servers, [])) cuenta.fichasEnriquecidas++;
    return;
  }
  const ficha = await fichaDesdeTmdb(t.tmdb, 'movie');
  if (!ficha) {
    cuenta.sinTmdb++;
    return;
  }
  if (await insertarFicha(ficha, servers, [], url)) {
    cuenta.fichasNuevas++;
    console.log(`   + ${ficha.title} (${String(ficha.release_date || '').slice(0, 4)}) · ${servers.length} servidores`);
  }
}

/** Los capítulos a pedir: los que menos servidores tienen primero, luego en orden. */
function capitulosAPedir(seasons: any[]): Array<{ temporada: number; capitulo: number }> {
  const lista: Array<{ temporada: number; capitulo: number; n: number }> = [];
  for (const s of seasons || []) {
    const nT = Number(s?.season_number);
    if (!(nT > 0)) continue;
    for (const e of s?.episodes || []) {
      const nE = Number(e?.episode_number);
      if (nE > 0) lista.push({ temporada: nT, capitulo: nE, n: (e?.servers || []).length });
    }
  }
  return lista
    .sort((a, b) => a.n - b.n || a.temporada - b.temporada || a.capitulo - b.capitulo)
    .slice(0, CAPITULOS_POR_SERIE === SIN_TOPE ? lista.length : CAPITULOS_POR_SERIE)
    .map(({ temporada, capitulo }) => ({ temporada, capitulo }));
}

async function serie(t: Trabajo): Promise<void> {
  let ficha: MediaItem | null = null;
  let seasonsBase: any[] = [];
  if (t.filaExistente) {
    const { data } = await db.from('media_items').select('seasons').eq('id', t.filaExistente).maybeSingle();
    seasonsBase = (data as any)?.seasons || [];
  } else {
    // Sonda barata antes de pedir la ficha entera a TMDB: si no hay latino en el 1x1, no se sigue.
    const sonda = embedsLatinos(await servidoresPorIdioma(urlDeEmbed('tv', t.tmdb, 1, 1)).catch(() => null));
    if (!sonda.length) {
      cuenta.sinLatino++;
      return;
    }
    ficha = await fichaDesdeTmdb(t.tmdb, 'tvseries');
    if (!ficha) {
      cuenta.sinTmdb++;
      return;
    }
    seasonsBase = (ficha as any).seasons || [];
  }

  const resueltos: Array<{ temporada: number; capitulo: number; servers: ServerOption[] }> = [];
  for (const c of capitulosAPedir(seasonsBase)) {
    if (!quedaTiempo()) break;
    const servers = await servidoresDe(urlDeEmbed('tv', t.tmdb, c.temporada, c.capitulo), `${t.tmdb}-${c.temporada}x${c.capitulo}`, 2).catch(() => null);
    if (servers && servers.length) resueltos.push({ ...c, servers });
  }
  if (!resueltos.length) {
    cuenta.sinVideo++;
    return;
  }

  const ahora = new Date().toISOString();
  const porTemporada = new Map<number, any[]>();
  for (const r of resueltos) {
    const lista = porTemporada.get(r.temporada) || [];
    lista.push({ episode_number: r.capitulo, servers: r.servers, checked_at: ahora });
    porTemporada.set(r.temporada, lista);
  }
  const seasons = [...porTemporada.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, episodes]) => ({ season_number: n, episodes: episodes.sort((a, b) => a.episode_number - b.episode_number) }));

  if (DRY) {
    cuenta.capitulos += resueltos.length;
    t.filaExistente ? cuenta.fichasEnriquecidas++ : cuenta.fichasNuevas++;
    return;
  }
  if (t.filaExistente) {
    if (await actualizarFicha(t.filaExistente, [], seasons)) {
      cuenta.fichasEnriquecidas++;
      cuenta.capitulos += resueltos.length;
    }
  } else if (ficha) {
    // Los rótulos de TMDB primero y los enlaces encima, para que los capítulos no se llamen «SERIE 1x1».
    const conRotulos = fusionarTemporadas(seasonsBase, seasons);
    if (await insertarFicha(ficha, [], conRotulos.length ? conRotulos : seasons, urlDeEmbed('tv', t.tmdb, 1, 1))) {
      cuenta.fichasNuevas++;
      cuenta.capitulos += resueltos.length;
      console.log(`   + ${ficha.title} (serie) · ${resueltos.length} capítulos`);
    }
  }
}

async function main() {
  console.log(`IMPORTANDO UNLIMPLAY${DRY ? ' (--dry, no escribe)' : ''}\n`);
  const tipos: ContentType[] = SOLO === 'peliculas' ? ['movie'] : SOLO === 'series' ? ['tvseries'] : ['movie', 'tvseries'];

  const nuevas: Trabajo[] = [];
  const existentes: Trabajo[] = [];
  const cursores = new Map<ContentType, number>();
  for (const type of tipos) {
    const nuestras = await nuestrasFilas(type);
    if (TMDB_IDS.length) {
      for (const tmdb of TMDB_IDS) (nuestras.has(tmdb) ? existentes : nuevas).push({ type, tmdb, filaExistente: nuestras.get(tmdb) });
      continue;
    }
    const populares = await popularesTmdb(type === 'movie' ? 'movie' : 'tv');
    const faltan = populares.filter((id) => !nuestras.has(id));
    console.log(`${type}: ${nuestras.size} nuestras · ${populares.length} populares en TMDB, ${faltan.length} que no tenemos`);
    for (const tmdb of faltan) nuevas.push({ type, tmdb });
    const cursor = await leerCursor(type);
    cursores.set(type, cursor);
    const sinRespaldo = await soloVideoapi(type);
    const candidatas = new Map([...nuestras].filter(([tmdb]) => sinRespaldo.has(tmdb)));
    console.log(`${type}: ${candidatas.size} fichas solo con VideoAPI, en vuelta desde tmdb ${cursor}`);
    for (const [tmdb, id] of enVuelta(candidatas, cursor)) existentes.push({ type, tmdb, filaExistente: id });
  }

  // Existentes intercaladas por tipo, para que una tanda corta no se la coman solo las películas.
  const pelis = existentes.filter((t) => t.type === 'movie');
  const series = existentes.filter((t) => t.type !== 'movie');
  const intercaladas: Trabajo[] = [];
  for (let i = 0; i < Math.max(pelis.length, series.length); i++) {
    if (pelis[i]) intercaladas.push(pelis[i]);
    if (series[i]) intercaladas.push(series[i]);
  }
  // Una nueva de cada tres: la primera corrida gastó los 40 minutos solo en novedades.
  const cola: Trabajo[] = [];
  for (let i = 0, j = 0; i < nuevas.length || j < intercaladas.length; ) {
    if (i < nuevas.length) cola.push(nuevas[i++]);
    for (let k = 0; k < 2 && j < intercaladas.length; k++) cola.push(intercaladas[j++]);
  }
  const tanda = cola.slice(0, LIMITE === SIN_TOPE ? cola.length : LIMITE);
  console.log(`\nCola: ${nuevas.length} nuevas + ${existentes.length} existentes · esta tanda: ${tanda.length}\n`);

  const ultimoDespachado = new Map<ContentType, number>();
  let siguiente = 0;
  const obrero = async () => {
    while (siguiente < tanda.length && quedaTiempo()) {
      const t = tanda[siguiente++];
      if (t.filaExistente) ultimoDespachado.set(t.type, t.tmdb);
      try {
        await (t.type === 'movie' ? pelicula(t) : serie(t));
      } catch (e: any) {
        cuenta.errores++;
        console.log(`   ! ${t.type} ${t.tmdb}: ${e?.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: TITULOS_A_LA_VEZ }, obrero));
  if (!quedaTiempo()) console.log('\n(se acabó el tiempo de la tanda)');

  if (!TMDB_IDS.length) for (const [type, tmdb] of ultimoDespachado) await guardarCursor(type, tmdb);

  console.log(
    `\nRESULTADO${DRY ? ' (simulado)' : ''}\n` +
      `  fichas nuevas:        ${cuenta.fichasNuevas}\n` +
      `  fichas enriquecidas:  ${cuenta.fichasEnriquecidas}\n` +
      `  capítulos:            ${cuenta.capitulos}\n` +
      `  serie sin latino:     ${cuenta.sinLatino}\n` +
      `  sin vídeo que valga:  ${cuenta.sinVideo}\n` +
      `  sin ficha de TMDB:    ${cuenta.sinTmdb}\n` +
      `  errores:              ${cuenta.errores}\n` +
      `  vuelta: ${[...ultimoDespachado].map(([t, n]) => `${t} hasta tmdb ${n}`).join(' · ') || '—'}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
