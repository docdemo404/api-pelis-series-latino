/**
 * hfpro — FICHEROS DIRECTOS, IDENTIDAD POBRE. La otra mitad exacta de lamoviebot.
 *
 * `hfprolatam.cursolatamsrc.workers.dev` (mismo desarrollador que lamoviebot: jjma49 / GATESCCN)
 * no publica metadata ninguna: publica DOS LISTAS M3U8 con rutas de fichero dentro de repositorios
 * de HuggingFace, y el worker hace de puerta.
 *
 *   /?gatesccn    → películas
 *   /?gatesccn2   → series
 *
 * LO BUENO, y es mucho: son FICHEROS, no embeds. Medido el 2026-09-20 sobre un .mkv real:
 * responde 206, respeta `Accept-Ranges`, y baja 1 MB de Matroska de verdad. La url del worker es
 * ESTABLE y **no va atada a IP** —la firma de AWS que hay al final del salto solo lleva `Expires`,
 * sin condición de dirección—, así que lo que se guarda hoy sirve mañana. Es la misma propiedad
 * que pone a Internet Archive en prioridad 2 y que no tiene ninguna fuente de embeds.
 *
 * LO MALO: **el nombre del fichero es TODA la identidad que hay.** No hay `tmdb_id`, ni título
 * original, ni año fiable, ni imagen. O sea que aquí FUENTES.md §1 aplica ENTERO y la identidad la
 * tiene que demostrar nuestro propio matcher (`resolveTmdb`), exigiendo `verified`. Es la misma
 * clase que archive.org, y por eso reutiliza su limpiador de nombres (`tituloDeArchive`) en vez de
 * inventarse otro.
 *
 * ── LA ESTRUCTURA, que es sorprendentemente regular ──────────────────────────────────────────
 *
 * Los 13.430 episodios tienen EXACTAMENTE cinco tramos, y la temporada siempre se llama igual:
 *
 *     SERIES/<CATEGORIA>/<Serie_Nombre_Año>/TEMPORADA<n>/<fichero>
 *     SERIES/SERIES_AMC/Mad_Men_2007/TEMPORADA1/Mad_Men_S01E04_New_Amsterdam.mp4
 *
 * Eso da DOS señales del número de temporada —la carpeta y el nombre del fichero— y conviene
 * usarlas las dos: FUENTES.md avisa de que rellenar un capítulo con el vídeo de otro es «el fallo
 * peor sin dar error», y aquí se puede comprobar gratis que las dos coincidan.
 *
 * ── LA LISTA DE PELÍCULAS ESTÁ SUCIA, y hay que saberlo ──────────────────────────────────────
 *
 * De sus 125 entradas solo 99 son películas. 16 son SERIES mal archivadas ahí, y el resto son
 * restos del que sube: `test.mp4`, `testa`, `localxd.mp4`, `sniffer_1782358496316_SD.mp4`,
 * `fb_video_1782343151536_SD.mp4`. Esa última clase es la peligrosa — un nombre sin título que un
 * matcher por parecido le colgaría a cualquier película. Se descartan en `esBasura`.
 */
import { httpClient } from '../utils/httpClient';
import { tituloDeArchive } from '../services/realScraperService';

export const BASE_HFPRO = 'https://hfprolatam.cursolatamsrc.workers.dev';

export const UA_NAVEGADOR =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Las dos listas, tal y como las nombra su propia portada. */
const LISTAS = { peliculas: '?gatesccn', series: '?gatesccn2' } as const;

/**
 * RESTOS DEL QUE SUBE, no obras. Se descartan antes de que los vea ningún matcher.
 *
 * `fb_video_1782343151536_SD.mp4` no tiene título que emparejar: lo que tiene es una marca de
 * tiempo. Dejarlo pasar es invitar a `resolveTmdb` a que le encuentre parecido con ALGO, que es
 * exactamente cómo se cuelan fichas con la identidad de otra obra.
 */
export function esBasura(ruta: string): boolean {
  const f = (String(ruta || '').split('/').pop() || '').toLowerCase();
  if (!f) return true;
  return (
    /^(test|testa|localxd|prueba)\b/.test(f) ||
    /^(fb_video|sniffer)_\d+/.test(f) ||
    /^\d+_sd\./.test(f) ||
    f.length < 5
  );
}

/** Etiquetas de edición que no son parte del nombre de la obra. */
const RUIDO = new Set([
  'DUAL', 'LAT', 'LATINO', 'CAST', 'SUB', 'SUBS', 'ESP', 'ENG', 'VOSE',
  'HD', 'FHD', 'UHD', '4K', '1080P', '720P', '2160P', 'SD',
  'WEB', 'WEBRIP', 'WEBDL', 'BLURAY', 'BRRIP', 'HDRIP', 'DVDRIP', 'REMUX', 'EXTENDED', 'UNRATED',
]);

/**
 * Título y año a partir de un nombre con guiones bajos.
 *
 * `Avatar_3_Fuego_y_Cenizas_DUAL_2025` → «Avatar 3 Fuego y Cenizas», 2025
 * `That_70_s_Show_Aquellos_Maravillosos_70_s_1998` → «That 70 s Show Aquellos Maravillosos 70 s», 1998
 *
 * El año se toma SOLO del final: «Blade Runner 2049», «Madrid 1987» y «Cherry 2000» llevan el año
 * DENTRO del título, y FUENTES.md los pone como trampa conocida. Un número de cuatro cifras en
 * medio se queda donde está.
 */
export function tituloYAnio(crudo: string): { titulo: string; anio: number } {
  const base = String(crudo || '').replace(/\.(mkv|mp4|avi|m4v|ts)$/i, '');
  const trozos = base.split('_').filter(Boolean);

  let anio = 0;
  // Solo el ÚLTIMO trozo puede ser el año, y solo si lo es de verdad.
  while (trozos.length > 1 && RUIDO.has(trozos[trozos.length - 1].toUpperCase())) trozos.pop();
  const ultimo = trozos[trozos.length - 1];
  if (ultimo && /^(19|20)\d{2}$/.test(ultimo)) {
    anio = Number(ultimo);
    trozos.pop();
  }

  const limpios = trozos.filter((t) => !RUIDO.has(t.toUpperCase()));
  // Se pasa por el limpiador de archive.org: es la misma clase de nombre y ya sabe quitar
  // corchetes, paréntesis de director y sufijos de edición. Llamar, no copiar.
  return { titulo: tituloDeArchive(limpios.join(' ')).trim(), anio };
}

/**
 * Temporada y episodio del nombre del fichero. Admite las DOS formas que publica:
 *
 *     Mad_Men_S01E04_New_Amsterdam.mp4   → T1 E4
 *     S1E12_You_are_Ms_Servant.mp4       → T1 E12
 */
export function temporadaYEpisodio(fichero: string): { temporada: number; episodio: number } | null {
  const m = String(fichero || '').match(/S(\d{1,2})[._\s-]?E(\d{1,3})/i);
  if (!m) return null;
  return { temporada: Number(m[1]), episodio: Number(m[2]) };
}

/** El número que declara la carpeta `TEMPORADA<n>`. Es la segunda señal, y sirve de control. */
export function temporadaDeCarpeta(carpeta: string): number {
  const m = String(carpeta || '').match(/TEMPORADA\s*(\d{1,2})/i);
  return m ? Number(m[1]) : 0;
}

export interface PeliculaHfpro {
  titulo: string;
  anio: number;
  url: string;
  ruta: string;
}

export interface EpisodioHfpro {
  temporada: number;
  episodio: number;
  url: string;
  ruta: string;
}

export interface SerieHfpro {
  /** El nombre de la carpeta, que es la llave de esta serie y su id estable. */
  carpeta: string;
  titulo: string;
  anio: number;
  categoria: string;
  episodios: EpisodioHfpro[];
}

async function bajarLista(cual: keyof typeof LISTAS): Promise<string[]> {
  const r = await httpClient.get(`${BASE_HFPRO}/${LISTAS[cual]}`, {
    // La de series pesa 4,3 MB y no la sirve un CDN de borde.
    timeout: 180000,
    responseType: 'text',
    transformResponse: [(d: unknown) => d],
    headers: { 'User-Agent': UA_NAVEGADOR },
    validateStatus: () => true,
  });
  if (r.status !== 200 || typeof r.data !== 'string') throw new Error(`hfpro ${cual} → HTTP ${r.status}`);

  /**
   * La ruta se lee del `#EXTINF`, no de la línea de url — y esa decisión importa.
   *
   * La url es del worker y lleva el sha del commit dentro
   * (`/datasets/usuario/repo/resolve/<sha>/<ruta>`), así que cambia cada vez que el dueño sube
   * algo aunque el fichero sea el mismo. El `#EXTINF` trae la RUTA, que es lo estable y lo que
   * identifica a la obra. Se emparejan por posición: `#EXTINF` y su url van siempre en ese orden.
   */
  const lineas = r.data.split('\n').map((l) => l.trim());
  const out: string[] = [];
  for (let i = 0; i < lineas.length; i++) {
    if (!lineas[i].startsWith('#EXTINF:')) continue;
    const ruta = lineas[i].split(',').slice(1).join(',').trim();
    const url = (lineas[i + 1] || '').trim();
    if (!ruta || !url.startsWith('http')) continue;
    out.push(`${ruta}\t${url}`);
  }
  return out;
}

/**
 * Las películas de verdad de su lista de películas.
 *
 * Se filtra la basura Y lo que en realidad son series: 16 de sus 125 entradas viven bajo
 * `SERIES/`, y tratarlas como películas las haría buscar en el catálogo de películas de TMDB —
 * que no da un 404, da los datos de OTRA obra (FUENTES.md §1, la clase forma parte de la
 * identidad).
 */
export async function listarPeliculas(): Promise<PeliculaHfpro[]> {
  const out: PeliculaHfpro[] = [];
  for (const linea of await bajarLista('peliculas')) {
    const [ruta, url] = linea.split('\t');
    if (!ruta || esBasura(ruta)) continue;
    if (/^SERIES\//i.test(ruta)) continue;
    const { titulo, anio } = tituloYAnio(ruta.split('/').pop() || '');
    if (!titulo) continue;
    out.push({ titulo, anio, url, ruta });
  }
  return out;
}

/**
 * Las series, agrupadas por su carpeta.
 *
 * La carpeta es la llave y no el título: dos carpetas distintas pueden limpiar al mismo título
 * (una con año y otra sin él) y fundirlas aquí sería juntar dos obras por parecido de nombre, que
 * es precisamente lo que este repositorio prohíbe. Que sean la misma lo decidirá el matcher más
 * adelante, con el año delante.
 */
export async function listarSeries(): Promise<SerieHfpro[]> {
  const porCarpeta = new Map<string, SerieHfpro>();

  for (const linea of await bajarLista('series')) {
    const [ruta, url] = linea.split('\t');
    if (!ruta || esBasura(ruta)) continue;
    const tramos = ruta.split('/');
    // SERIES / CATEGORIA / Serie_Año / TEMPORADA<n> / fichero
    if (tramos.length < 5) continue;
    const [, categoria, carpeta, carpetaTemp, fichero] = tramos;

    const delFichero = temporadaYEpisodio(fichero);
    if (!delFichero) continue;

    /**
     * LAS DOS SEÑALES DE TEMPORADA TIENEN QUE COINCIDIR.
     *
     * La carpeta dice `TEMPORADA4` y el fichero dice `S04E06`. Cuando discrepan no se elige una:
     * se descarta el episodio. Colgar un vídeo del capítulo equivocado es «el fallo peor sin dar
     * error» de FUENTES.md —pides el 1 y ves otro, y nadie se entera porque hay vídeo— y aquí
     * cuesta cero defenderse porque la fuente dice el número dos veces.
     */
    const deCarpeta = temporadaDeCarpeta(carpetaTemp);
    if (deCarpeta && deCarpeta !== delFichero.temporada) continue;

    const ya = porCarpeta.get(carpeta);
    const episodio: EpisodioHfpro = { ...delFichero, url, ruta };
    if (ya) ya.episodios.push(episodio);
    else {
      const { titulo, anio } = tituloYAnio(carpeta);
      if (!titulo) continue;
      porCarpeta.set(carpeta, { carpeta, titulo, anio, categoria, episodios: [episodio] });
    }
  }

  for (const s of porCarpeta.values()) {
    s.episodios.sort((a, b) => a.temporada - b.temporada || a.episodio - b.episodio);
  }
  return [...porCarpeta.values()];
}

/** ¿Es de esta fuente esta url? Para `candidateIdsForUrl` y para reconocer lo ya guardado. */
export function esUrlDeHfpro(url: string): boolean {
  return /hfprolatam\.[a-z0-9.-]+\.workers\.dev\/datasets\//i.test(url || '');
}

/**
 * El id de fila. Lleva la carpeta dentro porque es lo único estable que publica la fuente: la url
 * cambia con cada commit del repositorio y el título lo pone después TMDB.
 */
export function idDeFicha(tipo: 'movie' | 'tvseries', llave: string): string {
  const s = llave.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return tipo === 'movie' ? `hf-${s}` : `hf-tv-${s}`;
}
