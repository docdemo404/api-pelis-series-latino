/**
 * PONERLE SU FUENTE A LOS ENLACES QUE SE GUARDARON CON LA EQUIVOCADA.
 *
 * `fuenteDeLaUrl` no conocía archive.org y su `return` final es `'tioplus'`, así que las primeras
 * fichas de archive.org se guardaron con sus servidores rotulados como TioPlus. El panel las
 * enseñaba mal y, lo que importa más, `sortServersBySourcePriority` les daba la prioridad de
 * tioplus — la penúltima, y la de una fuente que publica urls que caducan.
 *
 * El `source_id` se deduce de la URL, que es el dato que no puede estar equivocado: un
 * `archive.org/download/…` es de archive.org lo diga la etiqueta o no.
 *
 *   npx ts-node -T scripts/dev/reparar_source_id.ts [--apply]
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';

const db = getSupabaseAdmin();
const apply = process.argv.includes('--apply');

function fuenteDe(url: string): string | null {
  if (/archive\.org/i.test(url)) return 'archive';
  if (/fuegocine|blogfc|repfuegocinefree/i.test(url)) return 'fuegocine';
  return null;
}

(async () => {
  let ultimo = '', filas = 0, tocadas = 0, servidores = 0;
  for (;;) {
    const { data, error } = await db.from('media_items')
      .select('id,title,servers,seasons').gt('id', ultimo).order('id').limit(500);
    if (error) { console.error(error.message); return; }
    if (!data?.length) break;
    ultimo = (data[data.length - 1] as any).id;

    for (const fila of data as any[]) {
      filas++;
      let cambiada = false;
      const arreglar = (lista: any[] | null | undefined) => {
        for (const s of lista || []) {
          const url = String(s?.direct_stream || s?.embed_url || '');
          const debeSer = fuenteDe(url);
          if (!debeSer || s.source_id === debeSer) continue;
          /**
           * LO PUESTO A MANO SE QUEDA COMO MANUAL, aunque el fichero viva en archive.org.
           *
           * `manual` no describe DONDE esta el fichero: describe que lo puso una persona desde el
           * panel, y por eso tiene la prioridad 1 — es lo unico que no depende de que una web
           * ajena siga viva. Reescribirlo por el host le quita esa garantia y lo manda a competir
           * con lo scrapeado.
           */
          if (s.source_id === 'manual') continue;
          console.log(`   ${fila.title}: ${s.source_id || '(sin)'} → ${debeSer}`);
          s.source_id = debeSer;
          cambiada = true;
          servidores++;
        }
      };
      arreglar(fila.servers);
      for (const t of fila.seasons || []) for (const e of t?.episodes || []) arreglar(e?.servers);

      if (!cambiada) continue;
      tocadas++;
      if (!apply) continue;
      const { error: e2 } = await db.from('media_items')
        .update({ servers: fila.servers || [], seasons: fila.seasons || [] }).eq('id', fila.id);
      if (e2) console.warn(`   ⚠ ${fila.id}: ${e2.message}`);
    }
  }
  console.log(`\n${filas} filas · ${tocadas} con la fuente mal · ${servidores} servidor(es) rotulados de nuevo`);
  if (!apply) console.log('   (ensayo — con --apply se escribe)');
})();
