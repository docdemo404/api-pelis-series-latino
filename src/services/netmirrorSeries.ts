import { getDb } from '../db/libsql';
import { supabase } from './supabaseService';
import { decodificarIdNetmirror, servidorVirtualDePelicula } from '../scrapers/netmirror';
import { tieneEspanolLatino } from '../utils/idiomas';
import { sortServersBySourcePriority } from './streamSorter';
import { Episode, MediaItem, Season, ServerOption } from '../types';

interface FilaNetmirror {
  tmdb_id: number;
  temporada: number;
  episodio: number;
  disponible: boolean;
  netflix_id: string | null;
  idiomas_audio: Array<{ lang: string; name_es: string; uri?: string; default?: boolean }> | null;
  dominio_hls: string | null;
}

/** Convierte solo capítulos comprobados con audio latino en enlaces publicables. */
export function servidorCapituloNetmirror(fila: FilaNetmirror): ServerOption | null {
  const idiomas = fila.idiomas_audio;
  if (!fila.disponible || !fila.netflix_id || !Array.isArray(idiomas)
    || idiomas.length < 2 || !tieneEspanolLatino(idiomas)) return null;

  const { ott, id } = decodificarIdNetmirror(fila.netflix_id);
  if (!id || fila.temporada < 1 || fila.episodio < 1) return null;
  const dominio = fila.dominio_hls && !/(?:freecdn|hakunaymatata|subscdn|^net\d+\.)/i.test(fila.dominio_hls)
    ? fila.dominio_hls : 'tv.imgcdn.kim';
  const master = `https://${dominio}/newtv/hls/${ott}/${encodeURIComponent(id)}.m3u8`;
  return {
    ...servidorVirtualDePelicula(fila.tmdb_id),
    id: `nm-tv-${fila.tmdb_id}-${fila.temporada}x${fila.episodio}`,
    language: 'latino',
    embed_url: master,
    direct_stream: master,
    direct_kind: 'hls',
    direct_mode: 'redirect',
    direct_host: dominio,
    headers: { Referer: 'https://net52.cc/', Origin: 'https://net52.cc' },
    netmirror_hls: { netflix_id: id, ott, dominio_hls: dominio, master_url: master, idiomas },
  };
}

/** La ficha pública refleja la misma fuente que ya ofrece GET /season/N/episode/M. */
export async function adjuntarCapitulosNetmirror(item: MediaItem): Promise<MediaItem> {
  if (item.type !== 'tvseries' || !item.tmdb_id) return item;
  const filas: FilaNetmirror[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from('netmirror_cache')
      .select('tmdb_id,temporada,episodio,disponible,netflix_id,idiomas_audio,dominio_hls')
      .eq('tmdb_id', item.tmdb_id).eq('disponible', true).gt('temporada', 0)
      .order('temporada').order('episodio').range(offset, offset + 499);
    if (error) throw new Error(`No se pudo leer NetMirror para ${item.tmdb_id}: ${error.message}`);
    filas.push(...(data as FilaNetmirror[] || []));
    if (!data || data.length < 500) break;
  }
  if (!filas.length) return item;

  // El objeto de metadata puede vivir en Redis: nunca se muta al mezclar la fuente auxiliar.
  const seasons: Season[] = (item.seasons || []).map(s => ({
    ...s, episodes: (s.episodes || []).map(e => ({ ...e, servers: [...(e.servers || [])] })),
  }));
  const porTemporada = new Map(seasons.map(s => [s.season_number, s]));
  for (const fila of filas) {
    const servidor = servidorCapituloNetmirror(fila);
    if (!servidor) continue;
    let temporada = porTemporada.get(fila.temporada);
    if (!temporada) {
      temporada = { season_number: fila.temporada, name: `Temporada ${fila.temporada}`,
        episodes_count: 0, poster: item.poster, episodes: [] };
      seasons.push(temporada);
      porTemporada.set(fila.temporada, temporada);
    }
    let capitulo = temporada.episodes.find(e => e.episode_number === fila.episodio);
    if (!capitulo) {
      capitulo = { episode_number: fila.episodio, name: `Episodio ${fila.episodio}`,
        overview: '', still_path: null, air_date: null, servers: [] } as Episode;
      temporada.episodes.push(capitulo);
    }
    capitulo.servers = sortServersBySourcePriority([
      ...capitulo.servers.filter(s => s.source_id !== 'netmirror'), servidor,
    ]);
    capitulo.primary_stream = capitulo.servers[0];
    temporada.episodes_count = temporada.episodes.length;
  }
  seasons.sort((a, b) => a.season_number - b.season_number);
  for (const season of seasons) season.episodes.sort((a, b) => a.episode_number - b.episode_number);
  return { ...item, seasons };
}

/** Una muestra por serie para el filtro del panel; la lista completa vive en la ficha. */
export async function muestrasNetmirrorSeries(tmdbIds?: number[]): Promise<Map<number, {
  temporada: number; episodio: number; netflix_id: string; dominio_hls: string | null;
}>> {
  const ids = tmdbIds?.filter(id => Number.isInteger(id) && id > 0) || [];
  if (tmdbIds && !ids.length) return new Map();
  const restringir = ids.length > 0 && ids.length <= 200;
  const filtro = restringir ? `AND tmdb_id IN (${ids.map(() => '?').join(',')})` : '';
  const rs = await getDb().execute({
    sql: `SELECT tmdb_id, temporada, episodio, netflix_id, dominio_hls FROM (
      SELECT tmdb_id, temporada, episodio, netflix_id, dominio_hls,
        ROW_NUMBER() OVER (PARTITION BY tmdb_id ORDER BY temporada, episodio) AS rn
      FROM netmirror_cache
      WHERE disponible = 1 AND temporada > 0 AND episodio > 0
        AND netflix_id IS NOT NULL AND idiomas_audio IS NOT NULL ${filtro}
    ) WHERE rn = 1`,
    args: restringir ? ids : [],
  });
  const muestras = new Map<number, { temporada: number; episodio: number; netflix_id: string; dominio_hls: string | null }>();
  for (const row of rs.rows) muestras.set(Number(row.tmdb_id), {
    temporada: Number(row.temporada), episodio: Number(row.episodio),
    netflix_id: String(row.netflix_id), dominio_hls: row.dominio_hls ? String(row.dominio_hls) : null,
  });
  return muestras;
}

/** Acota el barrido del panel a las obras que NetMirror confirmó en su caché. */
export async function idsCatalogoNetmirror(tipo?: 'movie' | 'tvseries'): Promise<number[]> {
  const temporada = tipo === 'movie' ? 'AND temporada = 0'
    : tipo === 'tvseries' ? 'AND temporada > 0' : '';
  const rs = await getDb().execute(`SELECT DISTINCT tmdb_id FROM netmirror_cache
    WHERE disponible = 1 AND netflix_id IS NOT NULL ${temporada}`);
  return rs.rows.map(row => Number(row.tmdb_id)).filter(id => Number.isInteger(id) && id > 0);
}
