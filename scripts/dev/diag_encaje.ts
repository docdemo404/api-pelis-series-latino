/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ¿SABE EL COMPARADOR DISTINGUIR UN SUBTÍTULO BUENO DE UNO DE OTRA PELÍCULA?
 *
 * De esta pregunta depende que se pueda publicar un fichero bajado de internet sin haberlo mirado
 * una persona. Si el comparador se equivoca hacia el «sí», se publica texto que no es lo que se
 * dice; si se equivoca hacia el «no», se tira trabajo humano y se gasta el runner escuchando
 * películas que ya tenían subtítulo.
 *
 * Se prueba con material inventado a propósito, no con ficheros reales, porque lo que hay que
 * comprobar es el MECANISMO y aquí se puede fabricar el caso exacto: el mismo texto corrido nueve
 * segundos, el mismo texto condensado como lo condensa una persona, y otro texto distinto.
 *
 *   npx ts-node -T scripts/dev/diag_encaje.ts
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { medirEncaje } from '../../src/services/subtitulos/encaje';
import { correrEnElTiempo, escribirVtt, leerSubtitulo, type Linea } from '../../src/services/subtitulos/formato';

/**
 * Diálogo inventado, con la forma que tiene el de verdad: frases cortas, nombres propios que se
 * repiten y palabras largas dispersas, que son las que el comparador usa para orientarse.
 */
const GUION = [
  'Comandante, la tormenta de arena cubrió todo el perímetro norte',
  'Necesitamos evacuar el laboratorio antes del amanecer',
  'Marisol dijo que el generador aguanta cuarenta minutos más',
  'Nadie mencionó que hubiera explosivos almacenados debajo',
  'El helicóptero no puede aterrizar con esta visibilidad',
  'Prepara los documentos y destruye las grabaciones inmediatamente',
  'Escúchame bien porque no voy a repetirlo',
  'La frecuencia del transmisor cambió durante la madrugada',
  'Encontraron huellas alrededor del invernadero abandonado',
  'Ese contenedor lleva refrigeración independiente desde octubre',
  'Confirmamos la posición aproximada del convoy enemigo',
  'Tu hermana firmó la autorización hace catorce años',
  'Los ingenieros calcularon mal la resistencia estructural',
  'Devuélveme el maletín y desaparezco para siempre',
  'Ninguna cámara registró lo que ocurrió en el sótano',
  'Necesito autorización presidencial para abrir ese archivo',
  'El satélite pasará sobre nosotros dentro de veinte minutos',
  'Aquellos planos pertenecían al arquitecto original del edificio',
  'Nunca imaginé que terminaríamos negociando con ellos',
  'Desactiva el protocolo antes de que suene la alarma',
];

/** Otro guion, para hacer de «subtítulo de otra película». */
const OTRA_PELICULA = [
  'La panadería abre temprano los domingos por costumbre',
  'Mi abuela guardaba las fotografías dentro del armario',
  'Compramos naranjas en el mercado de la plaza mayor',
  'El profesor explicó nuevamente la lección de geometría',
  'Aquel verano aprendimos a navegar en el lago',
  'Los vecinos organizaron una comida en el jardín',
  'Perdí las llaves mientras paseaba por la avenida',
  'Cristina prepara chocolate caliente cuando llueve tanto',
  'El tren de mediodía llegó con bastante retraso',
  'Terminamos pintando la habitación de color verde',
  'Encontré una carta antigua entre las páginas amarillentas',
  'Su bicicleta necesita una reparación bastante urgente',
  'Caminamos hasta la ermita siguiendo el sendero empedrado',
  'La biblioteca cierra durante las vacaciones de invierno',
  'Recogimos manzanas suficientes para toda la temporada',
  'Aprendió carpintería observando trabajar a su padre',
  'Las golondrinas regresaron antes de lo previsto',
  'Guardamos las herramientas dentro del cobertizo pequeño',
  'Celebramos el cumpleaños con una tarta enorme',
  'Nadie recordaba el nombre de aquella calle estrecha',
];

/** Convierte un guion en líneas de subtítulo, una cada tres segundos desde donde se diga. */
function comoSubtitulo(frases: string[], desdeMs: number): Linea[] {
  return frases.map((texto, i) => ({
    desdeMs: desdeMs + i * 3000,
    hastaMs: desdeMs + i * 3000 + 2600,
    texto,
  }));
}

/**
 * Lo que oiría Whisper: las mismas frases pero como las dice la gente.
 *
 * Es la parte que hace honesta la prueba. Un subtítulo NUNCA es la transcripción literal: quien lo
 * escribe quita muletillas, junta frases y corrige. Si el comparador solo acierta cuando los dos
 * textos son idénticos, no sirve para nada real.
 */
function comoSeOye(frases: string[], desdeMs: number): Linea[] {
  return frases.map((texto, i) => {
    const palabras = texto.split(' ');
    // Se cae una palabra de cada cuatro y se mete una muletilla: así habla la gente y así
    // transcribe Whisper.
    const oido = palabras.filter((_, j) => j % 4 !== 2);
    return {
      desdeMs: desdeMs + i * 3000 + 120,
      hastaMs: desdeMs + i * 3000 + 2500,
      texto: (i % 3 === 0 ? 'eh ' : '') + oido.join(' '),
    };
  });
}

function probar(nombre: string, oido: Linea[], fichero: Linea[], esperado: string) {
  const r = medirEncaje(oido, fichero);
  const bien = r.veredicto === esperado;
  console.log(
    `${bien ? '✅' : '❌'} ${nombre.padEnd(46)} ${r.veredicto.padEnd(10)} ` +
    `(esperado ${esperado}) · ${r.detalle}`
  );
  return bien;
}

(function main() {
  console.log('🎬 Comparador de subtítulos contra el audio\n');

  // Las tres ventanas del sondeo, repartidas por la película como en producción.
  const oido = [
    ...comoSeOye(GUION.slice(0, 7), 15 * 60_000),
    ...comoSeOye(GUION.slice(7, 14), 50 * 60_000),
    ...comoSeOye(GUION.slice(14), 80 * 60_000),
  ];

  const bueno = [
    ...comoSubtitulo(GUION.slice(0, 7), 15 * 60_000),
    ...comoSubtitulo(GUION.slice(7, 14), 50 * 60_000),
    ...comoSubtitulo(GUION.slice(14), 80 * 60_000),
  ];

  let todo = true;

  todo = probar('el mismo montaje, sin desfase', oido, bueno, 'encaja') && todo;

  // Un logo de nueve segundos por delante: el caso más común de todos.
  const corrido = correrEnElTiempo(bueno, 9_000);
  const conLogo = medirEncaje(oido, corrido);
  todo = probar('el mismo montaje con un logo delante', oido, corrido, 'desfasado') && todo;

  // Y lo que de verdad importa del caso anterior: que la corrección lo DEJE bien.
  const arreglado = correrEnElTiempo(corrido, conLogo.desfaseMs);
  todo = probar('  …y una vez corregido el desfase', oido, arreglado, 'encaja') && todo;

  todo = probar('un subtítulo de otra película', oido, comoSubtitulo(OTRA_PELICULA, 15 * 60_000), 'no es') && todo;

  // Media película: pasa a veces cuando el fichero es de una versión recortada.
  todo = probar('solo la primera ventana coincide', oido, comoSubtitulo(GUION.slice(0, 7), 15 * 60_000), 'no es') && todo;

  // --- Y de paso, que el formato sobreviva a la ida y vuelta ---
  const vtt = escribirVtt(bueno);
  const devuelta = leerSubtitulo(vtt);
  const igual = devuelta.length === bueno.length &&
    devuelta.every((l, i) => Math.abs(l.desdeMs - bueno[i].desdeMs) < 2 && l.texto === bueno[i].texto);
  console.log(`${igual ? '✅' : '❌'} ${'escribir VTT y volver a leerlo'.padEnd(46)} ${devuelta.length} líneas`);
  todo = igual && todo;

  // Un `.srt` de los que circulan: numeración rota, coma decimal, saltos de Windows y etiquetas.
  const srtFeo = '1\r\n00:00:05,120 --> 00:00:07,400\r\n{\\an8}<i>Hola desde el norte</i>\r\n\r\n' +
    '1\r\n0:00:09.000 --> 0:00:11.000\r\nSegunda línea\r\n';
  const leido = leerSubtitulo(srtFeo);
  const bienLeido = leido.length === 2 && leido[0].desdeMs === 5120 && leido[1].desdeMs === 9000;
  console.log(`${bienLeido ? '✅' : '❌'} ${'un .srt mal escrito de los de por ahí'.padEnd(46)} ${leido.length} líneas`);
  todo = bienLeido && todo;

  const limpio = escribirVtt(leido);
  const sinEtiquetas = !limpio.includes('{\\an8}') && !limpio.includes('<i>');
  console.log(`${sinEtiquetas ? '✅' : '❌'} ${'las etiquetas de estilo no llegan al VTT'.padEnd(46)}`);
  todo = sinEtiquetas && todo;

  console.log(todo ? '\n✅ Todo en orden.' : '\n❌ Hay algo que no hace lo que dice.');
  process.exit(todo ? 0 : 1);
})();
