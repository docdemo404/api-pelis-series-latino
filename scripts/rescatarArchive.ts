/**
 * DEVUELVE SU VÍDEO A LAS FICHAS DE ARCHIVE.ORG QUE SE QUEDARON SIN NINGUNA URL.
 *
 * Es la recuperación que el rastreo normal NO puede hacer, y conviene entender por qué. El scraper
 * de archive.org busca por etiquetas (`subject:"Pelicula"`) y descarta sin piedad todo lo que no
 * declara clase, año y lengua — esa dureza es deliberada, es lo que impide que el catálogo se
 * llene de identidades inventadas. El precio es que una ficha concreta que ya estaba dentro no
 * vuelve a salir por ahí: en una tanda entera se recolectó UN título.
 *
 * Pero para estas fichas no hace falta buscar nada. Su identificador de archive.org está escrito
 * en su propio id (`archive-<identifier>`), así que se le puede preguntar directamente a
 * `/metadata/<identifier>` qué ficheros tiene. Es una petición por ficha y no admite ambigüedad:
 * no se está decidiendo QUÉ película es esto —eso ya se decidió cuando entró—, solo dónde está su
 * vídeo.
 *
 * La elección del fichero la hace `ficherosDeVideoArchive`, la MISMA que usa el scraper: prefiere
 * mp4 sobre mkv y la copia más ligera que siga siendo la obra completa. Copiar ese criterio aquí
 * sería garantizar que dentro de dos meses las dos formas de entrar al catálogo elijan ficheros
 * distintos.
 *
 * NO SE SELLA NADA. Se restaura la url y se deja `has_streams` en manos del verificador, que es
 * quien mira de verdad. Sellar aquí sería afirmar algo que este script no ha comprobado, y eso es
 * justo lo que produce un título que aparece en la app y luego no reproduce.
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { ficherosDeVideoArchive, urlDeFicheroArchive } from '../src/services/realScraperService';

/** De tres en tres: archive.org va lento y aquí no hay ninguna prisa. */
const A_LA_VEZ = 3;

interface Resultado {
  id: string;
  titulo: string;
  ok: boolean;
  detalle: string;
}

/** Las urls de vídeo de un item, en el orden en que deberían probarse. */
async function videosDelItem(identifier: string): Promise<string[]> {
  const r = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, {
    signal: AbortSignal.timeout(45_000),
  });
  if (!r.ok) throw new Error(`metadata ${r.status}`);
  const datos: any = await r.json();
  const ficheros = ficherosDeVideoArchive(datos?.files || []);
  return ficheros.map(f => urlDeFicheroArchive(identifier, f.name));
}

async function rescatarUna(fila: any): Promise<Resultado> {
  const identifier = String(fila.id).replace(/^archive-/, '');
  const base = { id: fila.id, titulo: String(fila.title || fila.id) };

  let urls: string[];
  try {
    urls = await videosDelItem(identifier);
  } catch (e: any) {
    return { ...base, ok: false, detalle: e?.message || String(e) };
  }
  if (!urls.length) return { ...base, ok: false, detalle: 'el item ya no tiene ficheros de vídeo' };

  const servers = urls.map((url, i) => ({
    id: `srv_rescate_${identifier}_${i + 1}`,
    name: `Archive ${i + 1} [Vídeo directo]`,
    status: 'online',
    language: 'latino',
    source_id: 'archive',
    direct_stream: url,
    direct_kind: /\.mkv$/i.test(url) ? 'mkv' : 'mp4',
    direct_mode: 'public',
    last_checked: new Date().toISOString(),
  }));

  const db = getSupabaseAdmin();
  const { error } = await db
    .from('media_items')
    // `has_streams` NO se toca: lo decide el verificador después de comprobarlo.
    .update({ servers, streams_checked_at: null })
    .eq('id', fila.id);

  return error
    ? { ...base, ok: false, detalle: error.message }
    : { ...base, ok: true, detalle: `${servers.length} url(s)` };
}

async function main() {
  const db = getSupabaseAdmin();
  const { data, error } = await db.from('media_items').select('id,title,servers,seasons').limit(3000);
  if (error) throw error;

  const sinVideo = (data || []).filter((r: any) => {
    if (!String(r.id).startsWith('archive-')) return false;
    const urls = [
      ...((r.servers as any[]) || []),
      ...(((r.seasons as any[]) || []).flatMap((t: any) => t?.episodes || []).flatMap((e: any) => e?.servers || [])),
    ];
    return !urls.some((s: any) => String(s?.direct_stream || '').startsWith('http'));
  });

  console.log(`Se rescatan ${sinVideo.length} fichas de archive.org sin ninguna url.\n`);

  const hechos: Resultado[] = [];
  for (let i = 0; i < sinVideo.length; i += A_LA_VEZ) {
    const tanda = sinVideo.slice(i, i + A_LA_VEZ);
    for (const r of await Promise.all(tanda.map(rescatarUna))) {
      hechos.push(r);
      console.log(`${r.ok ? 'OK  ' : 'NO  '} ${r.titulo.slice(0, 44).padEnd(44)} ${r.detalle}`);
    }
  }

  console.log(`\nRescatadas ${hechos.filter(h => h.ok).length} de ${hechos.length}.`);
  console.log('Quedan sin sello: el verificador decidirá si se anuncian.');
}

main().catch(e => { console.error(e); process.exit(1); });
