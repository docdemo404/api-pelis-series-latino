import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';

/**
 * LA PRUEBA DE QUE EL CRAWL NO SE LLEVA LO PUESTO A MANO.
 *
 * No se puede probar con las fichas manuales que hay: sus ids empiezan por `manual-` y el crawl
 * nunca genera ese id, así que ni las mira. Lo que se perdía era otra cosa — una url manual
 * FUSIONADA dentro de la ficha de un scraper, que sí lleva el id que el crawl vuelve a escribir
 * cada pasada.
 *
 * Así que la prueba planta esa situación a propósito: una marca `source_id: 'manual'` dentro de
 * filas normales del catálogo, se lanza el crawl de verdad, y después se mira si siguen ahí.
 *
 * Las marcas son INERTES para la app: van sin `verified_at`, y `paraElCliente` exige el sello
 * vigente para publicar un servidor. Nadie puede recibirlas mientras dure la prueba.
 *
 *   plantar <n>   pone la marca en n filas (y en un capítulo, si la fila es serie)
 *   mirar         dice cuáles siguen y cuáles no, y si el crawl llegó a reescribir esa fila
 *   quitar        las retira todas
 */

const MARCA = 'https://prueba-crawl-no-borrar.invalid/';
const esMarca = (sv: any) => String(sv?.direct_stream || '').startsWith(MARCA);

async function todasLasFilas(db: any, columnas: string) {
  const filas: any[] = [];
  let desde = 0;
  for (;;) {
    const { data, error } = await db.from('media_items').select(columnas).order('id').range(desde, desde + 199);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 200) break;
    desde += 200;
  }
  return filas;
}

function servidorDePrueba(id: string, sufijo: string) {
  return {
    id: `${id}_prueba_${sufijo}`,
    name: 'PRUEBA no borrar',
    embed_url: `${MARCA}${id}/${sufijo}.mp4`,
    direct_stream: `${MARCA}${id}/${sufijo}.mp4`,
    direct_mode: 'public',
    direct_kind: 'mp4',
    status: 'online',
    source_id: 'manual',
    // A propósito SIN verified_at: sin sello no se publica a nadie.
  };
}

(async () => {
  const db = getSupabaseAdmin();
  const orden = process.argv[2];

  if (orden === 'plantar') {
    const cuantas = Number(process.argv[3]) || 20;
    /**
     * Solo filas de scraper, y de las que va a rescribir la pasada que se vaya a lanzar: el id
     * dice de qué fuente es. `^20\d\d-` es fuegocine; `^md-`, moviedays, que es donde están las
     * series y por tanto el único sitio donde se puede probar la marca DENTRO de un capítulo.
     */
    const filas = (await todasLasFilas(db, 'id,type,servers,seasons,streams_updated_at'))
      .filter(r => new RegExp(process.argv[4] || '^20\\d\\d-').test(r.id))
      .slice(0, cuantas);

    const puestas: any[] = [];
    for (const r of filas) {
      const servers = (r.servers || []).filter((sv: any) => !esMarca(sv));
      servers.unshift(servidorDePrueba(r.id, 'ficha'));

      let seasons = r.seasons || [];
      let capMarcado: string | null = null;
      if (r.type === 'tvseries' && seasons.length) {
        seasons = seasons.map((t: any) => ({ ...t, episodes: [...(t.episodes || [])] }));
        const t = seasons.find((x: any) => (x.episodes || []).length);
        if (t) {
          const e = t.episodes[0];
          capMarcado = `${t.season_number}x${e.episode_number}`;
          t.episodes[0] = {
            ...e,
            servers: [servidorDePrueba(r.id, 'cap'), ...((e.servers || []).filter((sv: any) => !esMarca(sv)))],
          };
        }
      }

      const patch: Record<string, unknown> = { servers };
      if (capMarcado) patch.seasons = seasons;
      const { error } = await db.from('media_items').update(patch).eq('id', r.id);
      if (error) { console.log(`  ✗ ${r.id}: ${error.message}`); continue; }
      puestas.push({ id: r.id, type: r.type, cap: capMarcado, streams_updated_at: r.streams_updated_at });
    }

    console.log(JSON.stringify(puestas, null, 1));
    console.log(`\nmarcadas ${puestas.length} filas (${puestas.filter(p => p.cap).length} con marca también en un capítulo)`);
    process.exit(0);
  }

  if (orden === 'mirar') {
    const filas = await todasLasFilas(db, 'id,type,servers,seasons,streams_updated_at,updated_at');
    let enFicha = 0, enCap = 0;
    const conMarca: any[] = [];
    for (const r of filas) {
      const ficha = (r.servers || []).some(esMarca);
      const caps = (r.seasons || []).flatMap((t: any) => t.episodes || []).filter((e: any) => (e.servers || []).some(esMarca));
      if (ficha) enFicha++;
      enCap += caps.length;
      if (ficha || caps.length) {
        conMarca.push({ id: r.id, ficha, caps: caps.length, streams_updated_at: r.streams_updated_at, updated_at: r.updated_at });
      }
    }
    console.log(JSON.stringify(conMarca, null, 1));
    console.log(`\nmarcas vivas: ${enFicha} en ficha · ${enCap} en capítulos`);
    process.exit(0);
  }

  if (orden === 'quitar') {
    const filas = await todasLasFilas(db, 'id,servers,seasons');
    let limpiadas = 0;
    for (const r of filas) {
      const ficha = (r.servers || []).some(esMarca);
      const enCaps = (r.seasons || []).some((t: any) => (t.episodes || []).some((e: any) => (e.servers || []).some(esMarca)));
      if (!ficha && !enCaps) continue;

      const patch: Record<string, unknown> = {};
      if (ficha) patch.servers = (r.servers || []).filter((sv: any) => !esMarca(sv));
      if (enCaps) {
        patch.seasons = (r.seasons || []).map((t: any) => ({
          ...t,
          episodes: (t.episodes || []).map((e: any) =>
            (e.servers || []).some(esMarca) ? { ...e, servers: e.servers.filter((sv: any) => !esMarca(sv)) } : e),
        }));
      }
      const { error } = await db.from('media_items').update(patch).eq('id', r.id);
      if (error) { console.log(`  ✗ ${r.id}: ${error.message}`); continue; }
      limpiadas++;
    }
    console.log(`marcas retiradas de ${limpiadas} filas`);
    process.exit(0);
  }

  console.error('uso: prueba_crawl_manual.ts plantar <n> | mirar | quitar');
  process.exit(1);
})();
