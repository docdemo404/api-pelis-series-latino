/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ¿ESTE SUBTÍTULO ES DE ESTA COPIA?
 *
 * Es la pregunta que convierte «bajar un fichero de internet» en algo que se puede publicar. Un
 * `.srt` de un banco público está hecho para UN montaje, y estos hosts republican versiones con
 * logos delante, anuncios metidos y cortes distintos. El fichero puede ser de la película correcta
 * y aun así ir corrido nueve segundos, que es peor que no tener nada: se lee lo que no se dice.
 *
 * ── CÓMO SE CONTESTA SIN ESCUCHAR LA PELÍCULA ENTERA ───────────────────────────────────────
 *
 * Se transcriben TRES VENTANAS de un minuto —al 15 %, al 50 % y al 80 %— y se busca dónde encajan
 * esas palabras dentro del fichero. Tres minutos de audio contra las horas que cuesta la película
 * completa, y son suficientes: si el fichero es de otro montaje, falla en las tres.
 *
 * Tres y no una porque un desfase puede ser CONSTANTE —un logo delante, y entonces las tres
 * ventanas están corridas lo mismo y se arregla sumando— o PROGRESIVO, que es lo que pasa cuando
 * el fichero viene de una copia a otra velocidad de fotogramas. Con una sola ventana los dos casos
 * se ven idénticos, y el segundo no tiene arreglo con una suma.
 *
 * ── POR QUÉ NO SE COMPARAN FRASES ──────────────────────────────────────────────────────────
 *
 * Porque lo que se oye y lo que está escrito NUNCA coinciden literalmente. El subtítulo condensa,
 * corrige la gramática de quien habla mal y se salta las muletillas; la transcripción escribe lo
 * que suena. Comparar cadenas daría «no se parecen» sobre un fichero perfecto.
 *
 * Lo que sí sobrevive a esa diferencia son las PALABRAS LARGAS y su posición en el tiempo. Si a los
 * 45 minutos y 12 segundos suena «helicóptero» y el fichero dice «helicóptero» a esa misma altura,
 * eso no es casualidad. Y si lo dice nueve segundos después, y las otras doscientas palabras
 * también van nueve segundos después, entonces es el mismo montaje con otro arranque.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import type { Linea } from './formato';

export interface Encaje {
  /** Qué fracción de lo que suena aparece en el fichero, a su hora. De 0 a 1. */
  parecido: number;
  /** Lo que hay que sumarle a cada marca del fichero para que cuadre. En milisegundos. */
  desfaseMs: number;
  veredicto: 'encaja' | 'desfasado' | 'no es';
  /** Para el registro: qué se midió, para poder discutir el veredicto sin repetirlo. */
  detalle: string;
}

/**
 * Quita todo lo que no distingue: mayúsculas, tildes, puntuación y signos.
 *
 * Las tildes se van porque medio internet escribe subtítulos sin ellas, y un fichero perfecto no
 * puede suspender por eso.
 */
function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    // Los signos diacriticos sueltos que deja NFD (U+0300 a U+036F): la tilde de «á» separada de
    // la «a». Escrito con escapes a proposito — en literal son caracteres invisibles que cualquier
    // editor puede comerse sin que se note.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Las palabras de una línea, cada una con la hora a la que se dijo.
 *
 * El reparto dentro de la línea es proporcional: una línea de tres segundos con seis palabras pone
 * una cada medio segundo. No es exacto —nadie habla a ritmo constante— pero el error que introduce
 * es de décimas, y la tolerancia con la que se compara es de segundo y medio.
 */
function palabrasConHora(lineas: Linea[]): Array<{ palabra: string; ms: number }> {
  const salida: Array<{ palabra: string; ms: number }> = [];

  for (const linea of lineas) {
    const palabras = normalizar(linea.texto).split(' ').filter(Boolean);
    if (!palabras.length) continue;

    const duracion = Math.max(1, linea.hastaMs - linea.desdeMs);
    const paso = duracion / palabras.length;

    palabras.forEach((palabra, i) => {
      salida.push({ palabra, ms: linea.desdeMs + paso * (i + 0.5) });
    });
  }

  return salida;
}

/**
 * SOLO LAS PALABRAS QUE DISTINGUEN.
 *
 * «de», «la», «que», «the», «and» están en todas partes, así que encajan con CUALQUIER desfase y
 * lo único que hacen es subir la nota de todos los candidatos por igual — o sea, esconder cuál era
 * el bueno. Fuera las cortas.
 *
 * Y fuera también las que aparecen demasiado en el propio fichero: el nombre del protagonista sale
 * cuatrocientas veces y encaja siempre, por el mismo motivo.
 */
const LARGO_MINIMO = 5;
const REPETICIONES_MAXIMAS = 25;

/** Cuánto puede bailar una palabra respecto a su hora y seguir contando como la misma. */
const TOLERANCIA_MS = 1_500;

/** Hasta dónde se busca el desfase. Dos minutos cubre cualquier careta o anuncio de por delante. */
const DESFASE_MAXIMO_MS = 120_000;

/** Cada cuánto se prueba un desfase. 250 ms es más fino que la tolerancia, así que no se escapa. */
const PASO_MS = 250;

/**
 * A partir de aquí se acepta. Provisional: sale de lo que da un fichero correcto contra su propia
 * película en las pruebas, y hay que volver a mirarlo con datos reales del catálogo.
 *
 * No es «cuánto se parecen los textos» sino «cuántas de las palabras raras que suenan están
 * escritas a su hora», y ahí un fichero bueno pasa de largo del 50 % aunque esté condensado.
 */
const PARECIDO_MINIMO = 0.45;

/**
 * Y además tiene que GANAR. Un fichero de otra película saca una nota de fondo —siempre hay
 * palabras que coinciden por azar— y esa nota es parecida en todos los desfases. Si el mejor no
 * destaca sobre esa base, no ha encontrado nada: ha empatado consigo mismo.
 */
const VENTAJA_MINIMA = 2.0;

/**
 * Un desfase que no baila más que esto se considera «ya venía bien».
 *
 * Tres cuartos de segundo y no un cuarto: por debajo de eso la medida es ruido —las palabras se
 * reparten dentro de cada línea a ojo, no una a una— y además un subtítulo se pone en pantalla
 * medio segundo antes de que se hable, a propósito, para que dé tiempo a leerlo.
 */
const DESFASE_DESPRECIABLE_MS = 750;

/**
 * Compara lo transcrito de las ventanas contra el fichero candidato.
 *
 * @param oido    lo que Whisper oyó en las ventanas, con las horas REALES de esta copia.
 * @param fichero el subtítulo bajado, tal cual venía.
 */
export function medirEncaje(oido: Linea[], fichero: Linea[]): Encaje {
  const sueltas = palabrasConHora(oido).filter(p => p.palabra.length >= LARGO_MINIMO);
  const delFichero = palabrasConHora(fichero).filter(p => p.palabra.length >= LARGO_MINIMO);

  if (sueltas.length < 20 || delFichero.length < 20) {
    return {
      parecido: 0,
      desfaseMs: 0,
      veredicto: 'no es',
      detalle: `demasiado poco que comparar (${sueltas.length} oídas, ${delFichero.length} escritas)`,
    };
  }

  // Dónde aparece cada palabra dentro del fichero, en orden, para poder buscar por hora.
  const donde = new Map<string, number[]>();
  for (const { palabra, ms } of delFichero) {
    const lista = donde.get(palabra);
    if (lista) lista.push(ms);
    else donde.set(palabra, [ms]);
  }
  for (const [palabra, veces] of donde) {
    if (veces.length > REPETICIONES_MAXIMAS) donde.delete(palabra);
    else veces.sort((a, b) => a - b);
  }

  const buscables = sueltas.filter(p => donde.has(p.palabra));
  if (!buscables.length) {
    return { parecido: 0, desfaseMs: 0, veredicto: 'no es', detalle: 'ni una palabra en común' };
  }

  /** ¿Hay una aparición de esta palabra a esta hora, con la tolerancia de siempre? */
  const estaAhi = (palabra: string, ms: number): boolean => {
    const veces = donde.get(palabra);
    if (!veces) return false;

    // Binaria: la primera aparición que no queda por detrás de la ventana.
    let bajo = 0;
    let alto = veces.length;
    while (bajo < alto) {
      const medio = (bajo + alto) >> 1;
      if (veces[medio] < ms - TOLERANCIA_MS) bajo = medio + 1;
      else alto = medio;
    }
    return bajo < veces.length && veces[bajo] <= ms + TOLERANCIA_MS;
  };

  const notas: number[] = [];
  const desfaseDe = (indice: number) => -DESFASE_MAXIMO_MS + indice * PASO_MS;

  let mejorNota = 0;
  let mejorIndice = 0;

  for (let desfase = -DESFASE_MAXIMO_MS; desfase <= DESFASE_MAXIMO_MS; desfase += PASO_MS) {
    let aciertos = 0;
    // Se compara contra TODAS las oídas, no solo contra las buscables: si de lo que suena solo una
    // cuarta parte está siquiera escrita en el fichero, eso ya es un no y tiene que notarse.
    for (const { palabra, ms } of sueltas) {
      if (estaAhi(palabra, ms - desfase)) aciertos++;
    }

    const nota = aciertos / sueltas.length;
    if (nota > mejorNota) {
      mejorNota = nota;
      mejorIndice = notas.length;
    }
    notas.push(nota);
  }

  /*
   * EL DESFASE ES EL CENTRO DE LA MESETA, NO EL PRIMER PICO.
   *
   * La nota no sube a un pico y baja: sube a una MESETA de unos tres segundos de ancho, porque una
   * palabra se da por encontrada si aparece dentro de la tolerancia. Quedarse con el primer punto
   * más alto es quedarse con un borde de esa meseta, y eso mete hasta segundo y medio de error en
   * la corrección — sobre un fichero que estaba perfecto.
   *
   * Se vio midiendo: un subtítulo sin ningún desfase salía «desfasado 0,75 s», y corregirlo lo
   * habría estropeado. El centro de la meseta es la estimación honesta de dónde está el fichero.
   */
  const EMPATE = 0.02;
  let izquierda = mejorIndice;
  let derecha = mejorIndice;
  while (izquierda > 0 && notas[izquierda - 1] >= mejorNota - EMPATE) izquierda--;
  while (derecha < notas.length - 1 && notas[derecha + 1] >= mejorNota - EMPATE) derecha++;

  const mejorDesfase = Math.round((desfaseDe(izquierda) + desfaseDe(derecha)) / 2);

  const ordenadas = [...notas].sort((a, b) => a - b);
  const base = ordenadas[Math.floor(ordenadas.length / 2)] || 0;
  const ventaja = base > 0 ? mejorNota / base : Infinity;

  const detalle =
    `${(mejorNota * 100).toFixed(0)} % de ${sueltas.length} palabras, ` +
    `desfase ${(mejorDesfase / 1000).toFixed(2)} s, ` +
    `${ventaja === Infinity ? 'sin ruido de fondo' : ventaja.toFixed(1) + '× el fondo'}`;

  if (mejorNota < PARECIDO_MINIMO || ventaja < VENTAJA_MINIMA) {
    return { parecido: mejorNota, desfaseMs: 0, veredicto: 'no es', detalle };
  }

  return {
    parecido: mejorNota,
    // El fichero hay que correrlo al REVÉS de como se buscó: si sus palabras aparecen antes de
    // cuando suenan, hay que empujarlas hacia adelante.
    desfaseMs: mejorDesfase,
    veredicto: Math.abs(mejorDesfase) <= DESFASE_DESPRECIABLE_MS ? 'encaja' : 'desfasado',
    detalle,
  };
}
