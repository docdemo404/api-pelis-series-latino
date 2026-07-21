import { ServerOption } from '../types';

/**
 * Servicio que selecciona el mejor enlace (Primary Stream) respetando las prioridades:
 * 1. Status === 'online'
 * 2. Language === 'latino'
 * 3. Quality === 4K > 1080p > 720p > 480p
 * 4. Presencia de direct_stream (HLS / m3u8)
 */
export function getPrimaryStream(servers: ServerOption[]): ServerOption | undefined {
  if (!servers || servers.length === 0) return undefined;

  // Filtrar solo los funcionales
  const onlineServers = servers.filter(s => s.status === 'online');
  if (onlineServers.length === 0) return undefined;

  const qualityScore: Record<string, number> = {
    '4K': 4,
    '1080p': 3,
    '720p': 2,
    '480p': 1
  };

  const sorted = [...onlineServers].sort((a, b) => {
    // 1. Idioma Latino preferido
    if (a.language === 'latino' && b.language !== 'latino') return -1;
    if (b.language === 'latino' && a.language !== 'latino') return 1;

    // 2. Calidad más alta
    const scoreA = qualityScore[a.quality] || 0;
    const scoreB = qualityScore[b.quality] || 0;
    if (scoreA !== scoreB) return scoreB - scoreA;

    // 3. Posee direct stream (HLS/mp4) sin anuncios
    if (a.direct_stream && !b.direct_stream) return -1;
    if (b.direct_stream && !a.direct_stream) return 1;

    return 0;
  });

  return sorted[0];
}
