/**
 * ROTULA CON TMDB LOS CAPÍTULOS YA GUARDADOS QUE ROTULÓ LA WEB.
 *
 * El arreglo vive en `TmdbService.rotularEpisodiosConTmdb` y corre en `enrichMediaItem`, o sea
 * sobre lo que ENTRA al catálogo. Lo que ya estaba guardado no lo arregla nadie: la fusión de
 * temporadas conserva a propósito la metadata previa —es lo que impide que un crawl parcial borre
 * capítulos— y una serie que ya está en la base no se vuelve a enriquecer. Este script es la
 * pasada que las pone al día.
 *
 * Entran TODAS las series, también las que se quedaron sin ficha de TMDB: a esas no se las puede
 * rotular, pero sí quitarles la publicidad de la web que ocupa el sitio de la sinopsis.
 *
 * Solo toca `seasons`, y solo el nombre, la sinopsis, el fotograma y la fecha de cada capítulo.
 * Los servidores y los campos internos (`_fuegocine_url`) se conservan: son lo único que aporta la
 * fuente y son de donde salen los enlaces.
 *
 *   npx tsx scripts/rotularCapitulos.ts --dry       ver qué cambiaría, sin escribir
 *   npx tsx scripts/rotularCapitulos.ts             aplicarlo
 *   npx tsx scripts/rotularCapitulos.ts --id=fc-invencible
 */
import 'dotenv/config';
import { TmdbService } from '../src/services/tmdbService';
import { getSupabaseAdmin } from '../src/services/supabaseService';

const db = getSupabaseAdmin();
const DRY = process.argv.includes('--dry');
const SOLO_ID = (process.argv.find(a => a.startsWith('--id=')) || '').split('=')[1] || '';

type Fila = { id: string; tmdb_id: number; title: string; poster: string | null; overview: string | null; seasons: any[] };

/**
 * La misma plantilla de SEO que `tmdbService` reconoce en los capítulos, aplicada a la sinopsis de
 * la FICHA. Estas dos —«La casa del dragón» y «Stranger Things» de FuegoCine— se quedaron sin
 * identidad en TMDB y con el anuncio de la web por sinopsis; no se anuncian, pero el texto se ve
 * desde el panel y viajaría entero el día que el matcher las reconozca.
 */
const PUBLICIDAD_DE_LA_WEB = /fuegocine|online gratis|tioplus/i;

/** Los capítulos de un árbol, aplanados, para poder compararlos antes y después. */
function capitulos(seasons: any[]): any[] {
  return (seasons || []).flatMap((t: any) => (t?.episodes || []));
}

/** Cuántos capítulos cambiarían de rótulo entre dos árboles. */
function cuantosCambian(antes: any[], despues: any[]): number {
  const clave = (t: any, e: any) => `${t?.season_number}x${e?.episode_number}`;
  const previo = new Map<string, any>();
  for (const t of antes || []) for (const e of (t?.episodes || [])) previo.set(clave(t, e), e);

  let n = 0;
  for (const t of despues || []) {
    for (const e of (t?.episodes || [])) {
      const p = previo.get(clave(t, e));
      if (!p) continue;
      if (p.name !== e.name || p.overview !== e.overview || p.still_path !== e.still_path || p.air_date !== e.air_date) n++;
    }
  }
  return n;
}

/**
 * Comprobación de seguridad: rotular NO puede perder capítulos ni servidores. Si el árbol nuevo
 * trae menos de una cosa o de la otra, esa fila no se escribe — en este proyecto han desaparecido
 * capítulos tres veces por escribir un `seasons` que parecía mejor.
 */
function noPierdeNada(antes: any[], despues: any[]): boolean {
  const bulto = (s: any[]) => capitulos(s).reduce((n, e) => n + 1 + (e?.servers || []).length, 0);
  const urls = (s: any[]) => new Set(capitulos(s).flatMap((e: any) =>
    (e?.servers || []).map((sv: any) => String(sv?.direct_stream || sv?.embed_url || ''))));
  if (bulto(despues) < bulto(antes)) return false;
  const previas = urls(antes);
  const nuevas = urls(despues);
  for (const u of previas) if (!nuevas.has(u)) return false;
  return true;
}

(async () => {
  const filas: Fila[] = [];
  const PAGE = 500;
  for (let desde = 0; ; desde += PAGE) {
    let q = db.from('media_items')
      .select('id,tmdb_id,title,poster,overview,seasons')
      .eq('type', 'tvseries')
      .order('id', { ascending: true })
      .range(desde, desde + PAGE - 1);
    if (SOLO_ID) q = q.eq('id', SOLO_ID);
    const { data, error } = await q;
    if (error) { console.error(`ERROR leyendo el catálogo: ${error.message}`); process.exit(1); }
    if (!data?.length) break;
    filas.push(...(data as any[]).filter(r => Array.isArray(r.seasons) && r.seasons.length) as Fila[]);
    if (data.length < PAGE) break;
    if (SOLO_ID) break;
  }

  /**
   * Y LA SINOPSIS DE LA FICHA, por lo mismo. Va sobre TODO el catálogo, no solo sobre series: la
   * plantilla la escribían por igual los cuatro scrapers.
   */
  let fichasLimpiadas = 0;
  for (let desde = 0; ; desde += PAGE) {
    let q = db.from('media_items').select('id,title,overview').order('id', { ascending: true }).range(desde, desde + PAGE - 1);
    if (SOLO_ID) q = q.eq('id', SOLO_ID);
    const { data, error } = await q;
    if (error) { console.error(`ERROR leyendo sinopsis: ${error.message}`); break; }
    if (!data?.length) break;
    for (const r of data as any[]) {
      if (!PUBLICIDAD_DE_LA_WEB.test(String(r.overview || ''))) continue;
      fichasLimpiadas++;
      console.log(`   ${DRY ? '·' : '✔'} ${r.id} «${r.title}»: sinopsis de la web retirada`);
      if (DRY) continue;
      const { error: e2 } = await db.from('media_items')
        .update({ overview: '', updated_at: new Date().toISOString() }).eq('id', r.id);
      if (e2) console.log(`      ✖ no se pudo escribir: ${e2.message}`);
    }
    if (data.length < PAGE) break;
    if (SOLO_ID) break;
  }

  console.log(`series con capítulos guardados: ${filas.length}${DRY ? '   (--dry: no se escribe nada)' : ''}\n`);

  let tocadas = 0, capsCambiados = 0, sinCambio = 0, rechazadas = 0, fallos = 0;
  for (const fila of filas) {
    const antes = fila.seasons;
    const despues = await TmdbService.rotularEpisodiosConTmdb(fila.tmdb_id, antes, fila.poster)
      .catch(() => antes);

    if (despues === antes) { sinCambio++; continue; }

    const cambian = cuantosCambian(antes, despues);
    if (!cambian) { sinCambio++; continue; }

    if (!noPierdeNada(antes, despues)) {
      rechazadas++;
      console.log(`   ⚠ ${fila.id} «${fila.title}»: el árbol nuevo perdía capítulos o enlaces — NO se escribe`);
      continue;
    }

    tocadas++;
    capsCambiados += cambian;
    console.log(`   ${DRY ? '·' : '✔'} ${fila.id} «${fila.title}» (tmdb ${fila.tmdb_id}): ${cambian} capítulos rotulados`);

    if (DRY) continue;
    const { error } = await db.from('media_items')
      .update({ seasons: despues, updated_at: new Date().toISOString() })
      .eq('id', fila.id);
    if (error) { fallos++; console.log(`      ✖ no se pudo escribir: ${error.message}`); }
  }

  console.log(`\n   series rotuladas:    ${tocadas}`);
  console.log(`   capítulos corregidos:${String(capsCambiados).padStart(6)}`);
  console.log(`   ya estaban bien:     ${sinCambio}`);
  if (rechazadas) console.log(`   rechazadas por perder algo: ${rechazadas}`);
  if (fichasLimpiadas) console.log(`   fichas con la sinopsis de la web retirada: ${fichasLimpiadas}`);
  if (fallos) console.log(`   fallos de escritura: ${fallos}`);
})();
