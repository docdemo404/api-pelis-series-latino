/**
 * PLUTO TV — DE LO QUE VE EL MÓVIL A FICHAS PUBLICADAS.
 *
 * El móvil llena `pluto_titulos` (ver src/scrapers/pluto.ts y src/services/plutoMovil.ts). Esto
 * hace lo que el móvil no puede y Vercel no alcanza a tiempo, en tres pasos:
 *
 *   1. IDENTIFICAR los que nadie ha mirado, contra TMDB (año ±1 + director + duración).
 *   2. PUBLICAR los verificados con audio en español que el móvil ha visto hace poco, o renovarles
 *      el sello. `verified_at` = la última vez que Pluto los tenía: es lo que los mantiene.
 *   3. RETIRAR los que Pluto ya no lista: vistos hace más de 2 días MENOS que el último informe.
 *      Se compara con el último informe y no con el reloj para que un móvil apagado una semana
 *      no vacíe la fuente: sin informes nuevos no se concluye nada.
 *
 *   npx ts-node --transpile-only scripts/importarPluto.ts --dry
 *   npm run importar:pluto -- --minutos=30
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { asegurarEsquema, getDb } from '../src/db/libsql';
import { TmdbService } from '../src/services/tmdbService';
import { CatalogService } from '../src/services/catalogService';
import { paraElCliente } from '../src/services/streamSorter';
import { searchIndexKey } from '../src/utils/text';
import { esServidorPluto, identificarPeliPluto, servidorDePluto, PeliPluto } from '../src/scrapers/pluto';
import { MediaItem, ServerOption } from '../src/types';

const argv = process.argv.slice(2);
const bandera = (n: string, d: number) => {
  const v = argv.find((a) => a.startsWith(`--${n}=`));
  return v ? Number(v.split('=')[1]) : d;
};
const DRY = argv.includes('--dry');
const MINUTOS = bandera('minutos', 40);
const fin = Date.now() + MINUTOS * 60_000;
const quedaTiempo = () => !MINUTOS || Date.now() < fin;

const db = getSupabaseAdmin();
const cuenta = { identificadas: 0, verificadas: 0, nuevas: 0, renovadas: 0, retiradas: 0, errores: 0 };
const dia = 86_400_000;

async function enParalelo<T>(xs: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < xs.length && quedaTiempo()) await fn(xs[i++]);
  }));
}

// ─── 1. IDENTIFICAR ──────────────────────────────────────────────────────────────────────────

async function identificar(): Promise<void> {
  const rs = await getDb().execute(
    `SELECT pluto_id,nombre,anio,minutos,directores FROM pluto_titulos WHERE veredicto IS NULL ORDER BY visto_at DESC`,
  );
  console.log(`\n1. Identificar: ${rs.rows.length} sin mirar`);
  await enParalelo(rs.rows as any[], 6, async (r) => {
    const p: PeliPluto = {
      id: String(r.pluto_id), nombre: String(r.nombre),
      anio: r.anio == null ? undefined : Number(r.anio),
      minutos: r.minutos == null ? undefined : Number(r.minutos),
      directores: JSON.parse(String(r.directores || '[]')),
    };
    let v;
    try { v = await identificarPeliPluto(p); } catch { cuenta.errores++; return; } // TMDB caído: otra vuelta
    cuenta.identificadas++;
    if (v.tipo === 'verificada') cuenta.verificadas++;
    if (DRY) return;
    await getDb().execute({
      sql: `UPDATE pluto_titulos SET veredicto=?, tmdb_id=?, identificado_at=? WHERE pluto_id=?`,
      args: [v.tipo, v.tipo === 'verificada' ? v.tmdbId : null, new Date().toISOString(), p.id],
    });
  });
  console.log(`   ${cuenta.identificadas} miradas · ${cuenta.verificadas} verificadas`);
}

// ─── 2. PUBLICAR ─────────────────────────────────────────────────────────────────────────────

async function fichaDesdeTmdb(tmdbId: number): Promise<MediaItem | null> {
  const semilla: MediaItem = {
    id: `pl-${tmdbId}`, tmdb_id: tmdbId, imdb_id: null, type: 'movie', title: '', original_title: '',
    aliases: [], overview: '', rating: 0, genres: [], subcategories: [], poster: null, backdrop: null,
    logo: null, trailer: null, cast: [], dubbing_cast: [],
  };
  try {
    const f = await TmdbService.enrichMediaItem(semilla, { skipSeasons: true });
    return f && f.tmdb_id > 0 && f.title ? f : null;
  } catch { return null; }
}

/** El de Pluto sustituye al de Pluto que hubiera; lo demás de la ficha no se toca. */
const conPluto = (previos: any[], nuevo: ServerOption) => [...(previos || []).filter((s) => !esServidorPluto(s)), nuevo];

async function publicarUna(tmdbId: number, plutoId: string, vistoAt: string): Promise<boolean> {
  const servidor = servidorDePluto(plutoId, vistoAt);
  const ahora = new Date().toISOString();
  const { data: existente, error: errL } = await db.from('media_items')
    .select('id,servers').eq('tmdb_id', tmdbId).eq('type', 'movie').maybeSingle();
  if (errL) throw new Error(errL.message);

  if (existente) {
    const { error } = await db.from('media_items').update({
      servers: conPluto((existente as any).servers || [], servidor),
      has_streams: true, streams_updated_at: ahora, streams_checked_at: ahora, updated_at: ahora,
    }).eq('id', (existente as any).id);
    if (error) throw new Error(error.message);
    cuenta.renovadas++;
    return true;
  }

  const f = await fichaDesdeTmdb(tmdbId);
  if (!f) return false;
  const { error } = await db.from('media_items').insert({
    id: f.id || `pl-${tmdbId}`, tmdb_id: tmdbId, imdb_id: f.imdb_id ?? null, type: 'movie',
    title: f.title, original_title: f.original_title || f.title,
    title_normalized: searchIndexKey(f.title, f.original_title, f.aliases), aliases: f.aliases || [],
    tagline: f.tagline || '', overview: f.overview || '', rating: f.rating || 0,
    content_rating: f.content_rating || null, release_date: f.release_date || '', genres: f.genres || [],
    subcategories: f.subcategories || [], poster: f.poster, backdrop: f.backdrop, logo: f.logo,
    trailer: f.trailer, cast_data: (f.cast_details?.length ? f.cast_details : f.cast) || [],
    dubbing_cast_data: f.dubbing_cast || [], runtime: f.runtime ?? null, director: f.director || null,
    metadata_source: f.metadata_source || 'tmdb', servers: [servidor], seasons: [],
    total_seasons: 0, total_episodes: 0, source_url: null, source_urls: [],
    has_streams: true, streams_updated_at: ahora, streams_checked_at: ahora, updated_at: ahora,
  });
  if (error) {
    // Otro escritor la creó entre medias: se reintenta como actualización.
    if (/duplicate|UNIQUE/i.test(error.message)) return publicarUna(tmdbId, plutoId, vistoAt);
    throw new Error(error.message);
  }
  cuenta.nuevas++;
  return true;
}

async function publicar(): Promise<void> {
  // Verificadas, con audio español, vistas en la última semana, y que o no están publicadas o
  // llevan el sello de hace más de un día y el móvil las ha visto después. Una por tmdb_id: la
  // vista más reciente.
  const rs = await getDb().execute(`
    SELECT pluto_id, tmdb_id, visto_at FROM (
      SELECT pluto_id, tmdb_id, visto_at, publicado_at,
             row_number() OVER (PARTITION BY tmdb_id ORDER BY visto_at DESC) AS n
      FROM pluto_titulos
      WHERE veredicto='verificada' AND tmdb_id > 0
        AND EXISTS (SELECT 1 FROM json_each(COALESCE(audios,'[]')) a WHERE a.value LIKE 'es%' OR a.value LIKE 'spa%')
        AND visto_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
    ) WHERE n=1 AND (publicado_at IS NULL OR (publicado_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') AND visto_at > publicado_at))`);
  console.log(`\n2. Publicar o renovar: ${rs.rows.length}`);
  if (DRY) return;
  for (const r of rs.rows as any[]) {
    if (!quedaTiempo()) break;
    try {
      if (await publicarUna(Number(r.tmdb_id), String(r.pluto_id), String(r.visto_at))) {
        await getDb().execute({
          sql: 'UPDATE pluto_titulos SET publicado_at=? WHERE tmdb_id=?',
          args: [new Date().toISOString(), Number(r.tmdb_id)],
        });
      }
    } catch (e: any) {
      cuenta.errores++;
      console.log(`   ! tmdb ${r.tmdb_id}: ${e?.message}`);
    }
  }
  console.log(`   ${cuenta.nuevas} fichas nuevas · ${cuenta.renovadas} renovadas`);
}

// ─── 3. RETIRAR ──────────────────────────────────────────────────────────────────────────────

async function retirar(): Promise<void> {
  const ultimo = await getDb().execute('SELECT max(visto_at) AS m FROM pluto_titulos');
  const m = String((ultimo.rows[0] as any)?.m || '');
  if (!m) return;
  const corte = new Date(Date.parse(m) - 2 * dia).toISOString();
  // Solo los que no tienen otra fila de Pluto viva para el mismo tmdb.
  const rs = await getDb().execute({
    sql: `SELECT DISTINCT tmdb_id FROM pluto_titulos t
          WHERE publicado_at IS NOT NULL AND visto_at < ?
            AND NOT EXISTS (SELECT 1 FROM pluto_titulos o WHERE o.tmdb_id=t.tmdb_id AND o.visto_at >= ?)`,
    args: [corte, corte],
  });
  console.log(`\n3. Retirar (Pluto dejó de listarlas antes de ${corte.slice(0, 10)}): ${rs.rows.length}`);
  if (DRY) return;
  for (const r of rs.rows as any[]) {
    const tmdbId = Number(r.tmdb_id);
    try {
      const { data: f } = await db.from('media_items').select('id,servers').eq('tmdb_id', tmdbId).eq('type', 'movie').maybeSingle();
      if (f) {
        const restantes = ((f as any).servers || []).filter((s: any) => !esServidorPluto(s));
        const ahora = new Date().toISOString();
        const { error } = await db.from('media_items').update({
          servers: restantes, has_streams: paraElCliente(restantes).length > 0,
          streams_checked_at: ahora, updated_at: ahora,
        }).eq('id', (f as any).id);
        if (error) throw new Error(error.message);
      }
      await getDb().execute({ sql: 'UPDATE pluto_titulos SET publicado_at=NULL WHERE tmdb_id=?', args: [tmdbId] });
      cuenta.retiradas++;
    } catch (e: any) {
      cuenta.errores++;
      console.log(`   ! retirar tmdb ${tmdbId}: ${e?.message}`);
    }
  }
}

async function main() {
  await asegurarEsquema();
  const e = await getDb().execute(`SELECT count(*) AS n, max(visto_at) AS m FROM pluto_titulos`);
  const fila: any = e.rows[0] || {};
  console.log(`pluto_titulos: ${fila.n} · último informe del móvil: ${fila.m || 'ninguno'}${DRY ? ' · EN SECO' : ''}`);
  if (!Number(fila.n)) { console.log('Sin informes del móvil todavía. Nada que hacer.'); return; }

  await identificar();
  await publicar();
  await retirar();
  if (!DRY && (cuenta.nuevas || cuenta.renovadas || cuenta.retiradas)) await CatalogService.invalidateListings().catch(() => {});
  console.log(`\nResumen: ${JSON.stringify(cuenta)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
