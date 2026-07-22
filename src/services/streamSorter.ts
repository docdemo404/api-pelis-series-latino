import { ServerOption } from '../types';
import { SourceManager, SourceConfig } from './sourceManager';

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
 * 2. Prioridad de Fuente de Servidor (Prioridad 1 primero, luego 2, etc.)
 * 3. Idioma Latino preferido
 * 4. Calidad más alta (4K > 1080p > 720p > 480p)
 * 5. Direct Stream (HLS/mp4)
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

  return [...activeServers].sort((a, b) => {
    // 1. Status online primero
    if (a.status === 'online' && b.status !== 'online') return -1;
    if (b.status === 'online' && a.status !== 'online') return 1;

    // 2. Prioridad de Fuente (1 primero, 2 después, 3 después...)
    const prioA = priorityMap[getSourceId(a)] ?? 99;
    const prioB = priorityMap[getSourceId(b)] ?? 99;
    if (prioA !== prioB) return prioA - prioB;

    // 3. Idioma Latino preferido
    if (a.language === 'latino' && b.language !== 'latino') return -1;
    if (b.language === 'latino' && a.language !== 'latino') return 1;

    // 4. Calidad más alta
    const scoreA = qualityScore[a.quality] || 0;
    const scoreB = qualityScore[b.quality] || 0;
    if (scoreA !== scoreB) return scoreB - scoreA;

    // 5. Presencia de direct_stream
    if (a.direct_stream && !b.direct_stream) return -1;
    if (b.direct_stream && !a.direct_stream) return 1;

    return 0;
  });
}

/**
 * Selecciona el mejor enlace (Primary Stream) usando el servidor #1 tras ordenar por prioridad
 */
export function getPrimaryStream(servers: ServerOption[]): ServerOption | undefined {
  if (!servers || servers.length === 0) return undefined;
  const sorted = sortServersBySourcePriority(servers);
  return sorted.find(s => s.status === 'online') || sorted[0];
}
