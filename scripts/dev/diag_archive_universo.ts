/**
 * ¿CUÁNTO HAY DE VERDAD EN CADA ETIQUETA DE ARCHIVE.ORG, Y CUÁNTO SOBREVIVE AL FILTRO?
 *
 * La API `scrape` devuelve la etiqueta ENTERA en una sola petición si se le pide `count` grande:
 * «Pelicula» son 3.759 items y tarda 6 s. Recorrerla con cursor de 100 en 100 —lo que hacía el
 * crawl— cuesta trece minutos y encima el cursor ignora `sorts`, así que siempre volvía a la
 * misma cabecera alfabética.
 *
 *   npx ts-node -T scripts/dev/diag_archive_universo.ts
 */
import 'dotenv/config';
import axios from 'axios';
import { supabase } from '../../src/services/supabaseService';
import {
  anioDeArchive, esPackArchive, claseDeArchive, esEnEspanolLatino, tituloDeArchive,
} from '../../src/services/realScraperService';

async function universo(etiqueta: string) {
  const p = new URLSearchParams({
    q: `mediatype:movies AND subject:"${etiqueta}"`,
    fields: 'identifier,title,subject,description,language,addeddate',
    count: '10000',
    sorts: 'addeddate desc',
  });
  const t0 = Date.now();
  const res = await axios.get(`https://archive.org/services/search/v1/scrape?${p}`,
    { timeout: 120000, validateStatus: () => true });
  if (res.status >= 400) { console.log(`${etiqueta}: [${res.status}]`); return []; }
  const items = (res.data?.items || []).filter(Boolean);
  const pasan: any[] = [];
  for (const it of items) {
    const titulo = String(it?.title || '').trim();
    const clase = claseDeArchive(it?.subject);
    if (!clase) continue;
    if (esPackArchive(titulo)) continue;
    if (!esEnEspanolLatino(it)) continue;
    if (!anioDeArchive(titulo, String(it?.description || ''))) continue;
    if (!tituloDeArchive(titulo)) continue;
    pasan.push({ ...it, clase });
  }
  const pelis = pasan.filter(x => x.clase === 'movie').length;
  console.log(`${etiqueta.padEnd(10)} ${String(items.length).padStart(6)} items en ${((Date.now() - t0) / 1000).toFixed(1)}s · PASAN ${pasan.length} (pelis ${pelis} · series ${pasan.length - pelis})`);
  return pasan;
}

(async () => {
  const todos = new Map<string, any>();
  for (const e of ['Pelicula', 'Pelis', 'Peliculas', 'Serie', 'Series', 'Telenovela']) {
    for (const it of await universo(e)) todos.set(`archive-${it.identifier}`, it);
  }
  console.log(`\nÚnicos que pasan el filtro: ${todos.size}`);

  const ids = [...todos.keys()];
  const yaEstan = new Set<string>();
  for (let i = 0; i < ids.length; i += 400) {
    const { data } = await supabase.from('media_items').select('id').in('id', ids.slice(i, i + 400));
    for (const f of (data || []) as any[]) yaEstan.add(f.id);
  }
  const nuevos = ids.filter(i => !yaEstan.has(i));
  console.log(`Ya en la base: ${yaEstan.size} · NUNCA VISTOS: ${nuevos.length}`);
  console.log('\nLos 15 más recientes que no están:');
  for (const id of nuevos.sort((a, b) => String(todos.get(b).addeddate).localeCompare(String(todos.get(a).addeddate))).slice(0, 15)) {
    const it = todos.get(id);
    console.log(`   ${String(it.addeddate).slice(0, 10)}  ${it.clase === 'movie' ? 'PELI ' : 'SERIE'} «${it.title}»`);
  }
})();
