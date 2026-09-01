import 'dotenv/config';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { pelicula, episodio } from '../src/scrapers/netmirror';

/**
 * Escaneo del catálogo contra NetMirror.
 *
 * Recorre las fichas con tmdb_id, pregunta a NetMirror si tiene la obra y guarda el resultado en
 * la tabla `netmirror_cache`. Con esto las aperturas dejan de preguntar por las que ya sabemos
 * que no están, y así se corta el efecto rate-limit que reducía cobertura observada en runtime.
 *
 * Para pelis: (tmdb, 0, 0). Para series: (tmdbSerie, 0, 0) — a nivel serie con sonda S1E1. Los
 * episodios sueltos se resuelven al vuelo cuando la serie está marcada disponible.
 *
 *   npx tsx scripts/scanNetmirror.ts               # todo
 *   npx tsx scripts/scanNetmirror.ts --tipo=movie  # solo pelis
 *   npx tsx scripts/scanNetmirror.ts --refrescar   # revisa tambien lo ya cacheado
 *   npx tsx scripts/scanNetmirror.ts --limite=500  # tope de fichas
 */

const args = process.argv.slice(2);
const soloTipo = args.find(a => a.startsWith('--tipo='))?.split('=')[1] as 'movie' | 'tvseries' | undefined;
const refrescar = args.includes('--refrescar');
const LIMITE = Number(args.find(a => a.startsWith('--limite='))?.split('=')[1] || 0) || Infinity;
const CONCURRENCIA = 3;           // NetMirror rate-limita con paralelas altas
const PAUSA_LOTE_MS = 100;        // entre lotes
const REFRESCAR_TRAS_DIAS = 14;

const sb = getSupabaseAdmin();

interface Ficha { id: string; tmdb_id: number; type: 'movie' | 'tvseries'; title: string }

async function yaCacheado(tmdbId: number, temporada: number, episodio: number): Promise<boolean> {
  const { data } = await sb.from('netmirror_cache')
    .select('comprobado_at')
    .eq('tmdb_id', tmdbId).eq('temporada', temporada).eq('episodio', episodio)
    .maybeSingle();
  if (!data) return false;
  if (refrescar) return false;
  const dias = (Date.now() - Date.parse(data.comprobado_at)) / 86_400_000;
  return dias < REFRESCAR_TRAS_DIAS;
}

async function guardar(tmdbId: number, s: number, e: number, disponible: boolean, resolucion: number | null) {
  await sb.from('netmirror_cache').upsert({
    tmdb_id: tmdbId, temporada: s, episodio: e,
    disponible, resolucion,
    comprobado_at: new Date().toISOString(),
  }, { onConflict: 'tmdb_id,temporada,episodio' });
}

async function comprobarFicha(f: Ficha): Promise<{ ok: boolean; res?: number }> {
  if (f.type === 'movie') {
    const r = await pelicula(f.tmdb_id).catch(() => null);
    return { ok: Boolean(r), res: r ? Number(r.meta.resolution) || undefined : undefined };
  }
  const r = await episodio(f.tmdb_id, 1, 1).catch(() => null);
  return { ok: Boolean(r), res: r ? Number(r.meta.resolution) || undefined : undefined };
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
  console.log(`Escaneo NetMirror  concurr=${CONCURRENCIA}  refrescar=${refrescar}  tipo=${soloTipo || 'todos'}`);

  // Batch por páginas de 1000 (rango de supabase)
  const tipos: Array<'movie' | 'tvseries'> = soloTipo ? [soloTipo] : ['movie', 'tvseries'];
  const stats = { pelisOk: 0, pelisNo: 0, pelisSaltadas: 0, seriesOk: 0, seriesNo: 0, seriesSaltadas: 0 };
  const t0 = Date.now();
  let procesadas = 0;

  for (const tipo of tipos) {
    let offset = 0;
    for (;;) {
      const { data, error } = await sb.from('media_items')
        .select('id,tmdb_id,type,title')
        .eq('type', tipo).gt('tmdb_id', 0)
        .order('tmdb_id')
        .range(offset, offset + 999);
      if (error) { console.error(error); break; }
      const filas = (data as Ficha[]) || [];
      if (filas.length === 0) break;

      await pool(filas, CONCURRENCIA, async f => {
        if (procesadas >= LIMITE) return;
        const s = tipo === 'movie' ? 0 : 1;
        const e = tipo === 'movie' ? 0 : 1;
        if (await yaCacheado(f.tmdb_id, s, e)) {
          if (tipo === 'movie') stats.pelisSaltadas++; else stats.seriesSaltadas++;
          return;
        }
        const r = await comprobarFicha(f);
        await guardar(f.tmdb_id, s, e, r.ok, r.res ?? null);
        if (r.ok) { if (tipo === 'movie') stats.pelisOk++; else stats.seriesOk++; }
        else       { if (tipo === 'movie') stats.pelisNo++; else stats.seriesNo++; }
        procesadas++;
        if (procesadas % 100 === 0) {
          const dt = ((Date.now() - t0) / 1000).toFixed(0);
          console.log(`  ${procesadas} procesadas  ${dt}s  pelis=${stats.pelisOk}/${stats.pelisOk + stats.pelisNo}  series=${stats.seriesOk}/${stats.seriesOk + stats.seriesNo}`);
        }
      });

      if (procesadas >= LIMITE) break;
      offset += 1000;
    }
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(0);
  console.log('---');
  console.log(`Pelis:  ${stats.pelisOk} disponibles / ${stats.pelisOk + stats.pelisNo} comprobadas / ${stats.pelisSaltadas} en cache`);
  console.log(`Series: ${stats.seriesOk} disponibles / ${stats.seriesOk + stats.seriesNo} comprobadas / ${stats.seriesSaltadas} en cache`);
  console.log(`Total: ${dt}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
