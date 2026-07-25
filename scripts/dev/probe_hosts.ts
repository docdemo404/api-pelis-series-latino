import 'dotenv/config';
import axios from 'axios';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { inspectEmbed } from '../../src/scrapers/embedHealth';
import { extractDirect, unwrapRedirector, DirectStream } from '../../src/scrapers/directStream';
import { USER_AGENT } from '../../src/utils/httpClient';

/**
 * ¿QUÉ EXIGE DE VERDAD CADA CDN? — medición, no suposición.
 *
 * Todo el catálogo se sirve hoy por el proxy porque `describeDirect` da por hecho que ningún
 * host acepta una URL acuñada desde otra red. Eso está escrito en un comentario, no medido, y
 * mezcla dos cosas distintas: que la URL CADUQUE (da igual: se acuña al reproducir) y que vaya
 * ATADA A LA IP que la pidió (eso sí obliga a proxear). Este script separa las dos.
 *
 * Lo que mide, por host:
 *   refererRequired  el CDN devuelve 403 sin el Referer del embed
 *   refererChecked   además valida QUÉ Referer es (rechaza uno ajeno)
 *   browserUaRequired exige un User-Agent de navegador
 *   cors             manda Access-Control-Allow-Origin (necesario para hls.js en navegador)
 *   ipBound          la URL acuñada aquí NO sirve desde otra red
 *   tokenTtl         cuánto vive de verdad la firma
 *   segment*         LO MISMO, pero pedido sobre un SEGMENTO de verdad
 *
 * POR QUÉ HAY QUE BAJAR HASTA EL SEGMENTO. La primera versión de este script se quedaba en la
 * URL extraída —el m3u8 maestro— y daba por hecho que el resto de la reproducción iría igual.
 * Con eso, la familia upns salió "redirigible" y se fue a producción un `redirect` que no
 * reproducía nada: sus playlists están en el host del embed y rechazan un Referer ajeno, pero
 * sus segmentos están en OTRO host y exigen un Referer cualquiera. Un manifiesto que responde 200
 * no dice NADA de lo que harán sus segmentos. Por eso se sigue la cadena maestro → variante →
 * primer segmento y se repiten las pruebas sobre él.
 *
 * EL TEST DE IP, que es el que decide todo: se acuña en LOCAL (IP residencial) y luego se le
 * pide a la API DESPLEGADA que descargue esa misma URL, cosa que `/stream/direct/seg` ya sabe
 * hacer con cualquier `?u=`. Si el CDN se la sirve a Vercel, la URL viaja entre redes y el host
 * es redirigible. Justo después se repite la prueba en local: sin ese control no se puede
 * distinguir "atado por IP" de "el token caducó mientras probábamos".
 *
 *   npx ts-node scripts/dev/probe_hosts.ts
 *   npx ts-node scripts/dev/probe_hosts.ts --sample=5
 *   npx ts-node scripts/dev/probe_hosts.ts --remote=https://api-pelis-series-latino.vercel.app
 *   npx ts-node scripts/dev/probe_hosts.ts https://pelisplus.upns.pro/#swto1
 */

const RANGE = 'bytes=0-2047';
const FOREIGN_REFERER = 'https://example.com/';

/** Muestra de respaldo: una por familia de host, cuando no hay catálogo a mano. */
const FALLBACK_SAMPLE = [
  'https://vidhideplus.com/v/30wr0gu38qsb',
  'https://pelisplus.upns.pro/#swto1',
  'https://dropload.co/e/36de67pbkl7x',
  'https://ok.ru/videoembed/8812862769808',
  'https://blogfc13.blogspot.com/?m=1.html?r=Ly9nc2Nkbi5jYW0vdmlkZW8vZW1iZWQvczNtYWw0ZzlnZHF2',
];

interface ProbeResult {
  status: number;
  ttfbMs: number;
  cors: string | null;
  error?: string;
}

interface HostFinding {
  family: string;
  embedUrl: string;
  cdnHost: string;
  kind: DirectStream['kind'];
  extracted: boolean;
  playable: boolean;
  refererRequired: boolean | null;
  refererChecked: boolean | null;
  browserUaRequired: boolean | null;
  cors: string | null;
  ipBound: boolean | null;
  /** Host que sirve los segmentos. Suele NO ser el del manifiesto, y ahí está la trampa. */
  segmentHost: string | null;
  segmentRefererRequired: boolean | null;
  segmentRefererChecked: boolean | null;
  segmentCors: string | null;
  tokenTtlSeconds: number | null;
  ttfbDirectMs: number | null;
  note: string;
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** Familia del host: los dos últimos labels. `pelisplus.upns.pro` y `x.upns.pro` son lo mismo. */
function familyOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().split('.').slice(-2).join('.');
  } catch {
    return '?';
  }
}

/**
 * Vida REAL que le queda a la firma.
 *
 * Estos CDN no publican la caducidad: la meten como un parámetro más con marca de tiempo Unix
 * (`e=` en la familia Earnvids, `kx=` en upns). Se coge la mayor que esté en el futuro, que es
 * la que manda. Sirve para dos cosas: saber cuánto puede durar el caché del mint y comprobar
 * si "caduca" y "ata por IP" son de verdad cosas distintas en este host.
 */
function tokenTtlSeconds(url: string): number | null {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  let best: number | null = null;
  for (const [, raw] of params) {
    if (!/^1[6-9]\d{8}$/.test(raw)) continue;
    const remaining = Number(raw) - now;
    if (remaining > 0 && (best === null || remaining > best)) best = remaining;
  }
  return best;
}

/**
 * Pide los primeros bytes y mide hasta la cabecera. Corta el flujo en cuanto llega: aquí
 * interesa si el CDN ACEPTA la petición y cuánto tarda en contestar, no descargar vídeo.
 */
async function probe(url: string, headers: Record<string, string>): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const res = await axios.get(url, {
      headers: { Range: RANGE, ...headers },
      responseType: 'stream',
      timeout: 15000,
      decompress: false,
      validateStatus: () => true,
    });
    const ttfbMs = Date.now() - started;
    res.data?.destroy?.();
    return {
      status: res.status,
      ttfbMs,
      cors: (res.headers['access-control-allow-origin'] as string) || null,
    };
  } catch (err: any) {
    return { status: 0, ttfbMs: Date.now() - started, cors: null, error: err.code || err.message };
  }
}

const ok = (r: ProbeResult) => r.status >= 200 && r.status < 300;

/**
 * ¿Sirve esta URL desde OTRA red? Se le pide a la API desplegada que la descargue ella.
 * `/stream/direct/seg` acepta cualquier `?u=` y reenvía el Referer que toca, así que replica
 * exactamente las condiciones del proxy — lo único que cambia es la IP de salida.
 *
 * CUIDADO CON EL FALSO POSITIVO: ante un 403 ese endpoint RE-ACUÑA por su cuenta y reintenta
 * (`refreshTarget`), así que un 200 podría significar "Vercel se fabricó su propia URL" en vez
 * de "el CDN aceptó la nuestra" — que es justo lo contrario de lo que queremos medir. Por eso
 * en `e=` no va el embed completo sino solo su ORIGEN: el Referer sigue saliendo correcto
 * (`${origin}/`, que es todo lo que mira el CDN), pero re-acuñar sobre una raíz sin reproductor
 * devuelve null y la rama de reintento queda muerta. Lo que llegue es el veredicto limpio.
 */
async function probeCrossNetwork(remote: string, embedUrl: string, target: string): Promise<ProbeResult> {
  let refererSeed = embedUrl;
  try {
    refererSeed = `${new URL(embedUrl).origin}/`;
  } catch {}
  const url = `${remote.replace(/\/$/, '')}/api/v1/stream/direct/seg?u=${b64url(target)}&e=${b64url(refererSeed)}`;
  return probe(url, {});
}

/**
 * Baja por el árbol HLS hasta el PRIMER SEGMENTO real.
 *
 * Un maestro apunta a variantes y una variante a segmentos, y cada escalón puede estar en un host
 * distinto con reglas distintas — en upns lo está. Se siguen como mucho `MAX_DEPTH` saltos: con
 * dos basta para cualquier manifiesto de los que se ven aquí, y el tope evita quedarse dando
 * vueltas si un host se referencia a sí mismo.
 */
const MAX_DEPTH = 3;

async function firstSegmentUrl(manifestUrl: string, headers: Record<string, string>): Promise<string | null> {
  let current = manifestUrl;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let body: string;
    try {
      const res = await axios.get(current, { headers, timeout: 15000, responseType: 'text', validateStatus: () => true });
      if (res.status >= 400) return null;
      body = String(res.data);
    } catch {
      return null;
    }

    // La primera línea que no es etiqueta ni está vacía: variante si acaba en .m3u8, si no, ya
    // es el segmento que buscábamos.
    const uri = body
      .split(/\r?\n/)
      .map(l => l.trim())
      .find(l => l && !l.startsWith('#'));
    if (!uri) return null;

    let absolute: string;
    try {
      absolute = new URL(uri, current).toString();
    } catch {
      return null;
    }

    // Ojo con fiarse de la extensión al revés: upns disfraza sus segmentos de `.woff2`. Aquí solo
    // se usa para reconocer una PLAYLIST, que sí lleva siempre `.m3u8` en la ruta.
    let isPlaylist: boolean;
    try {
      isPlaylist = /\.m3u8$/i.test(new URL(absolute).pathname);
    } catch {
      isPlaylist = false;
    }
    if (!isPlaylist) return absolute;
    current = absolute;
  }

  return null;
}

async function sampleFromCatalog(perHost: number): Promise<string[]> {
  try {
    const { data } = await getSupabaseAdmin()
      .from('media_items')
      .select('servers')
      .not('servers', 'is', null)
      .neq('servers', '[]')
      .limit(600);

    const byFamily = new Map<string, string[]>();
    for (const row of data || []) {
      for (const server of (row.servers || []) as any[]) {
        const embed = server?.embed_url;
        if (!embed) continue;
        const family = familyOf(unwrapRedirector(embed));
        const bucket = byFamily.get(family) || [];
        if (bucket.length >= perHost || bucket.includes(embed)) continue;
        bucket.push(embed);
        byFamily.set(family, bucket);
      }
    }
    const flat = [...byFamily.values()].flat();
    return flat.length ? flat : FALLBACK_SAMPLE;
  } catch {
    return FALLBACK_SAMPLE;
  }
}

async function inspectOne(original: string, remote: string | null): Promise<HostFinding> {
  const embedUrl = unwrapRedirector(original);
  const base: HostFinding = {
    family: familyOf(embedUrl),
    embedUrl,
    cdnHost: '-',
    kind: 'mp4',
    extracted: false,
    playable: false,
    refererRequired: null,
    refererChecked: null,
    browserUaRequired: null,
    cors: null,
    ipBound: null,
    segmentHost: null,
    segmentRefererRequired: null,
    segmentRefererChecked: null,
    segmentCors: null,
    tokenTtlSeconds: null,
    ttfbDirectMs: null,
    note: '',
  };

  const { html } = await inspectEmbed(embedUrl);
  const direct = await extractDirect(embedUrl, html, { allowNetwork: true });
  if (!direct) return { ...base, note: 'sin extracción' };

  const embedOrigin = (() => {
    try {
      return new URL(embedUrl).origin;
    } catch {
      return embedUrl;
    }
  })();

  const withReferer = { 'User-Agent': USER_AGENT, Referer: `${embedOrigin}/` };
  const baseline = await probe(direct.url, withReferer);

  const finding: HostFinding = {
    ...base,
    cdnHost: familyOf(direct.url),
    kind: direct.kind,
    extracted: true,
    playable: ok(baseline),
    cors: baseline.cors,
    tokenTtlSeconds: tokenTtlSeconds(direct.url),
    ttfbDirectMs: baseline.ttfbMs,
  };

  // Sin una petición buena de referencia, el resto de comparaciones no significan nada.
  if (!ok(baseline)) {
    return { ...finding, note: `el CDN rechaza incluso con Referer (HTTP ${baseline.status}${baseline.error ? ' ' + baseline.error : ''})` };
  }

  const [noReferer, badReferer, noBrowserUa] = await Promise.all([
    probe(direct.url, { 'User-Agent': USER_AGENT }),
    probe(direct.url, { 'User-Agent': USER_AGENT, Referer: FOREIGN_REFERER }),
    probe(direct.url, { Referer: `${embedOrigin}/` }),
  ]);

  finding.refererRequired = !ok(noReferer);
  finding.refererChecked = !ok(badReferer);
  finding.browserUaRequired = !ok(noBrowserUa);

  // Lo que decide si el 302 reproduce de verdad: qué exige un SEGMENTO, no el manifiesto.
  if (direct.kind === 'hls') {
    const segment = await firstSegmentUrl(direct.url, withReferer);
    if (!segment) {
      finding.note = 'no se pudo llegar a un segmento: los campos segment* quedan sin medir';
    } else {
      finding.segmentHost = familyOf(segment);
      const [segBaseline, segNoReferer, segBadReferer] = await Promise.all([
        probe(segment, withReferer),
        probe(segment, { 'User-Agent': USER_AGENT }),
        probe(segment, { 'User-Agent': USER_AGENT, Referer: FOREIGN_REFERER }),
      ]);
      if (!ok(segBaseline)) {
        finding.note = `el segmento rechaza incluso con Referer (HTTP ${segBaseline.status})`;
      } else {
        finding.segmentRefererRequired = !ok(segNoReferer);
        finding.segmentRefererChecked = !ok(segBadReferer);
        finding.segmentCors = segBaseline.cors;
      }
    }
  }

  if (remote) {
    const cross = await probeCrossNetwork(remote, embedUrl, direct.url);
    // Control: si el token murió durante la prueba, el fallo remoto no prueba atadura de IP.
    const stillAliveHere = ok(await probe(direct.url, withReferer));
    if (ok(cross)) {
      finding.ipBound = false;
    } else if (!stillAliveHere) {
      finding.ipBound = null;
      finding.note = 'no concluyente: el token caducó durante la prueba';
    } else {
      finding.ipBound = true;
      finding.note = `sirve aquí pero no desde Vercel (HTTP ${cross.status})`;
    }
  }

  return finding;
}

/** Veredicto por familia: se queda con lo MÁS restrictivo que se haya observado. */
function summarize(findings: HostFinding[]): Map<string, HostFinding> {
  const byFamily = new Map<string, HostFinding>();
  for (const f of findings) {
    if (!f.extracted || !f.playable) continue;
    const prev = byFamily.get(f.family);
    if (!prev) {
      byFamily.set(f.family, { ...f });
      continue;
    }
    byFamily.set(f.family, {
      ...prev,
      refererRequired: Boolean(prev.refererRequired || f.refererRequired),
      refererChecked: Boolean(prev.refererChecked || f.refererChecked),
      browserUaRequired: Boolean(prev.browserUaRequired || f.browserUaRequired),
      // Basta UNA observación de atadura para no poder redirigir esa familia.
      ipBound: prev.ipBound === true || f.ipBound === true ? true
        : prev.ipBound === false && f.ipBound === false ? false
        : prev.ipBound ?? f.ipBound,
      cors: prev.cors || f.cors,
      segmentHost: prev.segmentHost || f.segmentHost,
      // Mismo criterio que arriba: si una muestra vio la exigencia, la familia la tiene.
      segmentRefererRequired: prev.segmentRefererRequired === true || f.segmentRefererRequired === true ? true
        : prev.segmentRefererRequired ?? f.segmentRefererRequired,
      segmentRefererChecked: prev.segmentRefererChecked === true || f.segmentRefererChecked === true ? true
        : prev.segmentRefererChecked ?? f.segmentRefererChecked,
      segmentCors: prev.segmentCors || f.segmentCors,
      tokenTtlSeconds: Math.min(prev.tokenTtlSeconds ?? Infinity, f.tokenTtlSeconds ?? Infinity) || null,
    });
  }
  return byFamily;
}

function flag(value: boolean | null): string {
  return value === null ? ' ? ' : value ? 'SÍ ' : 'no ';
}

/**
 * El modo que le tocaría a este host. Es la misma cascada que `bestMode` (hostPolicy.ts), con
 * `null` —lo no medido— tratado como lo peor, para que el veredicto nunca sugiera más de lo que
 * se ha comprobado.
 */
function suggestMode(f: HostFinding): string {
  if (f.ipBound !== false) return f.ipBound === null ? 'proxy (ipBound sin medir)' : 'proxy';
  if (f.kind !== 'hls') return f.refererRequired ? 'redirect (solo cliente nativo)' : 'redirect';

  const playlistsOk = f.refererRequired === false && f.refererChecked === false && Boolean(f.cors);
  // El navegador manda el Referer de su página; solo importa que el segmento no exija OTRO.
  const segmentsOk = f.segmentRefererChecked === false && Boolean(f.segmentCors);
  if (playlistsOk && segmentsOk) {
    // Sin Referer no hay segmento, así que un cliente que no manda ninguno seguirá en proxy.
    return f.segmentRefererRequired ? 'redirect (proxy si el cliente no manda Referer)' : 'redirect';
  }
  if (segmentsOk) return 'manifest';
  if (f.segmentRefererRequired === null) return 'proxy (segmento sin medir)';
  return 'proxy';
}

function human(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '?';
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

async function main() {
  const args = process.argv.slice(2);
  const remote = (args.find(a => a.startsWith('--remote='))?.split('=')[1]) || null;
  const perHost = Number(args.find(a => a.startsWith('--sample='))?.split('=')[1]) || 2;
  const explicit = args.filter(a => a.startsWith('http'));

  const targets = explicit.length ? explicit : await sampleFromCatalog(perHost);

  console.log(`Sondeando ${targets.length} embeds${remote ? ` (test de IP contra ${remote})` : ' (sin --remote: NO se mide ipBound)'}\n`);

  const findings: HostFinding[] = [];
  for (const target of targets) {
    let finding: HostFinding;
    try {
      finding = await inspectOne(target, remote);
    } catch (err: any) {
      finding = { ...(await inspectOne(target, null).catch(() => null)) as HostFinding, note: `ERR ${err.message}` };
    }
    findings.push(finding);
    const state = !finding.extracted ? 'sin extracción' : finding.playable ? 'reproduce' : 'MUDO';
    console.log(
      `  ${finding.family.padEnd(22)} ${String(finding.kind).padEnd(4)} ${state.padEnd(14)} ` +
      `${(finding.ttfbDirectMs !== null ? finding.ttfbDirectMs + 'ms' : '-').padEnd(8)} ` +
      `cdn=${finding.cdnHost.padEnd(20)} ${finding.note}`
    );
  }

  const summary = summarize(findings);
  console.log('\n════ VEREDICTO POR HOST ════');
  console.log('host                    referer  valida  UA-nav  ipBound  CORS  seg-ref  seg-val  seg-CORS  token   modo sugerido');
  for (const [family, f] of summary) {
    console.log(
      `${family.padEnd(23)} ${flag(f.refererRequired)}     ${flag(f.refererChecked)}    ` +
      `${flag(f.browserUaRequired)}    ${flag(f.ipBound)}     ${(f.cors || '-').slice(0, 4).padEnd(5)} ` +
      `${flag(f.segmentRefererRequired)}      ${flag(f.segmentRefererChecked)}      ` +
      `${(f.segmentCors || '-').slice(0, 4).padEnd(9)} ` +
      `${human(f.tokenTtlSeconds).padEnd(7)} ${suggestMode(f)}`
    );
    if (f.segmentHost && f.segmentHost !== f.cdnHost) {
      console.log(`${''.padEnd(23)} └─ los segmentos están en ${f.segmentHost}, no en ${f.cdnHost}`);
    }
  }

  console.log('\n════ PARA SEMBRAR src/scrapers/hostPolicy.ts ════');
  console.log(JSON.stringify(
    [...summary.entries()].map(([family, f]) => ({
      match: [family],
      cdn: f.cdnHost,
      ipBound: f.ipBound ?? true,
      refererRequired: f.refererRequired ?? true,
      // Rechaza un Referer AJENO aunque acepte que no haya ninguno: obliga a mandar
      // `Referrer-Policy: no-referrer` en el 302 o el navegador filtrará nuestro origen.
      refererChecked: f.refererChecked ?? true,
      cors: f.cors === '*' || Boolean(f.cors),
      // Lo no medido en el segmento va a lo peor, igual que en CONSERVATIVE.
      segmentRefererRequired: f.segmentRefererRequired ?? true,
      segmentRefererChecked: f.segmentRefererChecked ?? true,
      segmentCors: f.segmentCors === '*' || Boolean(f.segmentCors),
      tokenTtlSeconds: Number.isFinite(f.tokenTtlSeconds) ? f.tokenTtlSeconds : null,
      measuredAt: new Date().toISOString().slice(0, 10),
    })),
    null,
    2
  ));

  const modes = [...summary.values()].map(suggestMode);
  const noProxy = modes.filter(m => !m.startsWith('proxy')).length;
  console.log(`\n${noProxy}/${summary.size} familias de host sirven el vídeo sin reenviar bytes.`);
  if (!remote) console.log('Sin --remote no hay medición de ipBound: todo queda en "proxy" por defecto.');
  const sinSegmento = [...summary.values()].filter(f => f.kind === 'hls' && f.segmentRefererRequired === null).length;
  if (sinSegmento) console.log(`${sinSegmento} familia(s) HLS sin medición de segmento: quedan en el perfil conservador.`);
}

main().then(() => setTimeout(() => process.exit(0), 400).unref());
