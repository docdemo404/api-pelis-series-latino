/**
 * ¿QUÉ SACA DE VERDAD EL SCRAPER DE ARCHIVE.ORG?
 *
 * No mide «cuántos items hay» —eso ya se sabe: 3.755 con `subject:"Pelicula"` y 5.530 con
 * `"Serie"`— sino cuántos SOBREVIVEN a la regla de identidad, que es lo único que importa. La
 * regla es estricta a propósito: `metadata.year` es el año de la SUBIDA y discrepa del real en
 * el 31 % de los casos, así que el año tiene que salir del título o de la descripción, y sin
 * año el item no entra. Ver el bloque de archive.org en realScraperService.
 *
 * Y abre unas cuantas fichas de verdad para ver si el fichero está y si el emparejado con TMDB
 * acierta, que es lo que ningún número dice.
 *
 *   npx ts-node -T scripts/dev/probe_archive_scraper.ts [cuantas]
 */
import 'dotenv/config';
import { RealScraperService } from '../../src/services/realScraperService';
import { TmdbService } from '../../src/services/tmdbService';
import { streamClient } from '../../src/utils/httpClient';

const N = Number(process.argv[2]) || 40;

/** ¿Entrega bytes de vídeo? Es la misma prueba que hace el crawl antes de guardar. */
async function entregaVideo(url: string): Promise<{ ok: boolean; http: number; tipo: string }> {
  try {
    const r = await streamClient.get(url, {
      headers: { Range: 'bytes=0-65535' },
      responseType: 'arraybuffer',
      timeout: 30000,
      validateStatus: () => true,
      maxRedirects: 5,
    } as any);
    const bytes = (r.data as ArrayBuffer)?.byteLength ?? 0;
    const tipo = String(r.headers['content-type'] || '');
    return { ok: r.status < 400 && bytes > 8192 && !/text\/html/i.test(tipo), http: r.status, tipo };
  } catch (e: any) {
    return { ok: false, http: 0, tipo: e?.code || 'excepción' };
  }
}

(async () => {
  for (const tipo of ['movie', 'tvseries'] as const) {
    console.log(`\n═══ ${tipo === 'movie' ? 'PELÍCULAS' : 'SERIES'} ═══`);
    const items = await RealScraperService.scrapeArchiveLatest(tipo, N);
    console.log(`${items.length} items pasan la regla de identidad (clase declarada + año de la obra + no es pack)\n`);

    let conFichero = 0, reproducen = 0, casanTmdb = 0;
    for (const it of items.slice(0, Math.min(10, items.length))) {
      const detalle = await RealScraperService.scrapeArchiveDetail(it._source_url as string);
      const servidores = detalle?.servers?.length
        ? detalle.servers
        : ((detalle as any)?.seasons || []).flatMap((t: any) => (t.episodes || []).flatMap((e: any) => e.servers || []));
      if (!servidores.length) {
        console.log(`  ✗ ${it.title.slice(0, 46).padEnd(46)} (${it.release_date})  sin fichero utilizable`);
        continue;
      }
      conFichero++;

      const prueba = await entregaVideo(String(servidores[0].direct_stream));
      if (prueba.ok) reproducen++;

      // El emparejado: lo mismo que hará el crawl al enriquecer.
      const match = await TmdbService.resolveTmdb(it.title, it.type, it.release_date).catch(() => null as any);
      if (match?.id) casanTmdb++;

      console.log(
        `  ${prueba.ok ? '✓' : '✗'} ${it.title.slice(0, 46).padEnd(46)} (${it.release_date})  ` +
        `${servidores.length} fichero(s)  http=${prueba.http}  ` +
        `TMDB=${match?.id ? `${match.id} «${String(match.title || match.name || '').slice(0, 28)}»` : 'sin match'}`
      );
    }
    const mirados = Math.min(10, items.length);
    console.log(`\n  de ${mirados} abiertos: ${conFichero} con fichero · ${reproducen} entregan vídeo · ${casanTmdb} casan con TMDB`);
  }
})();
