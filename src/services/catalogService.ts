import { MediaItem, ServerOption, ContentType } from '../types';
import { supabase, getSupabaseAdmin } from './supabaseService';
import { RealScraperService } from './realScraperService';
import { TmdbService } from './tmdbService';
import { sortServersBySourcePriority, getPrimaryStream, paraElCliente, fichaReproducible, veredictoDisponibilidad, VERIFICADO_VIGENTE_MS } from './streamSorter';
import { normalizeTitle, slugify, yearFromSlug, searchIndexKey } from '../utils/text';
import { httpClient } from '../utils/httpClient';
import { CacheStore } from '../cache/store';
import { unwrapRedirector, canonicalArchiveOrg } from '../scrapers/directStream';
import { revisarServidores, aplicarVeredictosRecordados } from './playbackHealth';

// TTL del caché de catálogo/búsqueda. Con Redis (KV_REST_API_* / UPSTASH_*) las entradas
// se comparten entre lambdas y sobreviven cold starts; sin Redis degrada a memoria local.
/**
 * TTL del caché de catálogo/búsqueda/enlaces.
 *
 * Eran 10 minutos, y ese número venía de cuando `direct_stream` guardaba la URL firmada del CDN,
 * que caduca. Hoy guarda `/api/v1/stream/direct?e=<embed>`, que es permanente y vuelve a acuñar la
 * URL real en CADA reproducción, así que la lista de servidores no se echa a perder en diez
 * minutos. Y esos diez minutos costaban caro: reconstruir la ficha de un capítulo son 5-9 s de
 * scraping, así que cada cuarto de hora alguien se los comía.
 *
 * Lo que sí puede cambiar dentro de la hora es que un servidor se muera, y de eso no se encarga
 * este TTL sino los veredictos de salud, que se aplican SIEMPRE al leer del caché
 * (`aplicarVeredictosRecordados`). Caché largo con veredicto fresco encima.
 */
const CACHE_TTL_SECONDS = 60 * 60;

// La METADATA (sinopsis, pósters, reparto…) apenas cambia: se cachea mucho más tiempo que
// los enlaces, que sí caducan. Es lo que permite que la ficha emergente abra al instante.
const METADATA_TTL_SECONDS = 6 * 60 * 60;

// Enlaces persistidos por debajo de esta antigüedad se sirven de la DB sin volver a scrapear.
const STREAMS_FRESH_MS = 24 * 60 * 60 * 1000;

// Corte de re-resolución: los enlaces guardados antes de esta fecha se consideran caducos
// aunque sean recientes, y se vuelven a resolver UNA vez por título según se van pidiendo.
//
// 2026-07-23 → empezó a extraerse el vídeo directo: lo guardado antes solo tenía embed.
// 2026-07-25 → se midió qué hosts admiten redirección (src/scrapers/hostPolicy.ts). Lo
//   guardado antes lleva `direct_mode: 'proxy'` a fuego y sin el campo `headers`.
//
//   Ni reproducir ni el ORDEN dependen ya de esto: /stream/direct vuelve a decidir el modo en
//   cada petición, y `streamSorter` lo RECALCULA antes de ordenar (`effectiveDirectMode`) en vez
//   de leer la etiqueta guardada — que era lo que hundía precisamente a los servidores que no
//   gastan proxy. Lo único que sigue sin arreglarse solo es `headers`, que es lo que copia un
//   cliente nativo para pedir `?mode=redirect`. Si algún día ese campo deja de importar, este
//   corte se puede retirar y se ahorra un re-escrapeo por título.
//
// 2026-07-25T21:42 → se arregló la comprobación de salud (src/scrapers/embedHealth.ts), que
//   marcaba caído a emturbovid entero: 6.265 servidores, el segundo host más grande y el más
//   rápido que se ha medido (holgura 6x en frío, 13x repetido). El `status` es un campo GUARDADO
//   y `streamSorter` antepone lo que está `online`, así que sin volver a comprobarlos seguirían
//   enterrados con el veredicto viejo. Esto es lo que los saca a flote.
const DIRECT_EXTRACTION_SINCE = Date.parse('2026-07-25T21:42:00Z');

/**
 * Clave canónica de título para AGRUPAR variantes del mismo contenido entre fuentes
 * (regionalizaciones ES/EN, sufijos "HD"/"La Película", casos Spider-Man). Insensible a
 * acentos y puntuación. Reutilizada por la fusión multifuente y el agrupamiento de búsqueda.
 */
function canonicalTitleKey(t: string): string {
  const norm = (t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return norm
    .replace(/\b(la pelicula|pelicula|the movie|hd)\b/g, '')
    .replace(/\bspiderman\b/g, 'spider man')
    .replace(/\bspider man 1\b/g, 'spider man')
    .replace(/sin camino a casa/g, 'no way home')
    .replace(/lejos de casa/g, 'far from home')
    .replace(/de regreso a casa/g, 'homecoming')
    .replace(/un nuevo universo/g, 'into the spider verse')
    .replace(/traves del spider verso/g, 'across the spider verse')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalización estricta alfanumérica para comparación EXACTA de títulos/slugs. */
function strictKey(t: string): string {
  return (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '').trim();
}

/**
 * Año de estreno de una ficha o de un candidato de las fuentes, mire donde mire.
 *
 * Ninguna de las dos vías está siempre: `release_date` lo pone TMDB (ISO completo) o la tarjeta
 * de la fuente (solo el año, entre paréntesis en el título), y el slug lo lleva embebido justo
 * cuando la fuente ha tenido que desambiguar homónimos (`sin-salida-2011`,
 * `2026-03-sin-salida-2022-html`). Se mira primero la fecha, que es el dato explícito; el slug
 * es el último recurso —un título que acaba en número ("Mujer Maravilla 1984") lo confundiría—.
 */
export function yearOf(item: { release_date?: string; id?: string; _tioplus_url?: string; _source_url?: string }): string | undefined {
  const fromDate = String(item.release_date || '').match(/\b(1[89]\d{2}|20\d{2})\b/);
  if (fromDate) return fromDate[1];
  const url = item._tioplus_url || item._source_url || '';
  return yearFromSlug(item.id) || yearFromSlug(slugify(url));
}

/**
 * ¿Un candidato de las fuentes es LA MISMA OBRA que la ficha que estamos resolviendo?
 *
 * Es la pregunta que autoriza a adoptar sus servidores, y hasta ahora se contestaba SOLO con el
 * título: cualquier candidato que se llamara igual entraba. Eso mezcla películas distintas de
 * forma sistemática, porque el catálogo está lleno de homónimos exactos y porque el título de la
 * ficha es el de TMDB en español, que multiplica las colisiones. Medido en vivo, "Sin salida"
 * devuelve CUATRO películas sin relación (Abduction 2011, Not Safe for Work 2014, No Exit 2022 y
 * la de 2024), y "The Firm" (1993) se llama "Sin salida" en es-MX: las cuatro acabaron
 * volcándose unas en otras. "Carrie" son tres (1976, 2002, 2013).
 *
 * El año es lo que las separa, así que aquí es REQUISITO, no desempate. Se contesta una de tres:
 *
 *   'misma'       → hay prueba de identidad: el mismo tmdb_id real, o mismo tipo + mismo título
 *                   + años que cuadran (±1, el desfase de distribución que ya tolera el matcher
 *                   de TMDB: festival un año, estreno el siguiente).
 *   'distinta'    → hay prueba de que NO lo es. Se descarta sin más.
 *   'sin-pruebas' → el candidato no trae año y no hay tmdb_id que valga: es indecidible. También
 *                   se descarta —mezclar es peor que perder un servidor—, pero el que llama debe
 *                   saberlo, porque una resolución con candidatos indecidibles NO puede concluir
 *                   que la ficha no tenga enlaces en ninguna parte.
 */
export type VeredictoIdentidad = 'misma' | 'distinta' | 'sin-pruebas';

export function mismaObra(target: MediaItem, cand: MediaItem): VeredictoIdentidad {
  // 1. tmdb_id REAL en los dos lados: identidad resuelta, en un sentido o en el otro. Se exige
  //    positivo porque los ids sintéticos se derivan del título (tmdbService.syntheticTmdbId) y
  //    dos homónimos sin match en TMDB comparten el mismo número negativo.
  if (target.tmdb_id > 0 && cand.tmdb_id > 0) {
    return target.tmdb_id === cand.tmdb_id ? 'misma' : 'distinta';
  }

  // 2. Una película y una serie no son la misma obra ni compartiendo nombre y año.
  if (cand.type !== target.type) return 'distinta';

  const targetStrict = strictKey(target.title);
  const targetCanonical = canonicalTitleKey(target.title);
  const mismoTitulo =
    (!!targetStrict && strictKey(cand.title) === targetStrict) ||
    (!!targetCanonical && canonicalTitleKey(cand.title) === targetCanonical);
  if (!mismoTitulo) return 'distinta';

  // 3. Mismo nombre: decide el año. Sin él no hay identidad que probar.
  const targetYear = yearOf(target);
  const candYear = yearOf(cand);
  if (!targetYear || !candYear) return 'sin-pruebas';

  return Math.abs(Number(targetYear) - Number(candYear)) <= 1 ? 'misma' : 'distinta';
}

/**
 * ¿Los años de estreno DEMUESTRAN que son obras distintas?
 *
 * Es la mitad "solo con prueba" de `mismaObra`, para cuando la identidad ya viene declarada por
 * otra vía (una url guardada en `source_urls`) y lo único que se busca es un desmentido. Que
 * falte el año en un lado no prueba nada, y que los títulos no se parezcan tampoco: los nombres
 * regionales de la misma película no se parecen entre sí ("En la tormenta" es "Sin salida").
 */
export function anosIncompatibles(
  a: { release_date?: string; id?: string },
  b: { release_date?: string; id?: string }
): boolean {
  const ya = yearOf(a);
  const yb = yearOf(b);
  if (!ya || !yb) return false;
  // ±1: el desfase de distribución que ya tolera el matcher de TMDB (festival vs. estreno).
  return Math.abs(Number(ya) - Number(yb)) > 1;
}

/**
 * Los ids con los que una página de origen puede estar registrada en el catálogo.
 *
 * Son los DOS moldes exactos con que cada fuente forma el id de su fila, y por eso se descarta
 * primero el dominio: los dos operan sobre la RUTA.
 *   · TioPlus  → el último tramo (`/pelicula/sin-salida-2011` → `sin-salida-2011`);
 *   · FuegoCine → la ruta entera sluguificada (`/2026/03/sin-salida-2022.html`
 *     → `2026-03-sin-salida-2022-html`).
 * El tramo final va además en minúsculas porque las fuentes publican rutas con mayúsculas
 * (`/serie/Inconcebible`) y los ids del catálogo no siempre las conservan.
 *
 * Sirve para preguntar QUIÉN es el dueño de una página: si una ficha lleva en sus `source_urls`
 * la página propia de OTRA ficha con distinto tmdb_id, está sacando el vídeo de otra obra, y eso
 * se demuestra sin salir a la red. Es la prueba más fuerte que hay, la única que separa homónimos
 * del MISMO año, donde la fecha ya no distingue nada ("El botín" son dos películas de 2026).
 */
export function candidateIdsForUrl(url: string): string[] {
  if (!url) return [];
  const path = String(url).replace(/^https?:\/\/[^/]+/i, '');
  const last = path.split('/').filter(Boolean).pop() || '';
  /**
   * EL MOLDE DE ARCHIVE.ORG, que lleva prefijo. Sus ids de fila son `archive-<identifier>` y no
   * el identifier pelado, a propósito: `shrek3_202506` a secas competiría con los slugs de las
   * otras webs por el mismo nombre, que es cómo `/ver-serie/animal/` acabó reconociendo como
   * suya la ficha `animal` de otro sitio. Sin registrarlo aquí, `esPaginaPropia` diría que la
   * página de la que salió la ficha no es suya, y la ficha perdería todas las comprobaciones
   * que dependen de reconocer su propio origen.
   */
  const deArchive = /archive\.org\/(?:details|metadata|download)\//i.test(String(url))
    ? [`archive-${last}`] : [];
  return Array.from(new Set([...deArchive, last, last.toLowerCase(), slugify(path)])).filter(Boolean);
}

/**
 * La categoría de la ruta de TioPlus dice si la página es de película o de serie. Es un dato de
 * la FUENTE, no una deducción, así que manda sobre lo que crea el matcher: un emparejado que
 * cruza de catálogo convierte la ficha de una película en la de una serie, con su póster y su
 * sinopsis (TMDB registra "Die Hart 2: Die Harter", que es una película, como título alternativo
 * de la SERIE "Die Hart"). Devuelve null en las fuentes cuya url no lo declara.
 */
export function tipoDeLaRuta(url: string): ContentType | null {
  if (/\/pelicula\//i.test(url)) return 'movie';
  // Cinecalidad: `/ver-pelicula/` y `/ver-serie/`. Se comprueba ANTES que el patrón genérico de
  // serie para que `/ver-pelicula/` no caiga en él por contener «pelicula».
  if (/\/ver-pelicula\//i.test(url)) return 'movie';
  if (/\/ver-serie\//i.test(url) || /\/ver-el-episodio\//i.test(url)) return 'tvseries';
  if (/\/(serie|anime|dorama)\//i.test(url)) return 'tvseries';
  /**
   * ARCHIVE.ORG NO LO DECLARA EN LA RUTA, y aquí se dice en voz alta para que nadie lo añada.
   * Todos sus items cuelgan de `/details/<id>` sean lo que sean; la clase la dice su `subject`
   * (ver `claseDeArchive`). Devolver un tipo adivinado desde esta url sería peor que devolver
   * null: este valor MANDA sobre lo que crea el matcher, así que una suposición aquí convierte
   * una serie en película con su póster y su sinopsis.
   */
  return null;
}

/**
 * ¿Esta url es la página de la que SALIÓ la ficha? El id de la fila ES el slug de su fuente (ver
 * mapDbItemToMediaItem), así que se compara contra el id y NO contra el título: comparar títulos
 * es justo lo que confunde homónimos —`carrie-2002` no debe reconocer como propia la página
 * `carrie-1976`—. Sirve para no dudar nunca del origen de la propia ficha.
 *
 * La comparación es EXACTA contra los moldes de arriba. Antes valía que el id fuera el final del
 * slug de la url, y eso hacía propias páginas ajenas: la ficha `sobre-ruedas` daba por suya
 * `/pelicula/amor-sobre-ruedas`, que es otra película, y así se libraba de todas las
 * comprobaciones. Y cuando dos páginas de categorías distintas caen en el mismo id —el mismo
 * nombre como película y como serie, `/pelicula/inconcebible` y `/serie/Inconcebible`— desempata
 * la categoría de la ruta contra el tipo de la ficha.
 */
export function esPaginaPropia(id: string | undefined, url: string, type?: ContentType): boolean {
  if (!id || !url) return false;
  if (!candidateIdsForUrl(url).includes(id)) return false;
  const tipoUrl = tipoDeLaRuta(url);
  return !type || !tipoUrl || tipoUrl === type;
}

/**
 * ¿De qué ficha del catálogo es ESTA página? — la llave más fuerte de FUENTES.md §1.
 *
 * Que el slug de una url case con el id de otra fila, y esa fila tenga otro `tmdb_id`, es la
 * prueba definitiva de que la página no es tuya, y sale gratis: no hay que visitarla. Es además
 * la única que separa homónimos del MISMO año.
 *
 * POR QUÉ NO BASTA CON BUSCAR EL ID EN EL MAPA. `candidateIdsForUrl` devuelve varios moldes, y
 * el primero es el último segmento pelado —`sakamoto-days`—, que es justo la forma que usan los
 * ids de TioPlus. Así que la página de Cinecalidad `/ver-pelicula/sakamoto-days/` encontraba como
 * «dueña» a la ficha de TioPlus `sakamoto-days`, que es OTRA obra: la serie de 2025, no la
 * película de 2026. Medido el 2026-08-19: los tres únicos cruces que denunciaba la auditoría del
 * crawl eran de esta clase —Sakamoto Days, Gintama y «Una historia real»—, cada ficha con UNA
 * sola fuente y esa fuente siendo su propia página. Ninguna servía contenido ajeno.
 *
 * No era inofensivo: ponía en rojo la corrida diaria del crawl, y un trabajo que siempre falla
 * deja de avisar de nada. Y crece con el catálogo — cualquier título que exista en dos webs con
 * el mismo slug cae aquí.
 *
 * La condición correcta es la simétrica de `esPaginaPropia`: alguien es dueño de una url solo si
 * esa url es SU propia página, con la clase de la ruta incluida (`/ver-pelicula/` frente a
 * `/ver-serie/`). Eso conserva entera la detección de verdad —si una fila apunta a la página de
 * otra, esa otra sigue reconociéndola como suya— y descarta la coincidencia de nombre.
 *
 * Vive aquí, y no copiada en la auditoría y en la purga, porque justo eso es lo que hizo que
 * `checkCatalog` denunciara tres fichas que `repairCatalog --fuentes` se negaba a tocar: dos
 * respuestas distintas a la misma pregunta.
 */
export function duenoDeLaPagina<T extends { id: string; type?: string | null }>(
  url: string,
  porId: Map<string, T>
): T | undefined {
  /**
   * DEL CANDIDATO MÁS ESPECÍFICO AL MÁS GENERAL, y esto es la mitad del arreglo.
   *
   * `candidateIdsForUrl` devuelve dos formas de la misma url: el último segmento pelado
   * (`animal`) y el camino entero convertido en slug (`ver-serie-animal`). La primera es la que
   * usan los ids de TioPlus y la segunda la de Cinecalidad — y la pelada casa con CUALQUIER sitio
   * que publique ese nombre, así que tomarla antes reparte la página de una web a la ficha de
   * otra.
   *
   * Exigir además que coincida la clase de la ruta (`esPaginaPropia`) tapa el caso fácil —una es
   * película y la otra serie— y NO el difícil: «Animal» son dos SERIES, la de 2021 en TioPlus y
   * la de 2025 en Cinecalidad. Ahí el tipo no desempata y la pelada volvía a ganar, así que la
   * auditoría del crawl seguía denunciando un cruce que no existe.
   *
   * Ordenar por longitud descendente pone delante la forma derivada del camino, que es la que
   * lleva la estructura del sitio dentro. Y no rompe a TioPlus: para `/serie/animal` prueba
   * primero `serie-animal`, que no es el id de nadie, y cae en `animal`, que sí.
   */
  return [...candidateIdsForUrl(url)]
    .sort((a, b) => b.length - a.length)
    .map(c => porId.get(c))
    .find((r): r is T =>
      !!r && esPaginaPropia(r.id, url, r.type === 'tvseries' ? 'tvseries' : 'movie'));
}

export class CatalogService {
  private static dedupeById(items: MediaItem[]): MediaItem[] {
    const seen = new Set<string>();
    return items.filter(item => {
      if (!item.id || seen.has(item.id)) {
        return false;
      }
      seen.add(item.id);
      return true;
    });
  }

  /**
   * Limpia toda la caché en memoria de la API
   */
  static clearCache(): void {
    CacheStore.clear();
  }

  /**
   * Ordena los servidores de cada episodio. UN EPISODIO NO HEREDA NADA.
   *
   * Esta función rellenaba con los servidores de nivel serie los episodios que no tenían los
   * suyos, «como fallback reproducible en la portada». Es el fallo que FUENTES.md §4 llama el peor
   * sin dar error: pides el capítulo 1 y ves otro. Los servidores de nivel serie salen de scrapear
   * la página de la SERIE, cuyo reproductor muestra un capítulo concreto —normalmente el último—,
   * así que los 289 episodios de «El Chapulín Colorado» anunciaban todos el mismo vídeo. Y como
   * `persistStreams` escribe `seasons`, esos enlaces prestados acababan GUARDADOS como si fueran
   * del capítulo 1, donde ya nada delata que no lo son.
   *
   * No da error en ninguna capa: el enlace existe, reproduce, y entrega la obra equivocada. Solo
   * lo nota quien está mirando.
   *
   * La regla es la que ya estaba escrita en la documentación y no en el código: si no hay enlaces
   * DEL capítulo, el capítulo va sin enlaces. Los suyos se piden a
   * /series/:id/season/:s/episode/:e, que scrapea SU página y desde `persistEpisodeServers` los
   * deja guardados.
   */
  private static inheritServersToEpisodes(item: MediaItem | null | undefined): void {
    if (!item || !item.seasons || item.seasons.length === 0) return;
    for (const season of item.seasons) {
      if (!season.episodes) continue;
      for (const ep of season.episodes) {
        if (!ep.servers || ep.servers.length === 0) continue;
        ep.servers = sortServersBySourcePriority(ep.servers);
        ep.primary_stream = getPrimaryStream(ep.servers);
      }
    }
  }

  /**
   * Resuelve un slug directamente contra las fuentes reales:
   * FuegoCine (ids con forma 2025-04-titulo-2012-html) y TioPlus (por categoría).
   * Devuelve el detalle SIN enriquecer, o null si el slug no existe en ninguna fuente.
   */
  private static async resolveFromSource(slug: string): Promise<MediaItem | null> {
    const fuegocineMatch = slug.match(/^(\d{4})-(\d{2})-(.+)-html$/);
    if (fuegocineMatch) {
      const fuegocineUrl = `https://www.fuegocine.com/${fuegocineMatch[1]}/${fuegocineMatch[2]}/${fuegocineMatch[3]}.html`;
      const fcDetail = await RealScraperService.scrapeFuegocineDetail(fuegocineUrl).catch(() => null);
      if (fcDetail) return fcDetail;
    }

    // Las 4 categorías se prueban EN PARALELO: en serie costaban hasta 4 round-trips
    // encadenados en el peor caso (el que más pesaba en la latencia del detalle).
    const categories = ['pelicula', 'serie', 'anime', 'dorama'];
    const probes = await Promise.all(
      categories.map(cat =>
        RealScraperService.scrapeDetail(`https://tioplus.app/${cat}/${slug}`).catch(() => null)
      )
    );

    // Se conserva el orden de preferencia original (película > serie > anime > dorama).
    for (const detail of probes) {
      if (detail && (detail.servers?.length || detail.seasons?.length)) return detail;
    }

    return null;
  }

  /**
   * Puntuación mínima para tratar una fila como LA ficha pedida. Por debajo de este umbral
   * la coincidencia es solo parcial y se prefiere resolver contra las fuentes en vivo.
   */
  private static readonly DB_MATCH_CONFIDENT = 70;

  /**
   * Todas las formas de slug bajo las que puede pedirse una fila, derivadas de su id.
   * FuegoCine antepone la fecha del post y añade el año + "-html":
   *   2025-04-shrek-2-2004-html  →  {id completo, "shrek-2-2004", "shrek-2"}
   * Es lo que permite reconocer "shrek-2" como EXACTAMENTE esa fila, y no como un trozo
   * suelto de "2025-04-shrek-2001-html" (donde "shrek-2" solo aparece dentro del año).
   */
  private static idSlugVariants(rowId: string): Set<string> {
    const variants = new Set<string>();
    const base = String(rowId || '').toLowerCase().trim();
    if (!base) return variants;

    variants.add(base);
    const fuegocine = base.match(/^\d{4}-\d{2}-(.+)-html$/);
    if (fuegocine) {
      variants.add(fuegocine[1]);
      variants.add(fuegocine[1].replace(/-\d{4}$/, ''));
    }
    return variants;
  }

  /**
   * Cuánto se parece una fila al slug pedido. Solo cuentan las coincidencias de UNIDAD
   * COMPLETA (id canónico, título, título original, alias); el "contiene" suelto puntúa
   * por debajo del umbral de confianza porque es justo lo que cruzaba fichas distintas
   * ("shrek" → Shrek Tercero, "shrek-2" → Shrek).
   */
  private static scoreDbCandidate(row: any, slug: string, typeHint?: ContentType): number {
    const idVariants = this.idSlugVariants(row?.id);
    const titleSlug = slugify(row?.title);
    let score = 0;

    if (idVariants.has(slug)) score = 100;
    else if (titleSlug && titleSlug === slug) score = 95;
    else if (slugify(row?.original_title) === slug && slug) score = 80;
    else if ((row?.aliases || []).some((a: string) => slugify(a) === slug)) score = 70;
    else {
      // Prefijo de segmento completo ("shrek" ⊂ "shrek-2"): plausible, nunca concluyente.
      const isSegmentPrefix = (v: string) => v === slug || v.startsWith(`${slug}-`);
      if (Array.from(idVariants).some(isSegmentPrefix) || (titleSlug && isSegmentPrefix(titleSlug))) score = 30;
      else if (Array.from(idVariants).some(v => v.includes(slug))) score = 10;
    }

    if (score === 0) return 0;

    // Desempates: no cruzan de nivel, solo ordenan dentro del mismo tipo de coincidencia.
    if (typeHint && row?.type === typeHint) score += 3;
    if (row?.poster) score += 2;
    if (row?.overview && String(row.overview).length > 20) score += 1;
    return score;
  }

  /**
   * Localiza la fila del catálogo que corresponde a CUALQUIER forma de id que la API haya
   * podido emitir: el id de la fuente, el tmdb_id, el slug corto de TioPlus, el slug
   * embebido en el id de FuegoCine o un slug derivado del título.
   *
   * Devuelve la mejor candidata JUNTO CON su puntuación: el llamador decide si la acepta
   * como definitiva (>= DB_MATCH_CONFIDENT) o si primero intenta resolver en vivo. Antes se
   * devolvía el primer `ilike '%slug%'` que apareciera, sin orden ni verificación, y los
   * slugs cortos acababan apuntando a la película equivocada.
   */
  private static async findDbRowScored(id: string, typeHint?: ContentType): Promise<{ row: any; score: number } | null> {
    const slug = id.trim().toLowerCase();
    if (!slug) return null;

    // a) id exacto de la fuente: no hay nada más que verificar.
    try {
      const { data } = await supabase.from('media_items').select('*').eq('id', slug).limit(1);
      if (data && data.length > 0) return { row: data[0], score: 100 };
    } catch {}

    // b) tmdb_id numérico. Un mismo número puede designar una película Y una serie —TMDB las
    //    numera por separado—, así que cuando el llamador dice de cuál habla, se le hace caso;
    //    si no lo dice, la primera que aparezca es lo mejor que se puede ofrecer.
    if (!isNaN(Number(slug))) {
      try {
        const byTmdb = supabase.from('media_items').select('*').eq('tmdb_id', Number(slug));
        const { data } = await (typeHint ? byTmdb.eq('type', typeHint) : byTmdb).limit(1);
        if (data && data.length > 0) return { row: data[0], score: 100 };
      } catch {}
    }

    // Solo [a-z0-9-] llega a los patrones LIKE, así que no hay riesgo de inyección de comodines.
    const safeSlug = slugify(slug);
    if (!safeSlug) return null;
    const deslugged = safeSlug.replace(/-/g, ' ');

    // Los pases van EN PARALELO. Los dos primeros están anclados a la gramática de los ids
    // de FuegoCine (`_` = un carácter en LIKE, `____` = el año), así que traen la fila
    // correcta aunque el pase suelto se quede corto por el límite de filas. El cuarto usa
    // `%` como separador para que la puntuación que el slug perdió ("9: el" ← "9-el") no
    // impida encontrar el título. Todos son CANDIDATOS: quien decide es la puntuación.
    const candidateSets = await Promise.all([
      supabase.from('media_items').select('*').ilike('id', `%-${safeSlug}-html`).limit(10),
      supabase.from('media_items').select('*').ilike('id', `%-${safeSlug}-____-html`).limit(10),
      supabase.from('media_items').select('*').ilike('title_normalized', `${deslugged}%`).limit(25),
      supabase.from('media_items').select('*').ilike('title_normalized', `${safeSlug.replace(/-/g, '%')}%`).limit(25),
      supabase.from('media_items').select('*').ilike('id', `%${safeSlug}%`).limit(25)
    ].map(p => Promise.resolve(p).then((r: any) => (r?.data as any[]) || []).catch(() => [] as any[])));

    let best: { row: any; score: number } | null = null;
    const seen = new Set<string>();
    for (const row of candidateSets.flat()) {
      if (!row?.id || seen.has(row.id)) continue;
      seen.add(row.id);
      const score = this.scoreDbCandidate(row, safeSlug, typeHint);
      if (score > 0 && (!best || score > best.score)) best = { row, score };
    }

    return best;
  }

  /**
   * Mapea un MediaItem a un payload compacto optimizado para listados y vistas rápidas
   */
  static toCompactItem(item: MediaItem): Partial<MediaItem> {
    // `compact=true` también es una respuesta pública: no puede saltarse el filtro de embeds.
    const playable = this.toPublicItem(item);
    return {
      id: playable.id,
      tmdb_id: playable.tmdb_id,
      type: playable.type,
      title: playable.title,
      original_title: playable.original_title,
      poster: playable.poster,
      backdrop: playable.backdrop,
      rating: playable.rating,
      release_date: playable.release_date,
      genres: playable.genres,
      subcategories: playable.subcategories,
      primary_stream: playable.primary_stream,
      servers: playable.servers
    };
  }

  /**
   * Proyección LEAN para resultados de BÚSQUEDA: solo lo necesario para pintar una tarjeta.
   * Sin cast, servers, seasons ni overview → payload pequeño y respuesta ultrarrápida.
   * El detalle completo se obtiene al abrir el título (getById).
   */
  static toSearchItem(item: MediaItem): Partial<MediaItem> {
    return {
      id: item.id,
      tmdb_id: item.tmdb_id,
      type: item.type,
      title: item.title,
      original_title: item.original_title,
      poster: item.poster,
      backdrop: item.backdrop,
      release_date: item.release_date,
      rating: item.rating,
      genres: item.genres,
      subcategories: item.subcategories
    };
  }

  /**
   * Proyección de TARJETA para el home y los carruseles. Lleva la metadata completa que
   * necesita la ficha emergente (sinopsis, tagline, logo, duración, clasificación, tráiler),
   * de modo que la app pueda abrir el popup SIN pedir nada más; solo los enlaces se piden
   * aparte, al pulsar Reproducir. Sin cast, servidores ni temporadas.
   */
  static toCardItem(item: MediaItem): Partial<MediaItem> & Record<string, unknown> {
    return {
      id: item.id,
      tmdb_id: item.tmdb_id,
      type: item.type,
      title: item.title,
      original_title: item.original_title,
      tagline: item.tagline || '',
      overview: item.overview || '',
      poster: item.poster,
      backdrop: item.backdrop,
      logo: item.logo,
      rating: item.rating,
      content_rating: item.content_rating,
      runtime: item.runtime,
      release_date: item.release_date,
      year: item.release_date ? Number(String(item.release_date).substring(0, 4)) || null : null,
      genres: item.genres,
      subcategories: item.subcategories,
      trailer: item.trailer,
      total_seasons: item.total_seasons,
      total_episodes: item.total_episodes,
      detail_url: `/api/v1/media/${item.id}`,
      streams_url: `/api/v1/media/${item.id}/streams`
    };
  }

  /**
   * Proyección de HÉROE (destacados del home): la tarjeta + reparto y dirección.
   */
  static toHeroItem(item: MediaItem): Partial<MediaItem> & Record<string, unknown> {
    return {
      ...this.toCardItem(item),
      cast: (item.cast || []).slice(0, 8),
      cast_details: (item.cast_details || []).slice(0, 8),
      dubbing_cast: item.dubbing_cast || [],
      director: item.director,
      created_by: item.created_by,
      original_language_title: item.original_title
    };
  }

  /**
   * Consulta múltiples títulos en lote (Batching Request).
   * Usa el camino RÁPIDO (metadata sin resolución de enlaces) para que prefetchear
   * una fila entera del home siga siendo barato.
   *
   * Y con el mismo descuento que los demás listados: esto sirve para prefetchear una fila del
   * home, así que es un listado con otro nombre. Si se lo saltara, la app se traería en el lote
   * justo los títulos que el carrusel acaba de dejar de enseñar. Ver `sinRetirados`.
   */
  static async getBatch(ids: string[]): Promise<MediaItem[]> {
    const results = await Promise.all(ids.map(id => this.getMetadata(id)));
    return this.sinRetirados(results.filter((item): item is MediaItem => item !== null));
  }

  /**
   * ¿Está aplicada la migración 005? Se comprueba UNA sola vez por proceso: sin ella las
   * columnas de disponibilidad no existen y cualquier consulta que las filtre sería
   * rechazada ENTERA, dejando el home y el discover vacíos. Ante la duda, no se filtra.
   */
  private static availabilityColumnProbe: Promise<boolean> | null = null;
  private static hasAvailabilityColumn(): Promise<boolean> {
    if (!this.availabilityColumnProbe) {
      // Aquí SÍ queremos ejecutar la consulta: `await` sobre el builder la lanza y basta
      // con mirar si Postgres se queja de que la columna no existe.
      this.availabilityColumnProbe = (async () => {
        try {
          const { error } = await supabase.from('media_items').select('has_streams').limit(1);
          return !error;
        } catch {
          return false;
        }
      })();
    }
    return this.availabilityColumnProbe;
  }

  /**
   * Predicado que deja fuera de un listado las fichas FANTASMA: las que se comprobaron a
   * fondo y no tienen ningún enlace reproducible (`has_streams = false`). Las que nunca se
   * han comprobado (NULL) siguen apareciendo — son la mayor parte del catálogo, y ocultarlas
   * por no estar verificadas vaciaría la API en vez de limpiarla. Devuelve null si la
   * migración 005 no está aplicada: entonces no se filtra nada.
   *
   * Se devuelve el PREDICADO, no la consulta ya filtrada, y no es casual: un
   * PostgrestFilterBuilder es "thenable", así que devolverlo desde una función `async` hace
   * que la promesa lo adopte y EJECUTE la consulta a medio construir. El llamador recibía
   * entonces un objeto de resultado en lugar del builder, los filtros siguientes se perdían
   * y el home se quedaba sin una sola fila.
   */
  private static async playableFilter(): Promise<string | null> {
    return (await this.hasAvailabilityColumn())
      ? 'has_streams.eq.true'
      : null;
  }

  /**
   * Todo lo que hace falta para que una ficha se pueda ANUNCIAR, en un solo sitio.
   *
   * Eran dos cosas separadas y solo se aplicaba una. `has_streams` dice que hay algo que
   * reproducir; no dice que la ficha se pueda pintar. El catálogo acabó anunciando
   * «INVENCIBLE» de FuegoCine —sin póster, sin géneros, con la sinopsis de plantilla «Ver …
   * online gratis» y un `tmdb_id` sintético— mientras la ficha buena de la misma serie, con su
   * metadata de TMDB completa, estaba escondida por no tener enlaces todavía.
   *
   * Una fila sin póster no es un título, es un hueco: en una parrilla se ve como una tarjeta
   * rota. Y viene siempre del mismo sitio, una ficha que no encontró su obra en TMDB y se quedó
   * con lo poco que publicaba la fuente.
   *
   * Se aplica sobre la CONSULTA y no como cadena para `.or()` porque son condiciones que se
   * suman, no alternativas. Que lo usen los cuatro caminos de listado es lo que evita que dentro
   * de un mes haya otra vez uno que se lo salta — que es exactamente cómo llegó aquí el buscador.
   *
   * Y es SÍNCRONA a propósito. Un builder de Supabase es *thenable*: devolverlo desde una función
   * `async` hace que el `await` lo EJECUTE a medio construir, y la consulta sale sin los filtros
   * que aún faltaban por encadenar. Lo que hacía falta esperar —si la columna existe— se resuelve
   * fuera y se pasa ya resuelto.
   */
  private static soloPublicables<T>(query: T, hayColumna: boolean): T {
    if (!hayColumna) return query;
    const q = query as any;
    return q
      .eq('has_streams', true)
      .not('poster', 'is', null)
      /**
       * Y CON LA PRUEBA AL DÍA, no con una que valió hace medio día.
       *
       * `has_streams` dice «la última vez que se miró, reproducía». Eso NO es lo mismo que «se
       * puede ver ahora», y la diferencia no es teórica: lo que se entrega al cliente exige
       * además que algún servidor haya demostrado el vídeo en las últimas 6 h (ver
       * `paraElCliente`). Entre que un sello caduca y el barrido lo renueva, la ficha seguía
       * anunciándose y contestaba vacía. Medido: 551 de 1.643 fichas anunciadas —el 33,5 %— no
       * entregaban un solo servidor, y los sellos se amontonaban justo contra el límite de las
       * 6 h (p90 = 6,3 h; p99 = 6,7 h). No estaban rotas: estaban sin comprobar.
       *
       * Esta es la diferencia entre las dos formas de no enseñar un título roto. Retirarlo cuando
       * alguien se lo encuentra llega tarde por definición: ya se llevó el «no se pudo
       * reproducir». Exigir la prueba vigente lo deja fuera ANTES, que es lo que se pidió.
       *
       * La ventana sale de `VERIFICADO_VIGENTE_MS`, la MISMA constante que usa `paraElCliente`,
       * y no de un 6 escrito aquí. Si un día se decide que el sello dura más o menos, esto tiene
       * que moverse con él; una copia se desincronizaría en silencio, y este proyecto ya se ha
       * llevado ese golpe cinco veces.
       *
       * `streams_checked_at` es el sustituto legítimo del sello a nivel de fila: el barrido lo
       * escribe en la misma pasada y con la misma marca de tiempo con la que sella los
       * servidores. Comprobado sobre el catálogo entero — las dos distribuciones son idénticas
       * (p50 0,1 h · p90 6,3 h · p99 6,7 h)—, y hace falta porque un listado no se trae la
       * columna `servers`: es justo la optimización que evita mover 23 MB para pintar carátulas.
       *
       * EL PRECIO, dicho claro: si el barrido se cae, el catálogo ENCOGE en vez de mentir. Es
       * deliberado y es la regla de la casa — más corto y cierto antes que largo y falso—, pero
       * significa que la salud del barrido pasa a ser visible en el tamaño del catálogo. Por eso
       * `--verificar` no puede volver a morir en silencio.
       */
      .gt('streams_checked_at', new Date(Date.now() - VERIFICADO_VIGENTE_MS).toISOString()) as T;
  }

  /**
   * LAS COLUMNAS QUE NECESITA UNA TARJETA, y ni una más.
   *
   * Los listados pedían `select('*')`, y eso arrastra `servers` y `seasons` —el JSON más pesado
   * de la tabla, con decenas de servidores y todos los capítulos de cada serie— para pintar una
   * carátula y un título. Con 800 filas eso son megabytes que viajan de Supabase a la función,
   * se parsean, y se tiran.
   *
   * Medido antes de tocarlo: el home en FRÍO tardaba 12,8 segundos. No era el scraping —que ni
   * se ejecuta— ni TMDB: era esta consulta.
   *
   * El mapeador tolera columnas ausentes (todas llevan su valor por defecto), así que una ficha
   * de listado sale igual; lo único que no trae son los datos que un listado no enseña. El
   * detalle sigue pidiendo la fila entera, que es donde sí hacen falta.
   *
   * OJO AL NOMBRAR: la primera versión incluía `slug`, que NO es una columna de la tabla —el
   * mapeador la lee pero cae a `title` cuando falta—. PostgREST rechaza la consulta ENTERA por
   * una columna inexistente, así que devolvía cero filas y el home se iba silenciosamente al
   * respaldo con `select('*')`: el mismo 23 MB de antes, pero ahora además con una consulta
   * fallida por delante. Un error de una palabra que anulaba la optimización sin dar la cara.
   */
  private static readonly COLUMNAS_DE_TARJETA =
    'id,tmdb_id,type,title,original_title,overview,rating,release_date,genres,' +
    'subcategories,poster,backdrop,logo,trailer,runtime,total_seasons,total_episodes,' +
    'has_streams,content_rating,metadata_source,updated_at';

  /**
   * Pool de títulos para construir el home. Una sola query a Postgres (sin scraping),
   * cacheada, lo bastante ancha para alimentar ~15 carruseles temáticos. Cae a getAll()
   * (que sí sabe scrapear en vivo) cuando la DB todavía no está poblada.
   *
   * Se exigen póster y géneros: el job de refresco escribe AL FINAL los títulos sin match
   * en TMDB (sin géneros ni sinopsis), así que ordenar solo por frescura llenaba el pool
   * entero con ellos y el home se quedaba sin carruseles temáticos ni destacados.
   */
  static async getHomePool(limit: number = 800): Promise<MediaItem[]> {
    const cacheKey = `home_pool:${limit}`;
    const cached = await CacheStore.get<MediaItem[]>(cacheKey);
    if (cached) return cached;

    try {
      let query = supabase
        .from('media_items')
        .select(this.COLUMNAS_DE_TARJETA)
        .not('poster', 'is', null)
        .not('genres', 'eq', '{}')
        .order('updated_at', { ascending: false })
        .limit(limit);

      query = this.soloPublicables(query, await this.hasAvailabilityColumn());

      const { data } = await query;

      if (data && data.length >= 30) {
        const items = data.map(this.mapDbItemToMediaItem);
        await CacheStore.set(cacheKey, items, CACHE_TTL_SECONDS);
        return items;
      }
    } catch {}

    // Sin la columna genres poblada (catálogo recién creado) se repite sin filtros.
    try {
      const { data } = await supabase
        .from('media_items')
        .select(this.COLUMNAS_DE_TARJETA)
        .order('updated_at', { ascending: false })
        .limit(limit);

      if (data && data.length >= 30) {
        const items = data.map(this.mapDbItemToMediaItem);
        await CacheStore.set(cacheKey, items, CACHE_TTL_SECONDS);
        return items;
      }
    } catch {}

    const fallback = await this.getAll();
    if (fallback.length > 0) {
      await CacheStore.set(cacheKey, fallback, CACHE_TTL_SECONDS);
    }
    return fallback;
  }

  /**
   * Consulta de UNA fila del home resuelta en Postgres.
   *
   * A partir de unos pocos miles de fichas ya no sirve filtrar un pool común en memoria:
   * "las N más recientes" son en realidad "las N últimas que escribió el crawl", así que
   * categorías enteras (anime, documentales…) quedaban fuera por puro orden de escritura.
   * Cada carrusel pide lo suyo con los índices de la migración 004.
   */
  static async queryRow(spec: {
    type?: ContentType;
    /** Basta con que la ficha tenga UNO de estos géneros (cubre las variantes de TMDB). */
    genres?: string[];
    /** Valor exacto dentro de subcategories (p. ej. 'Anime'). */
    subcategory?: string;
    minRating?: number;
    /** Estrenos anteriores a este año (clásicos). */
    beforeYear?: number;
    order?: 'recent' | 'rating';
    limit?: number;
  }): Promise<MediaItem[]> {
    const limit = Math.max(1, Math.min(spec.limit || 60, 200));

    try {
      /**
       * AQUÍ ESTABA EL HOME LENTO, y no donde parecía.
       *
       * Cada carrusel llama a esta función, y el home construye diecinueve más la fila de
       * recientes: unas 1.720 filas pedidas con `select('*')`, o sea con `servers` y `seasons`
       * enteros dentro. Medido: 800 filas así pesan 23,7 MB y tardan 5,7 s; las mismas 800 con
       * las columnas de una tarjeta pesan 823 KB y tardan 0,87 s. Multiplicado por veinte
       * consultas en paralelo, eso es el home en frío tardando doce segundos para pintar
       * carátulas y títulos.
       */
      let query = supabase
        .from('media_items')
        .select(this.COLUMNAS_DE_TARJETA)
        .not('poster', 'is', null)
        .not('genres', 'eq', '{}');

      // Los carruseles del home no anuncian títulos que ya sabemos que no se reproducen.
      query = this.soloPublicables(query, await this.hasAvailabilityColumn());

      if (spec.type) query = query.eq('type', spec.type);
      if (spec.genres && spec.genres.length > 0) query = query.overlaps('genres', spec.genres);
      if (spec.subcategory) query = query.contains('subcategories', [spec.subcategory]);
      if (spec.minRating) query = query.gte('rating', spec.minRating);
      if (spec.beforeYear) {
        // release_date es texto ('2009-05-01' o '2009'): la comparación lexicográfica
        // funciona con ambos formatos mientras se acote por abajo para excluir los vacíos.
        query = query.gte('release_date', '1900').lt('release_date', String(spec.beforeYear));
      }

      query = spec.order === 'recent'
        ? query.order('updated_at', { ascending: false })
        : query.order('rating', { ascending: false, nullsFirst: false });

      const { data, error } = await query.limit(limit);
      if (error || !data) return [];
      return data.map(this.mapDbItemToMediaItem);
    } catch {
      return [];
    }
  }

  /**
   * Listado paginado DIRECTO en Postgres (tipo + género + rango), con total exacto.
   * Habilita el "ver todo" de cada fila del home y el scroll infinito sin traer el
   * catálogo entero a memoria. Devuelve null si la DB no está poblada o la consulta
   * falla, para que el llamador caiga al filtrado en memoria de siempre.
   */
  static async discoverPaged(
    page: number,
    limit: number,
    type?: string,
    genre?: string
  ): Promise<{ items: MediaItem[]; total: number } | null> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const from = Math.max(0, (Math.max(1, page) - 1) * safeLimit);

    try {
      let query = supabase
        .from('media_items')
        .select('*', { count: 'exact' })
        .order('updated_at', { ascending: false })
        .range(from, from + safeLimit - 1);

      // El "ver todo" tampoco debe pasear fichas sin reproducción posible.
      query = this.soloPublicables(query, await this.hasAvailabilityColumn());

      if (type) query = query.eq('type', type);
      if (genre) query = query.contains('genres', [genre]);

      const { data, count, error } = await query;
      if (error || !data || data.length === 0) return null;

      return { items: data.map(this.mapDbItemToMediaItem), total: count ?? data.length };
    } catch {
      return null;
    }
  }

  /**
   * Obtiene todos los títulos del homepage en vivo enriquecidos con TMDB
   */
  static async getAll(): Promise<MediaItem[]> {
    // La versión evita reutilizar una lista anterior que todavía contenía títulos sin directo.
    const cacheKey = 'all_homepage:direct-only:v1';
    const cached = await CacheStore.get<MediaItem[]>(cacheKey);
    if (cached) return cached;

    // 0. DB-FIRST: catálogo pre-scrapeado en background (scripts/refreshCatalog.ts).
    //    Si Supabase tiene catálogo suficiente y fresco (< 24h), se sirve directo de la DB
    //    (1 query) en lugar de lanzar 4 scrapes en vivo por cold start.
    try {
      let query = supabase
        .from('media_items')
        .select(this.COLUMNAS_DE_TARJETA)
        .order('updated_at', { ascending: false })
        .limit(200);
      query = this.soloPublicables(query, await this.hasAvailabilityColumn());
      const { data } = await query;
      const filas = (data || []) as any[];
      if (filas.length >= 30) {
        const newest = Date.parse(filas[0].updated_at || '') || 0;
        const isFresh = Date.now() - newest < 24 * 60 * 60 * 1000;
        if (isFresh) {
          // La consulta ya trae solo `has_streams = true`; el filtro en memoria sobra y, sobre
          // una proyección de tarjeta (sin `servers`), además vaciaría la lista. Ver esReproducible.
          const dbItems = filas.map(this.mapDbItemToMediaItem);
          await CacheStore.set(cacheKey, dbItems, CACHE_TTL_SECONDS);
          return dbItems;
        }
      }
    } catch {}

    // 1. Scraping en vivo (fallback cuando la DB está vacía o desactualizada)
    const [homepageItems, latestMovies, latestSeries, latestAnimes] = await Promise.all([
      RealScraperService.scrapeHomepage(),
      RealScraperService.scrapeLatest('peliculas', 60),
      RealScraperService.scrapeLatest('series', 60),
      RealScraperService.scrapeLatest('animes', 60)
    ]);

    const liveItems = this.dedupeById([
      ...homepageItems,
      ...latestMovies,
      ...latestSeries,
      ...latestAnimes
    ]).filter(item => this.esReproducible(item));

    if (liveItems.length > 0) {
      const enrichedList: MediaItem[] = [];
      for (const item of liveItems) {
        enrichedList.push(await TmdbService.enrichMediaItem(item));
      }
      await CacheStore.set(cacheKey, enrichedList, CACHE_TTL_SECONDS);
      return enrichedList;
    }

    // 2. Último recurso: lo que haya en Supabase aunque esté desactualizado
    try {
      const { data } = await supabase.from('media_items').select('*').limit(50);
      if (data && data.length > 0) {
        const dbItems = data.map(this.mapDbItemToMediaItem);
        const enrichedList: MediaItem[] = [];
        for (const item of dbItems) {
          enrichedList.push(await TmdbService.enrichMediaItem(item));
        }
        await CacheStore.set(cacheKey, enrichedList, CACHE_TTL_SECONDS);
        return enrichedList;
      }
    } catch (err) {}

    return [];
  }

  /** Clave de caché estable para un id + pista de tipo. */
  private static cacheKeyFor(q: string, typeHint?: ContentType): string {
    return typeHint ? `${q}:${typeHint}` : q;
  }

  /**
   * Guarda un ítem bajo TODAS las formas de id con las que puede volver a pedirse
   * (id de la fuente, tmdb_id, con y sin tipo), para que la segunda visita sea gratis.
   */
  private static async cacheItem(prefix: 'meta' | 'byid', cacheKey: string, item: MediaItem, ttl: number): Promise<void> {
    const keys = new Set<string>([cacheKey, item.id, `${item.id}:${item.type}`]);
    if (item.tmdb_id) {
      keys.add(String(item.tmdb_id));
      keys.add(`${item.tmdb_id}:${item.type}`);
    }
    await Promise.all(Array.from(keys).filter(Boolean).map(k => CacheStore.set(`${prefix}:${k}`, item, ttl)));
  }

  /**
   * Retira una ficha del caché, por TODAS las claves con las que se guardó.
   *
   * Es la contrapartida de `cacheItem` y la tiene que llamar quien REPARE una fila: la metadata se
   * cachea 6 h y con Redis compartido las claves sobreviven a los despliegues, así que sin esto una
   * ficha corregida sigue sirviendo el póster, la sinopsis o los alias viejos durante horas — y el
   * arreglo parece no haber servido de nada.
   *
   * Se le pasa la fila TAL COMO ESTABA antes de arreglarla (id y tmdb_id viejos), que es con lo que
   * se construyeron las claves. Nunca lanza.
   */
  static async invalidateItem(item: { id?: string; tmdb_id?: number; type?: ContentType }): Promise<void> {
    await CacheStore.del(...this.cacheKeysFor(item));

    /**
     * Y SUS EPISODIOS, que se cachean por su cuenta bajo `ep:<id>:<temporada>:<episodio>`.
     *
     * `cacheKeysFor` no puede enumerarlos —no sabe cuántas temporadas ni cuántos capítulos hay—
     * así que se buscan por patrón. Sin esto, cualquier arreglo que afecte a episodios queda
     * INVISIBLE hasta que caduque su clave: al retirar el vídeo directo de vidhideplus, la ficha
     * ya salía corregida y el episodio seguía entregando el servidor viejo, rotulado "Vídeo
     * directo". Se persiguió como si fuera un despliegue que no subía.
     */
    if (!item.id) return;
    const claves = await CacheStore.keys(`ep:${item.id}:*`);
    if (claves.length) await CacheStore.del(...claves);
  }

  /**
   * UN REPRODUCTOR DE VERDAD DICE QUE NO SE VE: QUE DESAPAREZCA YA.
   *
   * La app manda `outcome: failed` cuando ha agotado TODAS las fuentes que le dimos —es el «Se
   * probaron todas las fuentes de este contenido» que ve el espectador—. No hay señal mejor en
   * todo el proyecto: un aparato real, con un reproductor real, acaba de demostrar que lo que
   * anunciamos no se ve.
   *
   * Hasta ahora eso solo purgaba el caché, y el título SEGUÍA ANUNCIÁNDOSE hasta que un barrido
   * de la nube pasara por él —hasta ocho horas—. Ese es el problema real que se reportó: no que
   * un enlace se muera (eso es inevitable), sino que siga ofreciéndose después de haberse muerto.
   *
   * LO QUE SE HACE ES REVOCAR EL SELLO, no marcar la ficha como muerta, y la diferencia es toda:
   *
   *   · `paraElCliente` solo publica servidores con un `verified_at` vigente. Sin sello, la ficha
   *     sale de los listados en cuanto se purga el caché — instantáneo, sin esperar a nadie.
   *   · No se borra nada: el `direct_stream` y el `embed_url` siguen ahí. `--verificar` recorre
   *     TODAS las filas (no solo las anunciadas) y sella lo que entregue, así que si esto era cosa
   *     de una wifi mala, la próxima pasada lo demuestra y el título vuelve solo.
   *   · Y no lo puede deshacer el barrido por accidente: `--sin-directo` recalcula el veredicto
   *     con `paraElCliente`, que exige el sello. Marcar `has_streams = false` a secas SÍ se
   *     habría revertido en la siguiente vuelta, porque los servidores seguían sellados.
   *
   * O sea: esconder es inmediato y barato; devolver exige prueba. Que es exactamente la regla de
   * la casa —retirar solo con prueba en contra, y todo lo que esconde catálogo tiene que saber
   * devolverlo— aplicada en el único punto del sistema que ve la verdad.
   */
  static async revocarSelloPorFalloDeReproduccion(id: string): Promise<boolean> {
    const { data } = await supabase
      .from('media_items').select('id,type,servers,seasons').eq('id', id).maybeSingle();
    if (!data) return false;

    const desellar = (s: any) => {
      if (!s || !s.verified_at) return s;
      const { verified_at, ...resto } = s;
      return resto;
    };
    const servers = Array.isArray((data as any).servers) ? (data as any).servers.map(desellar) : [];
    const seasons = Array.isArray((data as any).seasons)
      ? (data as any).seasons.map((t: any) => ({
          ...t,
          episodes: Array.isArray(t?.episodes)
            ? t.episodes.map((e: any) => ({
                ...e,
                servers: Array.isArray(e?.servers) ? e.servers.map(desellar) : e?.servers,
              }))
            : t?.episodes,
        }))
      : [];

    /**
     * El veredicto lo sigue decidiendo `veredictoDisponibilidad` sobre lo que queda, no este
     * sitio: sin sellos no hay nada publicable, así que dirá que no — pero se le pregunta a él
     * para no acabar con dos criterios distintos, que es como este proyecto se ha roto ya cinco
     * veces.
     */
    const veredicto = veredictoDisponibilidad(
      { type: (data as any).type, servers, seasons } as any, 'todo'
    );

    const update: Record<string, unknown> = { servers, seasons };
    if (seasons.length === 0) delete update.seasons;
    if (veredicto !== undefined) update.has_streams = veredicto;

    const escrito = await this.escribirFila(update, id, 'aviso de reproducción');
    // El caché de la ficha Y el de los listados: es en los listados donde se sigue viendo.
    await this.invalidateItem({ id });
    await this.invalidateListings();
    return escrito;
  }

  /**
   * Retira del caché las listas y las búsquedas, que son las que enseñan la ficha ANTES de que
   * nadie la abra.
   *
   * Invalidar la ficha no basta: sus datos viven además copiados dentro de los resultados de
   * búsqueda (`searchp:*`) y de los carruseles del home (`home:*`, `home_pool:*`, `all_homepage`).
   * Arreglar "Invencible" en la base y purgar su ficha dejaba la búsqueda enseñándola igual de
   * rota —sin póster y con id sintético—, que es por donde la ve quien usa la app.
   *
   * Se borran TODAS, no las que contengan la ficha: no hay forma de saber en qué consultas sale, y
   * reconstruirlas cuesta una lectura a la base. Son unas pocas claves.
   */
  static async invalidateListings(): Promise<void> {
    const prefijos = ['searchp:', 'home:', 'home_pool:', 'all_homepage'];
    const todas = await CacheStore.keys('*');
    const aBorrar = todas.filter(k => prefijos.some(p => k.startsWith(p)));
    if (aBorrar.length > 0) await CacheStore.del(...aBorrar);
  }

  /**
   * Todas las claves con las que una ficha puede estar cacheada. Se expone aparte de
   * `invalidateItem` para poder purgar MUCHAS fichas en pocas peticiones: cada `del` es una llamada
   * de red al Redis, y purgar el catálogo de una en una son decenas de miles de llamadas —suficiente
   * para agotar la cuota del plan gratuito—. Agrupando claves, el mismo trabajo cabe en un puñado.
   */
  static cacheKeysFor(item: { id?: string; tmdb_id?: number; type?: ContentType }): string[] {
    const bases = new Set<string>();
    for (const base of [item.id, item.tmdb_id ? String(item.tmdb_id) : '']) {
      if (!base) continue;
      bases.add(base);
      for (const t of ['movie', 'tvseries']) bases.add(`${base}:${t}`);
    }
    return Array.from(bases).flatMap(k => [`meta:${k}`, `byid:${k}`]);
  }

  /** ¿La ficha de la DB ya trae metadata utilizable, o hay que pasarla por TMDB? */
  private static isMetadataComplete(item: MediaItem): boolean {
    return Boolean(item.title && item.poster && item.overview && item.overview.length > 20);
  }

  /**
   * ¿Los enlaces persistidos siguen siendo válidos (menos de 24 h)?
   *
   * Además se descartan los resueltos ANTES de que existiera la extracción de vídeo directo:
   * sin esto, cualquier ficha ya guardada seguiría sirviendo solo embeds hasta que caducara
   * por su cuenta. Es una re-resolución única por título, no una invalidación permanente.
   */
  /**
   * Aplica a una ficha ya resuelta lo que se haya aprendido DESPUÉS de guardarla.
   *
   * Los dos caminos rápidos —ficha en caché y enlaces frescos de la DB— devuelven servidores con
   * el `status` que tenían al escribirlos, y entre medias puede haber pasado lo más informativo
   * que le ocurre a esta API: que alguien pulsara Reproducir y el CDN no tuviera el vídeo. Ese
   * 502 deja anotado el veredicto bajo el embed, y aquí se cobra — sin una sola petición de red,
   * porque estos caminos existen justamente para responder en milisegundos.
   *
   * No muta la ficha original: el caché entrega la MISMA referencia en cada acierto, y escribir
   * sobre ella dejaría el veredicto pegado a una entrada que nadie va a volver a revisar.
   */
  private static conSaludAlDia(item: MediaItem): MediaItem {
    if (!item.servers || item.servers.length === 0) return item;
    const revisados = aplicarVeredictosRecordados(item.servers);
    if (revisados === item.servers) return item;
    const servers = sortServersBySourcePriority(revisados);
    return { ...item, servers, primary_stream: getPrimaryStream(servers) };
  }

  /**
   * ¿Se puede entregar lo guardado sin volver a comprobar nada?
   *
   * ESTE ATAJO SE COMÍA TODAS LAS COMPROBACIONES. Bastaba con que los enlaces se hubieran escrito
   * hace menos de 24 h para devolverlos tal cual, sin sondear: se amplió el presupuesto de sondeo,
   * se hizo que se resellara al servir… y nada de eso llegaba a ejecutarse nunca, porque la ficha
   * salía por aquí. «Milagro en la Celda 7» seguía entregando su servidor muerto después de tres
   * arreglos seguidos, y los tres eran correctos: no se ejecutaba ninguno.
   *
   * La fecha de escritura dice cuándo se resolvió la lista, no si el vídeo sigue ahí. Lo segundo
   * lo dice el sello de cada servidor, y ahora se exige: si lo que se iba a entregar no está
   * sellado y vigente, se cae a la resolución completa, que sondea y resella.
   */
  private static hasFreshStreams(item: MediaItem): boolean {
    if (!item.servers || item.servers.length === 0) return false;
    if (!item.streams_updated_at) return false;
    const ts = Date.parse(item.streams_updated_at);
    if (!Number.isFinite(ts)) return false;
    if (ts < DIRECT_EXTRACTION_SINCE) return false;
    if (Date.now() - ts >= STREAMS_FRESH_MS) return false;
    // Y que haya ALTERNATIVAS, no solo uno: con un único servidor, un atasco no tiene salida y
    // el camino rápido impediría durante 24 h volver a buscar los demás. Ver `getEpisode`.
    return paraElCliente(item.servers).length >= 2 || this.hasEpisodeServers(item);
  }

  /**
   * ¿Tiene esta instancia permiso REAL para escribir en el catálogo?
   *
   * Se comprueba escribiendo: es la única forma. Un UPDATE bloqueado por RLS contesta 204 y sin
   * error, así que mirar si la variable de entorno está puesta no demuestra nada — podría estar y
   * ser la clave equivocada. Se toca una sola fila y con un valor que ya tenía (`id`), de modo que
   * la prueba no cambia nada aunque salga bien.
   */
  static async puedeEscribirCatalogo(): Promise<boolean> {
    try {
      const { data } = await supabase.from('media_items').select('id').limit(1);
      const id = (data || [])[0]?.id;
      if (!id) return false;
      const { data: tocadas, error } = await getSupabaseAdmin()
        .from('media_items')
        .update({ id })
        .eq('id', id)
        .select('id');
      return !error && Array.isArray(tocadas) && tocadas.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * FUENTE PROPIA: una ficha añadida a mano desde el panel.
   *
   * Es la fuente más fiable que puede tener este catálogo, y por eso existe: todo lo demás
   * depende de que una web ajena siga viva, siga publicando y no cambie su plantilla. Aquí la url
   * la pone una persona y no se va a caer porque a alguien le dé por rediseñar su reproductor.
   *
   * LA METADATA VIENE ENTERA DE TMDB, que es la regla de toda la casa (FUENTES.md §1): nada
   * adopta la identidad de otra cosa sin respaldo. Quien añade elige un título CONCRETO de TMDB
   * —con su año y su carátula delante—, así que la identidad está resuelta antes de empezar y no
   * hay matcher que pueda equivocarse.
   *
   * LAS URLS SE COMPRUEBAN ANTES DE GUARDARLAS. Si no entregan vídeo no se guardan, igual que en
   * el crawl: en esta base no entra nada que no reproduzca, venga de donde venga. Se devuelve
   * cuáles pasaron y cuáles no, para que quien las pegó lo vea.
   */
  static async anadirFichaManual(opts: {
    tmdbId: number;
    tipo: ContentType;
    urls: string[];
    /**
     * Urls por CAPÍTULO, para las series. Una serie no se reproduce por la ficha: se reproduce
     * capítulo a capítulo, así que pedir «las urls de la serie» no significa nada — hay que poder
     * decir cuál es la del 1x01 y cuál la del 1x02.
     */
    episodios?: Array<{ season: number; episode: number; urls: string[] }>;
  }): Promise<{
    ok: boolean; id?: string; titulo?: string;
    aceptadas: string[]; rechazadas: string[]; capitulos_ok?: number; error?: string;
  }> {
    /**
     * Se normaliza ANTES de comprobar, para que lo que se prueba sea lo que se guarda.
     *
     * `canonicalArchiveOrg` cambia el enlace del nodo que archive.org enseña en su web por su
     * forma canónica. No es cosmético: pegando el del nodo, el verificador del crawl recibe un
     * 500 de ese nodo y da el fichero por muerto teniéndolo vivo. Ver esa función.
     */
    const limpiar = (lista: string[]) =>
      Array.from(new Set(lista.map(u => canonicalArchiveOrg(u.trim())).filter(Boolean)));
    const urls = limpiar(opts.urls);
    const porCapitulo = (opts.episodios || [])
      .map(e => ({ ...e, urls: limpiar(e.urls) }))
      .filter(e => e.urls.length);
    if (!urls.length && !porCapitulo.length) {
      return { ok: false, aceptadas: [], rechazadas: [], error: 'No se pasó ninguna url' };
    }

    const detalle = await TmdbService.getTmdbDetails(opts.tmdbId, opts.tipo);
    if (!detalle) return { ok: false, aceptadas: [], rechazadas: urls, error: `TMDB no conoce el ${opts.tipo} ${opts.tmdbId}` };

    // Cada url se prueba de verdad: 64 KB bastan para ver la cabecera del contenedor.
    const aceptadas: string[] = [];
    const rechazadas: string[] = [];
    const comprobar = async (lista: string[]): Promise<string[]> => {
      const buenas: string[] = [];
      await Promise.all(lista.map(async url => {
        try {
          const r = await httpClient.get(url, {
            headers: { Range: 'bytes=0-65535' },
            responseType: 'arraybuffer',
            timeout: 25000,
            validateStatus: () => true,
            maxRedirects: 5,
          } as any);
          const bytes = (r.data as ArrayBuffer)?.byteLength ?? 0;
          const esHtml = /text\/html/i.test(String(r.headers['content-type'] || ''));
          if (r.status < 400 && !esHtml && bytes > 8192) { buenas.push(url); aceptadas.push(url); }
          else rechazadas.push(url);
        } catch {
          rechazadas.push(url);
        }
      }));
      return buenas;
    };

    const buenasDeLaFicha = await comprobar(urls);
    const capitulosBuenos: Array<{ season: number; episode: number; urls: string[] }> = [];
    for (const cap of porCapitulo) {
      const buenas = await comprobar(cap.urls);
      if (buenas.length) capitulosBuenos.push({ season: cap.season, episode: cap.episode, urls: buenas });
    }

    if (!buenasDeLaFicha.length && !capitulosBuenos.length) {
      return { ok: false, aceptadas, rechazadas, error: 'Ninguna url entregó vídeo' };
    }

    const titulo = detalle.title || detalle.name || `TMDB ${opts.tmdbId}`;
    const fecha = String(detalle.release_date || detalle.first_air_date || '');
    // El id lleva el año: dos obras del mismo nombre no pueden pisarse (FUENTES.md §1).
    const id = `manual-${slugify(titulo)}${fecha ? '-' + fecha.slice(0, 4) : ''}`;

    const servers = buenasDeLaFicha.map((url, i) => ({
      id: `${id}_manual_${i}`,
      name: `Manual ${i + 1}`,
      embed_url: url,
      direct_stream: url,
      direct_mode: 'public' as const,
      direct_kind: /\.m3u8(\?|$)/i.test(url) ? ('hls' as const) : ('mp4' as const),
      status: 'online' as const,
      source_id: 'manual',
      verified_at: new Date().toISOString(),
    }));

    const fila: Record<string, unknown> = {
      id,
      tmdb_id: opts.tmdbId,
      type: opts.tipo,
      title: titulo,
      original_title: detalle.original_title || detalle.original_name || titulo,
      overview: detalle.overview || '',
      release_date: fecha,
      rating: detalle.vote_average || 0,
      genres: (detalle.genres || []).map((g: any) => g.name),
      poster: detalle.poster_path ? `https://image.tmdb.org/t/p/w500${detalle.poster_path}` : null,
      backdrop: detalle.backdrop_path ? `https://image.tmdb.org/t/p/original${detalle.backdrop_path}` : null,
      runtime: detalle.runtime ?? null,
      metadata_source: 'tmdb',
      servers,
      /**
       * Los capítulos se agrupan por temporada. Cada uno lleva SUS urls: en una serie el vídeo
       * vive aquí, no en `servers`, y confundirlo es lo que hacía que una serie se anunciara
       * entera por lo que traía su portada (FUENTES.md §4).
       */
      seasons: Object.values(
        capitulosBuenos.reduce((acc: Record<number, any>, cap) => {
          acc[cap.season] ??= { season_number: cap.season, episodes: [] };
          acc[cap.season].episodes.push({
            episode_number: cap.episode,
            season_number: cap.season,
            servers: cap.urls.map((url, i) => ({
              id: `${id}_s${cap.season}e${cap.episode}_manual_${i}`,
              name: `Manual ${i + 1}`,
              embed_url: url,
              direct_stream: url,
              direct_mode: 'public' as const,
              direct_kind: /\.m3u8(\?|$)/i.test(url) ? ('hls' as const) : ('mp4' as const),
              status: 'online' as const,
              source_id: 'manual',
              verified_at: new Date().toISOString(),
            })),
          });
          return acc;
        }, {})
      ),
      has_streams: true,
      source_url: null,
      source_urls: [],
      streams_updated_at: new Date().toISOString(),
      streams_checked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      title_normalized: searchIndexKey(titulo, detalle.original_title || detalle.original_name || titulo, []),
    };

    const { error } = await getSupabaseAdmin().from('media_items').upsert(fila, { onConflict: 'id' });
    if (error) return { ok: false, aceptadas, rechazadas, error: error.message };

    await this.invalidateItem({ id });
    await this.invalidateListings();
    return { ok: true, id, titulo, aceptadas, rechazadas, capitulos_ok: capitulosBuenos.length };
  }

  /**
   * EL CATÁLOGO COMO UNA HOJA DE CÁLCULO, para el panel.
   *
   * Una fila por título con lo único que hace falta para juzgarlo de un vistazo: qué es, de qué
   * web salió, y TODAS sus urls directas — la primera es la que se entrega para reproducir y las
   * demás son el respaldo que la app usa si esa falla.
   *
   * Se pagina y se filtra en Postgres, no en memoria: la tabla puede tener miles de filas y el
   * panel pide cincuenta.
   */
  static async contenidoParaPanel(opts: {
    tipo?: 'movie' | 'tvseries';
    q?: string;
    /** Solo los títulos que traen algún enlace de esta fuente. Vacío = todas. */
    fuente?: string;
    pagina?: number;
    porPagina?: number;
  } = {}): Promise<{ total: number; pagina: number; filas: Array<Record<string, unknown>> }> {
    const porPagina = Math.min(Math.max(opts.porPagina ?? 50, 1), 200);
    const pagina = Math.max(opts.pagina ?? 1, 1);
    const desde = (pagina - 1) * porPagina;

    let q = supabase
      .from('media_items')
      .select('id,title,type,release_date,servers,seasons', { count: 'exact' })
      .order('title');
    if (opts.tipo) q = q.eq('type', opts.tipo);
    if (opts.q) q = q.ilike('title', `%${opts.q}%`);

    const { data, count, error } = await q.range(desde, desde + porPagina - 1);
    if (error) return { total: 0, pagina, filas: [] };

    /**
     * De qué web salió un enlace.
     *
     * LA URL MANDA SOBRE EL `source_id` GUARDADO cuando las dos hablan, y no al revés. Parece lo
     * contrario de lo razonable —el crawl sabe de qué página sacó el enlace— hasta que se mira
     * qué pasa cuando el crawl se equivocó: las primeras fichas de archive.org se guardaron
     * rotuladas «tioplus», porque `fuenteDeLaUrl` no conocía ese host y su `return` final es ese.
     * Quedaron mal etiquetadas para siempre, y el panel las enseñaba mal.
     *
     * Un `archive.org/download/…` es de archive.org, lo diga la etiqueta o no. Reconocer el host
     * arregla lo ya guardado sin tener que reescribir la base, y de paso hace que un fallo así
     * no vuelva a fosilizarse.
     */
    const fuenteDe = (sv: any): string => {
      // Lo puesto a mano se queda como manual: `manual` no dice dónde vive el fichero, dice que
      // lo puso una persona, y eso es lo que le da la prioridad 1.
      if (String(sv?.source_id || '').toLowerCase() === 'manual') return 'manual';
      const u = String(sv?.direct_stream || sv?.embed_url || '');
      if (/archive\.org/i.test(u)) return 'archive';
      if (/cinecalidad/i.test(u)) return 'cinecalidad';
      if (/fuegocine|blogfc|repfuegocinefree/i.test(u)) return 'fuegocine';
      const id = String(sv?.source_id || '').toLowerCase();
      if (id) return id;
      return 'tioplus';
    };

    const filtroFuente = String(opts.fuente || '').toLowerCase();

    const filas = (data || []).map((r: any) => {
      const deLaFicha: any[] = Array.isArray(r.servers) ? r.servers : [];
      const deCapitulos: any[] = (Array.isArray(r.seasons) ? r.seasons : [])
        .flatMap((t: any) => Array.isArray(t?.episodes) ? t.episodes : [])
        .flatMap((e: any) => Array.isArray(e?.servers) ? e.servers : []);
      // Ya vienen ordenadas de mejor a peor por el crawl; aquí no se reordena nada.
      const publicables = [...deLaFicha, ...deCapitulos].filter(sv => sv?.direct_stream);
      return {
        id: r.id,
        titulo: r.title,
        tipo: r.type === 'tvseries' ? 'Serie' : 'Película',
        anio: String(r.release_date || '').slice(0, 4),
        fuentes: Array.from(new Set(publicables.map(fuenteDe))),
        urls: publicables.map(sv => sv.direct_stream),
        // Cuántas de esas urls son de capítulos: en una serie el vídeo vive ahí.
        de_capitulos: deCapitulos.filter(sv => sv?.direct_stream).length,
      };
    });

    /**
     * EL FILTRO POR FUENTE SE APLICA AQUÍ Y NO EN POSTGRES, y conviene saber por qué.
     *
     * La fuente de un enlace no es una columna: sale de mirar cada objeto del array `servers`
     * —su `source_id` o su url—. Filtrar eso en la consulta pediría recorrer el JSON en SQL, y
     * además daría un `count` que no cuadra con lo que se puede paginar.
     *
     * El precio es que el total y las páginas siguen siendo los del filtro de tipo y título, así
     * que una página puede salir con menos filas de las pedidas. Se dice en el panel en vez de
     * disimularlo: es más honesto que inventar una paginación que no existe.
     */
    const visibles = filtroFuente
      ? filas.filter((f: any) => (f.fuentes as string[]).includes(filtroFuente))
      : filas;

    return { total: count ?? filas.length, pagina, filas: visibles };
  }

  /**
   * EL ESTADO DEL CATÁLOGO EN NÚMEROS, para el panel.
   *
   * Todo lo que este proyecto ha ido descubriendo a base de correr scripts a mano —cuánto se
   * anuncia de verdad, qué escalón lo está tapando, cuánto queda sin abrir— no se veía desde
   * ninguna parte. Y eso importa aquí más que en otros sitios: el catálogo ENCOGE cuando un
   * barrido se cae (es la regla de la casa, más corto y cierto antes que largo y falso), así que
   * la salud de los trabajos se lee en el tamaño de lo anunciable. Sin un sitio donde mirarlo,
   * la única señal es que la app se vea vacía.
   *
   * SOLO CUENTA FILAS, NUNCA LAS TRAE. Cada número es un `count` con `head: true`, así que
   * Postgres no manda ni una fila. Es deliberado: la tentación es calcular aquí la cola de
   * extracción, pero eso exige abrir el JSON de `servers` de 15.000 filas —23 MB— y convertiría
   * abrir el panel en la consulta más cara de la API. Ese número vive en
   * `scripts/dev/diag_extraible.ts`, que puede permitirse tardar.
   *
   * La ÚLTIMA ACTIVIDAD de cada trabajo se deduce de su propia huella en la base y no de la API
   * de GitHub: `updated_at` lo escribe el crawl, `streams_updated_at` la extracción y
   * `streams_checked_at` la verificación. Así no hace falta ninguna credencial nueva, y además
   * mide lo que de verdad importa —cuándo escribió algo por última vez— y no si la tarea arrancó.
   */
  static async estadoDelCatalogo(): Promise<Record<string, unknown>> {
    const cacheKey = 'panel:estado';
    const cached = await CacheStore.get<Record<string, unknown>>(cacheKey);
    if (cached) return cached;

    const cuantas = async (aplicar: (q: any) => any): Promise<number> => {
      try {
        const { count, error } = await aplicar(
          supabase.from('media_items').select('id', { count: 'exact', head: true })
        );
        return error ? -1 : (count ?? 0);
      } catch {
        return -1;
      }
    };

    const masReciente = async (columna: string): Promise<string | null> => {
      try {
        const { data } = await supabase
          .from('media_items').select(columna)
          .not(columna, 'is', null)
          .order(columna, { ascending: false }).limit(1);
        return ((data || [])[0] as any)?.[columna] ?? null;
      } catch {
        return null;
      }
    };

    const desde = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
    const vigente = new Date(Date.now() - VERIFICADO_VIGENTE_MS).toISOString();

    /**
     * EN TANDAS DE CUATRO, NO LAS DIECISIETE A LA VEZ.
     *
     * La primera versión hacía un `Promise.all` con todas y CUATRO volvían vacías —siempre
     * distintas—, así que el panel enseñaba «-1» en la mitad de los números sin dar ningún error.
     * Sueltas, las mismas consultas tardan 200-600 ms y aciertan: no era la consulta, era
     * dispararlas todas contra PostgREST a la vez.
     *
     * Con el resultado cacheado un minuto, ir por tandas no cuesta nada — y un número correcto
     * dos segundos más tarde vale infinitamente más que un «-1» inmediato, que es justo la clase
     * de dato falso que ha hecho perder tardes en este proyecto.
     */
    const enTandas = async <T>(tareas: Array<() => Promise<T>>, tanda = 4): Promise<T[]> => {
      const salida: T[] = [];
      for (let i = 0; i < tareas.length; i += tanda) {
        salida.push(...await Promise.all(tareas.slice(i, i + tanda).map(f => f())));
      }
      return salida;
    };

    const [
      total, peliculas, series,
      conPoster, reproducible, sinEnlaces, sinComprobar,
      selloVigente, sello24h, nuncaResueltas, conServidoresSinAnunciar,
      anunciables,
      reproducibleConPoster,
      // Las fuentes se reconocen por el molde del id, que ES el slug de su página (FUENTES.md §2.3).
      deFuegocine, deCinecalidad,
      ultimaHora, ultimas24h,
    ] = await enTandas<number>([
      () => cuantas(q => q),
      () => cuantas(q => q.eq('type', 'movie')),
      () => cuantas(q => q.eq('type', 'tvseries')),
      () => cuantas(q => q.not('poster', 'is', null)),
      () => cuantas(q => q.eq('has_streams', true)),
      () => cuantas(q => q.eq('has_streams', false)),
      () => cuantas(q => q.is('has_streams', null)),
      () => cuantas(q => q.gt('streams_checked_at', vigente)),
      () => cuantas(q => q.gt('streams_checked_at', desde(24))),
      () => cuantas(q => q.is('streams_updated_at', null)),
      () => cuantas(q => q.eq('has_streams', false).neq('servers', '[]')),
      () => cuantas(q => q.eq('has_streams', true).not('poster', 'is', null).gt('streams_checked_at', vigente)),
      // El escalón de en medio. Sin él, el panel enseñaba «reproducible» y «lo que ve la app»
      // como si fueran cosas distintas cuando uno es subconjunto del otro, y no se veía cuál de
      // las dos exigencias que faltan —carátula o sello— está dejando fuera a cada ficha.
      () => cuantas(q => q.eq('has_streams', true).not('poster', 'is', null)),
      () => cuantas(q => q.or('id.like.fc-%,id.like.2%-%-%')),
      () => cuantas(q => q.like('id', 'ver-%')),
      // EL RITMO. Con la base recién vaciada, «última actividad» dice «nunca» y no informa de
      // nada: lo que prueba que el crawl está trabajando es que entren fichas, no que haya
      // escrito alguna vez. `updated_at` se pone al escribir, así que contarlo por ventanas es
      // el avance en vivo — y como solo se escribe lo que reproduce, cada una es contenido bueno.
      () => cuantas(q => q.gt('updated_at', desde(1))),
      () => cuantas(q => q.gt('updated_at', desde(24))),
    ]);

    const [crawl, extraccion, verificacion] = await enTandas<string | null>([
      () => masReciente('updated_at'),
      () => masReciente('streams_updated_at'),
      () => masReciente('streams_checked_at'),
    ]);

    const pct = (a: number, b: number) => (b > 0 && a >= 0 ? Number(((a / b) * 100).toFixed(1)) : null);

    /**
     * CUÁNTAS URLS HAY Y CÓMO ESTÁN REPARTIDAS.
     *
     * Con el modelo nuevo los «escalones» de antes —sello vigente, has_streams, póster— ya no
     * describen nada: en la base solo entra lo que tiene una url directa comprobada, así que
     * TODO lo que hay reproduce por construcción. Lo que importa ahora es otra cosa: cuántos
     * enlaces tiene cada título y cuántos son respaldo, porque de eso depende que la app pueda
     * recuperarse sola cuando uno se cae.
     *
     * Se recorre el JSON de `servers`, que es caro — pero este catálogo es pequeño A PROPÓSITO
     * (esa es toda la idea), así que aquí sí se puede pagar. Si algún día creciera mucho, este
     * es el número que habría que mover a una columna.
     */
    let urlsTotales = 0, conRespaldo = 0, conUna = 0;
    const porFuente: Record<string, number> = {};
    try {
      let ultimo = '';
      for (let vuelta = 0; vuelta < 40; vuelta++) {
        const { data } = await supabase.from('media_items')
          .select('id,servers,seasons').gt('id', ultimo).order('id').limit(500);
        if (!data?.length) break;
        ultimo = (data[data.length - 1] as any).id;
        for (const r of data as any[]) {
          const enlaces = [
            ...(Array.isArray(r.servers) ? r.servers : []),
            ...(Array.isArray(r.seasons) ? r.seasons : [])
              .flatMap((t: any) => Array.isArray(t?.episodes) ? t.episodes : [])
              .flatMap((e: any) => Array.isArray(e?.servers) ? e.servers : []),
          ].filter((sv: any) => sv?.direct_stream);
          if (!enlaces.length) continue;
          urlsTotales += enlaces.length;
          if (enlaces.length > 1) conRespaldo++; else conUna++;
          for (const sv of enlaces) {
            const f = String(sv?.source_id || 'sin anotar').toLowerCase();
            porFuente[f] = (porFuente[f] || 0) + 1;
          }
        }
        if (data.length < 500) break;
      }
    } catch { /* si falla, el panel enseña el resto igual */ }

    const estado = {
      catalogo: { total, peliculas, series, anunciables, anunciables_pct: pct(anunciables, total) },
      /**
       * Los enlaces, que es lo que ahora define la salud del catálogo: uno solo significa que si
       * ese se cae no hay a dónde ir; varios son la red de seguridad de la app.
       */
      enlaces: {
        urls_totales: urlsTotales,
        media_por_titulo: total > 0 ? Number((urlsTotales / Math.max(total, 1)).toFixed(2)) : 0,
        con_respaldo: conRespaldo,
        con_uno_solo: conUna,
        por_fuente: porFuente,
      },
      fuentes: {
        cinecalidad: deCinecalidad,
        fuegocine: deFuegocine,
        tioplus: total >= 0 && deFuegocine >= 0 && deCinecalidad >= 0 ? total - deFuegocine - deCinecalidad : -1,
      },
      ultima_actividad: { crawl, extraccion, verificacion },
      ritmo: { ultima_hora: ultimaHora, ultimas_24h: ultimas24h },
      /**
       * Qué está haciendo el crawl AHORA. Lo deja él mismo en Redis cada pocos cientos de
       * títulos, porque su avance no se puede deducir de la base: recolecta, enriquece y
       * comprueba durante horas y solo escribe al final. Sin esto, «cero filas» es
       * indistinguible de «no hay nadie trabajando». Caduca a los 20 min: si el trabajo muere,
       * el panel deja de decir que hay algo en marcha.
       */
      crawl_en_marcha: await CacheStore.get<Record<string, unknown>>('crawl:latido'),
      cadencia: {
        crawl: { cada_horas: 24, workflow: 'scraper.yml', tarda_horas: 3 },
        extraccion: { cada_horas: 8, workflow: 'reproducible.yml', tarda_horas: 2 },
        verificacion: { cada_horas: 2, workflow: 'verificar.yml', tarda_horas: 1.5 },
      },
      medido_en: new Date().toISOString(),
    };

    // Un minuto: bastante para que recargar el panel no cueste quince consultas, y poco para que
    // el número que se mira mientras corre un barrido no se quede viejo delante de los ojos.
    await CacheStore.set(cacheKey, estado, 60);
    return estado;
  }

  /**
   * ESCRIBE EN LA FILA Y COMPRUEBA QUE DE VERDAD SE HA ESCRITO.
   *
   * Un UPDATE de PostgREST contra una fila que RLS no deja tocar NO da error: contesta 204 y sin
   * `error`, porque desde su punto de vista la consulta fue perfecta — simplemente no había
   * ninguna fila que casara. Medido contra esta misma base con la clave anónima: `204 sin error`,
   * y la fila intacta.
   *
   * Ese detalle es el que dejó al catálogo sin poder corregirse durante quién sabe cuánto. La API
   * en producción no tiene `SUPABASE_SERVICE_ROLE_KEY` —solo la tienen los trabajos de GitHub—,
   * así que `getSupabaseAdmin()` degrada a la clave anónima y TODAS las escrituras del camino de
   * petición eran un no-op silencioso: los enlaces resueltos, los sellos de los capítulos y los
   * veredictos de disponibilidad. El código creía que había escrito. Nadie podía enterarse.
   *
   * Pedir `select('id')` obliga a PostgREST a devolver las filas que ha tocado. Cero filas
   * significa que no se escribió, y eso ya se puede decir en voz alta.
   */
  private static async escribirFila(update: Record<string, unknown>, id: string, etiqueta: string): Promise<boolean> {
    try {
      const { data, error } = await getSupabaseAdmin()
        .from('media_items')
        .update(update)
        .eq('id', id)
        .select('id');
      if (error) {
        console.warn(`[persist] ${etiqueta} ${id}: ${error.message}${error.code ? ` (${error.code})` : ''}`);
        return false;
      }
      if (!data || data.length === 0) {
        console.warn(`[persist] ${etiqueta} ${id}: 0 filas escritas — sin permiso de escritura (¿falta SUPABASE_SERVICE_ROLE_KEY?)`);
        return false;
      }
      return true;
    } catch (e) {
      console.warn(`[persist] ${etiqueta} ${id}: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  /**
   * ESCRIBE EL VEREDICTO, Y SI ES EL QUE ESCONDE LA FICHA, ESPERA A QUE LLEGUE.
   *
   * `persistStreams` iba siempre lanzado y olvidado, y sobre Vercel eso significa muchas veces
   * NUNCA: la función se congela en cuanto contesta, así que un UPDATE que aún no había salido se
   * queda a medias y no se escribe jamás. No es una sospecha — está medido y documentado en este
   * mismo archivo, en `getEpisode`: por eso los capítulos pasaron a esperar su escritura, y por eso
   * `--episodios` veía los mismos 90.000 pendientes corrida tras corrida.
   *
   * Aquí muerde exactamente igual, y en el peor sitio: la petición sondea la lista entera, se queda
   * sin nada que entregar, concluye que la ficha no se puede anunciar… y ese `has_streams = false`
   * se evapora con la lambda. El título vuelve a la portada como si nada, y el siguiente que lo
   * abra repite la misma comprobación para volver a perderla.
   *
   * Así que se distingue por lo que hay en juego, no por comodidad:
   *
   *   · queda algo que entregar → el write-through es un ADELANTO para la próxima apertura, y
   *     perderlo solo cuesta repetir trabajo. Se lanza y se olvida, como estaba.
   *   · no queda nada          → esa escritura es lo ÚNICO que saca el título de los listados.
   *     Se espera. Son ~150 ms al final de una respuesta que acaba de gastar varios segundos
   *     sondeando, y sin ellos todo lo demás es decorativo.
   */
  private static async guardarEnlaces(item: MediaItem, verified: boolean, seMiroAlgo: boolean): Promise<void> {
    const hayQueEntregar = paraElCliente(item.servers).length > 0 || this.hasEpisodeServers(item);
    if (hayQueEntregar) {
      void this.persistStreams(item, verified, seMiroAlgo).catch(() => {});
      return;
    }
    await this.persistStreams(item, verified, seMiroAlgo).catch(() => {});
  }

  /**
   * FICHAS RETIRADAS EN CALIENTE: lo que la última petición demostró que ya no se puede entregar.
   *
   * `has_streams = false` saca un título de los listados… la próxima vez que se construyan. Y los
   * listados son justo lo más cacheado que hay aquí: la portada se sirve hasta 12 h (se entrega
   * caducada a propósito, para que nadie espere a reconstruirla) y las búsquedas y el «ver todo»,
   * una hora. O sea que retirar una película en la base de datos no impide que la portada la siga
   * enseñando durante media jornada — que es exactamente lo que el espectador ve.
   *
   * Purgar los listados en cada retirada tampoco vale: reconstruir la portada cuesta segundos y se
   * dispararía con cada título que se cae, en cadena y en hora punta.
   *
   * Así que se anota el id en un conjunto compartido y los listados lo descuentan AL SERVIR. Es
   * una lectura de Redis por instancia y por minuto —el conjunto es corto y se recuerda en el
   * proceso—, y funciona sobre cualquier lista ya construida, esté donde esté cacheada.
   *
   * Se cae solo: cada alta refresca el TTL del conjunto, y en cuanto un título vuelve a entregar
   * vídeo, el mismo sitio que escribe el veredicto lo da de baja. Nada queda escondido para
   * siempre por una tarde mala de un host.
   */
  private static readonly CLAVE_RETIRADOS = 'retirados:v1';

  /** Cuánto vive el conjunto sin que nadie lo toque. Por debajo del barrido, que decide de verdad. */
  private static readonly RETIRADOS_TTL_SECONDS = 3 * 60 * 60;

  /**
   * Copia en el proceso, para no preguntarle a Redis en cada petición de la portada.
   *
   * Un minuto: lo que se retira empieza a esconderse en menos de eso, y a cambio la lista de
   * carruseles no paga un viaje de red por servirse.
   */
  private static retiradosMemo: { ids: Set<string>; expira: number } = { ids: new Set(), expira: 0 };
  private static readonly RETIRADOS_MEMO_MS = 60_000;

  /** Los ids que ahora mismo no se anuncian aunque su fila todavía diga que sí. */
  static async retirados(): Promise<Set<string>> {
    if (Date.now() < this.retiradosMemo.expira) return this.retiradosMemo.ids;
    try {
      const ids = new Set(await CacheStore.readSet(this.CLAVE_RETIRADOS));
      this.retiradosMemo = { ids, expira: Date.now() + this.RETIRADOS_MEMO_MS };
      return ids;
    } catch {
      // Sin Redis no se esconde nada: el filtro de la base de datos sigue en pie.
      return this.retiradosMemo.ids;
    }
  }

  /**
   * Deja constancia de lo que se acaba de aprender sobre una ficha, en los dos sentidos.
   *
   * Además del conjunto se purga su propia entrada de caché: la ficha se guarda 6 h como metadata
   * y 1 h como enlaces, así que sin esto el detalle seguiría anunciando `streams.status: "ready"`
   * sobre una lista que ya sabemos vacía.
   */
  private static async anotarDisponibilidad(item: MediaItem, disponible: boolean): Promise<void> {
    if (!item.id) return;
    try {
      if (disponible) {
        await CacheStore.removeFromSet(this.CLAVE_RETIRADOS, item.id);
        this.retiradosMemo.ids.delete(item.id);
        return;
      }
      await CacheStore.addToSet(this.CLAVE_RETIRADOS, item.id, this.RETIRADOS_TTL_SECONDS);
      this.retiradosMemo.ids.add(item.id);
      await CacheStore.del(...this.cacheKeysFor(item));
    } catch {}
  }

  /** Descuenta de una lista ya construida lo que se ha retirado desde que se construyó. */
  static async sinRetirados<T extends { id?: string }>(items: T[]): Promise<T[]> {
    if (!items || items.length === 0) return items || [];
    const fuera = await this.retirados();
    if (fuera.size === 0) return items;
    return items.filter(i => !i?.id || !fuera.has(i.id));
  }

  /**
   * Escribe de vuelta en Supabase los enlaces recién resueltos (write-through). Se llama en
   * fire-and-forget: NUNCA debe retrasar ni tumbar la respuesta. Si la migración 004 aún no
   * se ejecutó, el update falla en silencio y todo sigue funcionando desde el caché.
   *
   * `verified` marca que la resolución fue EXHAUSTIVA (fusión multifuente incluida), lo
   * único que autoriza a anotar un veredicto de disponibilidad: que un camino barato no
   * encuentre enlaces no significa que la ficha sea un fantasma.
   */
  private static async persistStreams(item: MediaItem, verified: boolean = false, seMiroAlgo: boolean = true): Promise<void> {
    if (!item.id) return;

    const update: Record<string, unknown> = {
      servers: item.servers || [],
      seasons: item.seasons || [],
      source_url: item._source_url || null,
      streams_updated_at: new Date().toISOString()
    };
    /**
     * El veredicto lo decide `veredictoDisponibilidad`, no este sitio. `verified` dice si la
     * resolución fue exhaustiva —o sea, cuánto derecho hay a concluir— y eso es lo único que
     * aporta aquí. `undefined` significa «no se sabe»: la columna no se toca.
     */
    const veredicto = veredictoDisponibilidad(item as any, !seMiroAlgo ? 'nada' : verified ? 'todo' : 'parcial');
    if (veredicto !== undefined) {
      update.has_streams = veredicto;
      update.streams_checked_at = new Date().toISOString();
      // Y que se note YA, sin esperar a que caduquen los listados cacheados. Ver `anotarDisponibilidad`.
      await this.anotarDisponibilidad(item, veredicto);
    } else {
      /**
       * NO PODER CONCLUIR NO ES MOTIVO PARA SEGUIR ANUNCIÁNDOLA.
       *
       * Aquí estaba el resto de los títulos que salen en la app y no reproducen. `veredicto`
       * queda en `undefined` cuando la resolución fue PARCIAL —el presupuesto de 9 s se agota
       * antes de mirarlo todo, que es lo normal cuando los servidores están muertos y tardan en
       * fallar—, y entonces no se tocaba nada: ni la columna, ni el conjunto de retirados. La
       * ficha seguía en el home y en la búsqueda, y quien la abría se comía el «se probaron todas
       * las fuentes».
       *
       * Y son dos cosas distintas que aquí se confundían:
       *
       *   · el VEREDICTO («esta ficha no tiene nada») es una afirmación sobre su salud, y para eso
       *     sí hace falta haberlo mirado todo. Se sigue sin tocar.
       *   · el conjunto de RETIRADOS es una afirmación sobre AHORA MISMO: «no tengo nada que
       *     entregar de esto en este instante». Eso no necesita exhaustividad ninguna — lo acabo
       *     de comprobar intentándolo.
       *
       * Es además la única vía que se salta el caché: los listados descuentan este conjunto AL
       * SERVIR, así que el título desaparece del home y de la búsqueda al momento, sin esperar a
       * que caduque una lista de hace una hora ni a que pase un barrido de la nube.
       *
       * Se cae solo: el conjunto caduca a las 3 h y, en cuanto la ficha vuelva a entregar algo,
       * este mismo sitio la da de baja por la rama de arriba. Esconder es inmediato; devolver
       * exige prueba.
       */
      await this.anotarDisponibilidad(item, fichaReproducible(item as any));
    }
    if (item._source_urls && item._source_urls.length > 0) {
      update.source_urls = item._source_urls;
    }

    if (await this.escribirFila(update, item.id, 'enlaces')) return;

    // Sin la migración 005 las columnas nuevas no existen y el update entero se rechaza:
    // se reintenta con el conjunto de campos de la 004 para no perder los enlaces.
    delete update.has_streams;
    delete update.streams_checked_at;
    delete update.source_urls;
    await this.escribirFila(update, item.id, 'enlaces (reintento 004)');
  }

  /** ¿Algún episodio de la serie tiene enlaces propios? (una serie se reproduce por episodio). */
  private static hasEpisodeServers(item: MediaItem): boolean {
    return (item.seasons || []).some(season =>
      (season.episodes || []).some(ep => paraElCliente(ep.servers).length > 0)
    );
  }

  /** Delega en la única fuente de verdad. Ver `fichaReproducible` en streamSorter. */
  private static hasPlayableDirectStream(item: Pick<MediaItem, 'servers' | 'seasons' | 'type'>): boolean {
    return fichaReproducible(item as any);
  }

  /**
   * ¿Este ítem se puede reproducir? Igual que arriba, pero VÁLIDO TAMBIÉN cuando la fila no trae
   * los servidores.
   *
   * Hace falta porque `COLUMNAS_DE_TARJETA` no selecciona `servers` ni `seasons` —es justo la
   * optimización que evita traerse 23 MB para pintar el home—, así que sobre una fila de tarjeta
   * `hasPlayableDirectStream` no puede dar true JAMÁS: mira unos campos que no se han pedido.
   * Usarlo ahí de filtro vaciaba la lista entera y encima la cacheaba.
   *
   * Cuando los servidores están, mandan ellos. Cuando no, manda `has_streams`, que es ese mismo
   * veredicto ya calculado y escrito por quien sí los tenía delante (`persistStreams`).
   */
  private static esReproducible(item: MediaItem): boolean {
    const traeServidores = (item.servers && item.servers.length > 0)
      || (item.seasons && item.seasons.length > 0);
    return traeServidores ? this.hasPlayableDirectStream(item) : item.has_streams === true;
  }

  /**
   * Copia pública de un ítem: elimina los campos internos (`_source_url`, `_tioplus_url`) y deja
   * los servidores en lo único que la app sabe reproducir — vídeo directo, sin `embed_url`.
   *
   * Se hace en la COPIA, nunca sobre `item`: el caché devuelve la misma referencia en cada acierto
   * y `persistStreams` escribe `item.servers` en Supabase, así que mutar aquí sería borrar los
   * embed de la base de datos por la puerta de atrás. Ver `paraElCliente`.
   *
   * Cubre también los episodios, que llevan su propia lista de servidores dentro de las temporadas.
   */
  static toPublicItem<T extends Record<string, any>>(item: T): T {
    const { _source_url, _source_urls, _tioplus_url, ...rest } = item as any;
    if (Array.isArray(rest.servers)) {
      /**
       * SE ORDENA AL SERVIR, NO SOLO AL GUARDAR.
       *
       * El orden estaba fosilizado: se calculaba al escribir la ficha y a partir de ahí se
       * entregaba tal cual, así que cambiar una regla de orden no cambiaba nada hasta volver a
       * rastrear el catálogo entero. Se vio con «Gladiformers»: se añadió la regla de preferir el
       * `.mp4` al `.mkv` del mismo item, el comparador la aplicaba bien en aislado, y la API seguía
       * entregando el mkv primero — porque venía de la caché con el orden viejo dentro.
       *
       * El orden es una decisión de ENTREGA, no un dato del catálogo: depende de qué está
       * verificado hoy, de qué modo se puede usar hoy y de qué host va bien hoy. Guardarlo era
       * confundir las dos cosas. Ordenar aquí cuesta un `sort` sobre una lista de dos o tres
       * elementos y hace que cualquier regla nueva valga desde el primer despliegue.
       */
      rest.servers = paraElCliente(sortServersBySourcePriority(rest.servers));
      rest.primary_stream = getPrimaryStream(rest.servers) || null;
    } else if (rest.primary_stream) {
      rest.primary_stream = paraElCliente([rest.primary_stream])[0] || null;
    }
    /**
     * SOLO SE ANUNCIA EL CAPÍTULO QUE SE HA DEMOSTRADO QUE SE VE.
     *
     * La regla era la contraria —se anunciaba salvo que constara comprobado y vacío— y se puso por
     * miedo a vaciar el catálogo: los capítulos se resuelven al abrirlos, así que la mayoría están
     * sin comprobar y esconderlos deja las series casi sin lista.
     *
     * Pero ese miedo protegía al catálogo, no al espectador. Con el 9% comprobado, «se anuncia
     * salvo prueba en contra» significa que nueve de cada diez capítulos de la lista son una
     * promesa sin respaldo, y el que pulsa uno se encuentra con que no hay nada. Lo reportó el
     * usuario: desapareció el 1x1 de Trollhunters, que estaba comprobado, y el 2 seguía ahí sin
     * funcionar porque nadie lo había mirado.
     *
     * Un catálogo más corto y cierto es mejor que uno largo que falla al pulsar. Lo que aún no se
     * ha comprobado no se anuncia; en cuanto el barrido le encuentra vídeo, aparece.
     */
    if (Array.isArray(rest.seasons)) {
      const anunciable = (e: any) => paraElCliente(e?.servers).length > 0;
      rest.seasons = rest.seasons
        .map((s: any) => {
          if (!Array.isArray(s?.episodes)) return s;
          const episodes = s.episodes
            .filter(anunciable)
            .map((e: any) => {
              if (!Array.isArray(e?.servers)) return e;
              const servers = paraElCliente(e.servers);
              return { ...e, servers, primary_stream: getPrimaryStream(servers) || null };
            });
          return { ...s, episodes, episodes_count: episodes.length };
        })
        .filter((s: any) => !Array.isArray(s?.episodes) || s.episodes.length > 0);
    }
    return rest as T;
  }

  /**
   * Obtiene un título por ID/Slug CON los enlaces ya resueltos. Es la composición de los
   * dos caminos: metadata instantánea + resolución de servidores. Se conserva para los
   * clientes que quieren todo en una sola respuesta (`?streams=wait`) y para usos internos.
   */
  static async getById(id: string, typeHint?: ContentType): Promise<MediaItem | null> {
    return this.getStreams(id, typeHint);
  }

  /**
   * CAMINO RÁPIDO — metadata sin resolver enlaces (lo que necesita la ficha emergente).
   *
   * Orden: caché → Supabase (tolerante a cualquier forma de id) → fuentes en vivo.
   * No hace búsquedas por título en las fuentes ni fusión multifuente: eso es lo que
   * convertía cada apertura de popup en varios segundos de scraping. El resultado se
   * cachea SIEMPRE (antes solo se guardaba si traía servidores, así que los títulos
   * sin enlaces se re-scrapeaban en cada request).
   */
  static async getMetadata(id: string, typeHint?: ContentType): Promise<MediaItem | null> {
    const q = id.toLowerCase().trim();
    if (!q) return null;
    const cacheKey = this.cacheKeyFor(q, typeHint);

    // Un detalle completo ya caliente sirve también como metadata.
    const full = await CacheStore.get<MediaItem>(`byid:${cacheKey}`);
    if (full) return full;

    const cached = await CacheStore.get<MediaItem>(`meta:${cacheKey}`);
    if (cached) return cached;

    let result: MediaItem | null = null;

    // 1. DB-FIRST: el catálogo pre-scrapeado ya trae la ficha completa (job de refresh).
    //    Solo se acepta directamente si la coincidencia es inequívoca; una parcial se
    //    guarda como red de seguridad para el paso 3.
    const dbMatch = await this.findDbRowScored(q, typeHint);
    const fromDbRow = async (row: any): Promise<MediaItem> => {
      const mapped = this.mapDbItemToMediaItem(row);
      return this.isMetadataComplete(mapped)
        ? mapped
        : await TmdbService.enrichMediaItem(mapped, { skipSeasons: true });
    };

    if (dbMatch && dbMatch.score >= CatalogService.DB_MATCH_CONFIDENT) {
      result = await fromDbRow(dbMatch.row);
    }

    // 2. Fuera de la DB: resolver contra TMDB / las fuentes reales.
    if (!result) {
      result = await this.resolveMetadataLive(q, typeHint);
    }

    // 3. Ni la DB ni las fuentes en vivo dieron una ficha exacta: se usa la mejor
    //    coincidencia parcial de la DB antes que devolver 404.
    if (!result && dbMatch) {
      result = await fromDbRow(dbMatch.row);
    }

    if (!result) return null;

    // 3. Temporadas de series (desde la DB si están persistidas, si no desde TMDB).
    await this.ensureSeasons(result);
    this.inheritServersToEpisodes(result);

    await this.cacheItem('meta', cacheKey, result, METADATA_TTL_SECONDS);
    return result;
  }

  /**
   * Resolución de metadata contra TMDB y las fuentes reales, para ids que NO están en la DB.
   */
  private static async resolveMetadataLive(q: string, typeHint?: ContentType): Promise<MediaItem | null> {
    let result: MediaItem | null = null;

    // 0. Si el ID es numérico (ID oficial de TMDB), consultar primero DB/Caché y luego TMDB
    if (!isNaN(Number(q))) {
      const tmdbNumericId = Number(q);

      // Verificación directa en Supabase DB (ultra rápido sub-30ms)
      try {
        const { data: dbData } = await supabase
          .from('media_items')
          .select('*')
          .or(`tmdb_id.eq.${tmdbNumericId},id.eq.${q}`)
          .single();

        if (dbData) {
          result = await TmdbService.enrichMediaItem(this.mapDbItemToMediaItem(dbData));
        }
      } catch (err) {}

      if (!result) {
        const [tmdbMovieData, tmdbTvData] = await Promise.all([
          TmdbService.getTmdbDetails(tmdbNumericId, 'movie'),
          TmdbService.getTmdbDetails(tmdbNumericId, 'tvseries')
        ]);

        let tmdbData: any = null;
        let contentType: ContentType = 'movie';

        if (tmdbMovieData && !tmdbTvData) {
          tmdbData = tmdbMovieData;
          contentType = 'movie';
        } else if (!tmdbMovieData && tmdbTvData) {
          tmdbData = tmdbTvData;
          contentType = 'tvseries';
        } else if (tmdbMovieData && tmdbTvData) {
          const movieVotes = tmdbMovieData.vote_count || 0;
          const tvVotes = tmdbTvData.vote_count || 0;

          const tvTitle = tmdbTvData.name || tmdbTvData.original_name || '';
          const movieTitle = tmdbMovieData.title || tmdbMovieData.original_title || '';

          if (typeHint === 'tvseries') {
            tmdbData = tmdbTvData;
            contentType = 'tvseries';
          } else if (typeHint === 'movie') {
            tmdbData = tmdbMovieData;
            contentType = 'movie';
          } else {
            const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").trim();
            const tvNorm = norm(tvTitle);
            const movieNorm = norm(movieTitle);

            const [tvSearch, movieSearch] = await Promise.all([
              this.search(tvTitle).catch(() => []),
              this.search(movieTitle).catch(() => [])
            ]);

            const tvMatch = tvSearch.some(r => r.tmdb_id === tmdbNumericId || norm(r.title) === tvNorm);
            const movieMatch = movieSearch.some(r => r.tmdb_id === tmdbNumericId || norm(r.title) === movieNorm);

            if (movieMatch && !tvMatch) {
              tmdbData = tmdbMovieData;
              contentType = 'movie';
            } else {
              tmdbData = tmdbTvData;
              contentType = 'tvseries';
            }
          }
        }

        if (tmdbData) {
          const title = tmdbData.title || tmdbData.name;

          // Búsqueda con timeout estricto de 1.5s para no congelar la respuesta del cliente
          const timeoutPromise = new Promise<MediaItem[]>((resolve) => setTimeout(() => resolve([]), 1500));
          const searchResults = await Promise.race([this.search(title), timeoutPromise]);

          const getCanonicalKey = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").trim();
          const targetKey = getCanonicalKey(title);
          // El tmdb_id es la identidad pedida y manda. El t\u00edtulo es solo un ATAJO para reconocer
          // la ficha ya guardada, y por s\u00ed solo no identifica nada: hay tres fichas tituladas
          // "Sin salida" (The Firm 1993, No Exit 2022 y la de 2024) y la primera que pasara por
          // aqu\u00ed se devolv\u00eda como si fuera la pedida, con sus servidores y todo. Cuando se cae al
          // atajo, el a\u00f1o tiene que cuadrar.
          const targetYear = String(tmdbData.release_date || tmdbData.first_air_date || '').slice(0, 4);
          const match =
            searchResults.find(r => r.tmdb_id === tmdbNumericId) ||
            searchResults.find(r => {
              if (getCanonicalKey(r.title) !== targetKey) return false;
              // Una ficha con OTRO tmdb_id real ya se ha declarado otra obra: no es esta.
              if (r.tmdb_id > 0 && r.tmdb_id !== tmdbNumericId) return false;
              const y = yearOf(r);
              return !targetYear || !y || Math.abs(Number(targetYear) - Number(y)) <= 1;
            });

          if (match) {
            result = await TmdbService.enrichMediaItem(match);
          } else {
            // Construcción directa e instantánea desde metadatos TMDB (preservando ID y título exactos)
            result = await TmdbService.enrichMediaItem({
              id: String(tmdbData.id),
              tmdb_id: tmdbData.id,
              imdb_id: null,
              type: contentType,
              title: tmdbData.title || tmdbData.name,
              original_title: tmdbData.original_title || tmdbData.original_name,
              aliases: [tmdbData.title || tmdbData.name],
              tagline: tmdbData.tagline || '',
              overview: tmdbData.overview || '',
              rating: tmdbData.vote_average ? Number(tmdbData.vote_average.toFixed(1)) : 0,
              content_rating: 'PG-13',
              release_date: tmdbData.release_date || tmdbData.first_air_date || '',
              genres: tmdbData.genres?.map((g: any) => g.name) || [],
              subcategories: ['Latino HD'],
              poster: tmdbData.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}` : null,
              backdrop: tmdbData.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tmdbData.backdrop_path}` : null,
              logo: null,
              trailer: null,
              cast: [],
              dubbing_cast: [],
              servers: []
            });

          }
        }
      }
    }

    /**
     * 1-bis. ¿HAY UNA FICHA QUE YA SEA DUEÑA DE ESTA PÁGINA?
     *
     * El slug pedido puede ser el de una fila que se FUNDIÓ en otra y se borró (así se unifican los
     * duplicados entre fuentes). Su página, en cambio, quedó apuntada en la ficha que la absorbió,
     * de modo que hay a quién preguntar: quien tenga esa url en `source_urls` es la ficha buena.
     *
     * Sin esto la petición caía al camino de abajo y se RESUCITABA la ficha scrapeando su página en
     * vivo — volviendo a emparejarla con TMDB desde cero y, si el emparejado no sale igual, con la
     * obra equivocada. Y encima se cacheaba: pedir `2026-01-eric-2024-html` devolvía un especial de
     * monólogos en vez de la miniserie "Eric", que es la ficha que absorbió esa página.
     */
    if (!result) {
      const dueña = await this.fichaQuePoseeLaPagina(q);
      if (dueña) result = dueña;
    }

    // 1-2. Resolver el slug contra las fuentes reales (FuegoCine y TioPlus).
    if (!result) {
      const fromSource = await this.resolveFromSource(q);
      if (fromSource) result = await TmdbService.enrichMediaItem(fromSource);
    }

    // 3. Buscar por texto o TMDB ID de forma inteligente con filtro estricto de título / slug / alias.
    //    El término se des-sluguifica ("madagascar-3-los-fugitivos" → "madagascar 3 los fugitivos")
    //    porque la búsqueda opera sobre títulos, no sobre slugs con guiones.
    if (!result) {
      const scraped = await this.search(q.replace(/-/g, ' ').trim());
      if (scraped.length > 0) {
        const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").trim();
        const targetNorm = norm(q);
        // Identidad exacta primero: el id o el tmdb_id pedidos designan UNA ficha. El nombre es
        // un desempate posterior, y entre hom\u00f3nimos (tres fichas "Sin salida") no desempata
        // nada: si el slug pedido trae a\u00f1o \u2014as\u00ed es como las fuentes los distinguen,
        // `sin-salida-2011`\u2014 tiene que cuadrar con el de la ficha.
        const pedidoYear = yearFromSlug(q);
        const porNombre = (r: MediaItem) => {
          if (norm(r.title) !== targetNorm && !(r.aliases || []).some(a => norm(a) === targetNorm)) return false;
          const y = yearOf(r);
          return !pedidoYear || !y || Math.abs(Number(pedidoYear) - Number(y)) <= 1;
        };
        const match =
          scraped.find(r => r.id === q || String(r.tmdb_id) === q) ||
          scraped.find(porNombre);
        if (match) {
          result = match;
        }
      }
    }

    return result;
  }

  /**
   * Garantía de temporadas para series: si la ficha no las trae (ni de la DB ni de la
   * fuente), se reconstruyen desde TMDB. Las llamadas por temporada ya van en paralelo
   * dentro de getTmdbSeasons.
   */
  private static async ensureSeasons(item: MediaItem): Promise<void> {
    const isSeries = item.type === 'tvseries' || (item.total_seasons != null && item.total_seasons > 0);
    if (!isSeries || (item.seasons && item.seasons.length > 0)) return;

    const tmdbId = item.tmdb_id || Number(item.id);
    if (!tmdbId || tmdbId <= 0) return;

    try {
      item.seasons = await TmdbService.getTmdbSeasons(tmdbId, item.total_seasons || 1, item.poster, item.servers || []);
    } catch {}
  }

  /**
   * De las páginas que se proponen como fuente de esta ficha, cuáles son en realidad la página
   * PROPIA de otra ficha del catálogo.
   *
   * Es la única prueba que separa homónimos del MISMO año, donde comparar fechas ya no distingue
   * nada: "El botín" son dos películas de 2026 y "Sola" dos de 2020, con títulos idénticos. Si la
   * página que se quiere adoptar es de la que ya es dueña otra ficha con distinto tmdb_id real, es
   * de otra obra y punto.
   *
   * Cuesta UNA consulta por clave primaria para todas las urls juntas, y solo se paga en el camino
   * exhaustivo, que de por sí hace varios scrapes. Si la consulta falla no se descarta nada: se
   * devuelve el conjunto vacío y deciden las demás llaves.
   */
  private static async paginasDeOtraFicha(urls: Array<string | undefined>, self: MediaItem): Promise<Set<string>> {
    const ajenas = new Set<string>();
    if (!(self.tmdb_id > 0)) return ajenas;

    const porId = new Map<string, string[]>();   // id candidato → urls que lo generan
    for (const url of urls) {
      if (!url) continue;
      for (const id of candidateIdsForUrl(url)) {
        porId.set(id, [...(porId.get(id) || []), url]);
      }
    }
    if (porId.size === 0) return ajenas;

    try {
      const { data } = await supabase
        .from('media_items')
        .select('id,tmdb_id')
        .in('id', Array.from(porId.keys()));
      for (const row of data || []) {
        if (String(row.id) === self.id) continue;
        if (!(row.tmdb_id > 0) || row.tmdb_id === self.tmdb_id) continue;
        for (const url of porId.get(String(row.id)) || []) ajenas.add(url);
      }
    } catch {}

    return ajenas;
  }

  /**
   * La ficha que tiene apuntada como propia la página de este slug, si existe.
   *
   * Es la contrapartida de `candidateIdsForUrl`: en vez de preguntar "¿de quién es esta url?", se
   * pregunta "¿quién guarda una url que se llame así?". Sirve para que un slug ya fundido devuelva
   * la ficha que lo absorbió en lugar de resucitarse solo. Una consulta con `LIKE` sobre
   * `source_urls`, acotada: si no hay dueña clara no se devuelve nada y sigue el camino normal.
   */
  private static async fichaQuePoseeLaPagina(slug: string): Promise<MediaItem | null> {
    const s = String(slug || '').trim();
    if (s.length < 4) return null;

    // De `2026-01-eric-2024-html` (molde FuegoCine) se saca el trozo que aparece en la url real:
    // `2026/01/eric-2024.html`. Del molde TioPlus, el slug entero ya es el último tramo.
    const comoRuta = s.replace(/-html$/, '.html').replace(/^(\d{4})-(\d{2})-/, '$1/$2/');
    const patrones = Array.from(new Set([comoRuta, s]));

    try {
      for (const p of patrones) {
        const { data } = await supabase
          .from('media_items')
          .select('*')
          .or(`source_urls.cs.{https://www.fuegocine.com/${p}},source_url.ilike.%/${p}`)
          .limit(2);
        const filas = data || [];
        // Si hay más de una candidata no se adivina: que decidan los caminos de abajo.
        if (filas.length === 1) {
          const item = this.mapDbItemToMediaItem(filas[0]);
          // Y tiene que ser suya de verdad, con los mismos moldes que usa todo lo demás.
          const urls = [...(item._source_urls || []), item._source_url].filter(Boolean) as string[];
          if (urls.some(u => candidateIdsForUrl(u).includes(s))) return item;
        }
      }
    } catch {}

    return null;
  }

  /**
   * UN EPISODIO CONCRETO, con SUS enlaces y de nadie más.
   *
   * Es el único camino por el que las rutas deben pedir un episodio, y existe por lo que hacía cada
   * una por su cuenta: si el episodio no se resolvía, devolvían los servidores DE LA SERIE como si
   * fueran los del capítulo. El resultado es lo peor que puede pasarle a esta API sin dar error —
   * pides el capítulo 1 y ves otro—: todos los episodios de "One Piece" servían el mismo vídeo.
   *
   * Aquí no hay sustitución posible. El episodio se resuelve contra la PÁGINA DE ORIGEN de la serie
   * (el id de la fila no siempre es el slug de la fuente) y solo se aceptan enlaces de una página
   * que se declare de ese capítulo. Si no se consigue, el episodio se devuelve SIN enlaces: la app
   * lo enseña como no disponible, que es la verdad, en vez de reproducir otra cosa.
   */
  static async getEpisode(id: string, season: number, episode: number): Promise<any | null> {
    /**
     * CACHÉ DEL EPISODIO. No tenía ninguna: cada vez que alguien abría un capítulo se volvía a
     * scrapear su página y a sondear sus servidores, 9 segundos medidos. Con el mismo TTL que los
     * enlaces de una película (10 min), porque es lo mismo que caduca: las URLs firmadas.
     */
    const cacheKey = `ep:${String(id).toLowerCase().trim()}:${season}:${episode}`;
    const cacheado = await CacheStore.get<any>(cacheKey);
    if (cacheado) {
      // Veredicto fresco sobre lo cacheado: si alguno de estos servidores se ha demostrado muerto
      // desde que se guardó —lo haya descubierto esta instancia u otra— se cae aquí, sin red.
      const vivos = aplicarVeredictosRecordados(cacheado.servers || []).filter((x: any) => x.status !== 'offline');
      if (vivos.length === (cacheado.servers || []).length) return cacheado;
      return {
        ...cacheado,
        servers: vivos,
        primary_stream: vivos.length > 0 ? getPrimaryStream(vivos) : undefined,
        streams: {
          status: vivos.length > 0 ? 'ready' : 'unavailable',
          descartados_por_no_reproducir:
            (cacheado.streams?.descartados_por_no_reproducir || 0) + ((cacheado.servers || []).length - vivos.length)
        }
      };
    }

    const serie = await this.getMetadata(id, 'tvseries');
    if (!serie) return null;

    /**
     * UNA PELÍCULA NO TIENE CAPÍTULOS, y hasta ahora nadie lo comprobaba.
     *
     * Pedir `/media/<id-de-pelicula>/season/1/episode/6` entraba igual: se resolvía como si fuera
     * una serie y `persistEpisodeServers` le ESCRIBÍA el árbol encima. Peor todavía, la temporada
     * salía de pedirle a TMDB `tv/<tmdb_id>`, y TMDB numera películas y series por separado — así
     * que devolvía los capítulos de otra obra distinta. Es la colisión entre catálogos que
     * FUENTES.md §1 avisa que no da 404, da los datos de otra cosa.
     *
     * Resultado medido: 25 películas con árbol de capítulos, 10 de ellas anunciándose. La película
     * «Inseparables» salía en la app con seis capítulos llamados «Uno, Dos… Seis», y el espectador
     * veía botones para avanzar de capítulo en una película.
     */
    if (serie.type === 'movie') return null;

    // La ficha de la temporada da nombre, imagen y sinopsis del capítulo; los ENLACES, solo la
    // página del episodio o los que ya estuvieran guardados para ESE episodio.
    const deLaFicha = (serie.seasons || [])
      .find(s => s.season_number === season)?.episodes
      ?.find(e => e.episode_number === episode);

    /**
     * SI YA ESTÁ RESUELTO Y FRESCO, NO SE SCRAPEA. Es la misma regla que `hasFreshStreams` aplica
     * a las películas, y aquí faltaba: se scrapeaba SIEMPRE, aunque los enlaces estuvieran
     * guardados y recién comprobados. Abrir un capítulo costaba una visita a la fuente y el sondeo
     * de sus servidores —segundos— cuando la respuesta ya estaba en la base de datos.
     *
     * Resolver bajo demanda no puede ser el mecanismo normal: eso convierte cada reproducción en
     * una espera y deja al cliente pagando un trabajo que le toca al catálogo. Lo normal es leer
     * lo ya resuelto; scrapear es el respaldo para lo que la pasada de fondo aún no ha cubierto.
     */
    const selloEp = deLaFicha?.checked_at ? Date.parse(deLaFicha.checked_at) : 0;
    /**
     * Y que lo guardado SIRVA PARA ALGO. Tener servidores no basta: si ninguno es publicable, el
     * atajo devuelve una lista vacía y encima impide volver a mirar durante 24 h — el capítulo se
     * queda muerto por un sello que puso una resolución que salió mal.
     *
     * Pasó con «Breaking Bad»: un intento anterior selló el capítulo con los servidores de una sola
     * fuente, todos inservibles, y a partir de ahí ya no se scrapeaba. La fuente nueva estaba
     * enganchada, tenía tres vídeos directos y no se llegaba a preguntar.
     *
     * Es la misma regla que `hasFreshStreams` aplica a las películas.
     */
    /**
     * Y con ALTERNATIVAS, no con uno.
     *
     * Bastaba con que hubiera un servidor publicable para dar el capítulo por resuelto y no volver
     * a mirar en 24 h. Pero un solo servidor es justo el caso que no tiene salida: si se atasca, no
     * hay a dónde caer. El capítulo se quedaba con el primero que se selló y los otros tres con
     * vídeo directo seguían escondidos esperando turno para siempre.
     *
     * Con dos ya hay failover, que es lo que importa. Por debajo se vuelve a resolver, y esa pasada
     * sella hasta tres (`objetivoSellados`). Se paga una vez por capítulo.
     */
    const yaResuelto = Boolean(selloEp)
      && Date.now() - selloEp < STREAMS_FRESH_MS
      && paraElCliente(deLaFicha?.servers).length >= 2;

    const sourceUrls = [...(serie._source_urls || []), serie._source_url].filter(Boolean) as string[];
    const scraped = yaResuelto
      ? null
      : await RealScraperService
          .scrapeEpisodeDetail(serie.id || id, season, episode, { sourceUrls })
          .catch(() => null);

    const propios = scraped?.servers?.length
      ? scraped.servers
      : (deLaFicha?.servers || []).filter(s => s && s.embed_url);

    /**
     * ANTES DE ENTREGARLOS: que el de arriba REPRODUZCA.
     *
     * Esta comprobación existía solo en el camino de las películas, así que los episodios se
     * entregaban tal cual salían del scraping — con el vídeo directo primero, que es justo el que
     * más caduca. Resultado: el primer servidor del capítulo 1 de "Invencible" daba error al darle
     * a reproducir. `revisarServidores` baja hasta un segmento real, con tope de tiempo, y degrada
     * lo que no responde; después se reordena, porque el sorter recoloca lo que quedó `offline` y
     * vuelve a sellar el nombre como `[Embed]` cuando su vídeo directo ya no vale.
     *
     * Presupuesto de petición (4 s, 3 sondas, parando en el primero útil): el mismo que usa el
     * detalle de una película, para no cambiar la latencia de pulsar Reproducir.
     */
    const revisados = await revisarServidores(
      sortServersBySourcePriority(aplicarVeredictosRecordados(propios)),
      // Un episodio trae 4-6 servidores y a menudo la mitad están caídos, así que el cupo de sondas
      // cubre la lista entera: con tope de 3 se gastaban en los muertos y el último se entregaba
      // SIN comprobar, conservando su `online` viejo. Manda el presupuesto de TIEMPO, que se queda
      // en 3 s para no castigar la apertura — y lo ya sabido sale del caché compartido sin gastar
      // sonda, así que la segunda vez que alguien abre este capítulo no se sondea nada.
      // Mismo razonamiento que en las películas: quedarse a medias ya no entrega un servidor sin
      // comprobar, deja el capítulo vacío. Se para en cuanto uno demuestra que reproduce.
      // Mismo motivo que en las películas: alternativas para poder caer si el primero se atasca.
      { presupuestoMs: 8000, maximo: 8, objetivoSellados: 3 }
    );

    /**
     * Los que se han demostrado caídos NO se entregan.
     *
     * Se devolvían al final de la lista, marcados `offline`, con la idea de que el cliente los
     * ignorase. En la práctica es peor que no darlos: un reproductor los intenta igual y el
     * espectador ve un error. En "El Chavo" T6E3 los cuatro servidores están caídos, así que lo
     * único cierto que se puede contestar es que ese capítulo no se puede ver — no una lista de
     * cuatro cosas que no funcionan.
     *
     * Se informa de cuántos se descartaron, para que esto no sea nunca una pérdida silenciosa.
     */
    const todos = sortServersBySourcePriority(revisados);
    const vivos = todos.filter(s => s.status !== 'offline');
    const descartados = todos.length - vivos.length;
    // Y de los vivos, solo lo que la app puede reproducir: vídeo directo. Un capítulo cuyos
    // servidores son todos embed no está `pending` —no es que falte buscarlo—, está
    // `unavailable`: se encontró y no hay nada que este cliente pueda abrir.
    const servers = paraElCliente(vivos);
    const sinVideoDirecto = vivos.length - servers.length;

    const resultado = {
      id: `${serie.tmdb_id || serie.id}-${season}-${episode}`,
      series_id: serie.id,
      series_title: serie.title,
      season_number: season,
      episode_number: episode,
      name: deLaFicha?.name || `Episodio ${episode}`,
      overview: deLaFicha?.overview || '',
      still_path: deLaFicha?.still_path || serie.poster,
      air_date: deLaFicha?.air_date || null,
      poster: deLaFicha?.still_path || serie.poster,
      backdrop: serie.backdrop,
      primary_stream: servers.length > 0 ? getPrimaryStream(servers) : undefined,
      servers,
      /**
       * Contrato explícito de disponibilidad, en vez de dejar que el cliente lo deduzca de una
       * lista vacía: `ready` hay algo que reproducir · `unavailable` se comprobaron y ninguno
       * responde · `pending` no se encontró ninguna fuente para este capítulo.
       */
      streams: {
        status: servers.length > 0 ? 'ready' : (todos.length > 0 ? 'unavailable' : 'pending'),
        descartados_por_no_reproducir: descartados,
        sin_video_directo: sinVideoDirecto
      }
    };

    // Solo se cachea lo que aporta algo. Un `pending` —no se encontró la página— se deja sin
    // cachear para que el siguiente intento vuelva a probar.
    if (todos.length > 0) {
      await CacheStore.set(cacheKey, resultado, CACHE_TTL_SECONDS);
      /**
       * Y se GUARDA. Solo cuando se ha resuelto de verdad: si esto salió de lo ya guardado,
       * reescribirlo renovaría el sello sin haber comprobado nada, y el sello es justo lo que
       * dice que se comprobó.
       *
       * SE ESPERA, no se lanza y se olvida. Iba en fire-and-forget como `persistStreams`, y ahí
       * no se sostiene: en Vercel la función se congela en cuanto responde, así que el UPDATE se
       * quedaba a medias y NUNCA llegaba a escribirse — medido sobre Trollhunters, resuelto por
       * la API y con `checked_at` a null en la base de datos después. Lo mismo en el barrido por
       * lotes, cuyo proceso termina sin esperar a las promesas sueltas: por eso `--episodios`
       * seguía viendo los mismos 90.000 pendientes corrida tras corrida.
       *
       * Cuesta un UPDATE (~150 ms) sobre un camino que ya tarda segundos porque acaba de scrapear
       * la fuente, y solo se paga una vez por capítulo: la siguiente apertura sale del camino
       * rápido sin tocar la red. Un sello que no se escribe no vale nada.
       */
      if (!yaResuelto) {
        await this.persistEpisodeServers(serie, season, episode, todos).catch(() => {});
      }
    }
    return resultado;
  }

  /**
   * Escribe en la ficha los servidores que se acaban de resolver para UN episodio.
   *
   * ESTE ERA EL AGUJERO QUE HACÍA MENTIR AL CATÁLOGO SOBRE LAS SERIES. Una película guarda sus
   * servidores (`persistStreams`) y por eso `has_streams` dice la verdad sobre ella. Un episodio
   * los resolvía en vivo, los servía y los TIRABA: solo quedaban 10 minutos de caché. Así que en
   * la base de datos una serie que reproduce perfectamente parecía vacía, y cualquier recuento
   * hecho sobre lo guardado —la migración 007, sin ir más lejos— la escondía del catálogo. Medido:
   * 6 de cada 14 series ocultas SÍ reproducían.
   *
   * Se guarda lo resuelto ANTES de filtrar por vídeo directo (`todos`, no `servers`): el embed hay
   * que conservarlo para poder reextraer más adelante, y es `paraElCliente` quien decide qué sale
   * al cliente. Misma regla que en `persistStreams`.
   *
   * Va en fire-and-forget: nunca puede retrasar ni tumbar la respuesta del capítulo.
   */
  private static async persistEpisodeServers(
    serie: MediaItem,
    season: number,
    episode: number,
    servers: ServerOption[]
  ): Promise<void> {
    if (!serie?.id) return;
    // Cinturón: quien escriba capítulos tiene que ser una serie. El camino de arriba ya lo filtra,
    // pero esta función es la que dejó 25 películas con árbol de episodios y no puede volver a
    // depender de que la llamen bien.
    if (serie.type === 'movie') return;

    // Se parte de lo que ya tenga la ficha y se sustituye SOLO este episodio. Si la temporada o el
    // episodio no estaban, se crean: una serie recién descubierta no tiene árbol todavía.
    const seasons = JSON.parse(JSON.stringify(serie.seasons || [])) as any[];
    let temporada = seasons.find(t => Number(t?.season_number) === season);
    if (!temporada) {
      temporada = { season_number: season, name: `Temporada ${season}`, episodes_count: 0, poster: null, episodes: [] };
      seasons.push(temporada);
    }
    if (!Array.isArray(temporada.episodes)) temporada.episodes = [];
    let cap = temporada.episodes.find((e: any) => Number(e?.episode_number) === episode);
    if (!cap) {
      cap = { episode_number: episode, name: `Episodio ${episode}`, overview: '', still_path: null, air_date: null, servers: [] };
      temporada.episodes.push(cap);
    }
    cap.servers = servers;
    // El sello va SIEMPRE, con enlaces o sin ellos: «comprobado y vacío» es justo lo que
    // autoriza a dejar de anunciar el capítulo, y sin él no se distingue de «aún no mirado».
    cap.checked_at = new Date().toISOString();

    /**
     * EL VEREDICTO DE LA SERIE, y aquí hay que hilar fino porque el dato está a medias.
     *
     * Encontrar algo reproducible basta para decir que sí: una serie con un capítulo que se ve,
     * se ve. Es lo que devuelve al catálogo a las que estaban escondidas por no tener nada
     * guardado.
     *
     * NO ENCONTRARLO NO BASTA PARA DECIR QUE NO. Los capítulos se comprueban de uno en uno y a lo
     * ancho del catálogo, así que durante días una serie tendrá dos capítulos mirados y veinticinco
     * sin mirar. Poner `has_streams = false` ahí esconde la serie entera por lo que se sabe de dos
     * capítulos — y se notó: mientras el barrido corría, las series visibles cayeron de 789 a 534
     * en unas horas, no porque dejaran de funcionar sino porque el primer capítulo vacío las
     * enterraba.
     *
     * Así que solo se declara vacía cuando están TODOS comprobados y ninguno sirve. Mientras quede
     * alguno sin mirar, no se toca: es el mismo tri-estado que usa `checked_at` por capítulo —
     * comprobado-y-vacío no es lo mismo que sin-comprobar— aplicado a la ficha.
     */
    const update: Record<string, unknown> = {
      seasons,
      streams_updated_at: new Date().toISOString(),
      streams_checked_at: new Date().toISOString(),
    };
    // Acabamos de mirar UN capítulo: alcance parcial. Es `veredictoDisponibilidad` quien sabe que
    // con eso solo se puede concluir «sí», o «no» si ya no queda ninguno por comprobar.
    const veredicto = veredictoDisponibilidad({ type: serie.type, servers: serie.servers, seasons } as any, 'parcial');
    if (veredicto !== undefined) update.has_streams = veredicto;

    try {
      await this.escribirFila(update, serie.id, 'capítulo');

      /**
       * Y SE TIRA EL DETALLE CACHEADO DE LA SERIE, porque acaba de cambiar su árbol de temporadas.
       *
       * Sin esto el arreglo tarda hasta 6 h en verse y parece que no funciona: la ficha sigue
       * saliendo del caché con el capítulo vacío que se acaba de comprobar, así que se anuncia
       * algo que ya sabemos que no se puede ver. Ya pasó al retirar los vidhideplus —la ficha
       * salía corregida y el episodio seguía entregando el servidor viejo— y se persiguió como si
       * fuera un despliegue que no subía.
       *
       * Invalidar en la escritura es además lo único que funciona sin credenciales de Redis a
       * mano: lo hace el proceso que ya las tiene, en el momento en que el dato deja de ser
       * cierto, en vez de depender de acordarse de purgar después.
       */
      await this.invalidateItem(serie).catch(() => {});
    } catch {}
  }

  /** scrapeDetail con techo de latencia: una fuente lenta no puede bloquear la respuesta. */
  private static async scrapeDetailWithTimeout(url: string, ms: number = 2500): Promise<MediaItem | null> {
    const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), ms));
    return Promise.race([RealScraperService.scrapeDetail(url).catch(() => null), timeout]);
  }

  /**
   * CAMINO DE ENLACES — resuelve los servidores reproducibles de un título.
   *
   * Se pide aparte de la metadata (GET /api/v1/media/:id/streams), normalmente cuando el
   * usuario pulsa Reproducir, por lo que la ficha ya está pintada mientras esto ocurre.
   * Orden de coste creciente:
   *   A. Enlaces persistidos en Supabase con menos de 24 h → 0 scrapes.
   *   B. `source_url` de la fila → UN solo scrapeDetail contra la URL exacta.
   *   C. Fusión multifuente (búsqueda por título en tioplus + fuegocine) — el camino
   *      histórico, ahora reservado para cuando A y B no dan enlaces o se pide `deep`.
   * Lo resuelto se escribe de vuelta en la DB para que la próxima apertura sea instantánea.
   *
   * `cheap` corta en B: sirve para que el DETALLE pueda intentar traer los enlaces en la
   * misma respuesta sin arriesgar la latencia de la fusión multifuente.
   */
  static async getStreams(id: string, typeHint?: ContentType, opts: { deep?: boolean; cheap?: boolean } = {}): Promise<MediaItem | null> {
    const q = id.toLowerCase().trim();
    if (!q) return null;
    const cacheKey = this.cacheKeyFor(q, typeHint);

    /**
     * EL ATAJO NO VALE PARA UNA FICHA QUE NO TIENE NADA QUE ENTREGAR.
     *
     * Este caché guarda la ficha con sus enlaces una hora, y devolverla tal cual es lo correcto
     * mientras haya algo que reproducir. Pero cuando la última resolución acabó sin un solo
     * servidor entregable, guardar ESO y servirlo durante una hora hace justo lo contrario de lo
     * que hace falta: cada petición contesta «no hay nada» sin volver a mirar y, sobre todo, sin
     * llegar nunca al sitio donde se escribe el veredicto que la retiraría del catálogo. La ficha
     * se queda anunciándose y contestando vacío, en bucle, hasta que caduque la entrada.
     *
     * Así que una copia guardada que no entrega nada se trata como si no estuviera: se resuelve de
     * cero, se sondea, y con lo que se mida se decide. Cuesta una resolución completa la primera
     * vez — y a cambio esa ficha deja de anunciarse, que es lo que se estaba pidiendo.
     */
    const cached = await CacheStore.get<MediaItem>(`byid:${cacheKey}`);
    if (cached && !opts.deep) {
      const alDia = this.conSaludAlDia(cached);
      if (paraElCliente(alDia.servers).length > 0 || this.hasEpisodeServers(alDia)) return alDia;
    }

    const result = await this.getMetadata(q, typeHint);
    if (!result) return null;

    /**
     * A. Enlaces persistidos y frescos: no hay que scrapear, PERO SÍ HAY QUE COMPROBAR.
     *
     * Aquí estaba el fondo del asunto, y costó tres despliegues verlo. La lista guardada se
     * devolvía tal cual porque el sello decía que alguien había demostrado que funcionaba. Pero un
     * sello es una promesa sobre el PASADO: «Milagro en la Celda 7» y «Volver al Futuro 3» tenían
     * el suyo de hacía tres horas y sus enlaces daban 502 y 503 en ese momento. Acortar la ventana
     * solo mueve el problema — el vídeo se puede caer en el minuto siguiente a sellarlo.
     *
     * Si la regla es que lo que se entrega funciona, lo que se entrega hay que comprobarlo al
     * entregarlo. `revisarServidores` para en cuanto uno demuestra que reproduce y lo ya sabido
     * sale del caché de salud sin gastar sonda, así que el caso normal —la cabeza funciona, o se
     * comprobó hace nada— sigue costando prácticamente cero. Solo se paga cuando la cabeza ha
     * muerto, que es exactamente cuando hay que enterarse.
     *
     * Lo comprobado se resella, se reordena y se persiste: la siguiente apertura ya sale barata.
     */
    if (!opts.deep && this.hasFreshStreams(result)) {
      const revisados = await revisarServidores(
        sortServersBySourcePriority(aplicarVeredictosRecordados(result.servers || [])),
        // Tres demostrados, no uno: sin alternativas un atasco no tiene salida. Ver `objetivoSellados`.
        { presupuestoMs: 9000, maximo: 8, objetivoSellados: 3 }
      );
      result.servers = sortServersBySourcePriority(revisados);
      result.primary_stream = getPrimaryStream(result.servers);
      await this.guardarEnlaces(result, false, true);
      await this.cacheItem('byid', cacheKey, result, CACHE_TTL_SECONDS);
      return result;
    }

    const allServers: ServerOption[] = [...(result.servers || [])];
    // Se indexa por la URL YA DECODIFICADA. Las fichas antiguas guardaron el redirector de
    // Blogger y el re-scrapeo devuelve el host real: sin normalizar, el mismo servidor entraba
    // dos veces —el redirector viejo sin vídeo directo y el bueno— y la lista se iba llenando
    // de duplicados muertos.
    const keyOf = (s: ServerOption) => unwrapRedirector(s.embed_url);
    const byUrl = new Map<string, ServerOption>(allServers.map(s => [keyOf(s), s]));
    const addServers = (servers?: ServerOption[] | null) => {
      for (const s of servers || []) {
        if (!s) continue;
        const key = keyOf(s);
        const existing = byUrl.get(key);
        if (!existing) {
          allServers.push(s);
          byUrl.set(key, s);
          continue;
        }
        // El embed guardado era el redirector: nos quedamos con el host real, que es el que
        // el cliente puede incrustar sin pasar por una página de publicidad.
        if (existing.embed_url !== key && s.embed_url === key) {
          existing.embed_url = s.embed_url;
        }
        // Mismo embed ya conocido. Si el recién scrapeado trae vídeo directo y el guardado no,
        // se le trasplantan esos campos: de lo contrario una ficha que se persistió antes de
        // existir la extracción se quedaría para siempre sin `direct_stream`, porque el
        // duplicado se descartaba sin mirar qué aportaba.
        if (s.direct_stream && !existing.direct_stream) {
          existing.direct_stream = s.direct_stream;
          existing.direct_kind = s.direct_kind;
          existing.direct_mode = s.direct_mode;
          existing.direct_host = s.direct_host;
          existing.quality = s.quality;
        }
      }
    };
    /**
     * Expulsa de la lista los servidores que sirve una página que NO es de esta obra.
     *
     * Hace falta porque `allServers` arranca con lo que había guardado en la DB, y ahí puede
     * haber servidores de otra película metidos por la fusión por título de antes. Un servidor
     * no recuerda de qué página salió (`source_id` es el sitio, no la url), pero la página
     * intrusa recién scrapeada SÍ enseña los suyos: son los que se retiran, por su embed.
     */
    const dropServers = (servers?: ServerOption[] | null) => {
      for (const s of servers || []) {
        if (!s) continue;
        const key = keyOf(s);
        if (!byUrl.delete(key)) continue;
        const i = allServers.findIndex(x => keyOf(x) === key);
        if (i >= 0) allServers.splice(i, 1);
      }
    };
    const adoptSeasons = (seasons?: any[] | null) => {
      if (seasons && seasons.length > 0 && (!result.seasons || result.seasons.length === 0)) {
        result.seasons = seasons;
      }
    };

    // Todas las páginas de origen conocidas de esta ficha. Cuando la misma película existe
    // en TioPlus y en FuegoCine, el catálogo la guarda UNA sola vez (tmdb_id es UNIQUE)
    // pero con las dos URLs: hay que visitarlas TODAS o los servidores de la fuente
    // absorbida no aparecen nunca. Ver migración 005.
    const knownSources = new Set<string>(
      [...(result._source_urls || []), result._source_url].filter((u): u is string => Boolean(u))
    );

    // B. URLs exactas de las fuentes (persistidas por el job): un detalle por fuente,
    //    en paralelo y sin búsqueda por título.
    if (knownSources.size > 0) {
      // El presupuesto de 2,5 s protege la latencia de "pulsar Reproducir", pero resolver una
      // ficha con 5 servidores no cabe ahí: se queda siempre a medias. En el camino `deep`
      // (job de pre-calentado) la latencia no importa y sí importa terminar, que es lo que
      // deja los enlaces —y su vídeo directo— escritos en la DB para las siguientes aperturas.
      // Y en `deep` se visitan más: con el tope de 4 una ficha con cinco fuentes dejaba la
      // quinta sin repasar nunca, así que ni aportaba sus servidores ni se la podía descartar.
      const details = await Promise.all(
        Array.from(knownSources).slice(0, opts.deep ? 8 : 4).map(async url => ({
          url,
          detail: await this.scrapeDetailWithTimeout(url, opts.deep ? 20000 : 2500)
        }))
      );
      // Esta lista se pobló durante meses aceptando cualquier candidato que se LLAMARA igual, así
      // que puede traer páginas de otra película (la ficha de "Sin salida" de 2024 tenía apuntadas
      // las de 2011, 2014, 2022 y la de "The Firm", que en es-MX se titula igual). La página que
      // acabamos de scrapear dice su año: si desmiente al de la ficha, sus servidores no son de
      // esta obra. No se le exige que el título coincida —los nombres regionales de la misma
      // película no se parecen: "En la tormenta" ES "Sin salida"—, solo que el año no lo desmienta.
      // Y las que son la página propia de otra ficha se caen aunque el año cuadre: ahí está el
      // resto de homónimos, los del MISMO año, que ninguna fecha puede separar.
      const deOtraFicha = await this.paginasDeOtraFicha(details.map(d => d.url), result);

      const intrusas = details.filter(d =>
        d.detail && !esPaginaPropia(result.id, d.url, result.type) &&
        (deOtraFicha.has(d.url) || anosIncompatibles(result, d.detail))
      );

      // Las intrusas se expulsan ANTES de adoptar nada, para que un embed que además sirviera una
      // fuente legítima no se pierda por el orden en que se recorrieron las páginas.
      for (const { url, detail } of intrusas) {
        knownSources.delete(url);            // y no se le vuelve a preguntar
        dropServers(detail!.servers);        // incluidos los que ya estaban guardados en la DB
      }
      // La principal puede haber sido justo una de ellas: la ficha se queda con la primera suya.
      if (result._source_url && !knownSources.has(result._source_url)) {
        result._source_url = Array.from(knownSources)[0];
      }

      for (const { detail } of details) {
        if (!detail || intrusas.some(i => i.detail === detail)) continue;
        addServers(detail.servers);
        adoptSeasons(detail.seasons);
      }
    }

    // B-bis. Sin source_url: el id de la fila SÍ resuelve por categoría contra la fuente.
    if (allServers.length === 0) {
      const fromSource = await this.resolveFromSource(result.id);
      addServers(fromSource?.servers);
      adoptSeasons(fromSource?.seasons);
    }

    // C. Fusión multifuente (TioPlus + FuegoCine) por título. Es el camino caro: solo cuando
    //    no hemos conseguido enlaces por las vías baratas, o cuando se pide explícitamente
    //    (`deep`, que usa el job de pre-calentado para dejar el set completo en la DB).
    //    Es también el ÚNICO camino lo bastante exhaustivo como para concluir que una ficha
    //    no tiene enlaces en ninguna parte (ver `exhaustive` más abajo).
    const exhaustive = (allServers.length === 0 && !opts.cheap) || Boolean(opts.deep);

    // Candidatos que se llamaban igual pero no se pudo demostrar que fueran esta obra. Mientras
    // haya alguno, la fusión no ha mirado todo lo que había: no autoriza el veredicto de fantasma.
    let indecidibles = 0;

    if (exhaustive) {
      // Candidatos por título de AMBAS fuentes (scrapeRealMovies itera tioplus + fuegocine).
      const candidates = await RealScraperService.scrapeRealMovies(result.title, 8).catch(() => [] as MediaItem[]);

      // Las que ya son de otra ficha se descartan antes de mirarles el año: es el único filtro que
      // pilla a los homónimos del MISMO año, y con títulos idénticos el año no separa nada.
      const deOtraFicha = await this.paginasDeOtraFicha(
        candidates.map(c => (c as any)._tioplus_url), result
      );

      const sourceUrls: string[] = [];
      for (const cand of candidates) {
        const url = (cand as any)._tioplus_url as string | undefined;

        // La página de la que SALIÓ la ficha no necesita demostrar nada: es suya. Importa porque
        // es la única de la que a veces no se puede sacar el año, y porque una ficha sin
        // `source_url` guardada (filas antiguas) la descubre justamente aquí.
        const esPropia = !!url && esPaginaPropia(result.id, url, result.type);

        if (!esPropia) {
          // Hay prueba de que es de otra obra: se descarta y NO cuenta como indecidible.
          if (url && deOtraFicha.has(url)) continue;
          const veredicto = mismaObra(result, cand);
          if (veredicto === 'sin-pruebas') indecidibles++;
          if (veredicto !== 'misma') continue;
        }

        if (url && !sourceUrls.includes(url)) sourceUrls.push(url);
        addServers(cand.servers);
        adoptSeasons(cand.seasons);
      }

      // Detalle (servidores) de cada URL de fuente en paralelo, con timeout acotado.
      const details = await Promise.all(sourceUrls.slice(0, 4).map(u => this.scrapeDetailWithTimeout(u)));
      for (const detail of details) {
        addServers(detail?.servers);
        adoptSeasons(detail?.seasons);
      }

      // Guardamos TODAS las URLs descubiertas, no solo la primera: son las fuentes que
      // aportan servidores a esta misma ficha, y la próxima resolución las reutiliza sin
      // volver a buscar por título.
      for (const url of sourceUrls) knownSources.add(url);
      if (!result._source_url && sourceUrls.length > 0) {
        result._source_url = sourceUrls[0];
      }
    }

    result._source_urls = Array.from(knownSources);

    // D. Serie sin servidores → resolver activamente S1:E1.
    const isSeries = result.type === 'tvseries' || (result.total_seasons != null && result.total_seasons > 0);
    if (isSeries && allServers.length === 0 && !opts.cheap) {
      try {
        const titleSlug = normalizeTitle(result.title || '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const ep1Detail = await RealScraperService.scrapeEpisodeDetail(titleSlug, 1, 1);
        // El slug se INVENTA a partir del título, así que la página que contesta puede ser otra
        // serie que se llame igual (los homónimos de "Drácula" son cuatro). `scrapeEpisodeDetail`
        // resuelve el tmdb_id de la serie que ha contestado de verdad: solo se adoptan sus
        // enlaces si es esta misma, o si el slug resultó ser literalmente el id de la ficha.
        const mismaSerie = titleSlug === result.id
          || (!!ep1Detail && ep1Detail.tmdb_id > 0 && result.tmdb_id > 0 && ep1Detail.tmdb_id === result.tmdb_id);
        if (mismaSerie) {
          addServers(ep1Detail?.servers);
        } else if (ep1Detail && ep1Detail.servers && ep1Detail.servers.length > 0) {
          indecidibles++;
        }
      } catch {}
    }

    /**
     * ANTES DE ENTREGAR: que el de arriba reproduzca de verdad.
     *
     * Lo que se ordenaba hasta aquí venía con el `status` que puso `inspectEmbed`, que solo mira
     * si el reproductor del host carga. Se puede cargar entero y no tener vídeo detrás — el caso
     * que lo destapó fue «Sin salida» (2024): su servidor #1 era un emturbovid cuyo maestro
     * respondía 200 y listaba dos calidades en dominios que ya no existen. La API lo entregaba
     * como `online` y como `primary_stream`, y su propio `/stream/direct` contestaba 502 al
     * intentarlo. O sea que ya lo sabíamos y aun así lo poníamos el primero.
     *
     * `revisarServidores` es la comprobación de reproducir aplicada a la lista: baja hasta un
     * segmento real, empezando por la cabeza y con tope de tiempo. Se ordena OTRA VEZ después
     * porque puede haber degradado servidores, y es el sorter quien recoloca lo que queda
     * `offline` y vuelve a sellar el nombre como `[Embed]`.
     *
     * En `deep` (el job de refresco, sin nadie esperando) se repasa más lista y sin parar en el
     * primero: es la pasada que deja el veredicto escrito en la DB para todas las aperturas
     * siguientes, y la única que puede resucitar lo que se marcó caído y ha vuelto.
     */
    /**
     * EL PRESUPUESTO TIENE QUE ALCANZAR PARA ENCONTRAR UNO QUE SIRVA, no solo para mirar tres.
     *
     * Eran 4 s y 3 sondas, heredados de cuando entregar un servidor sin comprobar era aceptable
     * —se publicaba igual y el cliente se las arreglaba—. Desde que solo sale lo que ha demostrado
     * entregar vídeo, quedarse a medias ya no significa «se entrega sin verificar»: significa que
     * la ficha sale VACÍA y desaparece del catálogo.
     *
     * Medido sobre «Milagro en la Celda 7» (6 servidores) y «Volver al Futuro 3» (8): el primero
     * de la lista estaba muerto, y con tres sondas la pasada se quedaba sin encontrar ninguno de
     * los que sí sirven. La película desaparecía teniendo cinco o siete servidores sin mirar.
     *
     * 9 s y hasta 8 sondas —por debajo del techo de la función, que no admite acercarse— y se
     * PARA en cuanto uno demuestra que reproduce: en el caso normal
     * —el primero funciona— sigue costando una sonda y no se nota. Solo se paga entero cuando la
     * cabeza está muerta, que es justo cuando merece la pena pagarlo. Y se paga una vez: el
     * resultado queda sellado y cacheado.
     */
    const revisados = await revisarServidores(sortServersBySourcePriority(allServers), opts.deep
      ? { presupuestoMs: 20000, maximo: 8, hastaElPrimeroUtil: false, resucitar: 2 }
      : { presupuestoMs: 9000, maximo: 8, objetivoSellados: 3 });

    result.servers = sortServersBySourcePriority(revisados);
    if (result.servers.length > 0) {
      result.primary_stream = getPrimaryStream(result.servers);
      result.streams_updated_at = new Date().toISOString();
    }

    await this.ensureSeasons(result);
    this.inheritServersToEpisodes(result);

    // Veredicto de disponibilidad: solo una resolución EXHAUSTIVA puede concluir que una
    // ficha no tiene enlaces en ninguna fuente. Es lo que permite dejar de anunciar en el
    // home y en la búsqueda títulos que nunca podrán reproducirse (fichas fantasma).
    //
    // Y solo si además fue CONCLUYENTE: si algún candidato homónimo se descartó por no poder
    // demostrar que fuera esta obra, puede que sus enlaces sí fueran suyos. Anotar "no tiene"
    // en ese caso escondería del catálogo una ficha reproducible; se deja sin comprobar y el
    // siguiente pase (con más datos en la fuente) lo decidirá.
    const veredictoFiable = exhaustive && indecidibles === 0;
    if (veredictoFiable) {
      result.has_streams = this.hasPlayableDirectStream(result);
      result.streams_checked_at = new Date().toISOString();
    }

    /**
     * NOTA: quien decide es `veredictoDisponibilidad` (ver persistStreams). Aquí solo se traduce
     * lo que se ha llegado a mirar: sin haber podido visitar ni una fuente no se concluye nada.
     *
     * `has_streams` solo se actualizaba tras una resolución EXHAUSTIVA, y el camino normal no lo
     * es. Así quedaba la peor incoherencia posible: la columna decía que sí y la respuesta llegaba
     * vacía, o sea un título en el catálogo cuyo botón de reproducir no tiene nada detrás. Lo
     * encontró el usuario con «Batman: El caballero de la noche» (2008) — un servidor sellado en la
     * base de datos, cero servidores en la respuesta, y la ficha anunciándose igual.
     *
     * Que la resolución llegara a visitar alguna fuente es lo que separa esto de un fallo de red:
     * sin haber podido preguntar a nadie no se concluye nada. Y equivocarse hacia «no hay» se
     * arregla solo — `--sin-directo` y `--series-ocultas` devuelven al catálogo lo que vuelva a
     * reproducir— mientras que equivocarse hacia «sí hay» se lo come el espectador.
     */
    // Sin haber podido visitar ni una fuente no se concluye nada: se deja el veredicto como estaba
    // y `persistStreams` no lo tocará. Ver `veredictoDisponibilidad`.
    const seMiroAlgo = knownSources.size > 0;

    if (result.servers.length > 0 || (result.seasons && result.seasons.length > 0)) {
      await this.cacheItem('byid', cacheKey, result, CACHE_TTL_SECONDS);
      if (result.servers.length > 0) {
        // Coherencia de caché: la ficha ya cacheada como metadata (TTL de 6 h) se escribió
        // ANTES de resolver los enlaces, con `servers: []`. Sin refrescarla aquí, el detalle
        // seguía anunciando `streams.status: "pending"` durante horas para un título cuyos
        // servidores ya conocemos.
        await this.cacheItem('meta', cacheKey, result, METADATA_TTL_SECONDS);
      }
    }

    // Write-through: la próxima apertura (incluso desde otra lambda) sale de la DB. Se
    // escribe TAMBIÉN cuando la búsqueda exhaustiva terminó sin enlaces: es justo ese
    // resultado negativo el que marca la ficha como fantasma, y sin guardarlo la API
    // repetiría la fusión multifuente completa en cada petición del mismo título.
    if (result.servers.length > 0 || exhaustive) {
      await this.guardarEnlaces(result, veredictoFiable, seMiroAlgo);
    }

    return result;
  }

  /**
   * Búsqueda en vivo con Caché en Memoria, Web Scraping y Unificación
   * Implementa ponderación por título, búsqueda por prefijos y ordenamiento por relevancia
   */
  /**
   * Pase local de PREFIJO sobre Supabase: ilike 'q%' con acentos normalizados.
   * Usa la columna title_normalized (migración 001, índice text_pattern_ops => milisegundos)
   * y cae a title si la columna aún no existe. Nunca lanza: si la DB no está poblada
   * simplemente aporta 0 candidatos y la búsqueda sigue dependiendo del scraping.
   */
  private static async searchDbByPrefix(query: string, limit: number = 30): Promise<MediaItem[]> {
    const nq = normalizeTitle(query).trim();
    if (!nq) return [];

    /**
     * Y CON EL MISMO FILTRO QUE EL RESTO DEL CATÁLOGO.
     *
     * Era la única consulta que se lo saltaba: la portada, los carruseles, el «ver todo» y la RPC
     * `search_media` exigen `has_streams = true`, y este `ilike` devolvía todo. Resultado: un
     * título retirado por no poder reproducirse seguía saliendo si lo buscabas por su nombre.
     * Lo encontró el usuario con Trollhunters — fuera de la portada y del catálogo, dentro del
     * buscador—. Una regla que se aplica en cuatro sitios de cinco no es una regla.
     */
    const hayColumna = await this.hasAvailabilityColumn();

    try {
      let query1 = supabase
        .from('media_items')
        .select('*')
        .ilike('title_normalized', `${nq}%`)
        .limit(limit);
      query1 = this.soloPublicables(query1, hayColumna);
      const { data, error } = await query1;
      // Si la columna existe (sin error), confiar en su resultado aunque venga vacío.
      if (!error) return (data || []).map(this.mapDbItemToMediaItem);
    } catch {}
    try {
      // Fallback: la columna title_normalized aún no existe en esta DB.
      let query2 = supabase
        .from('media_items')
        .select('*')
        .ilike('title', `${nq}%`)
        .limit(limit);
      query2 = this.soloPublicables(query2, hayColumna);
      const { data } = await query2;
      return (data || []).map(this.mapDbItemToMediaItem);
    } catch {}
    return [];
  }

  /**
   * Búsqueda pública (compat): devuelve solo la primera página de ítems.
   * Callers internos (getById) y scripts de dev siguen usando esta firma.
   */
  static async search(query: string, maxResults: number = 25): Promise<MediaItem[]> {
    const { items } = await this.searchPaged(query, 1, maxResults);
    return items;
  }

  /**
   * Búsqueda paginada DB-FIRST con total exacto (habilita el scroll infinito).
   *  - Catálogo poblado: sirve del RPC `search_media` (substring + prefijo, rankeado,
   *    con COUNT total) en milisegundos, SIN scraping ni TMDB en el request.
   *  - DB vacía / sin migrar: cae a un scrape en vivo LEAN (sin enriquecer ni resolver
   *    servidores por ítem) y pagina en memoria.
   */
  static async searchPaged(query: string, page: number = 1, limit: number = 25): Promise<{ items: MediaItem[]; total: number }> {
    const q = query.toLowerCase().trim();
    if (!q) return { items: [], total: 0 };

    const nq = normalizeTitle(q).trim();
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const safePage = Math.max(1, page);
    const offset = (safePage - 1) * safeLimit;

    const cacheKey = `searchp:direct-only:v1:${nq}:${safePage}:${safeLimit}`;

    /**
     * EL DESCUENTO DE RETIRADOS VA FUERA DEL CACHÉ, y ese orden es el que hace que sirva.
     *
     * Una búsqueda se guarda una hora. Si el filtro se aplicara antes de guardar, la lista
     * quedaría congelada con lo que se supiera en ese momento y el título que se cae diez minutos
     * después seguiría saliendo los cincuenta restantes — que es el mismo agujero que tiene la
     * portada, solo que más corto. Aplicándolo a la SALIDA, lo cacheado es la consulta (que es lo
     * caro) y la disponibilidad se resuelve en cada respuesta. Ver `sinRetirados`.
     */
    const cached = await CacheStore.get<{ items: MediaItem[]; total: number }>(cacheKey);
    if (cached) return { ...cached, items: await this.sinRetirados(cached.items) };

    // 1. DB-FIRST: RPC rankeado sobre el catálogo poblado (prefijo-primero + rating).
    const dbResult = await this.searchDbPaged(nq, safeLimit, offset);
    if (dbResult && dbResult.total > 0) {
      await CacheStore.set(cacheKey, dbResult, CACHE_TTL_SECONDS);
      return { ...dbResult, items: await this.sinRetirados(dbResult.items) };
    }

    /**
     * 2. NO HAY NADA. Y eso es una respuesta, no un motivo para salir a buscar por ahí.
     *
     * Aquí había un scrape EN VIVO de todas las fuentes. Tenía sentido cuando la base estaba
     * vacía y el buscador era la única forma de encontrar algo. Con el catálogo poblado hace dos
     * cosas malas a la vez, las dos medidas:
     *
     *   · TARDA 28,7 SEGUNDOS. Buscar «avatar» —que no está en el catálogo— se iba a recorrer
     *     las webs en vivo. Las que sí están tardan 1 s, y cacheadas 0,35.
     *   · Y DEVUELVE TÍTULOS QUE NO SE PUEDEN VER. Lo que sale de ese scrape no está en la base,
     *     así que no tiene url permanente comprobada: son exactamente las fichas fantasma que
     *     este modelo entero existe para no volver a tener. El buscador era la última puerta por
     *     la que seguían entrando.
     *
     * El catálogo solo anuncia lo que ha demostrado reproducir, y el buscador tiene que decir lo
     * mismo que el catálogo. Si no está, no está.
     */
    const vacio = { items: [] as MediaItem[], total: 0 };
    await CacheStore.set(cacheKey, vacio, CACHE_TTL_SECONDS);
    return vacio;
  }

  /**
   * Pase DB paginado vía RPC `search_media(q, lim, off)` (migración 002). Devuelve null
   * si el RPC no existe (DB sin migrar) o no hay coincidencias, para caer al scrape en vivo.
   */
  private static async searchDbPaged(nq: string, limit: number, offset: number): Promise<{ items: MediaItem[]; total: number } | null> {
    if (!nq) return null;
    try {
      const { data, error } = await supabase.rpc('search_media', { q: nq, lim: limit, off: offset });
      if (error || !data || (data as any[]).length === 0) return null;
      const rows = data as any[];
      const total = Number(rows[0].total) || rows.length;
      const items = rows.map(row => this.mapDbItemToMediaItem(row.item));
      return { items, total };
    } catch {
      return null;
    }
  }

  /**
   * Scrape en vivo LEAN para el fallback de búsqueda: une fuentes activas + pase de prefijo
   * en DB + substring del catálogo homepage, y agrupa SIN enriquecer con TMDB ni resolver
   * servidores por ítem (eso encarecía cada búsqueda). Ver unifyForSearch.
   */
  private static async liveSearch(q: string, max: number): Promise<MediaItem[]> {
    const normalizedMax = Math.max(1, max);
    const [realScraped, dbPrefixMatches] = await Promise.all([
      RealScraperService.scrapeRealMovies(q, normalizedMax),
      this.searchDbByPrefix(q)
    ]);
    const pool = [...realScraped, ...dbPrefixMatches];

    if (pool.length < normalizedMax) {
      // Substring insensible a acentos sobre el catálogo homepage (aporta 0 si está vacío).
      const nq = normalizeTitle(q);
      const catalogMatches = (await this.getAll()).filter(item => {
        const haystack = normalizeTitle([item.title, item.original_title, ...(item.aliases || [])].join(' '));
        return haystack.includes(nq);
      });
      pool.push(...catalogMatches);
    }

    const unificados = this.unifyForSearch(pool, normalizedMax).filter(item => this.esReproducible(item));

    /**
     * Y NO RESUCITAR LO QUE EL CATÁLOGO YA DESCARTÓ.
     *
     * Este camino solo corre cuando la RPC no encuentra nada, y encontraba menos justamente porque
     * `search_media` exige `has_streams = true`. O sea que el fallback se activaba SOBRE los
     * títulos retirados y los devolvía recién scrapeados de la fuente, con servidores que aún no
     * ha comprobado nadie. Trollhunters desaparecía de la portada y del catálogo y seguía saliendo
     * al buscarlo por su nombre.
     *
     * Lo que la fuente publique hoy no vuelve a poner en pie un título que el catálogo ya juzgó:
     * si vuelve a ser reproducible, lo dirá el verificador y `has_streams` se pondrá solo.
     */
    const ids = unificados.map(i => i.id).filter(Boolean);
    if (ids.length === 0) return unificados;
    try {
      const { data } = await supabase
        .from('media_items')
        .select('id')
        .in('id', ids)
        .eq('has_streams', false);
      const descartados = new Set((data || []).map((r: any) => r.id));
      if (descartados.size > 0) return unificados.filter(i => !descartados.has(i.id));
    } catch {}
    return unificados;
  }
  /**
   * Calcula el score de relevancia para cada resultado y ordena por puntaje descendente
   * Ponderación (Relevance Scoring) - PRIORIDAD AL TÍTULO VISIBLE QUE COMIENZA CON EL TÉRMINO:
   *   - Peso 200: El título visible (title) COMIENZA con la frase completa buscada (ej: "el c" -> "El Chavo", "El Calabozo")
   *   - Peso 150: Coincidencia EXACTA completa en title (título completo igual al query)
   *   - Peso 120: El título visible COMIENZA con la primera palabra del query
   *   - Peso 100: El título original (original_title) COMIENZA con la frase completa
   *   - Peso 80: Coincidencia exacta de palabra completa en original_title
   *   - Peso 50: Contiene la palabra completa en title u original_title
   *   - Peso 10: Coincidencia por prefijo débil
   *   - Peso 1: Coincidencia en overview/sinopsis o aliases
   */
  private static scoreAndSortResults(items: MediaItem[], query: string): MediaItem[] {
    const queryLower = query.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 0);

    const scored = items.map(item => {
      let score = 0;

      const titleLower = (item.title || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const originalTitleLower = (item.original_title || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const overviewLower = (item.overview || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const aliasesLower = (item.aliases || []).map(a => a.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));

      // --- PRIORIDAD MÁXIMA: El título visible COMIENZA con la frase completa buscada ---
      // Ej: Busca "el c" -> Match máximo para "El Chavo", "El Calabozo", "El Chavo Animado"
      if (titleLower.startsWith(queryLower)) {
        score = 200;
      }
      // --- PRIORIDAD MUY ALTA: Título visible comienza con la primera palabra del query ---
      else if (queryWords.length > 0 && titleLower.startsWith(queryWords[0])) {
        score = 120;
      }
      // --- PRIORIDAD MEDIA-ALTA: Título original comienza con la frase completa ---
      else if (originalTitleLower.startsWith(queryLower)) {
        score = 100;
      }
      // --- PRIORIDAD MEDIA: Coincidencia exacta en original_title ---
      else if (originalTitleLower === queryLower) {
        score = 80;
      }

      // Si ya tiene score alto por prefix match, no necesitamos sumar más
      if (score >= 100) {
        // Bonus pequeño por rating como desempate
        const popularityBonus = (item.rating || 0) / 1000;
        return { item, score: score + popularityBonus };
      }

      // Coincidencias por palabra (acumulativas) para el resto de candidatos.
      // Usa conjuntos de palabras en vez de RegExp dinámico (evita el bug de escape
      // y el SyntaxError con queries que contienen metacaracteres como "(").
      const titleWords = new Set(titleLower.split(/\s+/));
      const originalWords = new Set(originalTitleLower.split(/\s+/));
      for (const word of queryWords) {
        if (word.length < 2) continue;
        if (titleWords.has(word)) score += 50;             // palabra completa en title
        else if (originalWords.has(word)) score += 40;     // palabra completa en original_title
        else if (titleLower.includes(word)) score += 10;   // substring en title
        else if (originalTitleLower.includes(word)) score += 8;
        else if (aliasesLower.some(a => a.includes(word))) score += 2;
        else if (overviewLower.includes(word)) score += 1;
      }

      // Sin relevancia textual no se muestra (el rating por sí solo no basta para aparecer).
      if (score <= 0) return { item, score: 0 };
      // Desempate por rating, acotado a <= 0.01 para no cruzar de nivel.
      const popularityBonus = Math.min(Math.max(item.rating || 0, 0), 10) / 1000;

      return { item, score: score + popularityBonus };
    });

    // Ordenar por score descendente
    scored.sort((a, b) => b.score - a.score);

    // Filtrar solo items con score > 0 (que tengan alguna relevancia)
    return scored.filter(s => s.score > 0).map(s => s.item);
  }
  /**
   * Agrupa/dedup ítems de BÚSQUEDA por clave canónica (o tmdb_id si ya viene resuelto),
   * fusionando metadatos básicos. NO enriquece con TMDB ni resuelve servidores por ítem:
   * la búsqueda debe ser ultraligera (sin cast ni reproductores). El detalle completo
   * (servidores multifuente, temporadas, cast) se resuelve bajo demanda en getById.
   */
  private static unifyForSearch(items: MediaItem[], maxResults: number = 25): MediaItem[] {
    const grouped = new Map<string, MediaItem>();

    for (const item of items) {
      // Sin tmdb_id real la clave es el título… y el título SOLO agrupa homónimos que no tienen
      // nada que ver ("Carrie" son tres películas: 1976, 2002 y 2013). El año forma parte de la
      // clave para que cada estreno siga siendo un resultado propio.
      const key = (item.tmdb_id && item.tmdb_id > 0)
        ? `${item.type}:${item.tmdb_id}`
        : (canonicalTitleKey(item.title) || strictKey(item.title)
            ? `${item.type}:${canonicalTitleKey(item.title) || strictKey(item.title)}:${yearOf(item) || ''}`
            : item.id);
      if (!key) continue;

      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, { ...item });
      } else {
        existing.overview = existing.overview || item.overview;
        existing.poster = existing.poster || item.poster;
        existing.backdrop = existing.backdrop || item.backdrop;
        existing.release_date = existing.release_date || item.release_date;
        existing.rating = existing.rating || item.rating;
        existing.subcategories = Array.from(new Set([...(existing.subcategories || []), ...(item.subcategories || [])]));
        existing.aliases = Array.from(new Set([...(existing.aliases || []), ...(item.aliases || [])]));
      }
    }

    return Array.from(grouped.values()).slice(0, maxResults);
  }

  private static mapDbItemToMediaItem(dbRow: any): MediaItem {
    // El id de la fila ES el slug de la fuente (tioplus/fuegocine): el ÚNICO valor con el que
    // getById puede volver a resolver el detalle y los servidores. Derivarlo del título
    // ("Madagascar 3: Los Fugitivos" → "madagascar-3-los-fugitivos") devolvía en la búsqueda
    // un id que no existía en ninguna fuente y el detalle respondía 404.
    const sourceId = String(dbRow.id || '').trim();
    const titleSlug = slugify(dbRow.slug || dbRow.title || '');

    return {
      id: sourceId || titleSlug || String(dbRow.tmdb_id || ''),
      tmdb_id: dbRow.tmdb_id || 0,
      imdb_id: dbRow.imdb_id || null,
      type: dbRow.type,
      title: dbRow.title,
      original_title: dbRow.original_title || dbRow.title,
      aliases: dbRow.aliases || [dbRow.title],
      tagline: dbRow.tagline || '',
      overview: dbRow.overview || '',
      rating: dbRow.rating || 0.0,
      // Sin dato real preferimos omitirlo: el 'PG-13' fijo que se emitía antes era
      // simplemente falso para la mayoría del catálogo.
      content_rating: dbRow.content_rating || undefined,
      release_date: dbRow.release_date || '',
      genres: dbRow.genres || [],
      subcategories: dbRow.subcategories || [],
      poster: dbRow.poster || null,
      backdrop: dbRow.backdrop || null,
      logo: dbRow.logo || null,
      trailer: dbRow.trailer || null,
      cast: Array.isArray(dbRow.cast_data) ? dbRow.cast_data.map((c: any) => (typeof c === 'string' ? c : (c.name || ''))) : [],
      cast_details: Array.isArray(dbRow.cast_data) && typeof dbRow.cast_data[0] === 'object' ? dbRow.cast_data : undefined,
      dubbing_cast: dbRow.dubbing_cast_data || [],
      runtime: typeof dbRow.runtime === 'number' && dbRow.runtime > 0 ? dbRow.runtime : undefined,
      director: dbRow.director || undefined,
      metadata_source: dbRow.metadata_source === 'source' ? 'source' : 'tmdb',
      total_seasons: dbRow.total_seasons || 0,
      total_episodes: dbRow.total_episodes || 0,
      // Temporadas y enlaces persistidos por el job (migración 004): con ellos el detalle
      // se resuelve sin scraping en vivo.
      seasons: Array.isArray(dbRow.seasons) && dbRow.seasons.length > 0 ? dbRow.seasons : undefined,
      streams_updated_at: dbRow.streams_updated_at || null,
      // `has_streams` es TRI-estado: false ⇒ verificada sin enlaces; null/undefined ⇒ sin
      // comprobar. Traducirlo a booleano con `|| false` borraría justo esa distinción.
      has_streams: typeof dbRow.has_streams === 'boolean' ? dbRow.has_streams : undefined,
      streams_checked_at: dbRow.streams_checked_at || null,
      _source_url: dbRow.source_url || undefined,
      // Migración 005. Sin ella la columna no existe y se degrada a la URL única.
      _source_urls: Array.isArray(dbRow.source_urls) && dbRow.source_urls.length > 0
        ? dbRow.source_urls.filter(Boolean)
        : (dbRow.source_url ? [dbRow.source_url] : []),
      primary_stream: getPrimaryStream((dbRow.servers || []).map((s: any) => ({ ...s, source_id: s.source_id || 'supabase' }))),
      servers: sortServersBySourcePriority((dbRow.servers || []).map((s: any) => ({ ...s, source_id: s.source_id || 'supabase' }))),
    };
  }
}
