import { CacheStore } from '../cache/store';
import { inspectEmbed } from '../scrapers/embedHealth';
import { extractDirect, DirectStream } from '../scrapers/directStream';

/**
 * Acuñado del vídeo directo en el momento de reproducir.
 *
 * Los CDN de estos hosts firman la URL entera y la atan a la red que la pidió, así que una URL
 * guardada ayer no sirve hoy. En vez de persistirla, se vuelve a sacar del embed cuando el
 * cliente pulsa Reproducir: es UNA petición HTTP más el desempaquetado en CPU (milisegundos).
 *
 * El resultado se cachea unos minutos para que las peticiones seguidas de una misma sesión
 * (manifiesto, reintentos, cambio de calidad) no repitan el trabajo.
 */

const MINT_TTL_SECONDS = 10 * 60;

/**
 * Cuánto se recuerda que un embed NO dio vídeo.
 *
 * Sin esto, cada intento de reproducir vuelve a golpear al host. upns responde 429 en cuanto
 * se le insiste, así que reintentar sin pausa alarga el bloqueo en lugar de resolverlo. Es
 * corto a propósito: un fallo pasajero se reintenta pronto, pero no en bucle.
 */
const MISS_TTL_SECONDS = 2 * 60;

export interface MintedStream extends DirectStream {
  /** Referer que espera el CDN: el del embed, no el suyo propio (dropload da 403 sin él). */
  referer: string;
  origin: string;
}

function refererFor(embedUrl: string): { referer: string; origin: string } {
  try {
    const origin = new URL(embedUrl).origin;
    return { referer: `${origin}/`, origin };
  } catch {
    return { referer: embedUrl, origin: embedUrl };
  }
}

/**
 * Resuelve el vídeo real de un embed. `fresh` salta el caché: es lo que se usa cuando un
 * segmento empieza a dar 403 a mitad de reproducción porque el token caducó o cambió la IP
 * de la instancia serverless.
 */
export async function mintDirect(embedUrl: string, opts: { fresh?: boolean } = {}): Promise<MintedStream | null> {
  if (!embedUrl) return null;
  const cacheKey = `mint:${embedUrl}`;

  if (!opts.fresh) {
    const cached = await CacheStore.get<MintedStream | { miss: true }>(cacheKey);
    if (cached && 'miss' in cached) return null;
    if (cached && 'url' in cached && cached.url) return cached;
  }

  const { status, html } = await inspectEmbed(embedUrl);
  // Al reproducir sí se permite la llamada extra a la API del host (upns): es una por
  // reproducción real, no una por ficha del catálogo.
  const direct = await extractDirect(embedUrl, html, { allowNetwork: true });
  if (!direct) {
    await CacheStore.set(cacheKey, { miss: true }, MISS_TTL_SECONDS);
    return null;
  }
  // Un embed marcado caído todavía puede entregar la URL (el 403 del WAF se cuenta como vivo),
  // así que no se descarta por `status`; solo se anota para el diagnóstico.
  void status;

  const minted: MintedStream = { ...direct, ...refererFor(embedUrl) };
  await CacheStore.set(cacheKey, minted, MINT_TTL_SECONDS);
  return minted;
}
