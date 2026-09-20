/**
 * RETIRA LOS VÍDEOS DE MUESTRA QUE SE COLARON COMO SI FUERAN LA OBRA (2026-09-20)
 *
 * El 2026-09-20 el usuario avisó de que «El conejo de peluche» reproducía diez segundos de Big
 * Buck Bunny. Medido: `voe.sx` nos devolvió ese mismo fichero en **83 de 83** extracciones, y como
 * es un mp4 real y sano pasó la verificación entera —resolver, bajar el manifiesto, descargar un
 * segmento—. El proyecto comprobaba que llegara vídeo; no que fuera EL vídeo.
 *
 * La puerta ya está cerrada en `esVideoDeMuestra` (directStream, vale para TODAS las fuentes) y en
 * `HOSTS_QUE_NO_ENTREGAN` (lamoviebot, para no guardar ni el embed). Esto limpia lo ya escrito.
 *
 * QUÉ HACE, y por qué no borra fichas:
 *
 *   · quita el SERVIDOR envenenado de `servers` y de los capítulos;
 *   · a la ficha que se queda sin ninguno le pone `has_streams = false`, que es lo que la retira
 *     del catálogo visible sin destruir nada. Borrar la fila sería irreversible y estas fichas
 *     tienen identidad buena — lo que no tienen es de dónde reproducir. Si mañana entra otra
 *     fuente con la misma obra, la fila ya está ahí y se le cuelga encima.
 *
 * Y retira del caché cada ficha tocada: arreglar la fila no basta, porque la metadata se cachea y
 * con caché compartido las claves sobreviven a los despliegues.
 *
 *   npx ts-node --transpile-only scripts/dev/limpiar_senuelos.ts           ← mide
 *   npx ts-node --transpile-only scripts/dev/limpiar_senuelos.ts --apply   ← y limpia
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { esVideoDeMuestra } from '../../src/scrapers/directStream';
import { CatalogService } from '../../src/services/catalogService';

const db = getSupabaseAdmin();
const APLICAR = process.argv.includes('--apply');

/** ¿Este servidor guardado sirve material de demostración? Se mira el directo Y el embed. */
function envenenado(s: any): boolean {
  return esVideoDeMuestra(s?.direct_stream) || esVideoDeMuestra(s?.embed_url) || esVideoDeMuestra(s?.url);
}

async function main() {
  const cuenta = { fichas: 0, servidores: 0, capitulos: 0, sinNada: 0, escritas: 0, errores: 0 };
  const sinNada: string[] = [];

  for (let desde = 0; ; desde += 500) {
    const { data, error } = await db
      .from('media_items')
      .select('id,title,servers,seasons,has_streams')
      .order('id')
      .range(desde, desde + 499);
    if (error) throw new Error(error.message);
    const lote: any[] = data || [];
    if (!lote.length) break;

    for (const f of lote) {
      const servers: any[] = Array.isArray(f.servers) ? f.servers : [];
      const seasons: any[] = Array.isArray(f.seasons) ? f.seasons : [];

      const limpios = servers.filter((s) => !envenenado(s));
      const quitadosFicha = servers.length - limpios.length;

      let quitadosCap = 0;
      const seasonsLimpias = seasons.map((t: any) => ({
        ...t,
        episodes: (t?.episodes || []).map((e: any) => {
          const srv: any[] = Array.isArray(e?.servers) ? e.servers : [];
          const ok = srv.filter((s) => !envenenado(s));
          quitadosCap += srv.length - ok.length;
          return { ...e, servers: ok };
        }),
      }));

      if (!quitadosFicha && !quitadosCap) continue;

      cuenta.fichas++;
      cuenta.servidores += quitadosFicha;
      cuenta.capitulos += quitadosCap;

      /**
       * ¿Le queda algo con lo que reproducir? Cuentan los servidores de la ficha Y los de sus
       * capítulos: una serie sin servidores propios pero con capítulos servidos sigue siendo
       * reproducible, y apagarle `has_streams` la escondería entera por nada.
       */
      const capitulosVivos = seasonsLimpias.some((t: any) =>
        (t?.episodes || []).some((e: any) => (e?.servers || []).length > 0)
      );
      const quedaAlgo = limpios.length > 0 || capitulosVivos;
      if (!quedaAlgo) {
        cuenta.sinNada++;
        if (sinNada.length < 15) sinNada.push(`     · ${f.id}  "${f.title}"`);
      }

      if (!APLICAR) continue;

      const update: Record<string, unknown> = {
        servers: limpios,
        updated_at: new Date().toISOString(),
        streams_checked_at: new Date().toISOString(),
      };
      if (seasons.length) update.seasons = seasonsLimpias;
      if (!quedaAlgo) update.has_streams = false;

      const { error: err } = await db.from('media_items').update(update).eq('id', f.id);
      if (err) {
        console.log(`   ! ${f.id}: ${err.message}`);
        cuenta.errores++;
        continue;
      }
      cuenta.escritas++;
      // El caché tapa las reparaciones: la fila arreglada y la respuesta vieja conviviendo.
      try {
        await CatalogService.invalidateItem({ id: f.id });
      } catch {}
    }
    if (lote.length < 500) break;
  }

  console.log(`\nSEÑUELOS RETIRADOS${APLICAR ? '' : ' (simulado — usa --apply)'}\n`);
  console.log(`  fichas tocadas:            ${cuenta.fichas}`);
  console.log(`  servidores de ficha:       ${cuenta.servidores}`);
  console.log(`  servidores de capítulo:    ${cuenta.capitulos}`);
  console.log(`  fichas que quedan SIN NADA: ${cuenta.sinNada}  → has_streams = false`);
  if (APLICAR) console.log(`  filas escritas:            ${cuenta.escritas}  (errores: ${cuenta.errores})`);
  if (sinNada.length) console.log(`\n  Las que se quedan sin con qué reproducir:\n${sinNada.join('\n')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
