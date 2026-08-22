/**
 * Prueba de la fuente moviedays de punta a punta, con el código real y no con curl.
 *
 * Lo que mide, en este orden: que una película salga con servidores que ABREN, que una serie
 * salga con su árbol, que un capítulo se resuelva por el camino del catálogo, y que el
 * descubrimiento por TMDB devuelva fichas con vídeo. Es lo que separa «devuelve servidores» de
 * «reproduce», que en este proyecto ya ha costado dos sustos.
 */
import { RealScraperService } from '../../src/services/realScraperService';
import { moviedaysSourceUrl } from '../../src/scrapers/moviedays';
import { extractDirect } from '../../src/scrapers/directStream';
import { MediaItem, ServerOption } from '../../src/types';

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36';

/**
 * REPRODUCIR DE VERDAD, no mirar si hay un campo puesto.
 *
 * `direct_stream` es una ruta de esta misma API (`/api/v1/stream/direct/v.m3u8?e=<embed en base64>`),
 * así que para comprobar que hay vídeo detrás hay que hacer lo que haría el servidor: decodificar
 * el embed, extraerlo y bajarse un trozo del CDN.
 */
async function abre(sv: ServerOption): Promise<string> {
  let url = sv.direct_stream || '';
  if (url.startsWith('/')) {
    const e = new URL(url, 'https://x').searchParams.get('e') || '';
    const embed = Buffer.from(e, 'base64').toString('utf8');
    const html = await fetch(embed, { headers: { 'User-Agent': UA, Referer: 'https://moviedays.lat/' } }).then(r => r.text()).catch(() => '');
    const d = await extractDirect(embed, html, { allowNetwork: true }).catch(() => null);
    if (!d) return `no se extrae de ${embed.slice(0, 40)}`;
    url = d.url;
  }
  if (!url) return 'sin directo';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Range: 'bytes=0-65535' } });
    const b = await r.arrayBuffer();
    return `${r.status} ${r.headers.get('content-type')} ${b.byteLength}B`;
  } catch (e: any) {
    return 'no abre: ' + String(e.message || e).slice(0, 40);
  }
}

function pinta(it: MediaItem | null, etiqueta: string) {
  if (!it) return console.log(`  ${etiqueta}: NULL`);
  console.log(`  ${etiqueta}: [${it.tmdb_id}] "${it.title}" (${it.release_date?.slice(0, 4) || '?'}) orig="${it.original_title}"`);
  console.log(`      id=${it.id} tipo=${it.type} imdb=${it.imdb_id} temporadas=${it.total_seasons ?? '-'} generos=${it.genres.join(',')}`);
  console.log(`      poster=${String(it.poster).slice(0, 58)}`);
  (it.servers || []).forEach(s =>
    console.log(`      · ${s.name} [${s.quality}/${s.language}] ${s.status} directo=${s.direct_kind || '-'}/${s.direct_mode || '-'} ${String(s.direct_stream || '').slice(0, 46)}`)
  );
}

(async () => {
  console.log('\n=== 1. PELICULA por tmdb id ===');
  for (const [nombre, id] of [['Fight Club', 550], ['Interstellar', 157336], ['Matrix', 603]] as Array<[string, number]>) {
    const it = await RealScraperService.scrapeMoviedaysDetail(moviedaysSourceUrl(id, 'movie'));
    pinta(it, nombre);
    for (const s of it?.servers || []) console.log(`        reproduce -> ${await abre(s)}`);
  }

  console.log('\n=== 2. SERIE por tmdb id ===');
  for (const [nombre, id] of [['Breaking Bad', 1396], ['Stranger Things', 66732]] as Array<[string, number]>) {
    const it = await RealScraperService.scrapeMoviedaysDetail(moviedaysSourceUrl(id, 'tvseries'));
    pinta(it, nombre);
    for (const s of it?.servers || []) console.log(`        reproduce -> ${await abre(s)}`);
    const conServidores = (it?.seasons || []).flatMap(t => (t.episodes || []).filter(e => (e.servers || []).length).map(e => `T${t.season_number}E${e.episode_number}`));
    const capitulos = (it?.seasons || []).reduce((n, t) => n + (t.episodes || []).length, 0);
    console.log(`      arbol: ${it?.seasons?.length || 0} temporadas, ${capitulos} capitulos | con servidores SOLO en: ${conServidores.join(', ') || 'ninguno'}`);
  }

  console.log('\n=== 3. CAPITULO por el camino del catalogo ===');
  for (const [nombre, id, se, ep] of [['Breaking Bad', 1396, 1, 1], ['Stranger Things', 66732, 4, 1], ['Arcane', 94605, 1, 2]] as Array<[string, number, number, number]>) {
    const r = await RealScraperService.scrapeEpisodeDetail(String(id), se, ep, { tmdbId: id });
    console.log(`  ${nombre} T${se}E${ep}: ${r ? `${r.servers.length} servidores (tmdb=${r.tmdb_id})` : 'NULL'}`);
    for (const s of r?.servers || []) console.log(`      · ${s.name} ${s.status} ${String(s.direct_stream || 'sin directo').slice(0, 50)}`);
  }

  console.log('\n=== 4. SENALES para el matcher ===');
  for (const u of [moviedaysSourceUrl(550, 'movie'), moviedaysSourceUrl(1396, 'tvseries')]) {
    console.log('  ', JSON.stringify(await RealScraperService.fetchSourceSignals(u)));
  }

  console.log('\n=== 5. DESCUBRIMIENTO (TMDB como indice) ===');
  for (const tipo of ['movie', 'tvseries'] as const) {
    const t0 = Date.now();
    const items = await RealScraperService.scrapeMoviedaysLatest(tipo, 10);
    console.log(`  ${tipo}: ${items.length} fichas con vídeo en ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    items.forEach(i => console.log(`      [${i.tmdb_id}] ${i.title} — ${i.servers?.length} srv`));
  }
  process.exit(0);
})();
