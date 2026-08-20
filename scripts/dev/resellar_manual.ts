/**
 * VUELVE A GUARDAR UNA FICHA DE LA FUENTE PROPIA, por el mismo camino que el panel.
 *
 * Existe porque la ficha manual de Shrek se perdió dos veces y por dos razones distintas, y las
 * dos dejan la fila en un estado del que no se sale sola:
 *
 *   1. `revocarSelloPorFalloDeReproduccion` le quitó el sello —con razón: se le estaba
 *      entregando a la app el proxy de un mp4 de 1,78 GB, y eso no reproduce—. Sin sello,
 *      `paraElCliente` no publica nada y la ficha desaparece de los listados.
 *   2. Una resolución profunda (`?deep=1`) juzgó el fichero como si fuera un reproductor, lo dio
 *      por muerto y le quitó el `direct_stream`, además de meterle embeds scrapeados.
 *
 * Las dos causas están arregladas, pero la fila estropeada sigue estropeada: devolver el sello
 * exige PRUEBA, que es la regla de la casa. `anadirFichaManual` se descarga 64 KB de cada url
 * antes de escribir nada, así que esto no «restaura» — vuelve a demostrarlo.
 *
 * Las urls se sacan de `embed_url`, que es donde sobreviven aunque `direct_stream` se pierda.
 *
 *   npx ts-node -T scripts/dev/resellar_manual.ts [id]
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { CatalogService } from '../../src/services/catalogService';
import { esFicheroDirecto } from '../../src/scrapers/directStream';

(async () => {
  const id = process.argv[2] || 'manual-shrek-tercero-2007';
  const { data } = await supabase
    .from('media_items').select('id,title,tmdb_id,type,servers,seasons').eq('id', id).maybeSingle();
  if (!data) { console.log(`No existe la fila ${id}.`); return; }

  const fila = data as any;

  /**
   * Solo las urls que son FICHERO. La fila puede haberse llenado de embeds scrapeados —a Shrek le
   * entraron emturbovid, vudeo y vidhideplus—, y esos no son de la fuente propia: los pone el
   * crawl y caducan. Meterlos aquí convertiría la fuente más fiable del catálogo en otra más.
   */
  const urls: string[] = Array.from(new Set(
    (fila.servers || [])
      .map((s: any) => String(s.direct_stream || s.embed_url || ''))
      .filter((u: string) => u && /^https?:\/\//i.test(u) && esFicheroDirecto(u))
  ));

  const episodios = (fila.seasons || []).flatMap((t: any) =>
    (t?.episodes || []).map((e: any) => ({
      season: t.season_number ?? e.season_number,
      episode: e.episode_number,
      urls: Array.from(new Set(
        (e?.servers || [])
          .map((s: any) => String(s.direct_stream || s.embed_url || ''))
          .filter((u: string) => u && /^https?:\/\//i.test(u) && esFicheroDirecto(u))
      )) as string[],
    })).filter((e: any) => e.urls.length)
  );

  console.log(`${fila.title} · tmdb=${fila.tmdb_id} · ${urls.length} url(s) de ficha · ${episodios.length} capítulo(s)`);
  for (const u of urls) console.log(`   ${u}`);
  if (!urls.length && !episodios.length) { console.log('Nada que volver a guardar: no queda ninguna url de fichero.'); return; }

  const r = await CatalogService.anadirFichaManual({ tmdbId: fila.tmdb_id, tipo: fila.type, urls, episodios });
  console.log(`\nok=${r.ok} id=${r.id} aceptadas=${r.aceptadas.length} rechazadas=${r.rechazadas.length}${r.error ? ' error=' + r.error : ''}`);
})();
