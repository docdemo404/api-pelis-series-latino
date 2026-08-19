/**
 * LA QUEJA, MEDIDA TAL CUAL: lo que hoy se ve en las webs, ¿llega a la app?
 *
 * Coge las primeras páginas de cada listado de la fuente y sigue cada título por los tres
 * escalones que tiene que pasar:
 *   1. ¿está en la base de datos?          (lo descubrió el crawl)
 *   2. ¿está anunciable?                   (has_streams + póster + sello vigente)
 *   3. ¿la API de producción da servidores? (lo que ve el reproductor)
 */
import 'dotenv/config';
import { RealScraperService } from '../../src/services/realScraperService';
import { supabase } from '../../src/services/supabaseService';

const BASE = process.argv[2] || 'https://api-pelis-series-latino-gilt.vercel.app';
const POR_TIPO = Number(process.argv[3] || 40);

async function servidoresDeLaApi(id: string): Promise<number> {
  try {
    const r = await fetch(`${BASE}/api/v1/media/${encodeURIComponent(id)}/streams`, { signal: AbortSignal.timeout(45000) });
    if (!r.ok) return 0;
    const j: any = await r.json();
    const s = j?.data?.servers ?? j?.servers ?? [];
    const eps = (j?.data?.seasons ?? []).flatMap((t: any) => t?.episodes ?? []).flatMap((e: any) => e?.servers ?? []);
    return (Array.isArray(s) ? s.length : 0) + eps.length;
  } catch { return 0; }
}

(async () => {
  for (const tipo of ['peliculas', 'series'] as const) {
    const items = await RealScraperService.scrapeLatest(tipo, POR_TIPO).catch(() => []);
    console.log(`\n=== ${tipo.toUpperCase()} — ${items.length} títulos leídos hoy de la fuente ===`);
    let enDb = 0, anunciable = 0, conServidores = 0;
    const faltan: string[] = [];
    const mudos: string[] = [];

    for (const it of items) {
      const { data } = await supabase.from('media_items')
        .select('id,title,has_streams,poster,streams_checked_at')
        .eq('id', it.id).maybeSingle();
      if (!data) { faltan.push(it.title); continue; }
      enDb++;
      const sello = data.streams_checked_at ? Date.now() - Date.parse(data.streams_checked_at) : Infinity;
      const pub = data.has_streams === true && data.poster && sello < 6 * 3600 * 1000;
      if (pub) {
        anunciable++;
        if (await servidoresDeLaApi(data.id) > 0) conServidores++;
        else mudos.push(data.title);
      }
    }
    const p = (a: number) => `${((a / items.length) * 100).toFixed(0)}%`;
    console.log(`  en la base de datos   ${enDb}/${items.length}  (${p(enDb)})`);
    console.log(`  anunciables en la app ${anunciable}/${items.length}  (${p(anunciable)})`);
    console.log(`  y con servidores      ${conServidores}/${items.length}  (${p(conServidores)})`);
    if (faltan.length) console.log(`  NO ESTÁN EN LA BASE (${faltan.length}): ${faltan.slice(0, 12).join(' · ')}`);
    if (mudos.length) console.log(`  ANUNCIADAS Y MUDAS (${mudos.length}): ${mudos.slice(0, 10).join(' · ')}`);
  }
})();
