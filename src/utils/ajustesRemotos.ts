/**
 * AJUSTES QUE PERSISTEN DE VERDAD, guardados en R2 a través del Worker.
 *
 * Vive en su propio módulo por una razón muy concreta: estaba dentro de `externalProxy`, y
 * `externalProxy` necesita preguntarle a `hostsConCache` qué dominios están encendidos, mientras
 * que `hostsConCache` necesitaba estos ajustes. Dos módulos importándose el uno al otro es un
 * ciclo, y en un ciclo uno de los dos se inicializa A MEDIAS: la función que el otro busca todavía
 * no existe. El síntoma fue justo el que se estaba persiguiendo — el ajuste se guardaba, el panel
 * lo leía bien, y el proceso que sirve vídeo seguía comportándose como si no hubiera nada.
 *
 * ─── por qué R2 y no donde estaba ───
 *
 * El sitio anterior no guardaba. La configuración del panel vivía en variables de entorno de
 * Vercel escritas por su API, y se comprobó paso a paso: se encendió un dominio, la respuesta dijo
 * «success», y al leer la variable seguía valiendo `[]`. La escritura falla en silencio.
 *
 * Un ajuste que contesta que sí y no persiste es peor que uno que no existe, porque nadie vuelve a
 * comprobarlo — se da por hecho y se busca el fallo en otra parte.
 *
 * R2 sí escribe: lleva toda la sesión sosteniendo la caché de vídeo. Va firmado como todo lo demás.
 */
import * as crypto from 'crypto';

function baseUrl(): string {
  return (process.env.VIDEO_PROXY_URL || '').replace(/\/$/, '');
}

function signingKey(): string {
  return process.env.VIDEO_PROXY_KEY || '';
}

function urlDeAjuste(nombre: string): string | null {
  const base = baseUrl();
  const key = signingKey();
  if (!base || !key) return null;
  const e = Buffer.from(nombre, 'utf8').toString('base64url');
  const s = crypto.createHmac('sha256', key).update(e).digest('hex');
  return `${base}/ajustes?e=${e}&s=${s}`;
}

/** Lee un ajuste. `null` si no hay ninguno guardado o si el proxy no está configurado. */
export async function leerAjuste<T>(nombre: string): Promise<T | null> {
  const url = urlDeAjuste(nombre);
  if (!url) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const valor = await r.json();
    return (valor ?? null) as T | null;
  } catch {
    return null;
  }
}

/** Guarda un ajuste. Devuelve si se pudo, para que quien llame no mienta al usuario. */
export async function guardarAjuste(nombre: string, valor: unknown): Promise<boolean> {
  const url = urlDeAjuste(nombre);
  if (!url) return false;
  try {
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(valor),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
