import { CacheStore } from '../cache/store';
import { inspectEmbed } from '../scrapers/embedHealth';
import { extractDirect, extractDirectFast, tokenExpirySeconds, DirectStream } from '../scrapers/directStream';

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

/** Cuánto se recuerda una URL cuya caducidad no se puede leer: poco, por prudencia. */
const MINT_TTL_FALLBACK_SECONDS = 10 * 60;

/** Techo del caché aunque la firma dure más: una hora ya evita casi todos los re-acuñados. */
const MINT_TTL_MAX_SECONDS = 60 * 60;

/** Margen para no entregar una URL que caduca mientras el cliente la está pidiendo. */
const MINT_TTL_MARGIN_SECONDS = 60;

/**
 * Cuánto vale la pena recordar esta URL.
 *
 * Antes eran 10 minutos fijos para todo, elegidos a ojo. Pero la firma trae su propia
 * caducidad, y en la familia upns son CUATRO HORAS: re-acuñar cada 10 minutos era repetir un
 * trabajo que seguía siendo válido veinticuatro veces más de lo necesario, y cada re-acuñado es
 * una petición a la API del host, justo la que responde 429 en cuanto se le insiste.
 */
function mintTtlFor(url: string): number {
  const expiry = tokenExpirySeconds(url);
  if (expiry === null) return MINT_TTL_FALLBACK_SECONDS;
  return Math.max(30, Math.min(expiry - MINT_TTL_MARGIN_SECONDS, MINT_TTL_MAX_SECONDS));
}

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

  // Primero lo que se resuelve solo con la URL. Para la familia upns y para los embeds que
  // llevan el vídeo en un parámetro, esto es TODO lo que hace falta: descargar antes el embed
  // —como se hacía— eran hasta dos viajes de ida y vuelta metidos en el camino crítico entre
  // pulsar Play y el primer fotograma, y su cuerpo ni se miraba. El estado de salud tampoco se
  // usaba: un embed marcado caído puede entregar la URL igualmente (el 403 del WAF cuenta como
  // vivo), así que nunca decidió nada aquí.
  const fast = await extractDirectFast(embedUrl, { allowNetwork: true });
  let direct = fast.direct;

  // Solo los hosts que esconden el vídeo DENTRO del HTML pagan la descarga del embed.
  if (!direct && !fast.conclusive) {
    const { html } = await inspectEmbed(embedUrl);
    direct = await extractDirect(embedUrl, html, { allowNetwork: true });
  }

  if (!direct) {
    await CacheStore.set(cacheKey, { miss: true }, MISS_TTL_SECONDS);
    return null;
  }

  const minted: MintedStream = { ...direct, ...refererFor(embedUrl) };
  await CacheStore.set(cacheKey, minted, mintTtlFor(direct.url));
  return minted;
}
