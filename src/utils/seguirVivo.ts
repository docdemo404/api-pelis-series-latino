/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUE UN SOCKET NO MATE UNA CORRIDA DE VEINTE MINUTOS
 *
 * Los barridos de este repositorio abren miles de conexiones a hosts que no controlamos, y de vez
 * en cuando una se muere de una forma que Node considera fatal: una promesa que se rompe cuando ya
 * nadie la espera. Desde Node 15 eso **tumba el proceso entero** con código 1.
 *
 * No es teórico. Medido el 2026-08-26, `verificarPermanentes` moría así en TODAS sus corridas —una
 * cada 20 minutos— al minuto y medio de arrancar:
 *
 *     DOMException [TimeoutError]: The operation was aborted due to timeout
 *     ##[error]Process completed with exit code 1
 *
 * El trabajo que había que hacer eran ~2.000 comprobaciones y se quedaba en 200. Todos los días.
 * Y el catálogo lo notaba justo donde duele: los vídeos caídos seguían anunciándose porque el
 * único que los retira no llegaba a mirarlos.
 *
 * ── QUÉ SE TRAGA Y QUÉ NO ───────────────────────────────────────────────────────────────────
 *
 * Solo los CORTES DE RED, y la distinción es la que sostiene todo lo demás: un timeout dice que
 * nosotros no pudimos, no que haya un fallo en el código. Un `TypeError` o un fallo de Supabase
 * siguen matando el proceso, porque ahí seguir adelante sería escribir basura en la base durante
 * veinte minutos sin que nadie se entere.
 *
 * Es el mismo criterio que ya usa el verificador para no retirar títulos por un fallo propio
 * (FUENTES.md §7.11), aplicado un nivel más arriba: al proceso en vez de a la ficha.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Nombres que pone Node/undici a lo que en realidad es «la red se cayó a media petición». */
const NOMBRES_DE_CORTE = new Set([
  'AbortError',
  'TimeoutError',
  'FetchError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
  'SocketError',
  'ResponseAborted',
]);

/** Códigos de `errno` y de undici que significan lo mismo. */
const CODIGOS_DE_CORTE = new Set([
  'ABORT_ERR',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'EPROTO',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_ABORTED',
]);

/** Y lo que solo se distingue por el texto, que es más de lo que uno querría. */
const TEXTOS_DE_CORTE =
  /socket hang up|fetch failed|terminated|other side closed|aborted|timeout|network|premature close|epipe|read econnreset/i;

/** Cierto cuando el fallo es «no se pudo hablar con ese host», y no un error de programa. */
export function esCorteDeRed(fallo: any): boolean {
  if (!fallo) return false;

  const nombre = String(fallo.name || fallo.constructor?.name || '');
  if (NOMBRES_DE_CORTE.has(nombre)) return true;

  const codigo = String(fallo.code || fallo.cause?.code || '');
  if (CODIGOS_DE_CORTE.has(codigo)) return true;

  // `cause` es donde undici deja el motivo de verdad de un `fetch failed`.
  if (fallo.cause && fallo.cause !== fallo && esCorteDeRed(fallo.cause)) return true;

  return TEXTOS_DE_CORTE.test(String(fallo.message || fallo));
}

/**
 * Deja al proceso vivo cuando el que se muere es un socket.
 *
 * Se llama UNA VEZ, al principio de un script de barrido. No cambia nada de lo que el script hace:
 * solo evita que un corte suelto —de una petición que ya nadie estaba esperando— se lleve por
 * delante el trabajo que quedaba y el que ya estaba hecho pero sin guardar.
 *
 * Cuenta cuántos se traga y lo dice al final, porque un número que sube sin parar es la señal de
 * que hay algo mal de verdad detrás y no simple mala suerte con un host.
 */
export function noMorirPorUnCorteDeRed(): void {
  let tragados = 0;

  const mirar = (fallo: any, de: string) => {
    if (esCorteDeRed(fallo)) {
      tragados++;
      // Uno por línea sería ruido; de diez en diez se ve la tendencia sin tapar el barrido.
      if (tragados <= 3 || tragados % 10 === 0) {
        console.warn(`   ⚠ corte de red suelto (${de}, ${tragados} en esta corrida): ${fallo?.message || fallo}`);
      }
      return;
    }

    // Cualquier otra cosa mata el proceso igual que antes: ver la nota de la cabecera.
    console.error(`❌ ${de}:`, fallo);
    process.exit(1);
  };

  process.on('unhandledRejection', motivo => mirar(motivo, 'promesa sin dueño'));
  process.on('uncaughtException', fallo => mirar(fallo, 'excepción suelta'));

  process.on('exit', () => {
    if (tragados) console.log(`   ⚠ ${tragados} corte(s) de red sueltos durante la corrida.`);
  });
}
