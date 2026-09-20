import crypto from 'crypto';
import { Request } from 'express';
import { getDb } from '../db/libsql';
import { getSupabaseAdmin } from './supabaseService';
import { CatalogService } from './catalogService';
import { TmdbService } from './tmdbService';
import { MediaItem, ServerOption } from '../types';
import { searchIndexKey } from '../utils/text';
import { tieneEspanolLatino, traducirYNormalizar } from '../utils/idiomas';
import { codificarIdNetmirror, normalizarNetmirrorOtt, servidorVirtualDePelicula } from '../scrapers/netmirror';

export type EstadoInformeNetmirror = 'found' | 'not_found' | 'unreachable';

export interface TareaNetmirrorCliente {
  task_id: number;
  token: string;
  tmdb_id: number;
  ott: 'nf' | 'pv' | 'hs';
  title: string;
  original_title: string;
  year: string;
  round: number;
}

interface TrabajoDb {
  id: number;
  tmdb_id: number;
  ott: 'nf' | 'pv' | 'hs';
  titulo: string;
  titulo_original: string | null;
  anio: string | null;
  ronda: number;
}

interface PistaCruda {
  language?: unknown;
  lang?: unknown;
  name?: unknown;
  uri?: unknown;
  default?: unknown;
}

export interface InformeNetmirrorCliente {
  device_id: string;
  token: string;
  status: EstadoInformeNetmirror;
  provider_id?: string;
  audios?: PistaCruda[];
  subtitles?: PistaCruda[];
}

const ISO = () => new Date().toISOString();
const sumarHoras = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const sumarDias = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

function secreto(): string {
  return String(process.env.NETMIRROR_TASK_SECRET || process.env.TURSO_AUTH_TOKEN || 'solo-desarrollo-local');
}

function hash(valor: string): string {
  return crypto.createHmac('sha256', secreto()).update(valor).digest('hex');
}

/**
 * La IP no se almacena ni se devuelve. Solo se deriva una huella de red (/24 en IPv4, prefijo
 * corto en IPv6) para que dos instalaciones de la misma casa no puedan formar quorum entre si.
 */
function redDe(req: Request): string {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = (xff || req.socket.remoteAddress || 'desconocida').replace(/^::ffff:/, '');
  const prefijo = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)
    ? ip.split('.').slice(0, 3).join('.') + '.0/24'
    : ip.split(':').slice(0, 4).join(':') + '::/64';
  return hash(`red:${prefijo}`);
}

function dispositivoDe(id: string): string {
  return hash(`dispositivo:${id}`);
}

function idDispositivoValido(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9._:-]{16,128}$/.test(id);
}

function valor(row: any, nombre: string, indice: number): any {
  return row?.[nombre] ?? row?.[indice];
}

/** Entrega lotes pequenos y nunca una URL escogida por el cliente. */
export async function asignarTareasNetmirror(
  req: Request,
  deviceId: string,
  limitePedido: number,
): Promise<TareaNetmirrorCliente[]> {
  if (!idDispositivoValido(deviceId)) throw new Error('DEVICE_ID_INVALID');
  const db = getDb();
  const ahora = ISO();
  const limite = Math.max(1, Math.min(5, Math.trunc(limitePedido) || 3));
  const dispositivo = dispositivoDe(deviceId);
  const red = redDe(req);

  // Las rondas vencidas se reabren solas; no hace falta que un PC mantenga un cron especial.
  await db.execute({
    sql: `UPDATE netmirror_trabajos
          SET estado='pendiente', ronda=ronda+1, actualizado_at=?
          WHERE estado <> 'pendiente' AND proxima_revision <= ?`,
    args: [ahora, ahora],
  });
  await db.execute({ sql: 'DELETE FROM netmirror_asignaciones WHERE expira_at < ?', args: [ahora] });

  const rs = await db.execute({
    sql: `SELECT t.id,t.tmdb_id,t.ott,t.titulo,t.titulo_original,t.anio,t.ronda
          FROM netmirror_trabajos t
          WHERE t.estado='pendiente' AND t.proxima_revision <= ?
            AND NOT EXISTS (
              SELECT 1 FROM netmirror_verificaciones v
              WHERE v.trabajo_id=t.id AND v.ronda=t.ronda AND v.dispositivo_hash=?
            )
          ORDER BY t.prioridad DESC,t.actualizado_at ASC,t.id ASC
          LIMIT ?`,
    args: [ahora, dispositivo, limite],
  });

  const tareas: TareaNetmirrorCliente[] = [];
  for (const row of rs.rows) {
    const id = Number(valor(row, 'id', 0));
    const ronda = Number(valor(row, 'ronda', 6));
    const token = crypto.randomBytes(24).toString('base64url');
    await db.execute({
      sql: `INSERT INTO netmirror_asignaciones
              (token,trabajo_id,ronda,dispositivo_hash,red_hash,expira_at)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(trabajo_id,ronda,dispositivo_hash) DO UPDATE SET
              token=excluded.token,red_hash=excluded.red_hash,expira_at=excluded.expira_at,creado_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      args: [token, id, ronda, dispositivo, red, sumarHoras(6)],
    });
    tareas.push({
      task_id: id,
      token,
      tmdb_id: Number(valor(row, 'tmdb_id', 1)),
      ott: normalizarNetmirrorOtt(valor(row, 'ott', 2)),
      title: String(valor(row, 'titulo', 3) || ''),
      original_title: String(valor(row, 'titulo_original', 4) || ''),
      year: String(valor(row, 'anio', 5) || ''),
      round: ronda,
    });
  }
  return tareas;
}

function limpiarPistas(lista: unknown): Array<{ language: string; name: string; uri: string; default: boolean }> {
  if (!Array.isArray(lista)) return [];
  return lista.slice(0, 64).map((a: PistaCruda, i) => ({
    language: String(a?.language || a?.lang || '').slice(0, 24),
    name: String(a?.name || '').slice(0, 80),
    // Las URLs pueden estar firmadas o contener identificadores efimeros. No se guardan.
    uri: '',
    default: a?.default === true,
  })).filter(a => a.language || a.name);
}

function resultadoCanonico(informe: InformeNetmirrorCliente): {
  status: EstadoInformeNetmirror;
  provider_id: string;
  audios: ReturnType<typeof limpiarPistas>;
  subtitles: ReturnType<typeof limpiarPistas>;
} {
  const status: EstadoInformeNetmirror = ['found', 'not_found', 'unreachable'].includes(String(informe.status))
    ? informe.status : 'unreachable';
  const providerId = /^[A-Za-z0-9_-]{5,80}$/.test(String(informe.provider_id || ''))
    ? String(informe.provider_id) : '';
  return {
    status: status === 'found' && !providerId ? 'unreachable' : status,
    provider_id: providerId,
    audios: status === 'found' ? limpiarPistas(informe.audios) : [],
    subtitles: status === 'found' ? limpiarPistas(informe.subtitles) : [],
  };
}

function hashResultado(r: ReturnType<typeof resultadoCanonico>): string {
  // DEFAULT y URLs cambian entre sesiones; identidad, orden y etiquetas no.
  const estable = {
    status: r.status,
    provider_id: r.provider_id,
    audios: r.audios.map(a => [a.language.toLowerCase(), a.name.toLowerCase()]),
    subtitles: r.subtitles.map(a => [a.language.toLowerCase(), a.name.toLowerCase()]),
  };
  return crypto.createHash('sha256').update(JSON.stringify(estable)).digest('hex');
}

function fusionarNetmirror(previos: any[], servidor: ServerOption): ServerOption[] {
  return [servidor, ...(previos || []).filter(s =>
    String(s?.source_id || '').toLowerCase() !== 'netmirror'
      && !/\/api\/v1\/netmirror\/stream\//i.test(String(s?.embed_url || s?.direct_stream || '')),
  )];
}

async function fichaDesdeTmdb(tmdbId: number): Promise<MediaItem | null> {
  const semilla: MediaItem = {
    id: `nm-${tmdbId}`, tmdb_id: tmdbId, imdb_id: null, type: 'movie', title: '', original_title: '',
    aliases: [], overview: '', rating: 0, genres: [], subcategories: [], poster: null, backdrop: null,
    logo: null, trailer: null, cast: [], dubbing_cast: [],
  };
  try {
    const ficha = await TmdbService.enrichMediaItem(semilla, { skipSeasons: true });
    return ficha?.tmdb_id > 0 && ficha.title ? ficha : null;
  } catch { return null; }
}

async function publicarConfirmado(trabajo: TrabajoDb, r: ReturnType<typeof resultadoCanonico>): Promise<boolean> {
  const normalizados = traducirYNormalizar(
    r.audios.map(a => ({ language: a.language, name: a.name, uri: '' })),
    r.provider_id,
  );
  if (normalizados.length < 2 || !tieneEspanolLatino(normalizados)) return false;
  const db = getSupabaseAdmin();
  const ahora = ISO();
  await db.from('netmirror_cache').upsert({
    tmdb_id: trabajo.tmdb_id,
    temporada: 0,
    episodio: 0,
    disponible: true,
    resolucion: 1080,
    netflix_id: codificarIdNetmirror(trabajo.ott, r.provider_id),
    idiomas_audio: normalizados,
    dominio_hls: 'tv.imgcdn.kim',
    comprobado_at: ahora,
  }, { onConflict: 'tmdb_id,temporada,episodio' });

  const servidor: ServerOption = {
    ...servidorVirtualDePelicula(trabajo.tmdb_id, '1080'),
    language: 'latino',
    netmirror_hls: {
      netflix_id: r.provider_id,
      ott: trabajo.ott,
      dominio_hls: 'tv.imgcdn.kim',
      master_url: `https://tv.imgcdn.kim/newtv/hls/${trabajo.ott}/${encodeURIComponent(r.provider_id)}.m3u8`,
      idiomas: normalizados,
    },
  };
  const { data: existente } = await db.from('media_items')
    .select('id,servers').eq('tmdb_id', trabajo.tmdb_id).eq('type', 'movie').maybeSingle();
  if (existente) {
    const { error } = await db.from('media_items').update({
      servers: fusionarNetmirror((existente as any).servers || [], servidor),
      has_streams: true,
      streams_updated_at: ahora,
      streams_checked_at: ahora,
      updated_at: ahora,
    }).eq('id', (existente as any).id);
    if (error) throw new Error(error.message);
  } else {
    const f = await fichaDesdeTmdb(trabajo.tmdb_id);
    if (!f) return false;
    const fila: Record<string, unknown> = {
      id: f.id || `nm-${trabajo.tmdb_id}`, tmdb_id: trabajo.tmdb_id, imdb_id: f.imdb_id ?? null,
      type: 'movie', title: f.title, original_title: f.original_title || f.title,
      title_normalized: searchIndexKey(f.title, f.original_title, f.aliases), aliases: f.aliases || [],
      tagline: f.tagline || '', overview: f.overview || '', rating: f.rating || 0,
      content_rating: f.content_rating || null, release_date: f.release_date || '', genres: f.genres || [],
      subcategories: f.subcategories || [], poster: f.poster, backdrop: f.backdrop, logo: f.logo,
      trailer: f.trailer, cast_data: (f.cast_details?.length ? f.cast_details : f.cast) || [],
      dubbing_cast_data: f.dubbing_cast || [], runtime: f.runtime ?? null, director: f.director || null,
      metadata_source: f.metadata_source || 'tmdb', servers: [servidor], seasons: [], total_seasons: 0,
      total_episodes: 0, source_url: servidor.embed_url, source_urls: [servidor.embed_url], has_streams: true,
      streams_updated_at: ahora, streams_checked_at: ahora, updated_at: ahora,
    };
    const { error } = await db.from('media_items').insert(fila);
    if (error && !/duplicate|UNIQUE/i.test(error.message)) throw new Error(error.message);
  }
  await CatalogService.invalidateListings().catch(() => {});
  return true;
}

async function retirarDescartado(trabajo: TrabajoDb): Promise<void> {
  const db = getSupabaseAdmin();
  const ahora = ISO();
  await db.from('netmirror_cache').upsert({
    tmdb_id: trabajo.tmdb_id, temporada: 0, episodio: 0, disponible: false,
    netflix_id: null, idiomas_audio: null, dominio_hls: `audit:${trabajo.ott}`, comprobado_at: ahora,
  }, { onConflict: 'tmdb_id,temporada,episodio' });
  const { data: existente } = await db.from('media_items')
    .select('id,servers').eq('tmdb_id', trabajo.tmdb_id).eq('type', 'movie').maybeSingle();
  if (!existente) return;
  const restantes = ((existente as any).servers || []).filter((s: any) =>
    String(s?.source_id || '').toLowerCase() !== 'netmirror'
      && !/\/api\/v1\/netmirror\/stream\//i.test(String(s?.embed_url || s?.direct_stream || '')),
  );
  await db.from('media_items').update({
    servers: restantes, has_streams: restantes.length > 0, streams_checked_at: ahora, updated_at: ahora,
  }).eq('id', (existente as any).id);
  await CatalogService.invalidateListings().catch(() => {});
}

export async function recibirInformeNetmirror(req: Request, informe: InformeNetmirrorCliente): Promise<{
  accepted: boolean; quorum: number; required: number; decision: string; materialized?: boolean;
}> {
  if (!idDispositivoValido(informe.device_id) || !/^[A-Za-z0-9_-]{20,80}$/.test(String(informe.token || ''))) {
    throw new Error('REPORT_INVALID');
  }
  const db = getDb();
  const ahora = ISO();
  const dispositivo = dispositivoDe(informe.device_id);
  const red = redDe(req);
  const asignada = await db.execute({
    sql: `SELECT a.trabajo_id,a.ronda,t.tmdb_id,t.ott,t.titulo,t.titulo_original,t.anio,t.ronda,
                 a.red_hash AS asignada_red
          FROM netmirror_asignaciones a JOIN netmirror_trabajos t ON t.id=a.trabajo_id
          WHERE a.token=? AND a.dispositivo_hash=? AND a.expira_at>=? LIMIT 1`,
    args: [informe.token, dispositivo, ahora],
  });
  const row: any = asignada.rows[0];
  if (!row) throw new Error('ASSIGNMENT_INVALID');
  if (String(valor(row, 'asignada_red', 8)) !== red) throw new Error('ASSIGNMENT_INVALID');
  const trabajo: TrabajoDb = {
    id: Number(valor(row, 'trabajo_id', 0)), tmdb_id: Number(valor(row, 'tmdb_id', 2)),
    ott: normalizarNetmirrorOtt(valor(row, 'ott', 3)), titulo: String(valor(row, 'titulo', 4) || ''),
    titulo_original: String(valor(row, 'titulo_original', 5) || '') || null,
    anio: String(valor(row, 'anio', 6) || '') || null, ronda: Number(valor(row, 'ronda', 7)),
  };
  const rondaAsignada = Number(valor(row, 'ronda', 1));
  if (rondaAsignada !== trabajo.ronda) throw new Error('ASSIGNMENT_EXPIRED');

  const resultado = resultadoCanonico(informe);
  if (resultado.status === 'unreachable') {
    await db.execute({ sql: 'DELETE FROM netmirror_asignaciones WHERE token=?', args: [informe.token] });
    return { accepted: false, quorum: 0, required: 2, decision: 'retry_later' };
  }
  const resultadoHash = hashResultado(resultado);
  await db.execute({
    sql: `INSERT INTO netmirror_verificaciones
            (trabajo_id,ronda,dispositivo_hash,red_hash,resultado_hash,resultado_json,recibido_at)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(trabajo_id,ronda,dispositivo_hash) DO UPDATE SET
            red_hash=excluded.red_hash,resultado_hash=excluded.resultado_hash,
            resultado_json=excluded.resultado_json,recibido_at=excluded.recibido_at`,
    args: [trabajo.id, trabajo.ronda, dispositivo, red, resultadoHash, JSON.stringify(resultado), ahora],
  });
  await db.execute({ sql: 'DELETE FROM netmirror_asignaciones WHERE token=?', args: [informe.token] });
  const votos = await db.execute({
    sql: `SELECT count(DISTINCT red_hash) AS n FROM netmirror_verificaciones
          WHERE trabajo_id=? AND ronda=? AND resultado_hash=?`,
    args: [trabajo.id, trabajo.ronda, resultadoHash],
  });
  const quorum = Number(valor(votos.rows[0], 'n', 0) || 0);
  const required = resultado.status === 'not_found' ? 3 : 2;
  if (quorum < required) return { accepted: true, quorum, required, decision: 'waiting' };

  let decision = 'rejected';
  let materialized: boolean | undefined;
  if (resultado.status === 'found') {
    materialized = await publicarConfirmado(trabajo, resultado);
    if (!materialized) {
      // Dos aparatos vieron el mismo master, pero no cumple multipista+Latino: no se publica.
      await retirarDescartado(trabajo);
      decision = 'discarded_no_latino';
    } else decision = 'confirmed';
  } else {
    await retirarDescartado(trabajo);
    decision = 'not_found';
  }
  await db.execute({
    sql: `UPDATE netmirror_trabajos SET estado=?,proxima_revision=?,actualizado_at=? WHERE id=? AND ronda=?`,
    args: [decision === 'confirmed' ? 'confirmado' : 'descartado', sumarDias(decision === 'confirmed' ? 14 : 7), ahora, trabajo.id, trabajo.ronda],
  });
  return { accepted: true, quorum, required, decision, materialized };
}

export async function estadoNetmirrorDistribuido(): Promise<Record<string, number>> {
  const rs = await getDb().execute(`SELECT estado,count(*) AS n FROM netmirror_trabajos GROUP BY estado`);
  const salida: Record<string, number> = { pendiente: 0, confirmado: 0, descartado: 0 };
  for (const row of rs.rows) salida[String(valor(row, 'estado', 0))] = Number(valor(row, 'n', 1));
  return salida;
}
