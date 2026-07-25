import 'dotenv/config';
import axios from 'axios';
import { USER_AGENT } from '../../src/utils/httpClient';

/**
 * ¿VA A HABER PARÓN? — la única cifra que lo predice es la HOLGURA.
 *
 * Un reproductor no se atasca porque la red sea "lenta" en abstracto, sino porque entregar N
 * segundos de vídeo tarda más de N segundos. Ese cociente es la holgura:
 *
 *     holgura = caudal medido / bitrate real del stream
 *
 * Con holgura 1,09x (medido en vidhideplus proxeado, 1080p) el búfer no se llena nunca: 10 s de
 * vídeo tardan 9,2 s en bajar, así que cualquier hipo lo vacía y el vídeo se para. Con 9x
 * (emturbovid por 302) no hay forma de que se pare. Los dos "reproducen"; sólo uno se puede ver.
 *
 * Por eso este script no mide megabits sueltos: baja hasta un segmento REAL, lee cuántos segundos
 * de vídeo contiene (`#EXTINF`) y cuánto ocupa, y divide. Mide además el segmento dos veces, para
 * separar el fallo de caché de borde del acierto — que es la otra diferencia grande.
 *
 *   npx ts-node scripts/dev/diag_playback_speed.ts --remote=https://api-pelis-series-latino.vercel.app "https://emturbovid.com/t/69ed6a7d95476"
 *   npx ts-node scripts/dev/diag_playback_speed.ts --remote=<api> <embed1> <embed2> ...
 *   npx ts-node scripts/dev/diag_playback_speed.ts --remote=<api> --media=<id-de-ficha>
 */

const LOCAL_DEFAULT = 'http://localhost:3000';

/** Segmentos consecutivos que se descargan para promediar. Con uno solo el número engaña. */
const SAMPLE_SEGMENTS = 5;

/** El primer segmento suele ser mayor que la media y falsearía el bitrate hacia arriba. */
const SKIP_FIRST = 3;

interface Timing {
  status: number;
  ttfbMs: number;
  totalMs: number;
  bytes: number;
  /** Bytes por segundo sobre el tiempo TOTAL: es lo que de verdad llena el búfer. */
  bytesPerSecond: number;
  edgeCache: string | null;
  location: string | null;
  contentType: string | null;
  error?: string;
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** Descarga entera y cronometrada. El TTFB solo no basta: lo que decide es el caudal sostenido. */
async function time(url: string, headers: Record<string, string> = {}): Promise<Timing> {
  const started = Date.now();
  let ttfbMs = 0;
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT, ...headers },
      responseType: 'stream',
      timeout: 120000,
      decompress: false,
      maxRedirects: 0,
      validateStatus: () => true,
    });
    ttfbMs = Date.now() - started;

    let bytes = 0;
    await new Promise<void>((resolve, reject) => {
      res.data.on('data', (c: Buffer) => { bytes += c.length; });
      res.data.on('end', () => resolve());
      res.data.on('error', reject);
    });

    const totalMs = Math.max(1, Date.now() - started);
    return {
      status: res.status,
      ttfbMs,
      totalMs,
      bytes,
      bytesPerSecond: Math.round(bytes / (totalMs / 1000)),
      edgeCache: (res.headers['x-vercel-cache'] as string) || null,
      location: (res.headers['location'] as string) || null,
      contentType: (res.headers['content-type'] as string) || null,
    };
  } catch (err: any) {
    return {
      status: 0, ttfbMs, totalMs: Date.now() - started, bytes: 0, bytesPerSecond: 0,
      edgeCache: null, location: null, contentType: null,
      error: err.code || err.message,
    };
  }
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string | null> {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT, ...headers },
      timeout: 30000, responseType: 'text', validateStatus: () => true,
    });
    return res.status < 400 ? String(res.data) : null;
  } catch {
    return null;
  }
}

/** URIs no comentadas de un manifiesto, ya absolutas. */
function uris(manifest: string, base: string): string[] {
  return manifest
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => { try { return new URL(l, base).toString(); } catch { return ''; } })
    .filter(Boolean);
}

/** Duraciones declaradas en los `#EXTINF`, en orden. Son el denominador de la holgura. */
function segmentDurations(manifest: string): number[] {
  return [...manifest.matchAll(/#EXTINF:\s*([\d.]+)/g)]
    .map(m => parseFloat(m[1]))
    .filter(v => Number.isFinite(v) && v > 0);
}

function isPlaylist(url: string): boolean {
  try {
    return /\.m3u8$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function mbps(bytesPerSecond: number): string {
  return `${(bytesPerSecond * 8 / 1e6).toFixed(2)} Mbps`;
}

function kbs(bytesPerSecond: number): string {
  return `${Math.round(bytesPerSecond / 1024)} KB/s`;
}

/**
 * El manifiesto puede venir de un 302 al CDN o servido por la API. Se resuelve a mano
 * (`maxRedirects: 0`) para poder contar el salto y saber por dónde fue.
 */
async function resolveManifest(api: string, embedUrl: string, browserLike: boolean) {
  const headers: Record<string, string> = browserLike
    ? { Origin: 'https://miapp.com', Referer: 'https://miapp.com/' }
    : {};
  const url = `${api.replace(/\/$/, '')}/api/v1/stream/direct?e=${b64url(embedUrl)}`;
  const first = await time(url, headers);

  if (first.status === 302 && first.location) {
    return { modo: 'redirect', entrada: first, manifestUrl: first.location, servedByApi: false, headers };
  }
  if (first.status === 200) {
    const modo = /mpegurl/i.test(first.contentType || '') ? 'manifest o proxy' : 'bytes directos';
    return { modo, entrada: first, manifestUrl: url, servedByApi: true, headers };
  }
  return { modo: `FALLO HTTP ${first.status}`, entrada: first, manifestUrl: null, servedByApi: false, headers };
}

async function measure(api: string, embedUrl: string, browserLike: boolean): Promise<void> {
  console.log(`\n──────── ${embedUrl}`);
  const { modo, entrada, manifestUrl, headers } = await resolveManifest(api, embedUrl, browserLike);

  console.log(`  arranque   ${modo.padEnd(16)} HTTP ${entrada.status}  TTFB ${entrada.ttfbMs}ms${entrada.error ? '  ' + entrada.error : ''}`);
  if (!manifestUrl) return;

  const master = await fetchText(manifestUrl, headers);
  if (!master) {
    console.log('  (no se pudo leer el manifiesto; si es mp4 no hay segmentos que medir)');
    return;
  }

  // Bajar de maestro a variante hasta dar con la playlist que tiene los segmentos. Se coge la
  // ÚLTIMA variante: suele ser la de mayor calidad, que es donde aparecen los parones.
  let playlistUrl = manifestUrl;
  let playlist = master;
  for (let depth = 0; depth < 3 && !playlist.includes('#EXTINF'); depth++) {
    const lines = playlist.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const pick = lines[lines.length - 1];
    if (!pick) break;
    let next: string;
    try {
      next = new URL(pick, playlistUrl).toString();
    } catch { break; }
    const body = await fetchText(next, headers);
    if (!body) break;
    playlistUrl = next;
    playlist = body;
  }

  const durations = segmentDurations(playlist);
  const all = uris(playlist, playlistUrl);
  // Se saltan los primeros: el segmento inicial suele ser bastante más grande que la media, y
  // calcular el bitrate con él solo daba una holgura falsamente mala.
  const chosen = all.slice(SKIP_FIRST, SKIP_FIRST + SAMPLE_SEGMENTS);
  if (!chosen.length || !durations.length || isPlaylist(chosen[0])) {
    console.log('  (no se llegó a segmentos con duración declarada)');
    return;
  }

  // Segmentos DISTINTOS y consecutivos, como los pediría el reproductor: es la única forma de
  // saber si el castigo del arranque en frío se repite en cada uno o era solo el primero.
  let bytes = 0;
  let seconds = 0;
  let millis = 0;
  const muestras: Timing[] = [];
  for (let i = 0; i < chosen.length; i++) {
    const t = await time(chosen[i], headers);
    if (t.status >= 400 || t.bytes === 0) continue;
    muestras.push(t);
    bytes += t.bytes;
    millis += t.totalMs;
    seconds += durations[Math.min(SKIP_FIRST + i, durations.length - 1)];
  }
  if (!muestras.length || seconds === 0) {
    console.log('  (el CDN no sirvió ningún segmento)');
    return;
  }

  // Repetir el PRIMERO de la muestra: ya está caliente, y la diferencia mide cuánto aporta la
  // caché (la del borde si va por la API, la del propio CDN si va directo).
  const caliente = await time(chosen[0], headers);

  const bitrate = bytes / seconds;                 // B/s que consume la reproducción
  const caudalFrio = bytes / (millis / 1000);      // B/s que se consiguen bajando
  const holgura = (bps: number) => (bitrate > 0 ? bps / bitrate : 0);
  const veredicto = (h: number) => (h >= 2 ? 'holgado' : h >= 1.3 ? 'justo' : h >= 1 ? 'AL LÍMITE' : 'NO DA');
  const hFrio = holgura(caudalFrio);
  const hCaliente = holgura(caliente.bytesPerSecond);

  console.log(`  muestra    ${muestras.length} segmentos, ${seconds.toFixed(0)}s de vídeo, ${(bytes / 1024 / 1024).toFixed(2)} MB → bitrate ${mbps(bitrate)}`);
  console.log(`  en frío    ${kbs(caudalFrio).padEnd(10)} ${mbps(caudalFrio).padEnd(11)} ${(millis / 1000).toFixed(1)}s para ${seconds.toFixed(0)}s de vídeo  holgura ${hFrio.toFixed(2)}x  ${veredicto(hFrio)}`);
  console.log(`  repetido   ${kbs(caliente.bytesPerSecond).padEnd(10)} ${mbps(caliente.bytesPerSecond).padEnd(11)} ${caliente.totalMs}ms  holgura ${hCaliente.toFixed(2)}x  ${veredicto(hCaliente)}${caliente.edgeCache ? '  [borde: ' + caliente.edgeCache + ']' : ''}`);
  console.log(`  segmentos por la API: ${playlist.includes('/api/v1/stream/direct/seg') ? 'SÍ (proxy)' : 'no (van al CDN)'}`);
}

/** Embeds de una ficha, en el orden en que la API los sirve: así se ve a cuál mandaría de verdad. */
async function embedsFromMedia(api: string, mediaId: string): Promise<string[]> {
  const base = api.replace(/\/$/, '');
  for (const path of [`/api/v1/media/${mediaId}/streams`, `/api/v1/series/${mediaId}/streams`]) {
    const body = await fetchText(`${base}${path}`);
    if (!body) continue;
    try {
      const servers = JSON.parse(body)?.data?.servers || [];
      const embeds = servers
        .filter((s: any) => s.direct_stream && s.embed_url)
        .map((s: any) => s.embed_url as string);
      if (embeds.length) {
        console.log(`Ficha ${mediaId}: ${servers.length} servidores, ${embeds.length} con vídeo directo.`);
        console.log('Orden que devuelve la API (el primero es el que se reproduce):');
        servers.slice(0, 6).forEach((s: any, i: number) => {
          console.log(`  ${i + 1}. ${(s.direct_mode || '(sin modo)').padEnd(9)} ${(s.direct_host || '-').padEnd(32)} ${String(s.name || '').slice(0, 34)}`);
        });
        return embeds.slice(0, 3);
      }
    } catch {}
  }
  return [];
}

async function main() {
  const args = process.argv.slice(2);
  const api = args.find(a => a.startsWith('--remote='))?.split('=')[1] || LOCAL_DEFAULT;
  const mediaId = args.find(a => a.startsWith('--media='))?.split('=')[1];
  // Sin `--nativo` se imita a un navegador: manda Origin/Referer https, que es lo que hace que
  // `/stream/direct` pueda elegir `manifest` en vez de proxy.
  const browserLike = !args.includes('--nativo');

  let embeds = args.filter(a => a.startsWith('http'));
  if (!embeds.length && mediaId) embeds = await embedsFromMedia(api, mediaId);

  if (!embeds.length) {
    console.log('Nada que medir. Pasa uno o más embeds, o --media=<id de ficha>.');
    console.log(`Ejemplo: npx ts-node scripts/dev/diag_playback_speed.ts --remote=${api} --media=2026-04-stranger-things-relatos-del-85-2026-html`);
    return;
  }

  console.log(`API: ${api}   cliente simulado: ${browserLike ? 'navegador' : 'nativo (sin Origin/Referer)'}`);
  console.log('La holgura es caudal ÷ bitrate. Por debajo de 1x el vídeo no puede ir sin pararse.');

  for (const embed of embeds) {
    try {
      await measure(api, embed, browserLike);
    } catch (err: any) {
      console.log(`\n──────── ${embed}\n  ERROR ${err.message}`);
    }
  }
}

main().then(() => setTimeout(() => process.exit(0), 300).unref());
