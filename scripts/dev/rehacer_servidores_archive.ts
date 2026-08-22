/**
 * REHACE LA LISTA DE SERVIDORES DE UNA FICHA DE ARCHIVE.ORG, sin perder lo ya verificado.
 *
 * Para qué: un item de archive.org puede traer varias películas dentro, y hubo fichas que
 * acabaron con los ficheros de todas. El scraper ya no las cuelga y la API ya no las entrega,
 * pero la fila guardada puede haber perdido por el camino el fichero BUENO — en «Astérix El
 * Galo» se quedó solo con el `.avi` en Cinepack, que ningún Android decodifica, mientras el
 * `.mp4` de 1967 seguía estando en archive.org y arranca de inmediato.
 *
 * Qué hace: pregunta a `/metadata/<identifier>` qué ficheros hay, se queda con los de la obra
 * (mismo criterio que el scraper, `ficherosDeVideoArchive` con el año de la ficha) y reconstruye
 * la lista.
 *
 * SE FUSIONA, NO SE REEMPLAZA. Un servidor que ya estaba y sigue apuntando a un fichero válido se
 * conserva TAL CUAL, con su `verified_at`. Reescribirlo entero costaría el sello, y sin sello
 * `paraElCliente` no anuncia la ficha: se arreglaría el catálogo y desaparecería el título de la
 * app hasta que el verificador volviera a pasar.
 *
 *   npx ts-node scripts/dev/rehacer_servidores_archive.ts --ids=archive-x            # dry-run
 *   npx ts-node scripts/dev/rehacer_servidores_archive.ts --ids=archive-x --apply
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { ficherosDeVideoArchive, urlDeFicheroArchive } from '../../src/services/realScraperService';

const apply = process.argv.includes('--apply');
const ids = (process.argv.find(a => a.startsWith('--ids=')) || '').split('=')[1]?.split(',').map(s => s.trim()).filter(Boolean) || [];

/** El nombre del fichero al que apunta un servidor, venga como venga la url. */
function ficheroDe(s: any): string {
  const url = String(s?.direct_stream || s?.embed_url || '');
  const m = /[?&]e=([^&]+)/.exec(url);
  let real = url;
  if (m) {
    try { real = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { /* se queda la url */ }
  }
  try { return decodeURIComponent(new URL(real).pathname).split('/').pop() || ''; } catch { return ''; }
}

async function main() {
  if (!ids.length) throw new Error('hace falta --ids=');
  const db = getSupabaseAdmin();

  for (const id of ids) {
    const { data, error } = await db.from('media_items').select('id,title,release_date,servers').eq('id', id).single();
    if (error || !data) { console.log(`NO  ${id}: ${error?.message || 'no existe'}`); continue; }

    const identifier = String(data.id).replace(/^archive-/, '');
    const anio = String(data.release_date || '').slice(0, 4);

    const r = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, { signal: AbortSignal.timeout(45_000) });
    const meta: any = await r.json();
    const buenos = ficherosDeVideoArchive(meta?.files || [], anio);
    if (!buenos.length) { console.log(`NO  ${id}: el item no ofrece ficheros de esta obra`); continue; }

    const previos: any[] = Array.isArray(data.servers) ? data.servers : [];
    const porFichero = new Map(previos.map(s => [ficheroDe(s), s]));

    const servers = buenos.map((f, i) => {
      const yaEstaba = porFichero.get(f.name);
      if (yaEstaba) return yaEstaba;                       // conserva su verified_at
      return {
        id: `archive-${identifier}_r${i}`,
        name: `Archive ${i + 1}`,
        embed_url: urlDeFicheroArchive(identifier, f.name),
        direct_stream: urlDeFicheroArchive(identifier, f.name),
        direct_mode: 'public',
        direct_kind: 'mp4',
        status: 'online',
        source_id: 'archive',
      };
    });

    console.log(`\n${id}  (${anio})`);
    console.log('  antes:'); previos.forEach(s => console.log('    -', ficheroDe(s), s.verified_at ? '[sellado]' : ''));
    console.log('  ahora:'); servers.forEach(s => console.log('    -', ficheroDe(s), (s as any).verified_at ? '[sellado]' : '[nuevo]'));

    if (!apply) { console.log('  (dry-run, no se escribe)'); continue; }

    const { error: e2 } = await db.from('media_items').update({ servers }).eq('id', id);
    if (e2) { console.log('  NO se escribió:', e2.message); continue; }

    // Un UPDATE bloqueado por RLS contesta sin error, así que se RELEE para saber si entró.
    const { data: check } = await db.from('media_items').select('servers').eq('id', id).single();
    const quedaron = ((check?.servers as any[]) || []).map(ficheroDe);
    console.log('  escrito y releído:', quedaron.join(' | '));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
