/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PONERLE SUBTÍTULOS A LO QUE NO TRAE NINGUNO
 *
 * Coge lo primero de la cola, consigue su audio y sale de ahí con texto sincronizado. Por dentro
 * son dos caminos de coste muy distinto, y el orden entre ellos es lo que hace que esto sea
 * viable con un runner gratis:
 *
 *   1. ¿Hay un fichero público? Se baja y se COMPRUEBA contra el audio de esta copia —tres
 *      ventanas de un minuto— para saber si es de este montaje o de otro. Un minuto de máquina.
 *   2. Si no hay, o no encaja, se escucha la película entera. Decenas de minutos.
 *
 * ── EL INGLÉS TIENE REGLA PROPIA ───────────────────────────────────────────────────────────
 *
 * Lo que se pidió del inglés es que sea LO QUE SE HABLA, y un subtítulo escrito por una persona
 * está condensado: resume las frases largas, se salta muletillas y los de sordos meten
 * acotaciones. Así que ahí el fichero público es solo el parche mientras la transcripción llega,
 * y la ficha NO sale de la cola hasta que existe la transcripción de verdad.
 *
 * En español no: un público bien sincronizado cumple de sobra y cierra el trabajo, que es lo que
 * deja las horas del runner para lo que no tiene nada.
 *
 *   npx ts-node -T scripts/subtitular.ts [--apply] [--minutos=N] [--limite=N] [--llenar=N]
 *                                        [--solo=<media_id>]
 *
 * Sin `--apply` no escribe: dice lo que haría.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import 'dotenv/config';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { enlaceDirecto, paraElCliente } from '../src/services/streamSorter';
import { medirEncaje } from '../src/services/subtitulos/encaje';
import { correrEnElTiempo, escribirVtt, leerSubtitulo, type Linea } from '../src/services/subtitulos/formato';
import { buscarPublicos, descargarPublico } from '../src/services/subtitulos/publicos';
import { noMorirPorUnCorteDeRed } from '../src/utils/seguirVivo';

// Un socket que se muere no puede llevarse por delante el barrido entero. Ver ahi.
noMorirPorUnCorteDeRed();

const apply = process.argv.includes('--apply');
const numero = (nombre: string, porDefecto: number) =>
  Number((process.argv.find(a => a.startsWith(`--${nombre}=`)) || '').split('=')[1]) || porDefecto;
const texto = (nombre: string) =>
  (process.argv.find(a => a.startsWith(`--${nombre}=`)) || '').split('=')[1] || null;

/** Presupuesto de la corrida. Por debajo del `timeout-minutes` del trabajo, con margen. */
const MINUTOS = numero('minutos', 300);
const LIMITE = numero('limite', 20);

/** Las tres ventanas del sondeo, en fracción de la película. Ver `encaje.ts`. */
const VENTANAS = [0.15, 0.5, 0.8];
const VENTANA_SEGUNDOS = 60;

/** Los dos que se persiguen. El primero manda: es el que se pidió. */
const IDIOMAS = ['en', 'es'] as const;
type Idioma = (typeof IDIOMAS)[number];

const NOMBRE_DEL_IDIOMA: Record<Idioma, string> = { en: 'Inglés', es: 'Español' };

/**
 * Lo que se le añade a la etiqueta para que nadie confunda esto con un subtitulo de fabrica.
 *
 * Se quito y se volvio a poner a peticion, y la segunda vez tiene mas razon: estas pistas no son
 * lo mismo que las que trae el fichero. Un subtitulo automatico se equivoca en nombres propios y
 * en frases sueltas, y quien lo lee tiene derecho a saber lo que esta leyendo antes de extrañarse.
 */
const SELLO_DE_ORIGEN = ' (Generado automáticamente)';

const supabase = getSupabaseAdmin();

// ── Herramientas ──────────────────────────────────────────────────────────────────────────

function correr(programa: string, args: string[], recogerSalida: boolean): Promise<string> {
  return new Promise((resolver, rechazar) => {
    const hijo = spawn(programa, args, { stdio: ['ignore', recogerSalida ? 'pipe' : 'inherit', 'inherit'] });
    let salida = '';
    hijo.stdout?.on('data', trozo => { salida += trozo; });
    hijo.on('error', rechazar);
    hijo.on('close', codigo => {
      if (codigo === 0) resolver(salida);
      else rechazar(new Error(`${programa} terminó con ${codigo}`));
    });
  });
}

/**
 * Saca a un fichero local SOLO el audio, y solo el trozo que se pida.
 *
 * `-ss` va ANTES de `-i` a propósito: así ffmpeg salta con una petición de rango y se baja el
 * minuto que necesita en vez de la película entera para tirar el 99 %. Es lo que hace que
 * comprobar un subtítulo cueste segundos de red y no gigas.
 *
 * 16 kHz y mono porque es exactamente lo que Whisper escucha; darle más es tirar ancho de banda
 * para que el modelo lo tire después.
 */
async function sacarAudio(
  fuente: Audio,
  destino: string,
  desdeS?: number,
  duracionS?: number,
): Promise<void> {
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
  if (desdeS !== undefined) args.push('-ss', String(desdeS));
  args.push('-i', fuente.url);
  if (duracionS !== undefined) args.push('-t', String(duracionS));
  if (fuente.mapa) args.push('-map', fuente.mapa);
  args.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', destino);

  await correr('ffmpeg', args, false);
}

/** De donde sacar el audio y, si hizo falta elegir, cual se eligio. */
interface Audio {
  url: string;
  mapa?: string;
  idioma?: string;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PISTA DE AUDIO QUE HAY QUE ESCUCHAR — Y SI HAY INGLES, LA INGLESA
 *
 * Esto es lo que decide si el subtitulo sale en el idioma que se pidio. La primera corrida real
 * transcribio Breaking Bad y salio EN ESPAÑOL: el fichero traia las dos pistas y ffmpeg, sin que
 * nadie le dijera nada, cogio la primera. El ingles estaba ahi al lado.
 *
 * ── POR QUE NO SE HACE CON `-map ...:m:language:eng` ───────────────────────────────────────
 *
 * Porque no funciona sobre un HLS. Probado contra el manifiesto real:
 *
 *     ffmpeg -i main.m3u8 -map "0:a:m:language:eng?"  →  Error opening output files
 *
 * Los idiomas viven en el MANIFIESTO —`#EXT-X-MEDIA:TYPE=AUDIO,LANGUAGE="en"`— y no llegan a las
 * etiquetas de los flujos que `-map` sabe mirar.
 *
 * Asi que en HLS se lee el manifiesto y se apunta DIRECTAMENTE a la pista inglesa, que ademas
 * sale mucho mas barato: esa lista solo tiene audio. Lo de antes bajaba la variante entera —107 MB
 * de Breaking Bad— para tirar el video con `-vn`.
 *
 * En lo que no es HLS si vale preguntar por los flujos, que ahi las etiquetas si estan.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
async function pistaDeAudio(url: string): Promise<Audio> {
  const preferido = 'en';

  if (/\.m3u8(\?|$)/i.test(url)) {
    const enElManifiesto = await pistaDelManifiesto(url, preferido);
    if (enElManifiesto) return enElManifiesto;
  } else {
    const entreLosFlujos = await pistaEntreLosFlujos(url, preferido);
    if (entreLosFlujos) return entreLosFlujos;
  }

  // Sin idioma declarado no se adivina: se coge lo que el fichero ofrezca por defecto y luego el
  // propio modelo dice en que se hablaba. Ver la nota de la transcripcion.
  return { url };
}

/** Las lineas `#EXT-X-MEDIA:TYPE=AUDIO` de un master de HLS, con su idioma y su direccion. */
async function pistaDelManifiesto(url: string, preferido: string): Promise<Audio | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const texto = await r.text();

    for (const linea of texto.split('\n')) {
      if (!/^#EXT-X-MEDIA:.*TYPE=AUDIO/i.test(linea)) continue;

      const idioma = /LANGUAGE="([^"]+)"/i.exec(linea)?.[1] || '';
      const destino = /URI="([^"]+)"/i.exec(linea)?.[1];
      if (!destino || !idioma.toLowerCase().startsWith(preferido)) continue;

      return { url: new URL(destino, url).toString(), idioma };
    }
  } catch {
    // Un manifiesto que no se puede leer no es un problema: se sigue por el camino de siempre.
  }
  return null;
}

/** Los flujos de audio de un fichero normal, preguntando a ffprobe por sus etiquetas. */
async function pistaEntreLosFlujos(url: string, preferido: string): Promise<Audio | null> {
  try {
    const crudo = await correr('ffprobe', [
      '-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=index:stream_tags=language',
      '-of', 'json', url,
    ], true);

    const flujos = (JSON.parse(crudo)?.streams || []) as Array<{ tags?: { language?: string } }>;
    const cual = flujos.findIndex(f => (f?.tags?.language || '').toLowerCase().startsWith(preferido));
    if (cual < 0) return null;

    return { url, mapa: `0:a:${cual}`, idioma: preferido };
  } catch {
    return null;
  }
}

/**
 * Una url que ffmpeg pueda abrir.
 *
 * Algunos servidores se sirven por NUESTRA API y su enlace sale como ruta relativa
 * —`/api/v1/stream/direct/...`—, que dentro de la app se completa sola con el host del catalogo.
 * Aqui no hay app: ffmpeg recibe eso y no sabe que hacer con ello. Si un titulo solo tuviera un
 * servidor de esos, fallaria con un error que no dice nada de la causa.
 */
function urlAbsoluta(url: string): string {
  if (!url.startsWith('/')) return url;
  const base = (process.env.API_PUBLIC_URL || 'https://api-pelis-series-latino-gilt.vercel.app')
    .replace(/\/$/, '');
  return base + url;
}

interface Transcripcion {
  idioma: string;
  seguridad: number;
  segundos_audio: number;
  segundos_maquina: number;
  modelo: string;
  lineas: Array<{ inicio: number; fin: number; texto: string }>;
}

async function transcribir(
  audio: string,
  opciones: { idioma?: string | null; contexto?: string | null; desde?: number }
): Promise<Transcripcion> {
  const args = [join(__dirname, 'subtitular', 'transcribir.py'), '--audio', audio];
  if (opciones.idioma) args.push('--idioma', opciones.idioma);
  if (opciones.contexto) args.push('--contexto', opciones.contexto);
  if (opciones.desde) args.push('--desde', String(opciones.desde));

  const crudo = await correr(process.env.PYTHON || 'python3', args, true);
  return JSON.parse(crudo);
}

const aLineas = (t: Transcripcion): Linea[] =>
  t.lineas.map(l => ({ desdeMs: Math.round(l.inicio * 1000), hastaMs: Math.round(l.fin * 1000), texto: l.texto }));

/**
 * LOS NOMBRES DEL REPARTO, COMO CONTEXTO PARA EL MODELO.
 *
 * Whisper acepta un texto de arranque y lo usa para decidir cómo se escribe lo que oye. Los
 * nombres propios son donde más canta una transcripción automática —los escribe de oído, y un
 * personaje puede aparecer con tres grafías distintas en la misma película—, y la ficha ya los
 * tiene guardados de TMDB. Es la mejora de precisión más barata que hay aquí: cuesta una columna
 * que ya estaba leída.
 */
function contextoDe(item: any): string | null {
  const reparto: string[] = (item?.cast_data || [])
    .slice(0, 12)
    .flatMap((p: any) => [p?.character, p?.name])
    .filter((n: any) => typeof n === 'string' && n.trim().length > 2);

  const partes = [item?.title, item?.original_title, ...reparto].filter(Boolean);
  if (!partes.length) return null;

  /*
   * SEPARADOS POR PUNTOS, NO POR COMAS. Y no es un detalle de formato.
   *
   * El contexto no solo le dice al modelo QUE nombres esperar: le dice COMO SE ESCRIBE aqui. El
   * modelo imita el estilo de lo que se le da, y una lista separada por comas y sin un solo punto
   * es exactamente el estilo que salio en la primera transcripcion real — texto corrido, sin
   * puntuar y sin mayusculas.
   *
   * Con puntos, el contexto ya enseña frases que empiezan en mayuscula y acaban en punto.
   *
   * Y NADA DE TEXTO PROPIO ALREDEDOR. La tentacion es escribir «Los personajes de esta serie son…»,
   * pero eso mete un idioma en el contexto, y cuando el audio esta en otro el modelo se
   * desconcierta — puede hasta arrastrar la deteccion de idioma. Solo nombres.
   */
  return partes.slice(0, 20).join('. ') + '.';
}

/** Lo que hace falta para ir a por el audio, y para pedir el subtitulo publico que le toca. */
interface Donde {
  urls: string[];
  /** Solo en series. Un banco publico necesita los dos numeros para dar el fichero correcto. */
  temporada?: number;
  capitulo?: number;
}

/**
 * La url reproducible de una ficha o de uno de sus capítulos.
 *
 * EL IDENTIFICADOR DE UN CAPITULO NO ESTA GUARDADO: SE CONSTRUYE. Esto buscaba `capitulo.id`
 * contra el id de la cola, y en la base los episodios no tienen ese campo —traen `season_number` y
 * `episode_number`—, asi que la comparacion no acertaba nunca y TODA serie habria fallado con «sin
 * url reproducible». Un fallo que no se habria visto hasta la primera serie, porque las peliculas
 * van por la otra rama.
 *
 * La regla vive en la app (`VodMapping.episodeId`) y es la que decide bajo que clave se guarda el
 * progreso, asi que tiene que ser exactamente la misma: `serie:s1e1`.
 */
function urlDe(item: any, episodioId: string): Donde | undefined {
  // TODOS, no solo el primero: cual sirve se decide despues, mirando quien tiene audio ingles.
  const todas = (servers: any) =>
    paraElCliente(servers).map(enlaceDirecto).filter((u): u is string => !!u);

  if (!episodioId) {
    const urls = todas(item?.servers);
    return urls.length ? { urls } : undefined;
  }

  for (const temporada of item?.seasons || []) {
    const numeroDeTemporada = Number(temporada?.season_number);
    for (const capitulo of temporada?.episodes || []) {
      const numeroDeCapitulo = Number(capitulo?.episode_number);
      if (`${item.id}:s${numeroDeTemporada}e${numeroDeCapitulo}` !== episodioId) continue;

      const urls = todas(capitulo?.servers);
      return urls.length ? { urls, temporada: numeroDeTemporada, capitulo: numeroDeCapitulo } : undefined;
    }
  }
  return undefined;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL SERVIDOR QUE TENGA LA PISTA INGLESA, NO EL PRIMERO QUE SALGA
 *
 * Una ficha suele tener varios servidores y NO son la misma copia: uno trae el doblaje y otro el
 * original con sus dos pistas. Cogiendo el primero, lo que sale depende del orden en que el
 * catalogo los devuelva ese dia — y ese orden cambia.
 *
 * Paso de verdad: la primera corrida cogio el servidor con audio ingles y transcribio en ingles;
 * la siguiente cogio otro, se quedo sin pista inglesa, y como ya existia la transcripcion española
 * dio el trabajo por hecho. El ingles no se llegaba a generar nunca.
 *
 * Asi que se preguntan por orden y se para en el primero que ofrezca ingles. Si ninguno lo tiene,
 * el primero que haya — que es lo que habia antes, pero ahora como ultimo recurso y no por azar.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
async function elegirAudio(urls: string[]): Promise<Audio> {
  let respaldo: Audio | null = null;

  for (const url of urls) {
    const pista = await pistaDeAudio(urlAbsoluta(url));
    if (pista.idioma === 'en') return pista;
    respaldo = respaldo || pista;
  }

  return respaldo || { url: urlAbsoluta(urls[0]) };
}

// ── Los dos caminos ───────────────────────────────────────────────────────────────────────

/**
 * Escucha tres minutos repartidos por la película. Es lo que se compara con un fichero público.
 *
 * Se transcribe SIN forzar idioma: de paso, esto es lo que averigua en qué está hablada la copia,
 * que decide todo lo demás. Una película que se anuncia en inglés y llega doblada al español no es
 * rara en este catálogo.
 */
async function sondear(fuente: Audio, duracionS: number, contexto: string | null, carpeta: string) {
  const trozos: Linea[] = [];
  let idioma = '';
  let seguridad = 0;

  for (const fraccion of VENTANAS) {
    const desde = Math.max(0, Math.round(duracionS * fraccion));
    const wav = join(carpeta, `ventana-${Math.round(fraccion * 100)}.wav`);

    await sacarAudio(fuente, wav, desde, VENTANA_SEGUNDOS);
    const t = await transcribir(wav, { contexto, desde });
    rmSync(wav, { force: true });

    trozos.push(...aLineas(t));
    // El idioma de la ventana en la que el modelo estuvo más seguro.
    if (t.seguridad > seguridad) { idioma = t.idioma; seguridad = t.seguridad; }
  }

  return { lineas: trozos, idioma, seguridad };
}

async function guardar(fila: {
  media_id: string;
  episodio_id: string;
  idioma: string;
  origen: 'transcrito' | 'traducido' | 'publico';
  contenido: string;
  modelo?: string | null;
  desfase_ms?: number | null;
  parecido?: number | null;
  segundos_audio?: number | null;
}) {
  if (!apply) return;
  const { error } = await supabase
    .from('subtitulos')
    /*
     * LA ETIQUETA ES EL IDIOMA A SECAS. Decia «Ingles (generado)» y se pidio quitarlo: quien abre
     * el menu esta eligiendo en que idioma leer, no auditando de donde salio el fichero. El origen
     * sigue guardado en su columna y la API lo entrega, asi que no se pierde — simplemente deja de
     * ocupar sitio en la unica linea que se lee con la pelicula corriendo.
     */
    .upsert(
      {
        ...fila,
        etiqueta: NOMBRE_DEL_IDIOMA[fila.idioma as Idioma] + SELLO_DE_ORIGEN,
        creado_en: new Date().toISOString(),
      },
      { onConflict: 'media_id,episodio_id,idioma' });
  if (error) throw new Error(`no se pudo guardar: ${error.message}`);
}

// ── El barrido ────────────────────────────────────────────────────────────────────────────

(async function main() {
  const hasta = Date.now() + MINUTOS * 60_000;
  console.log(`🎬 Subtitulando · presupuesto ${MINUTOS} min · ${apply ? 'ESCRIBIENDO' : 'ensayo'}\n`);

  const llenar = numero('llenar', 0);
  if (llenar && apply) {
    /*
     * RELLENAR LA COLA PARA QUE EL RUNNER NUNCA SE QUEDE PARADO.
     *
     * Lo que pide un espectador entra con prioridad, pero si nadie ha pedido nada esta noche la
     * máquina no tiene por qué dormirse: se meten fichas reproducibles que no tengan subtítulos,
     * con prioridad cero, y se van haciendo por debajo.
     */
    const { data } = await supabase
      .from('media_items')
      .select('id')
      .eq('has_streams', true)
      .limit(llenar);

    for (const fila of data || []) {
      await supabase.from('subtitulos_cola')
        .upsert({ media_id: fila.id, episodio_id: '', prioridad: 0 }, { onConflict: 'media_id,episodio_id', ignoreDuplicates: true });
    }
    console.log(`   cola rellenada con hasta ${llenar} ficha(s) sin pedir.\n`);
  }

  const soloUna = texto('solo');

  /*
   * `--solo` TIENE QUE PODER METER LA FICHA EN LA COLA, no solo filtrarla.
   *
   * Filtraba y ya: si la ficha no estaba en la cola, la consulta no devolvia nada y la corrida
   * terminaba diciendo «no hay nada pendiente» — sobre la ficha que le acababas de nombrar. O sea
   * que el unico modo pensado para probar una pelicula concreta no servia para probar una pelicula
   * concreta, salvo que alguien la hubiera pedido antes desde la app.
   *
   * Con prioridad alta porque es una peticion a mano: quien lanza esto con un nombre encima quiere
   * ESA, y quiere verla salir en el registro de esta corrida.
   */
  if (soloUna && apply) {
    /*
     * Y LE BORRA LOS INTENTOS FALLIDOS, que es lo que faltaba.
     *
     * La cola descarta lo que ha fallado tres veces, para no gastarse la ventana entera en el
     * mismo imposible. Perfecto para el barrido automatico y pesimo para este caso: nombrar una
     * pelicula a mano es, casi siempre, lo que se hace JUSTO DESPUES de arreglar lo que la rompio.
     *
     * Con `ignoreDuplicates` la fila se quedaba como estaba —tres intentos, descartada— y la
     * corrida contestaba «no hay nada pendiente» sobre la pelicula que le acababas de nombrar.
     * Paso: tres arreglos seguidos y ninguno se llego a probar.
     */
    const { error } = await supabase
      .from('subtitulos_cola')
      .upsert(
        {
          media_id: soloUna,
          episodio_id: texto('episodio') || '',
          prioridad: 100,
          intentos: 0,
          ultimo_error: null,
          hecho_en: null,
        },
        { onConflict: 'media_id,episodio_id' },
      );
    if (error) throw new Error(`no se pudo encolar ${soloUna}: ${error.message}`);
  }

  let consulta = supabase
    .from('subtitulos_cola')
    .select('id, media_id, episodio_id, intentos')
    .is('hecho_en', null)
    .lt('intentos', 3)
    .order('prioridad', { ascending: false })
    .order('pedido_en', { ascending: true })
    .limit(LIMITE);
  if (soloUna) consulta = consulta.eq('media_id', soloUna);

  const { data: cola, error } = await consulta;
  if (error) throw new Error(error.message);
  if (!cola?.length) { console.log('   No hay nada pendiente.'); return; }

  console.log(`   ${cola.length} en cola.\n`);
  let hechas = 0;

  for (const entrada of cola) {
    if (Date.now() > hasta) { console.log(`\n   ⏱ agotado el presupuesto: ${hechas}/${cola.length} hechas.`); break; }

    const carpeta = mkdtempSync(join(tmpdir(), 'sub-'));
    // El id de un capitulo YA LLEVA DENTRO el de su serie —`md-1396:s1e1`—, asi que pegarlos
    // daba `md-1396:md-1396:s1e1` en cada linea del registro.
    const etiqueta = entrada.episodio_id || entrada.media_id;

    try {
      const { data: item } = await supabase
        .from('media_items')
        .select('id, title, original_title, imdb_id, tmdb_id, runtime, cast_data, servers, seasons')
        .eq('id', entrada.media_id)
        .single();
      if (!item) throw new Error('la ficha ya no está');

      const donde = urlDe(item, entrada.episodio_id);
      if (!donde) throw new Error('sin url reproducible');

      const audio = await elegirAudio(donde.urls);
      console.log(
        `   ${donde.urls.length} servidor(es) · se escucha ` +
        (audio.idioma ? `la pista en ${audio.idioma}` : 'la pista que venga por defecto')
      );

      const { data: yaHay } = await supabase
        .from('subtitulos')
        .select('idioma, origen')
        .eq('media_id', entrada.media_id)
        .eq('episodio_id', entrada.episodio_id);

      const tiene = (idioma: Idioma, origen?: string) =>
        (yaHay || []).some(f => f.idioma === idioma && (!origen || f.origen === origen));

      const contexto = contextoDe(item);
      /*
       * Solo se usa para repartir las tres ventanas del sondeo, asi que basta con que se parezca.
       * En series `runtime` es la duracion de UN capitulo, que es justo lo que hace falta; cuando
       * no hay dato, 45 minutos se acerca mas a un capitulo que los 100 de una pelicula.
       */
      const duracionS = (Number(item.runtime) || (entrada.episodio_id ? 45 : 100)) * 60;

      console.log(`▶ ${etiqueta} · ${item.title}`);

      /*
       * ── 1. ¿HAY ALGUN PUBLICO QUE MEREZCA COMPROBARSE? ────────────────────────────────────
       *
       * ESTE ORDEN ES EL ARREGLO DE UN DESPERDICIO MEDIDO. Antes se sondeaba SIEMPRE —tres
       * ventanas de un minuto— y despues se miraba si habia candidatos. Pero el sondeo existe
       * solo para decidir si un fichero publico sirve: sin candidatos no decide nada.
       *
       * Y no es gratis. Medido contra archive.org: sacar UNA ventana de un minuto tardo cinco
       * minutos de reloj, porque el `-ss` no se salta la descarga, la acelera como puede. Tres
       * ventanas son un cuarto de hora largo antes de empezar a escuchar nada. Sin clave de
       * OpenSubtitles configurada no hay candidatos jamas, asi que ese cuarto de hora se pagaba
       * en todas las peliculas para no comprobar nada.
       *
       * Preguntar primero cuesta una peticion HTTP.
       */
      const candidatosPorIdioma = new Map<Idioma, Awaited<ReturnType<typeof buscarPublicos>>>();
      for (const idioma of IDIOMAS) {
        if (tiene(idioma)) continue;
        const candidatos = await buscarPublicos({
          imdbId: item.imdb_id,
          tmdbId: item.tmdb_id,
          idioma,
          // SIN ESTOS DOS, UNA SERIE PIDE «LOS SUBTITULOS DE BREAKING BAD» y el banco contesta con
          // cualquiera de sus sesenta y dos capitulos. El comprobador lo rechazaria —es su
          // trabajo— pero se habria gastado una descarga de la cuota diaria para nada.
          temporada: donde.temporada,
          capitulo: donde.capitulo,
        });
        if (candidatos.length) candidatosPorIdioma.set(idioma, candidatos);
      }

      // --- 2. El sondeo, solo si hay algo que comprobar con el ---
      let sondeo: { lineas: Linea[]; idioma: string; seguridad: number } | null = null;
      if (candidatosPorIdioma.size) {
        sondeo = await sondear(audio, duracionS, contexto, carpeta);
        console.log(
          `   habla ${sondeo.idioma || '?'} (${(sondeo.seguridad * 100).toFixed(0)} %) · ` +
          `${sondeo.lineas.length} lineas de muestra`
        );
      } else {
        console.log('   sin candidatos publicos: se escucha la pelicula directamente.');
      }

      // --- 3. Los publicos que pasen la comprobacion ---
      if (sondeo && sondeo.lineas.length) {
        for (const [idioma, candidatos] of candidatosPorIdioma) {
          for (const candidato of candidatos) {
            const crudo = await descargarPublico(candidato);
            if (!crudo) continue;

            const lineas = leerSubtitulo(crudo);
            const encaje = medirEncaje(sondeo.lineas, lineas);
            console.log(`   publico ${idioma} «${candidato.nombre}» → ${encaje.veredicto} · ${encaje.detalle}`);
            if (encaje.veredicto === 'no es') continue;

            await guardar({
              media_id: entrada.media_id,
              episodio_id: entrada.episodio_id,
              idioma,
              origen: 'publico',
              contenido: escribirVtt(correrEnElTiempo(lineas, encaje.desfaseMs)),
              desfase_ms: encaje.desfaseMs,
              parecido: Number(encaje.parecido.toFixed(3)),
            });
            break;
          }
        }
      }

      /*
       * ── 4. LA TRANSCRIPCION, QUE ES LA QUE DE VERDAD SE PIDIO ─────────────────────────────
       *
       * Solo del idioma QUE SE HABLA: transcribir es escuchar, y no se puede escuchar un idioma
       * que no suena. Lo otro seria traducir, que es otro trabajo y otra fidelidad.
       *
       * Y NO SE LE DICE CUAL ES cuando no se sabe. La deteccion sobre la pelicula entera es mas
       * fiable que la de un minuto suelto —que puede caer en musica— y no cuesta nada aparte: el
       * modelo la hace igual antes de empezar. Si hubo sondeo, su idioma va como pista.
       */
      /*
       * «YA TRANSCRITO» ES POR IDIOMA, NO EN GENERAL.
       *
       * Era en general, y con eso Breaking Bad se quedaba cerrado para siempre en cuanto existia
       * su transcripcion del DOBLAJE: la pista inglesa —la que se pidio— no se llegaba a escuchar
       * nunca porque ya habia «una».
       *
       * Cuando se ha podido elegir la pista de audio, se sabe de antemano en que idioma va a salir
       * y se pregunta por ese. Cuando no, se conserva la regla vieja: sin saber que va a salir, no
       * hay forma de saber si ya esta.
       */
      /*
       * SOLO SE SALTA LO QUE SE SABE QUE YA ESTA.
       *
       * Cuando se ha podido elegir la pista, se sabe de antemano que idioma va a salir y se
       * pregunta por ese. Cuando NO se sabe, antes se daba el trabajo por hecho si existia
       * cualquier transcripcion — y eso es lo que dejaba el ingles sin generar para siempre en
       * cuanto habia una española.
       *
       * Ahora, sin saberlo, se escucha. Puede costar una transcripcion repetida; lo otro costaba
       * no tener nunca el idioma que se pidio.
       */
      const yaTranscrito = audio.idioma
        ? (yaHay || []).some(f => f.origen === 'transcrito' && f.idioma === audio.idioma)
        : false;

      if (!yaTranscrito) {
        const wav = join(carpeta, 'completo.wav');
        console.log('   bajando el audio de la pelicula entera…');

        const t0 = Date.now();
        await sacarAudio(audio, wav);
        const mb = statSync(wav).size / 1048576;
        console.log(`   ${mb.toFixed(0)} MB de audio en ${((Date.now() - t0) / 60000).toFixed(1)} min`);

        const t = await transcribir(wav, {
          idioma: (sondeo?.idioma as Idioma) || null,
          contexto,
        });
        rmSync(wav, { force: true });

        const hablado = t.idioma as Idioma;
        if (!IDIOMAS.includes(hablado)) {
          console.log(`   habla ${t.idioma || '?'}, que no es ninguno de los dos: no se guarda.`);
        } else if (!t.lineas.length) {
          console.log('   no se oyo ni una palabra en toda la pelicula: no se guarda.');
        } else {
          await guardar({
            media_id: entrada.media_id,
            episodio_id: entrada.episodio_id,
            idioma: hablado,
            origen: 'transcrito',
            contenido: escribirVtt(aLineas(t)),
            modelo: t.modelo,
            segundos_audio: t.segundos_audio,
          });

          console.log(
            `   ✅ ${hablado} transcrito · ${t.lineas.length} lineas · ` +
            `${(t.segundos_audio / 60).toFixed(0)} min de audio en ` +
            `${(t.segundos_maquina / 60).toFixed(1)} min de maquina ` +
            `(${(t.segundos_audio / Math.max(1, t.segundos_maquina)).toFixed(1)}× tiempo real)`
          );
        }
      }

      if (apply) await supabase.from('subtitulos_cola').update({ hecho_en: new Date().toISOString() }).eq('id', entrada.id);
      hechas++;
    } catch (e: any) {
      console.log(`   ✗ ${etiqueta}: ${e?.message || e}`);
      if (apply) {
        await supabase.from('subtitulos_cola')
          .update({ intentos: (entrada.intentos || 0) + 1, ultimo_error: String(e?.message || e).slice(0, 500) })
          .eq('id', entrada.id);
      }
    } finally {
      rmSync(carpeta, { recursive: true, force: true });
    }
  }

  console.log(`\n✅ ${hechas} ficha(s) atendidas.` + (apply ? '' : '\n   (ensayo — con --apply se escribe)'));

  /*
   * QUE FALLEN TODAS ES UN FALLO DE LA CORRIDA, NO UN DIA FLOJO.
   *
   * Un titulo que no se puede escuchar —el fichero se cayo, el host no da rangos— no puede tumbar
   * el barrido: por eso cada ficha va en su propio `try` y la corrida sigue. Pero si NINGUNA sale
   * adelante, lo que hay no son veinte titulos con mala suerte: es algo roto que las afecta a
   * todas, y eso tiene que verse en rojo.
   *
   * Sin esto, la primera corrida real termino en VERDE habiendo atendido 0 de 1, y el motivo
   * —`spawn ffmpeg ENOENT`, o sea que faltaba la herramienta— estaba enterrado en el registro de
   * un trabajo que decia que todo habia ido bien.
   */
  if (cola.length && hechas === 0) {
    console.error('');
    console.error('Ninguna salio adelante. No es mala suerte: revisa el primer error de arriba.');
    process.exit(1);
  }
})();
