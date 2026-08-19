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
];

/**
 * SUPABASE NO ES UNA FUENTE, y estaba aquí como si lo fuera desde el 2026-07-22.
 *
 * Esta lista es de webs que se scrapean. Supabase es donde se GUARDA lo scrapeado, así que salía
 * en el panel con su interruptor y sus flechas de prioridad, al lado de Cinecalidad y FuegoCine,
 * como si se pudiera crawlear.
 *
 * Y no era solo cosmético: `sortServersBySourcePriority` filtra por `enabled`, y a los servidores
 * que se leen de la base sin `source_id` anotado se les pone `'supabase'` por defecto. O sea que
 * apagar ese interruptor —algo que el panel invitaba a hacer— habría escondido de golpe todos los
 * servidores cuyo origen no estuviera registrado. Un botón rotulado como fuente que en realidad
 * vaciaba el catálogo.
 *
 * Quitarlo es seguro: un id que no está en la lista NO se filtra (`enabledMap[x] !== false` es
 * cierto para `undefined`) y su prioridad cae al 99 por defecto, o sea detrás de las tres webs
 * reales, que es exactamente donde debe ir algo sin origen conocido.
 */
