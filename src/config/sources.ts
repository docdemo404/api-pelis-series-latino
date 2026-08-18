/**
 * Configuración de las fuentes de contenido (única fuente de verdad).
 * Consumida por SourceManager, CloudStore y streamSorter.
 */
export interface SourceConfig {
  id: string; // 'tioplus' | 'fuegocine' | 'supabase'
  name: string;
  enabled: boolean;
  priority: number;
}

export const DEFAULT_SOURCES: SourceConfig[] = [
  // Cinecalidad va primera: de sus cuatro reproductores, `vimeos.net` y `goodstream.one` se
  // extraen y se ha COMPROBADO que entregan vídeo desde el datacenter, que es donde upns murió y
  // vidhideplus estrangula. La prioridad ordena los servidores de una ficha, así que ponerla
  // delante hace que lo primero que intenta el cliente venga de la fuente que mejor se sirve.
  { id: 'cinecalidad', name: 'Cinecalidad', enabled: true, priority: 1 },
  { id: 'tioplus', name: 'TioPlus / PelisPlus Latino', enabled: true, priority: 2 },
  { id: 'fuegocine', name: 'FuegoCine', enabled: true, priority: 3 },
  { id: 'supabase', name: 'Base de Datos Supabase', enabled: true, priority: 4 }
];
