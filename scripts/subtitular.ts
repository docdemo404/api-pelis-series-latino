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
import { mkdtempSync, rmSync } from 'fs';
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
async function sacarAudio(url: string, destino: string, desdeS?: number, duracionS?: number): Promise<void> {
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
  if (desdeS !== undefined) args.push('-ss', String(desdeS));
  args.push('-i', url);
  if (duracionS !== undefined) args.push('-t', String(duracionS));
  args.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', destino);

  await correr('ffmpeg', args, false);
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

  // Una frase, no una lista: el modelo espera texto natural, no un CSV.
  return `${partes.slice(0, 20).join(', ')}.`;
}

/** La url reproducible de una ficha o de uno de sus capítulos. */
function urlDe(item: any, episodioId: string): string | undefined {
  if (!episodioId) {
    for (const s of paraElCliente(item?.servers)) {
      const url = enlaceDirecto(s);
      if (url) return url;
    }
    return undefined;
  }

  for (const temporada of item?.seasons || []) {
    for (const capitulo of temporada?.episodes || []) {
      if (capitulo?.id !== episodioId) continue;
      for (const s of paraElCliente(capitulo?.servers)) {
        const url = enlaceDirecto(s);
        if (url) return url;
      }
    }
  }
  return undefined;
}

// ── Los dos caminos ───────────────────────────────────────────────────────────────────────

/**
 * Escucha tres minutos repartidos por la película. Es lo que se compara con un fichero público.
 *
 * Se transcribe SIN forzar idioma: de paso, esto es lo que averigua en qué está hablada la copia,
 * que decide todo lo demás. Una película que se anuncia en inglés y llega doblada al español no es
 * rara en este catálogo.
 */
async function sondear(url: string, duracionS: number, contexto: string | null, carpeta: string) {
  const trozos: Linea[] = [];
  let idioma = '';
  let seguridad = 0;

  for (const fraccion of VENTANAS) {
    const desde = Math.max(0, Math.round(duracionS * fraccion));
    const wav = join(carpeta, `ventana-${Math.round(fraccion * 100)}.wav`);

    await sacarAudio(url, wav, desde, VENTANA_SEGUNDOS);
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
    .upsert({ ...fila, etiqueta: `${NOMBRE_DEL_IDIOMA[fila.idioma as Idioma]} (generado)`, creado_en: new Date().toISOString() },
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
    const etiqueta = `${entrada.media_id}${entrada.episodio_id ? ':' + entrada.episodio_id : ''}`;

    try {
      const { data: item } = await supabase
        .from('media_items')
        .select('id, title, original_title, imdb_id, tmdb_id, runtime, cast_data, servers, seasons')
        .eq('id', entrada.media_id)
        .single();
      if (!item) throw new Error('la ficha ya no está');

      const url = urlDe(item, entrada.episodio_id);
      if (!url) throw new Error('sin url reproducible');

      const { data: yaHay } = await supabase
        .from('subtitulos')
        .select('idioma, origen')
        .eq('media_id', entrada.media_id)
        .eq('episodio_id', entrada.episodio_id);

      const tiene = (idioma: Idioma, origen?: string) =>
        (yaHay || []).some(f => f.idioma === idioma && (!origen || f.origen === origen));

      const contexto = contextoDe(item);
      const duracionS = (Number(item.runtime) || 100) * 60;

      console.log(`▶ ${etiqueta} · ${item.title}`);

      // --- 1. El sondeo: en qué idioma habla, y material para comprobar públicos ---
      const sondeo = await sondear(url, duracionS, contexto, carpeta);
      console.log(`   habla ${sondeo.idioma} (${(sondeo.seguridad * 100).toFixed(0)} %) · ${sondeo.lineas.length} líneas de muestra`);

      // --- 2. Los públicos, como adelanto ---
      for (const idioma of IDIOMAS) {
        if (tiene(idioma)) continue;

        const candidatos = await buscarPublicos({
          imdbId: item.imdb_id, tmdbId: item.tmdb_id, idioma,
        });

        for (const candidato of candidatos) {
          const crudo = await descargarPublico(candidato);
          if (!crudo) continue;

          const lineas = leerSubtitulo(crudo);
          const encaje = medirEncaje(sondeo.lineas, lineas);
          console.log(`   público ${idioma} «${candidato.nombre}» → ${encaje.veredicto} · ${encaje.detalle}`);
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

      // --- 3. La transcripción, que es la que de verdad se pidió ---
      //
      // Solo del idioma QUE SE HABLA: transcribir es escuchar, y no se puede escuchar un idioma
      // que no suena. Lo otro sería traducir, que es otro trabajo y otra fidelidad.
      const hablado = sondeo.idioma as Idioma;
      const interesa = IDIOMAS.includes(hablado);

      if (interesa && !tiene(hablado, 'transcrito')) {
        const wav = join(carpeta, 'completo.wav');
        console.log(`   escuchando la película entera…`);
        await sacarAudio(url, wav);

        const t = await transcribir(wav, { idioma: hablado, contexto });
        rmSync(wav, { force: true });

        await guardar({
          media_id: entrada.media_id,
          episodio_id: entrada.episodio_id,
          idioma: hablado,
          origen: 'transcrito',
          contenido: escribirVtt(aLineas(t)),
          modelo: t.modelo,
          segundos_audio: t.segundos_audio,
        });

        console.log(`   ✅ ${hablado} transcrito · ${t.lineas.length} líneas · ${(t.segundos_maquina / 60).toFixed(0)} min de máquina`);
      } else if (!interesa) {
        console.log(`   habla ${sondeo.idioma}, que no es ninguno de los dos: solo queda lo público.`);
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
})();
