/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LEER SRT, ESCRIBIR VTT, Y CORRER LAS MARCAS DE TIEMPO
 *
 * Los bancos públicos entregan `.srt`; el reproductor de la app —Media3— quiere `.vtt`. Son casi
 * el mismo formato: cambian la coma de los decimales, la cabecera y poco más. Casi.
 *
 * Aquí no hay ninguna decisión de producto, solo el trabajo sucio de que un fichero escrito por
 * cualquiera en 2009 acabe siendo texto que un reproductor de 2026 sabe pintar.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Una línea de subtítulo: cuándo entra, cuándo sale y qué dice. */
export interface Linea {
  desdeMs: number;
  hastaMs: number;
  texto: string;
}

/**
 * `00:01:23,456` y `00:01:23.456` son la misma hora escrita por dos tribus distintas.
 *
 * También se acepta `1:23.456` —sin horas— porque los ficheros de por ahí lo hacen y negarse solo
 * sirve para tirar un subtítulo que era bueno.
 */
const RELOJ = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/;

function aMilisegundos(texto: string): number | null {
  const m = RELOJ.exec(texto.trim());
  if (!m) return null;

  const horas = Number(m[1] || 0);
  const minutos = Number(m[2]);
  const segundos = Number(m[3]);
  // `,5` son 500 ms, no 5. Se rellena a la derecha hasta tres cifras.
  const fraccion = Number(m[4].padEnd(3, '0'));

  return ((horas * 60 + minutos) * 60 + segundos) * 1000 + fraccion;
}

function aReloj(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const f = total % 1000;

  const dos = (n: number) => String(n).padStart(2, '0');
  return `${dos(h)}:${dos(m)}:${dos(s)}.${String(f).padStart(3, '0')}`;
}

/**
 * Lee un fichero de subtítulos, sea `.srt` o `.vtt`, y devuelve sus líneas.
 *
 * NO SE FÍA DE LA NUMERACIÓN. Un `.srt` canónico numera sus bloques, pero los que circulan traen
 * numeraciones repetidas, saltadas o ausentes, y un lector que las use como separador se come
 * medio fichero. Lo que de verdad marca un bloque es la línea del reloj, así que es esa la que se
 * busca y todo lo que va detrás —hasta el siguiente reloj— es su texto.
 */
export function leerSubtitulo(bruto: string): Linea[] {
  // BOM al principio y saltos de Windows: dos clásicos de ficheros que vienen de cualquier sitio.
  const limpio = bruto.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  const lineas: Linea[] = [];
  const filas = limpio.split('\n');

  let actual: Linea | null = null;
  const guardar = () => {
    if (!actual) return;
    actual.texto = actual.texto.trim();
    if (actual.texto) lineas.push(actual);
    actual = null;
  };

  for (const fila of filas) {
    const flecha = fila.indexOf('-->');
    if (flecha > 0) {
      const desde = aMilisegundos(fila.slice(0, flecha));
      // Lo de después de la flecha puede traer parámetros de posición pegados: `... align:start`.
      const hasta = aMilisegundos(fila.slice(flecha + 3));
      if (desde !== null && hasta !== null) {
        guardar();
        actual = { desdeMs: desde, hastaMs: Math.max(hasta, desde), texto: '' };
        continue;
      }
    }

    if (!actual) continue;

    // La numeración de un `.srt` va justo antes del reloj, o sea que aquí ya no aparece nunca.
    // Lo que sí llega es la línea vacía que separa bloques.
    if (!fila.trim()) {
      guardar();
      continue;
    }

    actual.texto += (actual.texto ? '\n' : '') + fila;
  }
  guardar();

  return lineas.sort((a, b) => a.desdeMs - b.desdeMs);
}

/**
 * Escribe WebVTT, que es lo que sabe leer el reproductor.
 *
 * Se van las etiquetas de estilo tipo `{\an8}` y `<font color=...>` que arrastran los `.srt`
 * viejos: Media3 no las entiende y las pinta como texto, así que un subtítulo con formato acaba
 * enseñando su propio código encima de la película.
 */
export function escribirVtt(lineas: Linea[]): string {
  const cuerpo = lineas
    .map(l => {
      const texto = l.texto
        .replace(/\{\\[^}]*\}/g, '')
        .replace(/<\/?(?:font|b|i|u)[^>]*>/gi, '')
        .trim();
      return `${aReloj(l.desdeMs)} --> ${aReloj(l.hastaMs)}\n${texto}`;
    })
    .filter(bloque => bloque.split('\n').slice(1).join('').trim())
    .join('\n\n');

  return `WEBVTT\n\n${cuerpo}\n`;
}

/**
 * Corre todas las marcas de tiempo lo que diga [desfaseMs].
 *
 * Es lo que arregla un subtítulo del montaje correcto pero con otro arranque —un logo delante, un
 * anuncio metido—, que es el caso que sale una y otra vez con estos hosts.
 *
 * Lo que queda antes del cero se TIRA, no se recorta a cero: amontonar cinco líneas en el segundo
 * cero es peor que perderlas, porque se leen todas de golpe encima de los créditos iniciales.
 */
export function correrEnElTiempo(lineas: Linea[], desfaseMs: number): Linea[] {
  if (!desfaseMs) return lineas;

  return lineas
    .map(l => ({ ...l, desdeMs: l.desdeMs + desfaseMs, hastaMs: l.hastaMs + desfaseMs }))
    .filter(l => l.hastaMs > 0);
}
