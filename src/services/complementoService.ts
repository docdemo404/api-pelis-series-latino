import axios from 'axios';
import { ContentType } from '../types';

/**
 * LO QUE TMDB NO TIENE.
 *
 * No es un segundo TMDB: es el plan B para los huecos que TMDB no va a rellenar. La medición que
 * justifica que exista está en `scripts/dev/diag_hueco_tmdb.ts`, y dice esto: de los campos vacíos
 * del catálogo (23,5 % sin logo, 21,8 % sin tráiler, 20 % sin clasificación, 17,7 % sin duración),
 * al volver a preguntarle a TMDB SIN filtros solo el 8 % existía allí. El otro 92 % es hueco de
 * TMDB de verdad — el catálogo está lleno de cine argentino y venezolano viejo cuya ficha en TMDB
 * existe pero está vacía, y por mucho que se reintente seguirá vacía.
 *
 * De ahí el reparto de esta cascada:
 *
 *   · Wikidata + Wikipedia en español → sinopsis, duración, director, imdb_id. Sin clave, sin
 *     cupo, y ya en español, que es justo lo que le falta a las 27 fichas cuya sinopsis se quedó
 *     en inglés. Medido sobre esas 27: 16 tienen artículo en español.
 *   · Fanart.tv → logos, que es el único campo donde no hay alternativa textual. Pide una clave
 *     gratuita (FANART_API_KEY); sin ella el paso se salta solo y no rompe nada.
 *
 * Lo que NO hace: elegir. Aquí se busca y se devuelve lo que haya; quién gana y qué se escribe lo
 * decide `scripts/rellenarMetadatos.ts`, que es el que sabe qué campo estaba vacío.
 */

const UA = 'api-pelis-latino/1.0 (catalogo de peliculas; complemento de metadata)';

/** Propiedades de Wikidata que publican el id de TMDB. */
const P_TMDB_PELICULA = 'P4947';
const P_TMDB_SERIE = 'P4983';

/** Títulos de sección de Wikipedia que contienen el ARGUMENTO, en el orden en que se prefieren. */
const SECCIONES_DE_TRAMA = ['sinopsis', 'argumento', 'trama', 'resumen'];

/** Una sinopsis por debajo de esto no es una sinopsis: es un pie de foto. */
const MINIMO_SINOPSIS = 80;

export interface DatosWikidata {
  /** URL del artículo en es.wikipedia.org, si existe. */
  articuloEs: string | null;
  /** Duración en minutos (P2047). */
  duracion: number | null;
  /** Director (P57), ya etiquetado en español. */
  director: string | null;
  /** Id de IMDb (P345), que la tabla tiene columna para guardar y casi nunca rellena. */
  imdbId: string | null;
  /** El identificador Qxxxx, para poder citar de dónde salió el dato. */
  entidad: string;
}

export interface SinopsisEs {
  texto: string;
  /** URL del artículo. Wikipedia es CC BY-SA: sin esto no se puede atribuir. */
  url: string;
  /** `true` si viene de una sección de trama; `false` si es la entradilla del artículo. */
  esArgumento: boolean;
}

const cacheWikidata = new Map<string, DatosWikidata | null>();
const cacheSinopsis = new Map<string, SinopsisEs | null>();

async function pedir(url: string, params: any, timeout = 20000): Promise<any> {
  const res = await axios.get(url, {
    params,
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    timeout,
    validateStatus: () => true,
  });
  return res.status >= 200 && res.status < 300 ? res.data : null;
}

export class ComplementoService {
  /**
   * Del id de TMDB a la ficha de Wikidata.
   *
   * Se entra por el id y no por el título a propósito: buscar «Caribe» por nombre en Wikipedia
   * devuelve el mar, la región y una decena de homónimos, y ya se ha pagado una vez el precio de
   * emparejar por parecido de títulos (ver la escalera de `resolveTmdb`). El id de TMDB está
   * publicado en Wikidata como propiedad, así que el enlace es exacto o no es.
   *
   * OJO con la propiedad: las películas son P4947 y las series P4983. Son catálogos distintos con
   * numeración propia que se repite entre sí, igual que en el propio TMDB.
   */
  static async porTmdbId(tmdbId: number, tipo: ContentType): Promise<DatosWikidata | null> {
    const clave = `${tipo}:${tmdbId}`;
    if (cacheWikidata.has(clave)) return cacheWikidata.get(clave)!;

    const prop = tipo === 'tvseries' ? P_TMDB_SERIE : P_TMDB_PELICULA;
    const sparql = `SELECT ?item ?articulo ?duracion ?imdb ?directorLabel WHERE {
      ?item wdt:${prop} "${tmdbId}" .
      OPTIONAL { ?item wdt:P2047 ?duracion }
      OPTIONAL { ?item wdt:P345 ?imdb }
      OPTIONAL { ?item wdt:P57 ?director }
      OPTIONAL { ?articulo schema:about ?item ; schema:isPartOf <https://es.wikipedia.org/> }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "es". }
    } LIMIT 1`;

    let salida: DatosWikidata | null = null;
    try {
      const data = await pedir('https://query.wikidata.org/sparql', { query: sparql, format: 'json' });
      const fila = data?.results?.bindings?.[0];
      if (fila) {
        // P2047 llega en minutos, pero a veces con decimales ("94.0").
        const min = fila.duracion?.value ? Math.round(Number(fila.duracion.value)) : null;
        salida = {
          articuloEs: fila.articulo?.value || null,
          duracion: min && min > 0 && min < 2000 ? min : null,
          director: fila.directorLabel?.value || null,
          imdbId: /^tt\d+$/.test(fila.imdb?.value || '') ? fila.imdb.value : null,
          entidad: String(fila.item?.value || '').split('/').pop() || '',
        };
      }
    } catch { /* Wikidata caído o lento: el complemento es opcional por definición */ }

    cacheWikidata.set(clave, salida);
    return salida;
  }

  /**
   * El ARGUMENTO del artículo en español, no su entradilla.
   *
   * La diferencia importa más de lo que parece. La entradilla de Wikipedia es catalográfica —«es
   * una película argentina filmada en colores dirigida por Raúl de la Torre»— y puesta en la ficha
   * se lee como un pie de museo: dice quién la hizo, no de qué va. La sección «Sinopsis» del mismo
   * artículo sí cuenta la película. Se prefiere esa y solo se cae a la entradilla cuando el
   * artículo no tiene ninguna sección de trama, porque una entradilla en español informa más que
   * una sinopsis en inglés, que es contra lo que se compite aquí.
   */
  static async sinopsisEnEspanol(articuloEs: string): Promise<SinopsisEs | null> {
    if (cacheSinopsis.has(articuloEs)) return cacheSinopsis.get(articuloEs)!;

    let salida: SinopsisEs | null = null;
    try {
      const titulo = decodeURIComponent((articuloEs.split('/wiki/')[1] || '').replace(/_/g, ' '));
      if (titulo) {
        const data = await pedir('https://es.wikipedia.org/w/api.php', {
          action: 'query', prop: 'extracts', explaintext: 1, format: 'json', redirects: 1, titles: titulo,
        }, 15000);
        const pagina: any = Object.values(data?.query?.pages || {})[0];
        const completo: string = (pagina?.extract || '').trim();

        if (completo) {
          // El extracto en texto plano conserva los títulos como «== Sinopsis ==», así que el
          // artículo se puede partir en secciones sin analizar wikitexto ni HTML.
          const trozos = completo.split(/\n==+\s*([^=\n]+?)\s*==+\n/);
          const entradilla = (trozos[0] || '').trim();
          let argumento = '';
          for (let i = 1; i < trozos.length; i += 2) {
            const nombre = (trozos[i] || '').toLowerCase().trim();
            if (SECCIONES_DE_TRAMA.includes(nombre)) {
              const cuerpo = (trozos[i + 1] || '').trim();
              if (cuerpo.length >= MINIMO_SINOPSIS) { argumento = cuerpo; break; }
            }
          }
          const texto = argumento || entradilla;
          if (texto.length >= MINIMO_SINOPSIS) {
            salida = { texto: recortar(texto), url: articuloEs, esArgumento: !!argumento };
          }
        }
      }
    } catch { /* idem: opcional */ }

    cacheSinopsis.set(articuloEs, salida);
    return salida;
  }

  /**
   * Logo tipográfico de Fanart.tv.
   *
   * Es el único banco de logos que existe fuera de TMDB, y el logo es el único de los campos que
   * faltan sin alternativa textual: una duración se puede sacar de Wikidata, un logo no se escribe.
   *
   * Necesita FANART_API_KEY (personal y gratuita). Sin ella devuelve null y no se avisa por ficha:
   * el que llama lo dice una vez.
   *
   * Y OJO con cómo se indexa cada catálogo: las películas van por id de TMDB o de IMDb, pero las
   * SERIES van por id de TheTVDB, que es otro número distinto. Ese número lo publica el propio
   * TMDB en `/tv/{id}/external_ids`, así que se pide ahí antes de preguntar.
   */
  static async logoFanart(tmdbId: number, tipo: ContentType, tmdbApiKey: string): Promise<string | null> {
    const clave = process.env.FANART_API_KEY;
    if (!clave) return null;

    try {
      let ruta: string;
      if (tipo === 'tvseries') {
        const ext = await pedir(`https://api.themoviedb.org/3/tv/${tmdbId}/external_ids`, { api_key: tmdbApiKey }, 8000);
        const tvdb = ext?.tvdb_id;
        if (!tvdb) return null;
        ruta = `https://webservice.fanart.tv/v3/tv/${tvdb}`;
      } else {
        ruta = `https://webservice.fanart.tv/v3/movies/${tmdbId}`;
      }

      const data = await pedir(ruta, { api_key: clave }, 12000);
      if (!data) return null;

      const candidatos: any[] = [
        ...(data.hdmovielogo || []), ...(data.hdtvlogo || []),
        ...(data.movielogo || []), ...(data.clearlogo || []),
      ].filter(l => l?.url);
      if (candidatos.length === 0) return null;

      // Mismo criterio que `pickLogo` en TMDB: español, luego inglés, luego alfabeto latino.
      // Un logo en cirílico o en kana no es una alternativa al texto: es peor que el texto.
      const porIdioma = (lang: string) => candidatos.find(l => l.lang === lang);
      const elegido = porIdioma('es') || porIdioma('en')
        || candidatos.find(l => ['pt', 'it', 'fr', 'ca', 'gl', ''].includes(l.lang || ''));
      return elegido?.url || null;
    } catch {
      return null;
    }
  }
}

/**
 * Una sinopsis de ficha no son cinco párrafos.
 *
 * Las secciones de trama de Wikipedia llegan a contar la película entera, final incluido, y eso en
 * la portada de la app ni cabe ni se quiere leer. Se corta por el final de FRASE más cercano al
 * tope para no dejar la última a medias.
 */
function recortar(texto: string, tope = 700): string {
  const limpio = texto.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (limpio.length <= tope) return limpio;
  const cortado = limpio.slice(0, tope);
  const fin = cortado.lastIndexOf('. ');
  return (fin > tope * 0.5 ? cortado.slice(0, fin + 1) : cortado.trimEnd() + '…').trim();
}
