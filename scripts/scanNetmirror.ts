import 'dotenv/config';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { pelicula, episodio, buscarNetflixId, masterHls } from '../src/scrapers/netmirror';
import { traducirYNormalizar } from '../src/utils/idiomas';

/**
 * Escaneo del catálogo contra NetMirror.
 *
 * Recorre las fichas con tmdb_id y para cada una:
 *   1. Comprueba si NetMirror la tiene (via `/api/embed-tmdb/{tmdb}` mp4 mono-audio) → `disponible`.
 *   2. Resuelve su `netflix_id` (via `/search.php?s=<titulo>` sin token).
 *   3. Si `NM_TOKEN_ESCANEO` está en el entorno, llama al HLS master
 *      (`/hls/{netflix_id}.m3u8?in=<token>`) y guarda las pistas de audio disponibles
 *      normalizadas al español (regla: 1 spa = "Español"; 2+ = "Latino"/"Castellano").
 *
 * Para pelis: (tmdb, 0, 0). Para series: (tmdbSerie, 0, 0) — a nivel serie con sonda S1E1.
 *
 *   npx tsx scripts/scanNetmirror.ts
 *   npx tsx scripts/scanNetmirror.ts --tipo=movie
 *   npx tsx scripts/scanNetmirror.ts --refrescar         # revisa lo ya cacheado
 *   npx tsx scripts/scanNetmirror.ts --solo-idiomas      # solo pobla netflix_id + audios
 *                                                       # (no revisa disponible: ya está)
 *   npx tsx scripts/scanNetmirror.ts --limite=500
 *   NM_TOKEN_ESCANEO="…" npx tsx scripts/scanNetmirror.ts   # con audios
 */

const args = process.argv.slice(2);
const soloTipo = args.find(a => a.startsWith('--tipo='))?.split('=')[1] as 'movie' | 'tvseries' | undefined;
const refrescar = args.includes('--refrescar');
const soloIdiomas = args.includes('--solo-idiomas');
const LIMITE = Number(args.find(a => a.startsWith('--limite='))?.split('=')[1] || 0) || Infinity;
const CONCURRENCIA = 3;
const PAUSA_LOTE_MS = 100;
const REFRESCAR_TRAS_DIAS = 14;

const NM_TOKEN = process.env.NM_TOKEN_ESCANEO || '';

const sb = getSupabaseAdmin();

interface Ficha { id: string; tmdb_id: number; type: 'movie' | 'tvseries'; title: string; release_date?: string }

async function yaCacheado(tmdbId: number, temporada: number, episodio: number): Promise<boolean> {
  const { data } = await sb.from('netmirror_cache')
    .select('comprobado_at,netflix_id,idiomas_audio')
    .eq('tmdb_id', tmdbId).eq('temporada', temporada).eq('episodio', episodio)
    .maybeSingle();
  if (!data) return false;
  if (refrescar) return false;
  // En modo `--solo-idiomas` decidimos con criterios distintos: se salta si ya tiene
  // netflix_id + idiomas.
  if (soloIdiomas) return Boolean((data as any).netflix_id && (data as any).idiomas_audio);
  const dias = (Date.now() - Date.parse(data.comprobado_at)) / 86_400_000;
  return dias < REFRESCAR_TRAS_DIAS;
}

async function guardar(row: Record<string, unknown>) {
  await sb.from('netmirror_cache').upsert({
    ...row,
    comprobado_at: new Date().toISOString(),
  }, { onConflict: 'tmdb_id,temporada,episodio' });
}

async function comprobarFicha(f: Ficha, s: number, e: number): Promise<{
  disponible: boolean;
  resolucion: number | null;
  netflix_id: string | null;
  idiomas_audio: Array<{ lang: string; name_es: string; default: boolean }> | null;
  dominio_hls: string | null;
}> {
  const salida = {
    disponible: false as boolean,
    resolucion: null as number | null,
    netflix_id: null as string | null,
    idiomas_audio: null as any,
    dominio_hls: null as string | null,
  };

  // Paso 1 — disponibilidad via embed-tmdb (mp4 mono-audio). Solo si no estamos en `--solo-idiomas`.
  if (!soloIdiomas) {
    const r = f.type === 'movie'
      ? await pelicula(f.tmdb_id).catch(() => null)
      : await episodio(f.tmdb_id, 1, 1).catch(() => null);
    salida.disponible = Boolean(r);
    salida.resolucion = r ? Number(r.meta.resolution) || null : null;
  }

  // Paso 2 — netflix_id via /search.php. Barato, sin token.
  const anio = f.release_date ? f.release_date.slice(0, 4) : undefined;
  salida.netflix_id = await buscarNetflixId(f.title, anio).catch(() => null);

  // Paso 3 — si hay netflix_id + token de sesión, poblamos idiomas_audio.
  if (salida.netflix_id && NM_TOKEN) {
    const m = await masterHls(salida.netflix_id, NM_TOKEN).catch(() => null);
    if (m && m.audios.length > 0) {
      salida.idiomas_audio = traducirYNormalizar(
        m.audios.map(a => ({ language: a.language, name: a.name, uri: a.uri })),
      );
      // dominio_hls: se saca de las URIs de video si hay, o del play-origen conocido.
      const uriEjemplo = m.video[0]?.uri || m.audios[0]?.uri || '';
      try { salida.dominio_hls = new URL(uriEjemplo).hostname; } catch { /* dejar null */ }
    }
  }

  return salida;
}

async function pool<T>(items: T[], concurr: number, fn: (x: T) => Promise<void>) {
  const iter = items[Symbol.iterator]();
  const runners = Array.from({ length: concurr }, async () => {
    for (const it of iter as any) {
      await fn(it);
      if (PAUSA_LOTE_MS > 0) await new Promise(r => setTimeout(r, PAUSA_LOTE_MS));
    }
  });
  await Promise.all(runners);
}

async function main() {
  console.log(`Escaneo NetMirror  concurr=${CONCURRENCIA}  refrescar=${refrescar}  soloIdiomas=${soloIdiomas}  tipo=${soloTipo || 'todos'}  token=${NM_TOKEN ? 'sí' : 'no'}`);

  const tipos: Array<'movie' | 'tvseries'> = soloTipo ? [soloTipo] : ['movie', 'tvseries'];
  const stats = { procesadas: 0, pelisOk: 0, pelisNo: 0, seriesOk: 0, seriesNo: 0, saltadas: 0, netflix: 0, conIdiomas: 0 };
  const t0 = Date.now();

  for (const tipo of tipos) {
    let offset = 0;
    for (;;) {
      const { data, error } = await sb.from('media_items')
        .select('id,tmdb_id,type,title,release_date')
        .eq('type', tipo).gt('tmdb_id', 0)
        .order('tmdb_id')
        .range(offset, offset + 999);
      if (error) { console.error(error); break; }
      const filas = (data as Ficha[]) || [];
      if (filas.length === 0) break;

      await pool(filas, CONCURRENCIA, async f => {
        if (stats.procesadas >= LIMITE) return;
        const s = tipo === 'movie' ? 0 : 1;
        const e = tipo === 'movie' ? 0 : 1;
        if (await yaCacheado(f.tmdb_id, s, e)) { stats.saltadas++; return; }
        const r = await comprobarFicha(f, s, e);

        // En `--solo-idiomas` solo actualizamos columnas nuevas (no `disponible`, que ya está).
        const row: Record<string, unknown> = {
          tmdb_id: f.tmdb_id, temporada: s, episodio: e,
          netflix_id: r.netflix_id,
          idiomas_audio: r.idiomas_audio,
          dominio_hls: r.dominio_hls,
        };
        if (!soloIdiomas) {
          row.disponible = r.disponible;
          row.resolucion = r.resolucion;
        }
        await guardar(row);

        if (r.disponible) { if (tipo === 'movie') stats.pelisOk++; else stats.seriesOk++; }
        else if (!soloIdiomas) { if (tipo === 'movie') stats.pelisNo++; else stats.seriesNo++; }
        if (r.netflix_id) stats.netflix++;
        if (r.idiomas_audio) stats.conIdiomas++;
        stats.procesadas++;
        if (stats.procesadas % 100 === 0) {
          const dt = ((Date.now() - t0) / 1000).toFixed(0);
          console.log(`  ${stats.procesadas}  ${dt}s  disp=${stats.pelisOk + stats.seriesOk}/${stats.pelisOk + stats.pelisNo + stats.seriesOk + stats.seriesNo}  netflix_id=${stats.netflix}  idiomas=${stats.conIdiomas}`);
        }
      });

      if (stats.procesadas >= LIMITE) break;
      offset += 1000;
    }
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(0);
  console.log('---');
  console.log(`Pelis:  ${stats.pelisOk} disp  ${stats.pelisNo} no  |  Series: ${stats.seriesOk} disp  ${stats.seriesNo} no`);
  console.log(`Netflix ids resueltos: ${stats.netflix}   Idiomas poblados: ${stats.conIdiomas}   Saltadas: ${stats.saltadas}`);
  console.log(`Total: ${dt}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
