import { ServerOption, DirectMode } from '../types';
import { SourceManager, SourceConfig } from './sourceManager';
import { bestMode } from '../scrapers/hostPolicy';

/**
 * Cómo se va a servir este servidor HOY, no cómo se guardó.
 *
 * `direct_mode` es un valor persistido, y el catálogo arrastra decenas de miles de servidores
 * etiquetados `proxy` desde antes de que existiera `hostPolicy`. Ordenar por ese campo hacía que
 * todos empataran, que el desempate cayera en la prioridad de fuente y que se acabara eligiendo
 * SIEMPRE vidhideplus — el único host del catálogo que de verdad ata por IP y no puede evitar el
 * reenvío de bytes— teniendo al lado un emturbovid que se sirve con un 302. Medido: 482 KB/s
 * proxeado contra 1,2-2,1 MB/s por redirección, con el vídeo 1080p pidiendo 3,55 Mbps. Esa
 * diferencia es exactamente la que se nota como parones y como esperar al adelantar.
 *
 * Se asume un navegador (`sendsReferer: true`) porque al ordenar todavía no se sabe qué cliente
 * pedirá después, y es el caso mayoritario: separa bien "hay que reenviar bytes" (vidhideplus) de
 * "no hace falta" (upns → `manifest`, emturbovid → `redirect`). Equivocarse con un VLC solo
 * afecta al ORDEN, nunca a la corrección: `/api/v1/stream/direct` vuelve a decidir en cada
 * petición mirando las cabeceras reales.
 *
 * Sin `direct_kind` se asume HLS, que es el supuesto conservador: un mp4 nunca baja de modo por
 * culpa de los segmentos, así que dar por hecho HLS no puede sobrevalorar a nadie.
 */
export function effectiveDirectMode(server: ServerOption): DirectMode | undefined {
  if (!server.direct_stream) return undefined;
  // Una URL `public` es del CDN y ya no depende de ninguna política: se queda como está.
  if (server.direct_mode === 'public') return 'public';
  if (!server.embed_url) return server.direct_mode;
  return bestMode(server.embed_url, server.direct_kind ?? 'hls', { sendsReferer: true });
}

/**
 * Infiere la fuente de un servidor si no tiene source_id asignado
 */
export function getSourceId(server: ServerOption): string {
  if (server.source_id) return server.source_id.toLowerCase();
  const id = (server.id || '').toLowerCase();
  const name = (server.name || '').toLowerCase();
  if (id.includes('_fc_') || name.includes('fuegocine')) return 'fuegocine';
  if (id.includes('_db_') || name.includes('supabase')) return 'supabase';
  return 'tioplus';
}

/**
 * Ordena la lista de servidores respetando las prioridades configuradas en SourceManager (/panel):
 * 1. Status 'online' primero
 * 2. Vídeo directo (m3u8/mp4) antes que embed, y URL libre antes que proxeada
 * 3. Prioridad de Fuente de Servidor (Prioridad 1 primero, luego 2, etc.)
 * 4. Idioma Latino preferido
 * 5. Calidad más alta (4K > 1080p > 720p > 480p)
 *
 * El criterio 2 es lo que hace que reproducir signifique "vídeo directo" y que el iframe de
 * terceros quede como último recurso. Antes era el último desempate, así que un embed de una
 * fuente prioritaria adelantaba siempre a un servidor con vídeo directo de otra fuente.
 *
 * También filtra servidores pertenecientes a fuentes deshabilitadas (enabled: false).
 */
export function sortServersBySourcePriority(servers: ServerOption[], sourcesConfig?: SourceConfig[]): ServerOption[] {
  if (!servers || servers.length === 0) return [];

  const sources = sourcesConfig || SourceManager.getSources();
  const priorityMap: Record<string, number> = {};
  const enabledMap: Record<string, boolean> = {};

  sources.forEach(src => {
    const key = src.id.toLowerCase();
    priorityMap[key] = src.priority;
    enabledMap[key] = src.enabled;
  });

  // Filtrar servidores de fuentes deshabilitadas
  const activeServers = servers.filter(s => {
    const srcId = getSourceId(s);
    return enabledMap[srcId] !== false;
  });

  const qualityScore: Record<string, number> = {
    '4K': 4,
    '1080p': 3,
    '720p': 2,
    '480p': 1
  };

  // Un servidor con vídeo directo vale más que cualquier embed; y entre dos directos, gana el
  // que no obliga a reenviar bytes por esta API. `public`, `redirect` y `manifest` empatan a
  // propósito: en los tres el VÍDEO viaja del CDN al reproductor sin pasar por aquí, que es lo
  // único que decide la velocidad real que nota el usuario — que en `manifest` pasen unos KB de
  // playlist no cambia nada. `proxy` queda de último recurso.
  //
  // El modo se RECALCULA (`effectiveDirectMode`); leer el guardado era lo que hundía a los
  // servidores rápidos al fondo de la lista.
  // El modo se recalcula UNA vez por servidor, antes de ordenar: hacerlo dentro del comparador lo
  // repetiría en cada comparación. Y de paso se publica, para que el campo deje de mentir —
  // `direct_mode` es informativo (lo dice openapi.json) y anunciar el valor guardado describía un
  // comportamiento que ya no ocurre.
  const withEffectiveMode = activeServers.map(s => {
    const mode = effectiveDirectMode(s);
    return mode && mode !== s.direct_mode ? { ...s, direct_mode: mode } : s;
  });

  const directScore = (s: ServerOption): number => {
    if (!s.direct_stream) return 0;
    return s.direct_mode === 'proxy' || s.direct_mode === undefined ? 1 : 2;
  };

  return [...withEffectiveMode].sort((a, b) => {
    // 1. Status online primero
    if (a.status === 'online' && b.status !== 'online') return -1;
    if (b.status === 'online' && a.status !== 'online') return 1;

    // 2. Vídeo directo antes que embed
    const directA = directScore(a);
    const directB = directScore(b);
    if (directA !== directB) return directB - directA;

    // 3. Prioridad de Fuente (1 primero, 2 después, 3 después...)
    const prioA = priorityMap[getSourceId(a)] ?? 99;
    const prioB = priorityMap[getSourceId(b)] ?? 99;
    if (prioA !== prioB) return prioA - prioB;

    // 4. Idioma Latino preferido
    if (a.language === 'latino' && b.language !== 'latino') return -1;
    if (b.language === 'latino' && a.language !== 'latino') return 1;

    // 5. Calidad más alta
    const scoreA = qualityScore[a.quality] || 0;
    const scoreB = qualityScore[b.quality] || 0;
    if (scoreA !== scoreB) return scoreB - scoreA;

    return 0;
  });
}

/**
 * Selecciona el mejor enlace (Primary Stream) usando el servidor #1 tras ordenar por prioridad.
 * El orden ya antepone lo que está online y, dentro de eso, lo que trae vídeo directo, así que
 * el primero online es también el que mejor reproduce.
 */
export function getPrimaryStream(servers: ServerOption[]): ServerOption | undefined {
  if (!servers || servers.length === 0) return undefined;
  const sorted = sortServersBySourcePriority(servers);
  return sorted.find(s => s.status === 'online') || sorted[0];
}
