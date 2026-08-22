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
  /**
   * La fuente propia va PRIMERA, y no por capricho: es la única que no depende de que una web
   * ajena siga viva, siga publicando y no cambie su plantilla. Si un título tiene una url puesta
   * a mano y otra scrapeada, la de casa es la que más probabilidades tiene de seguir ahí mañana.
   */
  { id: 'manual', name: 'Fuente propia (panel)', enabled: true, priority: 1 },
  /**
   * Internet Archive va SEGUNDA, solo por detrás de lo puesto a mano, y la razón es la misma que
   * pone a la fuente propia la primera: no depende de que nadie siga vivo. Sus ficheros son
   * públicos y sin firma, así que la url que se guarda hoy sirve dentro de un mes — mientras que
   * las otras tres publican enlaces que caducan y hay que volver a acuñar en cada reproducción.
   *
   * La prioridad ordena los servidores DENTRO de una ficha, así que esto decide qué intenta
   * primero el cliente cuando un título tiene servidores de varias webs.
   */
  { id: 'archive', name: 'Internet Archive', enabled: true, priority: 2 },
  /**
   * MOVIEDAYS va TERCERA, por delante de las tres webs que se scrapean, y por un motivo que no
   * tiene que ver con la calidad de su vídeo sino con la de su IDENTIDAD.
   *
   * Es la única fuente indexada por `tmdb_id`: no publica un título que haya que emparejar, se le
   * pregunta por una obra concreta y contesta por esa obra o por ninguna. O sea que es la única
   * que NO PUEDE cometer el fallo que FUENTES.md documenta como origen de casi todos los destrozos
   * del catálogo —adoptar la ficha de un homónimo—, y sus servidores son los que con más
   * seguridad pertenecen a la ficha donde están colgados.
   *
   * Va DETRÁS de la fuente propia y de Archive por la razón de siempre: aquellas no dependen de
   * que nadie siga vivo, y esta es de un tercero.
   *
   * Solo se publica su proveedor `vimeus`. El otro (`zonaaps`) acaba contra el muro de Cloudflare
   * de zonaaps.com, que no deja pasar a ningún datacenter — medido. Está explicado en
   * `PROVEEDORES_ALCANZABLES` (src/scrapers/moviedays.ts), que es el único sitio que habría que
   * tocar si algún día se monta el relé en el Worker propio.
   */
  { id: 'moviedays', name: 'MovieDays (por TMDB id)', enabled: true, priority: 3 },
  { id: 'cinecalidad', name: 'Cinecalidad', enabled: true, priority: 4 },
  { id: 'tioplus', name: 'TioPlus / PelisPlus Latino', enabled: true, priority: 5 },
  { id: 'fuegocine', name: 'FuegoCine', enabled: true, priority: 6 },
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
