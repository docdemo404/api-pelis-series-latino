/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUE NADIE SE ENCUENTRE UN VÍDEO CAÍDO. NUNCA.
 *
 * El aviso que manda la app cuando falla una reproducción es una red de seguridad, pero llega
 * TARDE POR DEFINICIÓN: para que se dispare, alguien ha tenido que abrir la ficha, esperar, y
 * leer «se probaron todas las fuentes». Eso ya es un espectador que se llevó el error. La
 * detección tiene que ocurrir ANTES de que nadie abra nada.
 *
 * Hasta ahora eso era caro. `verificar.yml` tarda unos 24 s POR SERVIDOR, y no por estar mal
 * escrito: para comprobar un embed hay que resolverlo, acuñar la url, bajar el manifiesto y
 * descargar un segmento real. A ese ritmo el catálogo entero no cabe en una vuelta.
 *
 * CON LAS URLS PERMANENTES ESE COSTE SE DESPLOMA. Una url `public` ES el fichero: ni resolución,
 * ni manifiesto, ni cadena de segmentos. Una petición de rango. Medido: ~2 s contra archive.org.
 *
 * ─── Cómo está pensado para 20.000 títulos, que es a donde va esto ───────────────────────────
 *
 * 1. NO SE CARGA EL CATÁLOGO EN MEMORIA. Se pagina, y se lee A LA VEZ que se comprueba. Veinte
 *    mil filas con sus `servers` y sus `seasons` son cientos de megas de JSON; y separar el
 *    «leer» del «comprobar» deja la red parada esperando a la base.
 *
 * 2. SE EMPIEZA POR LO MÁS VIEJO (`streams_checked_at` ascendente, los nulos primero). Cada
 *    corrida ataca lo que está más cerca de caducar, y las corridas encadenadas cubren el catálogo
 *    en rueda sin llevar estado entre ellas — que es como ya funcionan las demás pasadas largas
 *    de este proyecto, porque un punto de guardado en un runner se pierde.
 *
 * 3. LA CONCURRENCIA SALE DEL CATÁLOGO, NO DE LA FICHA. La primera versión agrupaba por ficha y
 *    hacía tandas dentro de cada una; como casi toda ficha tiene UNA url, eran tandas de uno y el
 *    barrido acababa siendo secuencial. Con 27 fichas ya se notaba. Aquí hay un pozo de obreros
 *    tomando urls de una cola común, y ninguno espera a nadie.
 *
 * 4. SE RETIRA AL INSTANTE, NO AL FINAL. En cuanto se resuelve la última url de una ficha, esa
 *    ficha se escribe y se purga su caché. Esperar al final del barrido significaría que un vídeo
 *    caído en el minuto 1 se sigue anunciando los veinte que queda de vuelta — y con 20.000
 *    títulos esa espera solo crece.
 *
 * LO QUE HACE AL ENCONTRAR UNO MUERTO es quitarle el SELLO, no la url. `paraElCliente` solo
 * publica servidores con `verified_at` vigente, así que sin sello la ficha sale de los listados en
 * cuanto se purga el caché; y como la url sigue guardada, la vuelta siguiente puede absolverla
 * sola si era un corte de red. Retirar es barato y reversible; anunciar algo roto no.
 *
 *   npx ts-node -T scripts/verificarPermanentes.ts [--apply] [--minutos=N] [--conc=N] [--parte=N --de=M]
 *
 * Sin `--apply` no escribe: dice lo que haría.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { puedeAbrirse } from '../src/services/arranqueMp4';
import { streamClient } from '../src/utils/httpClient';
import { CacheStore } from '../src/cache/store';
import { CatalogService } from '../src/services/catalogService';
import { fichaReproducible } from '../src/services/streamSorter';
import { esUrlDeFicheroPermanente } from '../src/scrapers/directStream';

const db = getSupabaseAdmin();
const numero = (bandera: string, porDefecto: number) =>
  Number((process.argv.find(a => a.startsWith(`--${bandera}=`)) || '').split('=')[1]) || porDefecto;

const apply = process.argv.includes('--apply');
const minutosTope = numero('minutos', 45);
const topeFilas = numero('limit', 0);

/**
 * Cuántas urls a la vez DENTRO DE UN RUNNER. Ocho, y es un techo impuesto desde fuera.
 *
 * El coste de cada comprobación es casi todo latencia (TLS + ida y vuelta), así que lo natural
 * sería subir mucho la concurrencia: son peticiones repartidas entre archive.org, el CDN de Rumble
 * y los demás, o sea unas pocas por host. Se probó con 48 y GitHub CANCELÓ el runner al minuto y
 * medio — el mismo `cancelled` sin error que ya había matado tres pasadas del crawl. Abrir muchas
 * conexiones salientes a la vez es justo lo que no tolera.
 *
 * Así que la concurrencia no se gana dentro de un runner: se gana repartiendo. Ver `parte`.
 */
const CONC = numero('conc', 8);

/**
 * REPARTO ENTRE VARIOS RUNNERS. `--parte=0 --de=8` mira solo una octava parte del catálogo.
 *
 *   1 runner  x 48 a la vez  →  cancelado al minuto y medio
 *   8 runners x 8 a la vez   →  los mismos 64 en vuelo, y ninguno llama la atención
 *
 * El reparto va por una huella del id, no por páginas: así los runners no tienen que ponerse de
 * acuerdo en nada ni saber por dónde va el otro. Cada fila cae siempre en la misma parte, y las
 * ocho juntas son el catálogo exacto, sin huecos ni solapes.
 *
 * Las cuentas para 20.000 títulos (~30.000 urls): 3.750 por parte, a 8 a la vez y ~2 s cada una,
 * unos 15 minutos por runner corriendo los ocho a la vez.
 */
const parte = numero('parte', -1);
const deCuantas = numero('de', 0);

/** Huella estable de un id. No hace falta que sea criptográfica: solo que reparta parejo. */
function meToca(id: string): boolean {
  if (deCuantas <= 1 || parte < 0) return true;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % deCuantas === parte;
}

/** Filas por página. Ni tan pocas que la lectura domine, ni tantas que la memoria importe. */
const PAGINA = 500;

/** Con menos de esto por delante no se empieza otra url: mejor terminar de escribir lo aprendido. */
const MARGEN_PARA_ESCRIBIR_MS = 30_000;

/**
 * ¿SIGUE EL FICHERO, Y SE PUEDE ADELANTAR EN ÉL? Las dos cosas, en una sola petición.
 *
 * Se pide un trozo DE EN MEDIO (64 KB a partir del primer mega), y no los primeros 64 KB. La
 * diferencia no es un detalle: es la única forma de que la respuesta signifique algo.
 *
 * Un servidor PUEDE contestar `200` a `Range: bytes=0-65535` y estar comportándose bien —un
 * rango que arranca en el byte cero se puede servir como el recurso entero, y el HTTP lo
 * permite—. Medido sobre `files.eintim.me`:
 *
 *   Range: bytes=0-              200, fichero entero        ← correcto, no dice nada
 *   Range: bytes=500000000-      206 con Content-Range      ← esto sí dice que hay rangos
 *
 * Así que exigir 206 a una petición desde el cero rechaza ficheros perfectamente utilizables.
 * Desde el medio no hay ambigüedad: o contesta 206 con su `Content-Range`, o no sabe hacer
 * rangos — y sin rangos ExoPlayer no puede saltar, así que cada adelanto reempieza en el byte
 * cero, se atasca y acaba en error.
 *
 * Y de paso se leen bytes de vídeo de verdad: el primer mega de un mp4 suele ser cabecera
 * (`ftyp` + `moov`), no imagen.
 *
 * `416` significa que el fichero es más corto que el offset pedido. No es un fallo: es un
 * fichero pequeño, y ahí se comprueba por el principio, porque en algo así de corto no hay nada
 * que adelantar.
 */
async function sigueVivo(url: string): Promise<{ ok: boolean; motivo: string; sinVeredicto?: boolean }> {
  /**
   * SE JUZGA POR LAS CABECERAS, NO DESCARGANDO.
   *
   * Antes se pedía con `responseType: 'arraybuffer'` y se esperaba a tener los 64 KB. El problema
   * no es el tiempo, es lo que pasa cuando el host IGNORA el rango: contesta 200 y se pone a
   * mandar el fichero entero, así que la "comprobación" se traga decenas de megas antes de que
   * salte el tope. Medido contra `files.eintim.me`: 19 MB en 10 s, por una comprobación.
   *
   * Con un stream se mira el `status` y el `Content-Range` y se cierra en el acto. Un `206` con su
   * `Content-Range` desde el byte 1.000.000 ya demuestra las dos cosas que hay que demostrar: que
   * el fichero está, y que el host sabe posicionarse dentro — que es lo que permite adelantar.
   */
  const pedir = (rango: string) => streamClient.get(url, {
    headers: { Range: rango },
    responseType: 'stream',
    /**
     * Treinta segundos, no diez.
     *
     * archive.org tarda entre 10 y 25 s SOLO en el primer byte, medido hoy y de forma constante.
     * Con el tope en 10 s todos sus ficheros caían en «sin veredicto», su sello no se renovaba
     * nunca y acababan caducando a las 12 h — o sea que el barrido los hacía desaparecer sin
     * llegar a comprobarlos. Y como ya no se descargan megas, un tope alto no cuesta tiempo salvo
     * cuando el host de verdad lo gasta.
     */
    timeout: 30000,
    validateStatus: () => true,
    maxRedirects: 5,
  } as any);

  /** Se cierra el stream en cuanto se ha leído lo que hacía falta: el status y las cabeceras. */
  const cerrar = (r: any) => { try { r?.data?.destroy?.(); } catch { /* ya estaba cerrado */ } };
  const esHtml = (r: any) => /text\/html/i.test(String(r.headers['content-type'] || ''));

  try {
    /**
     * HASTA TRES INTENTOS ANTES DE CONDENAR, y esto no es prudencia genérica: es lo que hace
     * falta con los hosts que hay.
     *
     * `files.eintim.me` —98 servidores, la mitad del catálogo— contesta al MISMO rango de en
     * medio `206` una vez y `200` las cinco siguientes. Con un solo intento, un barrido le quita
     * el sello a un fichero que está perfectamente ahí. Pasó: 54 de sus servidores se quedaron
     * sin sello y sus títulos dejaron de aparecer en la app.
     *
     * Tres intentos no arreglan el host —para eso está el Worker— pero evitan que su capricho se
     * lleve por delante medio catálogo mientras tanto.
     */
    let ultimoMotivo = '';
    for (let intento = 1; intento <= INTENTOS; intento++) {
      const r = await pedir(`bytes=${DESDE_MEDIO}-${DESDE_MEDIO + 65535}`);

      // Más corto que el offset: fichero pequeño. Se comprueba por el principio y ya está.
      if (r.status === 416) {
        cerrar(r);
        const chico = await pedir('bytes=0-65535');
        const status = chico.status;
        const html = esHtml(chico);
        cerrar(chico);
        if (status >= 500) return { ok: true, motivo: `sin veredicto (http ${status})`, sinVeredicto: true };
        if (status >= 400) return { ok: false, motivo: `http ${status}` };
        if (html) return { ok: false, motivo: 'html en vez de vídeo' };
        return { ok: true, motivo: '' };
      }

      const status = r.status;
      const html = esHtml(r);
      const rango = String(r.headers['content-range'] || '');
      const tipoContenido = String(r.headers['content-type'] || '');
      const largoContenido = Number(r.headers['content-length']) || 0;
      cerrar(r);

      /**
       * UN 5xx NO ES UNA BAJA: ES EL SERVIDOR CAÍDO.
       *
       * La regla de la casa es retirar solo con prueba EN CONTRA (FUENTES.md §7.11), y un 500,
       * un 502 o un 503 no dicen nada sobre el fichero — dicen que el host no está pudiendo
       * ahora mismo. archive.org los devuelve a puñados cuando va cargado, y en la primera
       * pasada de este barrido se llevó por delante ocho títulos por eso.
       *
       * Lo que sí es una declaración del host sobre el recurso es un 404, un 403 o un 410. Esos
       * retiran; los 5xx se quedan sin veredicto y se vuelven a mirar en la vuelta siguiente.
       */
      if (status >= 500) return { ok: true, motivo: `sin veredicto (http ${status})`, sinVeredicto: true };
      if (status >= 400) return { ok: false, motivo: `http ${status}` };
      if (html) return { ok: false, motivo: 'html en vez de vídeo' };
      if (status === 206 && rango) return { ok: true, motivo: '' };

      /**
       * UN 200 CON VÍDEO DENTRO SIGUE SIENDO UN FICHERO VIVO — desde que existe el Worker.
       *
       * Que el origen ignore el `Range` era motivo de retirada porque sin rangos no se puede
       * adelantar: el reproductor pedía el minuto 40, recibía el fichero desde el principio y se
       * quedaba descargando. Con la caché por trozos delante eso ya no ocurre — el Worker pide,
       * cachea y SIEMPRE contesta 206, así que el cliente ve un host que se comporta.
       *
       * Retirar por esto ahora sería tirar contenido que se puede servir perfectamente. Y no es
       * poco: `files.eintim.me` son 98 servidores y contesta 200 cinco de cada seis veces.
       *
       * Lo que sí se sigue exigiendo es que haya VÍDEO: content-type de vídeo y un tamaño de
       * película. Un 200 con una página de error dentro no salva a nadie.
       */
      if (status === 200 && hayWorker) {
        if (/^video\//i.test(tipoContenido) && largoContenido > MINIMO_PELICULA_BYTES) {
          return { ok: true, motivo: '' };
        }
      }

      ultimoMotivo = `no sabe hacer rangos (http ${status})`;
      // Una espera corta entre intentos: es un capricho del origen, no una carrera.
      if (intento < INTENTOS) await new Promise(r2 => setTimeout(r2, 400 * intento));
    }
    return { ok: false, motivo: ultimoMotivo };
  } catch (e: any) {
    /**
     * UN FALLO NUESTRO NO ES UNA BAJA SUYA (FUENTES.md §7.11).
     *
     * Un timeout o un DNS caído dicen que NOSOTROS no pudimos, no que el fichero no esté. Si eso
     * retirara títulos, un corte de red en el runner vaciaría el catálogo de golpe.
     */
    return { ok: true, motivo: `sin veredicto (${e?.code || 'error'})`, sinVeredicto: true };
  }
}

/** Cuántas veces se le pregunta a un host antes de darle por incapaz de hacer rangos. */
const INTENTOS = 3;

/**
 * ¿Hay caché por trozos delante? Cambia qué se puede perdonar.
 *
 * Con el Worker puesto, un origen que ignora el `Range` deja de ser un problema del cliente: el
 * Worker lo normaliza. Sin él, sí lo es, y entonces sí hay que retirar.
 */
const hayWorker = Boolean(process.env.VIDEO_PROXY_URL && process.env.VIDEO_PROXY_KEY);

/** Un fichero de vídeo de verdad pesa esto como mínimo. Una página de error, no. */
const MINIMO_PELICULA_BYTES = 40 * 1024 * 1024;

/** Desde dónde se pide el trozo de prueba. Ver la nota de `sigueVivo`. */
const DESDE_MEDIO = 1000000;

/**
 * QUITA DE LA FILA LO QUE HOY YA NO ENTRARÍA. Devuelve cuántos ha quitado.
 *
 * Desellar no basta cuando el host ha salido de la lista de permanentes. Un servidor sin sello
 * sigue guardado esperando que alguna vuelta lo absuelva, y eso está bien para un corte de red;
 * pero si su host ya no se acepta, esa absolución no puede llegar nunca. Mientras tanto sigue
 * ahí, ocupando sitio y —esto es lo que se vio— volviendo a sellarse cuando una tanda del crawl
 * escrita antes del cambio pasa por encima de la ficha.
 *
 * Pasó con `remux.unlimplay.com`: se quitó de la lista, el barrido le quitaba el sello, y cinco
 * títulos seguían entregándolo igual. Lo que hoy no entraría, no se queda.
 */
function purgarLoQueYaNoVale(fila: any): number {
  let quitados = 0;
  const limpiar = (servidores: any[] | null | undefined): any[] =>
    (servidores || []).filter((s: any) => {
      const url = String(s?.direct_stream || s?.embed_url || '');
      if (s?.direct_mode !== 'public' || !url) return true;
      if (esUrlDeFicheroPermanente(url)) return true;
      quitados++;
      return false;
    });

  fila.servers = limpiar(fila.servers);
  for (const t of fila.seasons || []) {
    for (const e of t?.episodes || []) e.servers = limpiar(e?.servers);
  }
  return quitados;
}

/** Los servidores `public` de una fila, estén en la ficha o colgando de un capítulo. */
function permanentesDe(fila: any): Array<{ sv: any; donde: string }> {
  const salida: Array<{ sv: any; donde: string }> = [];
  const esPermanente = (s: any) =>
    s?.direct_mode === 'public' && typeof s?.direct_stream === 'string' && /^https?:\/\//i.test(s.direct_stream);

  for (const sv of fila.servers || []) if (esPermanente(sv)) salida.push({ sv, donde: 'ficha' });
  for (const t of fila.seasons || []) {
    for (const e of t?.episodes || []) {
      for (const sv of e?.servers || []) {
        if (esPermanente(sv)) salida.push({ sv, donde: `${t.season_number}x${e.episode_number}` });
      }
    }
  }
  return salida;
}

/**
 * Cuántos veredictos CONCLUYENTES de «no arranca» hacen falta para retirar.
 *
 * Dos. Uno es demasiado poco: los orígenes tienen malos ratos y este catálogo ya se quedó una vez
 * a la mitad por condenar a la primera. Tres sería seguir anunciando una hora larga algo que no se
 * puede ver, que es justo lo que hay que evitar.
 */
const GOLPES_PARA_RETIRAR = 2;

const cuenta = { miradas: 0, vivas: 0, retiradas: 0, sinVeredicto: 0, fichas: 0, dejanDeAnunciarse: 0, purgados: 0, arranques: 0, noArrancan: 0, primerAviso: 0, arranqueSinVeredicto: 0 };
/** Los listados se purgan la PRIMERA vez que algo se retira, no una vez por ficha. */
let listadosPurgados = false;

/**
 * Escribe el veredicto de UNA ficha y purga lo suyo, en cuanto se sabe.
 *
 * Aquí está la diferencia entre «se retira al instante» y «se retira al acabar el barrido». Con
 * 20.000 títulos una vuelta dura veinte minutos, y esperar al final sería seguir anunciando
 * durante veinte minutos un vídeo que se supo caído en el primero.
 */
async function guardarFicha(fila: any): Promise<void> {
  const sigue = fichaReproducible(fila);
  const dejaDeAnunciarse = fila.has_streams !== false && !sigue;
  if (dejaDeAnunciarse) {
    cuenta.dejanDeAnunciarse++;
    console.log(`   ⛔ deja de anunciarse: ${fila.id} · ${String(fila.title).slice(0, 50)}`);
  }
  if (!apply) return;

  const { error } = await db.from('media_items').update({
    servers: fila.servers || [],
    seasons: fila.seasons || [],
    has_streams: sigue,
    streams_checked_at: new Date().toISOString(),
  }).eq('id', fila.id);
  if (error) { console.warn(`   ⚠ ${fila.id}: ${error.message}`); return; }

  /**
   * La ficha, y —solo si algo se ha retirado— los listados, que es donde la ve el espectador.
   * Purgar la ficha y no los listados la deja arreglada por dentro y rota por fuera: el home y la
   * búsqueda llevan los datos COPIADOS dentro y duran horas.
   */
  const claves = CatalogService.cacheKeysFor({ id: fila.id, type: fila.type } as any);
  await CacheStore.del(...claves).catch(() => {});
  if (dejaDeAnunciarse && !listadosPurgados) {
    listadosPurgados = true;
    await CatalogService.invalidateListings().catch(() => {});
  }
}

(async () => {
  const fin = Date.now() + minutosTope * 60_000;
  const seAcaba = () => Date.now() > fin - MARGEN_PARA_ESCRIBIR_MS;
  const reparto = deCuantas > 1 ? ` · parte ${parte + 1}/${deCuantas}` : '';
  console.log(`🔍 Repasando urls permanentes${apply ? '' : ' (ENSAYO: no escribe)'} · ${CONC} a la vez${reparto}
`);

  type Tarea = { fila: any; sv: any; donde: string };
  const cola: Tarea[] = [];
  /** Cuántas urls le quedan por resolver a cada ficha. Al llegar a cero, se escribe. */
  const pendientes = new Map<string, number>();
  const cambiadas = new Set<string>();
  let leyendoTerminado = false;
  let filasEncoladas = 0;

  /** Va llenando la cola mientras los obreros la vacían. */
  const leer = (async () => {
    let desde = 0;
    for (;;) {
      if (seAcaba()) break;
      const { data, error } = await db
        .from('media_items')
        .select('id,title,type,servers,seasons,has_streams')
        // Lo más viejo primero: cada corrida ataca lo que está más cerca de caducar.
        .order('streams_checked_at', { ascending: true, nullsFirst: true })
        .range(desde, desde + PAGINA - 1);
      if (error) { console.error('   ✗ no se pudo leer:', error.message); break; }
      if (!data?.length) break;

      for (const fila of data as any[]) {
        if (!meToca(String(fila.id))) continue;

        // Primero fuera lo que hoy no entraría; luego ya se comprueba lo que quede.
        const quitados = purgarLoQueYaNoVale(fila);
        if (quitados > 0) {
          cuenta.purgados += quitados;
          console.log(`   🗑 ${String(fila.title).slice(0, 44)} · ${quitados} servidor(es) de un host que ya no se acepta`);
          await guardarFicha(fila);
        }

        const suyas = permanentesDe(fila);
        if (!suyas.length) continue;
        filasEncoladas++;
        cuenta.fichas++;
        pendientes.set(fila.id, suyas.length);
        for (const s of suyas) cola.push({ fila, sv: s.sv, donde: s.donde });
      }

      desde += PAGINA;
      if (data.length < PAGINA) break;
      if (topeFilas && filasEncoladas >= topeFilas) break;
      // No dejar que la cola crezca sin freno: si los obreros van por detrás, se espera.
      while (cola.length > CONC * 20 && !seAcaba()) await new Promise(r => setTimeout(r, 200));
    }
    leyendoTerminado = true;
  })();

  const obrero = async () => {
    for (;;) {
      if (seAcaba()) return;
      const tarea = cola.shift();
      if (!tarea) {
        if (leyendoTerminado) return;
        await new Promise(r => setTimeout(r, 100));
        continue;
      }

      const { fila, sv, donde } = tarea;
      const r = await sigueVivo(String(sv.direct_stream));
      cuenta.miradas++;

      if (r.sinVeredicto) {
        cuenta.sinVeredicto++;
      } else if (r.ok) {
        /**
         * EL FICHERO ESTÁ. ¿PERO SE PUEDE ABRIR?
         *
         * Son dos preguntas distintas y hasta ahora solo se hacía la primera. `sigueVivo` demuestra
         * que el fichero existe y que el host sabe posicionarse dentro, y eso está bien — pero no
         * demuestra que alguien pueda darle a Ver y ver algo. Un mp4 no se abre sin su índice, y
         * ese índice puede pesar seis megas, puede estar AL FINAL del fichero, o puede no estar
         * entero. En los tres casos el rango contesta 206 y la pantalla se queda en negro.
         *
         * Se midió: de 21 fichas de archive.org que el catálogo daba por buenas, un tercio no
         * llegaba a abrir. Todas tenían su sello.
         *
         * DOS BARRIDOS ANTES DE RETIRAR, y esa es la parte importante. Un solo mal rato no puede
         * retirar una película: ya pasó una vez —54 servidores desellados de golpe por un host que
         * contestaba mal una de cada seis veces— y vaciar el catálogo por impaciencia es peor que
         * dejar pasar un título dudoso. Y solo cuentan los veredictos CONCLUYENTES: si el origen no
         * contestó a tiempo no se sabe nada, y no saber no es un golpe.
         */
        const arranque = await puedeAbrirse(String(sv.direct_stream));
        cuenta.arranques++;

        if (arranque.ok) {
          cuenta.vivas++;
          delete sv.fallos_arranque;
          // Sello fresco: es lo que mantiene la ficha anunciada sin depender de una ventana larga.
          sv.verified_at = new Date().toISOString();
          sv.status = 'online';
          cambiadas.add(fila.id);
        } else if (arranque.sinVeredicto) {
          // No se pudo concluir: se deja como estaba. Ni sello nuevo ni golpe.
          cuenta.arranqueSinVeredicto++;
        } else {
          const golpes = Number(sv.fallos_arranque || 0) + 1;
          sv.fallos_arranque = golpes;
          cambiadas.add(fila.id);

          if (golpes >= GOLPES_PARA_RETIRAR) {
            cuenta.noArrancan++;
            delete sv.verified_at;
            sv.status = 'offline';
            sv.last_checked = new Date().toISOString();
            console.log(`   ⊘ ${String(fila.title).slice(0, 38).padEnd(38)} [${donde}] no arranca (${arranque.causa}: ${arranque.detalle})`);
          } else {
            cuenta.primerAviso++;
            // Sigue anunciada: un golpe no retira. Pero tampoco se le renueva el sello, para que
            // si el problema es de verdad acabe caducando aunque el barrido no vuelva a pasar.
            console.log(`   … ${String(fila.title).slice(0, 38).padEnd(38)} [${donde}] primer aviso (${arranque.causa})`);
          }
        }
      } else {
        cuenta.retiradas++;
        // Se le quita el SELLO, no la url: la vuelta siguiente lo mira otra vez y puede absolver.
        delete sv.verified_at;
        sv.status = 'offline';
        sv.last_checked = new Date().toISOString();
        cambiadas.add(fila.id);
        console.log(`   ✗ ${String(fila.title).slice(0, 38).padEnd(38)} [${donde}] ${r.motivo}  ${String(sv.direct_stream).slice(0, 58)}`);
      }

      // ¿Era la última url de esta ficha? Entonces su veredicto está completo: se escribe YA.
      const quedan = (pendientes.get(fila.id) ?? 1) - 1;
      pendientes.set(fila.id, quedan);
      if (quedan === 0 && cambiadas.has(fila.id)) await guardarFicha(fila);

      if (cuenta.miradas % 200 === 0) {
        console.log(`   ${cuenta.miradas} miradas · ${cuenta.retiradas} retiradas · ${cola.length} en cola`);
      }
    }
  };

  await Promise.all([leer, ...Array.from({ length: CONC }, () => obrero())]);

  console.log(
    `\n✅ ${cuenta.miradas} urls de ${cuenta.fichas} fichas · ${cuenta.vivas} siguen · ` +
    `${cuenta.retiradas} retiradas` + (cuenta.sinVeredicto ? ` · ${cuenta.sinVeredicto} sin veredicto (no se tocan)` : '')
  );
  if (cuenta.arranques) {
    console.log(
      `   ${cuenta.arranques} arranques probados · ${cuenta.noArrancan} retirados por no abrir · ` +
      `${cuenta.primerAviso} con un aviso` +
      (cuenta.arranqueSinVeredicto ? ` · ${cuenta.arranqueSinVeredicto} sin veredicto` : '')
    );
  }
  if (cuenta.purgados) console.log(`   ${cuenta.purgados} servidor(es) borrados por venir de un host que ya no se acepta.`);
  if (cuenta.dejanDeAnunciarse) console.log(`   ${cuenta.dejanDeAnunciarse} título(s) dejan de anunciarse.`);
  if (!apply) console.log(`\n   (ensayo — con --apply se escribe)`);
})();
