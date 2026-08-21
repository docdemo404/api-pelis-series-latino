/**
 * QUÉ HOSTS PASAN POR LA CACHÉ DEL WORKER. Por defecto, NINGUNO.
 *
 * Hasta ahora la caché se le ponía a cualquier fichero permanente, viniera de donde viniera, y esa
 * decisión estaba tomada en el código: si la url parecía un fichero, se envolvía. Se pidió lo
 * contrario y tiene sentido — envolver un host es una decisión con consecuencias que no se ven
 * desde aquí:
 *
 *   · Lo que pasa por el Worker gasta cuota de Cloudflare y ocupa sitio en R2, que es limitado.
 *   · Un host que ya va rápido y sabe de rangos no gana nada, y encima mete un salto de más.
 *   · Y si el Worker tiene un mal día, se lleva por delante hosts que funcionaban solos.
 *
 * Apagado por defecto es la postura correcta para algo así: lo que se enciende, se enciende
 * mirando, host por host, desde el panel. Un ajuste que empieza encendido para todos no es un
 * ajuste, es un comportamiento con un interruptor decorativo.
 *
 * SE GUARDA DONDE SE GUARDAN LAS FUENTES, en una variable de entorno de Vercel a través de
 * `CloudStore`. No es el sitio más bonito para un ajuste, pero es el que ya funciona en este
 * proyecto y no necesita una tabla nueva — y crear tablas aquí no es una opción: la clave de
 * servicio de Supabase no ejecuta DDL.
 */
import { leerAjuste, guardarAjuste } from '../utils/ajustesRemotos';

/**
 * La lista viva en memoria del proceso.
 *
 * Hace falta que sea SÍNCRONA porque quien pregunta es `enlaceDirecto`, que decide la url que sale
 * hacia el reproductor y no puede esperar a la red en mitad de una respuesta. Es el mismo patrón
 * que `SourceManager`: una copia en memoria que se refresca aparte.
 *
 * Vacía al arrancar, y eso es deliberado: mientras no se sepa qué hosts están encendidos, la
 * respuesta correcta es «ninguno». Un fallo de lectura no debe encender nada.
 */
let encendidos: string[] = [];
let yaSeLeyo = false;
let leidoEn = 0;

/**
 * Cuánto vale una lectura antes de volver a preguntar.
 *
 * Sin caducidad, un proceso leía la lista una vez y ya no volvía a mirarla nunca. Encender un
 * dominio funcionaba —los procesos nuevos lo veían— pero APAGARLO no se notaba: los que ya estaban
 * calientes seguían mandando el vídeo por la caché. Un interruptor que solo va en un sentido no es
 * un interruptor.
 *
 * Un minuto es el equilibrio: una petición de más por proceso y por minuto, y un cambio hecho en
 * el panel se nota antes de que dé tiempo a comprobarlo.
 */
const VIGENCIA_MS = 60_000;

/**
 * SE LEE AL CARGAR EL MÓDULO, y por dos caminos, porque uno solo no basta.
 *
 * Cada función serverless tiene su propia memoria: encender un host desde el panel cambia la del
 * proceso que atendió ESA petición, y el que sirve vídeo no se entera. Se comprobó — se encendió
 * `archive.org` y `/streams` seguía entregando la url directa.
 *
 * El primer camino es `process.env`, que es instantáneo y no toca la red, pero solo trae el valor
 * que había en el último despliegue. El segundo es la API de Vercel, que sí trae lo recién
 * guardado y tarda. Se hacen los dos: el proceso arranca con lo que sabe y se corrige solo en
 * cuanto llega la respuesta.
 *
 * Mientras tanto la respuesta es «no pasa por la caché», que es la que no cambia el comportamiento
 * de nadie. Un ajuste que se lee tarde no puede encender algo que estaba apagado.
 */
try {
  const delProceso = process.env.APP_HOSTS_CACHE;
  if (delProceso) {
    const lista = JSON.parse(delProceso);
    if (Array.isArray(lista)) encendidos = lista.map(hostNormalizado).filter(Boolean);
  }
} catch {
  // Un valor ilegible es un valor que no enciende nada.
}

/** Normaliza un host para compararlo: minúsculas y sin `www.`. */
export function hostNormalizado(valor: string): string {
  const bruto = String(valor || '').trim().toLowerCase();
  if (!bruto) return '';
  try {
    // Acepta tanto una url completa como un host suelto.
    const host = bruto.includes('://') ? new URL(bruto).hostname : bruto.split('/')[0];
    return host.replace(/^www\./, '');
  } catch {
    return bruto.replace(/^www\./, '');
  }
}

/** Los hosts encendidos, tal y como están en memoria ahora mismo. */
export function hostsConCache(): string[] {
  return [...encendidos];
}

/**
 * ¿Se sirve este fichero por la caché?
 *
 * Contesta `false` mientras no se haya leído la configuración, y no es un despiste: entre que
 * arranca el proceso y llega la lista pueden pasar unos milisegundos, y en ese hueco la respuesta
 * segura es la que no cambia el comportamiento de nadie.
 */
export function pasaPorLaCache(url: string): boolean {
  if (!encendidos.length) return false;
  const host = hostNormalizado(url);
  return host ? encendidos.includes(host) : false;
}

/**
 * Lee la lista de la nube y la deja en memoria.
 *
 * Se llama al resolver la configuración del panel y al arrancar; no en cada petición de vídeo,
 * que es justo lo que este módulo existe para evitar.
 */
export async function refrescarHostsConCache(): Promise<string[]> {
  const lista = await leerAjuste<string[]>('hosts-cache');
  if (Array.isArray(lista)) {
    encendidos = lista.map(hostNormalizado).filter(Boolean);
    yaSeLeyo = true;
    leidoEn = Date.now();
  }
  // Si no se pudo leer se deja lo que hubiera: un fallo de lectura nunca enciende ni apaga nada.
  return [...encendidos];
}

/**
 * Se asegura de que la lista esté leída ANTES de decidir una url, una sola vez por proceso.
 *
 * El refresco al cargar el módulo no bastaba y la razón se midió: con poco tráfico Vercel arranca
 * un proceso nuevo para casi cada petición, así que la lectura asíncrona del arranque no llega
 * nunca a tiempo. El ajuste se guardaba, el panel lo leía bien, y el proceso que sirve vídeo
 * seguía comportándose como si no hubiera nada encendido.
 *
 * Cuesta una petición en el primer uso de cada proceso y cero en los siguientes. Es el precio de
 * que un interruptor signifique algo.
 */
export async function asegurarHostsConCache(): Promise<void> {
  if (yaSeLeyo && Date.now() - leidoEn < VIGENCIA_MS) return;
  await refrescarHostsConCache();
}

/**
 * Enciende o apaga un host y lo deja guardado.
 *
 * Devuelve también si se GUARDÓ. La versión anterior no lo hacía y el panel enseñaba «success»
 * sobre una escritura que había fallado en silencio — el interruptor se quedaba puesto y el
 * comportamiento no cambiaba. Decir la verdad sobre si se guardó es la mitad del arreglo.
 */
export async function ponerHostConCache(
  host: string,
  encendido: boolean
): Promise<{ guardado: boolean; encendidos: string[] }> {
  await asegurarHostsConCache();

  const limpio = hostNormalizado(host);
  if (!limpio) return { guardado: false, encendidos: [...encendidos] };

  const sinEl = encendidos.filter(h => h !== limpio);
  const siguiente = encendido ? [...sinEl, limpio].sort() : sinEl;

  const guardado = await guardarAjuste('hosts-cache', siguiente);
  // Solo se cambia la memoria si se pudo guardar: si no, este proceso se comportaría distinto a
  // los demás y el fallo sería aún más difícil de ver.
  if (guardado) {
    encendidos = siguiente;
    leidoEn = Date.now();
  }

  return { guardado, encendidos: [...encendidos] };
}

// Y se pide lo recién guardado sin bloquear a nadie: el que llegue en el primer instante verá la
// lista del despliegue, y el siguiente ya la de verdad.
void refrescarHostsConCache().catch(() => {});
