/**
 * LOS SIMPSON DESDE SIMPSONIZADOS: 768 CAPÍTULOS EN LATINO, CON URL PERMANENTE.
 *
 * La fuente está descrita y medida en src/scrapers/simpsonizados.ts. Aquí se hace en DOS PASOS, y
 * el orden no es capricho:
 *
 *   1. RESOLVER (sin base): sitemap → código de videok → master sin firma → verificarlo. El
 *      resultado se vuelca a `data/simpsonizados.json`. Como las urls son permanentes, el volcado
 *      vale mañana igual que hoy: se puede resolver con la base caída (lecturas bloqueadas por
 *      cuota el 2026-09-29) y escribir cuando vuelva, sin volver a molestar a la web.
 *   2. ESCRIBIR: UNA fila leída por clave (`tmdb_id` 456 + `type`), `seasons` FUSIONADO con lo que
 *      ya tenga (`fusionarTemporadas`; reemplazar borra capítulos de otras fuentes) y UNA escrita.
 *
 * IDENTIDAD: la web no publica el `tmdb_id`. Antes de colgar nada de la ficha 456 se exige que la
 * fecha de estreno que declara la web (`datePublished` de /serie/los-simpson/) sea el
 * `first_air_date` de TMDB. Solo el título no basta (FUENTES.md §1, nunca fusionar por título).
 *
 * VERIFICACIÓN de cada capítulo, que es lo que decide si entra:
 *   · no es un vídeo de muestra (`esVideoDeMuestra`);
 *   · el master declara calidades y la variante dura lo que un capítulo (≥ 12 min — un clip de
 *     relleno reproduce perfectamente y no es la obra: voe.sx, 2026-09-20);
 *   · `manifiestoArranca`: la misma prueba del barrido de permanentes, con un trozo real.
 *
 *   npm run importar:simpsonizados -- --dry          ← resolver y volcar, sin escribir
 *   npm run importar:simpsonizados                   ← lo pendiente del volcado + escribir
 *   npm run importar:simpsonizados -- --refrescar    ← volver a resolver los 768
 *   npm run importar:simpsonizados -- --temporada=34 ← solo una temporada
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { httpClient } from '../src/utils/httpClient';
import { esVideoDeMuestra } from '../src/scrapers/directStream';
import { manifiestoArranca } from '../src/services/permanentHealth';
import { TmdbService, TMDB_API_KEY } from '../src/services/tmdbService';
import { fusionarTemporadas } from '../src/services/catalogService';
import { searchIndexKey } from '../src/utils/text';
import {
  listarCapitulos,
  estrenoDeLaSerie,
  codigoVideok,
  masterDeVideok,
  sinSubtitulos,
  CapituloSimpsonizados,
} from '../src/scrapers/simpsonizados';
import { MediaItem } from '../src/types';

const TMDB_SIMPSON = 456;
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const REFRESCAR = argv.includes('--refrescar');
const SOLO_TEMPORADA = Number((argv.find((a) => a.startsWith('--temporada=')) || '').split('=')[1]) || 0;
const EN_PARALELO = 4;
const MINUTOS_MINIMOS = 12;
const VOLCADO = path.join(process.cwd(), 'data', 'simpsonizados.json');

interface Resuelto {
  temporada: number;
  episodio: number;
  pagina: string;
  codigo?: string;
  master?: string;
  calidad?: '4K' | '1080p' | '720p' | '480p';
  minutos?: number;
  audios?: string[];
  ok: boolean;
  motivo?: string;
  resuelto_at: string;
}

interface Volcado { tmdb_id: number; estreno: string; capitulos: Record<string, Resuelto> }

const clave = (t: number, e: number) => `${t}x${e}`;

function leerVolcado(): Volcado {
  try {
    const v = JSON.parse(fs.readFileSync(VOLCADO, 'utf8'));
    if (v && v.capitulos) return v;
  } catch {}
  return { tmdb_id: TMDB_SIMPSON, estreno: '', capitulos: {} };
}

function guardarVolcado(v: Volcado): void {
  fs.mkdirSync(path.dirname(VOLCADO), { recursive: true });
  fs.writeFileSync(VOLCADO, JSON.stringify(v, null, 1), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PASO 1: RESOLVER Y VERIFICAR
// ─────────────────────────────────────────────────────────────────────────────────────────────

function calidadDe(alto: number): Resuelto['calidad'] {
  if (alto >= 2000) return '4K';
  if (alto >= 1000) return '1080p';
  if (alto >= 700) return '720p';
  return '480p';
}

/** Calidad máxima, audios y duración (de la variante más baja, que es la más barata de bajar). */
async function leerMaster(master: string): Promise<{ calidad: Resuelto['calidad']; minutos: number; audios: string[] } | null> {
  const r = await httpClient.get(master, { timeout: 20000, responseType: 'text', validateStatus: () => true });
  if (r.status >= 400) return null;
  const texto = String(r.data || '');
  const altos = [...texto.matchAll(/RESOLUTION=\d+x(\d+)/g)].map((m) => Number(m[1]));
  const audios = [...texto.matchAll(/TYPE=AUDIO[^\n]*LANGUAGE="([^"]+)"/g)].map((m) => m[1]);
  const variante = texto.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!variante) return null;
  const rv = await httpClient.get(new URL(variante, master).toString(), {
    timeout: 20000, responseType: 'text', validateStatus: () => true,
  });
  if (rv.status >= 400) return null;
  const segundos = [...String(rv.data || '').matchAll(/#EXTINF:([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0);
  return { calidad: calidadDe(Math.max(0, ...altos)), minutos: Math.round((segundos / 60) * 10) / 10, audios };
}

async function resolver(c: CapituloSimpsonizados): Promise<Resuelto> {
  const base: Resuelto = { ...c, ok: false, resuelto_at: new Date().toISOString() };
  try {
    const codigo = await codigoVideok(c.pagina);
    if (!codigo) return { ...base, motivo: 'sin opción de videok' };
    let master = await masterDeVideok(codigo);
    if (!master) return { ...base, codigo, motivo: 'videok no dio fuente' };
    if (esVideoDeMuestra(master)) return { ...base, codigo, master, motivo: 'vídeo de muestra' };
    let info = await leerMaster(master);
    // Un subtítulo que falta tumba el master entero (ver `sinSubtitulos`); sin ellos, el vídeo sí.
    const recortado = info ? null : sinSubtitulos(master);
    if (recortado) {
      info = await leerMaster(recortado);
      if (info) master = recortado;
    }
    if (!info) return { ...base, codigo, master, motivo: 'el master no se deja leer' };
    const r = { ...base, codigo, master, ...info };
    if (info.minutos < MINUTOS_MINIMOS) return { ...r, motivo: `dura ${info.minutos} min: no es un capítulo` };
    const arranque = await manifiestoArranca(master);
    if (!arranque.ok) return { ...r, motivo: `no arranca: ${arranque.causa}` };
    return { ...r, ok: true };
  } catch (e: any) {
    return { ...base, motivo: `error: ${e?.message || e}` };
  }
}

async function resolverPendientes(v: Volcado): Promise<void> {
  const todos = await listarCapitulos();
  const lista = SOLO_TEMPORADA ? todos.filter((c) => c.temporada === SOLO_TEMPORADA) : todos;
  const pendientes = lista.filter((c) => REFRESCAR || !v.capitulos[clave(c.temporada, c.episodio)]?.ok);
  console.log(`Sitemap: ${todos.length} capítulos · a resolver: ${pendientes.length}`);

  let hechos = 0;
  const cola = [...pendientes];
  const trabajador = async () => {
    for (let c = cola.shift(); c; c = cola.shift()) {
      const r = await resolver(c);
      v.capitulos[clave(r.temporada, r.episodio)] = r;
      hechos++;
      if (!r.ok) console.log(`   ✗ ${clave(r.temporada, r.episodio)} — ${r.motivo}`);
      // Se vuelca cada 25: si algo corta la corrida, lo resuelto no se pierde.
      if (hechos % 25 === 0) { guardarVolcado(v); console.log(`   … ${hechos}/${pendientes.length}`); }
    }
  };
  await Promise.all(Array.from({ length: EN_PARALELO }, trabajador));
  guardarVolcado(v);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// RÓTULOS DE TMDB (nombre, sinopsis, fotograma y fecha de cada capítulo)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Se piden aquí y no con `getTmdbSeasons`, que se queda en las 15 primeras temporadas: Los Simpson
 * tienen 35 en esta web. Una petición por temporada, solo de las que traen capítulos.
 */
async function rotulosDeTmdb(temporadas: number[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  for (const t of temporadas) {
    try {
      const r = await axios.get(`https://api.themoviedb.org/3/tv/${TMDB_SIMPSON}/season/${t}`, {
        params: { api_key: TMDB_API_KEY, language: 'es-MX' }, timeout: 15000,
      });
      for (const e of r.data?.episodes || []) out.set(clave(t, Number(e.episode_number)), e);
    } catch (e: any) {
      console.log(`   (TMDB no dio la temporada ${t}: ${e?.message})`);
    }
  }
  return out;
}

function servidor(r: Resuelto, ahora: string): any {
  return {
    id: `srv_simpsonizados_${clave(r.temporada, r.episodio)}`,
    name: 'Simpsonizados [Vídeo directo]',
    quality: r.calidad || '720p',
    language: 'latino',
    status: 'online',
    source_id: 'simpsonizados',
    embed_url: r.master,
    direct_stream: r.master,
    direct_kind: 'hls',
    direct_mode: 'public',
    direct_host: new URL(r.master!).hostname,
    last_checked: ahora,
    verified_at: ahora,
  };
}

async function arbolDeTemporadas(buenos: Resuelto[]): Promise<any[]> {
  const numeros = [...new Set(buenos.map((r) => r.temporada))].sort((a, b) => a - b);
  const rotulos = await rotulosDeTmdb(numeros);
  const ahora = new Date().toISOString();
  return numeros.map((t) => ({
    season_number: t,
    episodes: buenos
      .filter((r) => r.temporada === t)
      .sort((a, b) => a.episodio - b.episodio)
      .map((r) => {
        const o = rotulos.get(clave(r.temporada, r.episodio));
        return {
          episode_number: r.episodio,
          ...(o?.name ? { name: o.name } : {}),
          ...(o?.overview ? { overview: o.overview } : {}),
          ...(o?.still_path ? { still_path: `https://image.tmdb.org/t/p/w500${o.still_path}` } : {}),
          ...(o?.air_date ? { air_date: o.air_date } : {}),
          servers: [servidor(r, ahora)],
          checked_at: ahora,
        };
      }),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PASO 2: ESCRIBIR
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function escribir(seasons: any[]): Promise<void> {
  const db = getSupabaseAdmin();
  const ahora = new Date().toISOString();
  // UNA fila, por clave indexada (`idx_media_tmdb_id`). Nunca la tabla.
  const { data, error } = await db.from('media_items')
    .select('id,seasons').eq('tmdb_id', TMDB_SIMPSON).eq('type', 'tvseries').limit(1);
  if (error) throw new Error(`no se pudo leer la ficha: ${error.message}`);
  const fila: any = data && data[0];

  if (fila) {
    const previas = Array.isArray(fila.seasons) ? fila.seasons : [];
    const { error: e2 } = await db.from('media_items').update({
      seasons: fusionarTemporadas(previas, seasons),
      has_streams: true, streams_updated_at: ahora, streams_checked_at: ahora, updated_at: ahora,
    }).eq('id', fila.id);
    if (e2) throw new Error(`no se pudo escribir ${fila.id}: ${e2.message}`);
    console.log(`\n✓ Ficha ${fila.id} actualizada (fusionada con sus ${previas.length} temporadas previas).`);
    return;
  }

  // No estaba: se crea desde TMDB, rótulos de TMDB primero y los enlaces encima.
  const id = `simpsonizados-tv-${TMDB_SIMPSON}`;
  const semilla: MediaItem = {
    id, tmdb_id: TMDB_SIMPSON, imdb_id: null, type: 'tvseries',
    title: '', original_title: '', aliases: [], overview: '', rating: 0,
    genres: [], subcategories: [], poster: null, backdrop: null, logo: null,
    trailer: null, cast: [], dubbing_cast: [],
  };
  const f = await TmdbService.enrichMediaItem(semilla);
  if (!f?.title || f.tmdb_id !== TMDB_SIMPSON) throw new Error('TMDB no devolvió la ficha 456');
  const arbol = fusionarTemporadas((f as any).seasons || [], seasons);
  const { error: e3 } = await db.from('media_items').insert({
    id, tmdb_id: f.tmdb_id, imdb_id: f.imdb_id ?? null, type: f.type,
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
    servers: [], seasons: arbol,
    total_seasons: f.total_seasons || arbol.length || 0, total_episodes: f.total_episodes || 0,
    source_url: 'https://simpsonizados.me/serie/los-simpson/',
    source_urls: ['https://simpsonizados.me/serie/los-simpson/'],
    has_streams: true, streams_updated_at: ahora, streams_checked_at: ahora, updated_at: ahora,
  });
  if (e3) throw new Error(`no se pudo crear ${id}: ${e3.message}`);
  console.log(`\n✓ Ficha ${id} creada.`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`IMPORTANDO SIMPSONIZADOS${DRY ? ' (--dry, no escribe)' : ''}\n`);

  const v = leerVolcado();

  // Identidad antes que nada: si la web no es la serie 456, no se resuelve ni se escribe. Si la
  // web no contesta, vale la fecha que se comprobó al hacer el volcado (se guarda en él).
  const [estrenoWeb, tmdb] = await Promise.all([
    estrenoDeLaSerie().catch(() => ''),
    axios.get(`https://api.themoviedb.org/3/tv/${TMDB_SIMPSON}`, { params: { api_key: TMDB_API_KEY }, timeout: 15000 })
      .then((r) => r.data).catch(() => null),
  ]);
  const estreno = estrenoWeb || v.estreno;
  if (!estreno || !tmdb?.first_air_date || estreno !== tmdb.first_air_date) {
    throw new Error(`identidad sin respaldo: la web dice estreno «${estreno}», TMDB ${TMDB_SIMPSON} dice «${tmdb?.first_air_date}»`);
  }
  console.log(`Identidad: «${tmdb.name}» (TMDB ${TMDB_SIMPSON}), estreno ${estreno}${estrenoWeb ? ' en los dos lados' : ' (del volcado)'}.`);
  v.estreno = estreno;

  /**
   * La web es de hosting compartido y a ratos contesta 508 («Resource Limit Is Reached») al
   * sitemap. Eso no puede frenar la escritura: las urls del volcado son permanentes y ya están
   * verificadas. Sin web se escribe lo que haya; lo pendiente, en la corrida siguiente.
   */
  try {
    await resolverPendientes(v);
  } catch (e: any) {
    const listos = Object.values(v.capitulos).filter((r) => r.ok).length;
    if (!listos) throw e;
    console.log(`(la web no contesta: ${e?.message}; se sigue con los ${listos} capítulos del volcado)`);
  }

  const todos = Object.values(v.capitulos)
    .filter((r) => !SOLO_TEMPORADA || r.temporada === SOLO_TEMPORADA);
  const buenos = todos.filter((r) => r.ok && r.master);
  const porCalidad: Record<string, number> = {};
  buenos.forEach((r) => { porCalidad[r.calidad || '?'] = (porCalidad[r.calidad || '?'] || 0) + 1; });
  const sinEspanol = buenos.filter((r) => r.audios?.length && !r.audios.includes('es')).length;
  console.log(
    `\nRESUELTO\n` +
    `  capítulos verificados: ${buenos.length} de ${todos.length}\n` +
    `  calidades:             ${JSON.stringify(porCalidad)}\n` +
    `  sin pista «es»:        ${sinEspanol}\n` +
    `  volcado:               ${path.relative(process.cwd(), VOLCADO)}`
  );
  for (const r of todos.filter((x) => !x.ok)) console.log(`  ✗ ${clave(r.temporada, r.episodio)} — ${r.motivo}`);

  if (!buenos.length) return;
  const arbol = await arbolDeTemporadas(buenos);
  const conNombre = arbol.flatMap((t) => t.episodes).filter((e: any) => e.name).length;
  console.log(`  rotulados por TMDB:    ${conNombre} de ${buenos.length}`);
  console.log(`  tamaño de «seasons»:   ${Math.round(JSON.stringify(arbol).length / 1024)} KB`);
  if (DRY) {
    console.log(`\nEjemplo:\n${JSON.stringify(arbol[0]?.episodes?.[0], null, 2)}`);
    return;
  }
  await escribir(arbol);
}

main().catch((e) => { console.error(`\n! ${e?.message || e}`); process.exit(1); });
