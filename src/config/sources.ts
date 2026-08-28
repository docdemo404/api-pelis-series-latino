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

/**
 * CINECALIDAD SE RETIRÓ EL 2026-08-27, y conviene saber por qué antes de que a alguien se le
 * ocurra volver a añadirla.
 *
 * No estaba rota: era REDUNDANTE. Aportaba cero —cero fichas y cero servidores sobre las 8.524
 * filas del catálogo, ni una con página suya— y encima fallaba en silencio, porque su llamada se
 * tragaba el error dos veces. Pero lo que decidió la retirada fue mirar QUÉ HABÍA DETRÁS: publica
 * sus reproductores en `data-option`, y el bueno es `vimeos.net` — el mismo host que ya sirve
 * videoapi. Para «Pelotas en juego» era literalmente el mismo fichero (`embed-20ls07ugclbo`, el
 * que videoapi devuelve para tmdb 9472).
 *
 * O sea: era un cliente del mismo proveedor al que ya le hablamos, solo que por una puerta peor
 * —recorrer su índice y emparejar por slug, en vez de preguntar por `tmdb_id` y que te den la
 * lista entera—. Se fue con su scraper, sus moldes de url y su reparto de cupo.
 */
export const DEFAULT_SOURCES: SourceConfig[] = [
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
  { id: 'moviedays', name: 'MovieDays (por TMDB id)', enabled: true, priority: 4 },
  /**
   * VIDEOAPI va CUARTA, y es la única de la lista que no es una web que se scrapee.
   *
   * Comparte con moviedays lo que la puso a ella delante de las tres webs: se le pregunta por un
   * `tmdb_id` y contesta por esa obra o por ninguna, así que no puede cometer el fallo del que
   * salen casi todos los destrozos del catálogo. Y va un escalón MÁS allá — publica su catálogo
   * entero en listas de ids (`/api/v1/public/wordpress/ids/*.txt`), o sea que tampoco hay que
   * recorrer un índice ni adivinar cuándo publica algo nuevo.
   *
   * SUBE POR DELANTE DE MOVIEDAYS EL MISMO DÍA (2026-08-27), y no por entusiasmo: por medición.
   * Entró detrás con el argumento de que moviedays llevaba meses en producción, y el usuario
   * reportó títulos que no reproducían. Los dos casos que dio —«Woo, una abogada extraordinaria»
   * 1x1 y «Coraje, el perro cobarde» 1x1— tenían la MISMA forma:
   *
   *     servidor 1 (Vimeos, de moviedays)  →  403
   *     servidor 2 (VideoAPI)              →  200, reproduce
   *
   * O sea que el orden ponía delante al que no entrega. Y no es mala suerte, es estructural:
   * moviedays guarda una url de `vimeos.net` YA ACUÑADA, que caduca; videoapi guarda un embed
   * DERIVABLE del `tmdb_id`, que se vuelve a acuñar en cada reproducción. Lo que caduca no puede
   * ir por delante de lo que no caduca.
   *
   * Delante de las tres webs porque su url de embed es DERIVABLE del `tmdb_id` (ver
   * `embedDeVideoapi`): no caduca, no hay que re-rastrear nada para recuperarla, y no depende de
   * que una plantilla ajena siga igual mañana.
   *
   * Medido al entrar: 7.177 películas y 1.714 series/anime que el catálogo no tenía, y 23 de 23
   * títulos probados entregando vídeo.
   */
  { id: 'videoapi', name: 'VideoAPI (por TMDB id)', enabled: true, priority: 3 },
  { id: 'tioplus', name: 'TioPlus / PelisPlus Latino', enabled: true, priority: 5 },
  { id: 'fuegocine', name: 'FuegoCine', enabled: true, priority: 6 },
];

/**
 * SUPABASE NO ES UNA FUENTE, y estaba aquí como si lo fuera desde el 2026-07-22.
 *
 * Esta lista es de webs que se scrapean. Supabase es donde se GUARDA lo scrapeado, así que salía
 * en el panel con su interruptor y sus flechas de prioridad, al lado de TioPlus y FuegoCine,
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
