/**
 * ¿POR DÓNDE SE ESCAPAN LOS TÍTULOS DE ARCHIVE.ORG?
 *
 * Cuenta, etiqueta por etiqueta y filtro por filtro, cuántos items sobreviven. Y compara el
 * orden por defecto del buscador con `addeddate desc`, que es el que trae subidas NUEVAS.
 *
 *   npx ts-node -T scripts/dev/diag_archive_embudo.ts [--tandas=3]
 */
import 'dotenv/config';
import axios from 'axios';
import {
  anioDeArchive, esPackArchive, claseDeArchive, esEnEspanolLatino, tituloDeArchive,
} from '../../src/services/realScraperService';

const TANDAS = Number((process.argv.find(a => a.startsWith('--tandas=')) || '').split('=')[1] || 3);

async function embudo(etiqueta: string, orden: string) {
  let cursor = '';
  const c = { items: 0, sinClase: 0, clasePeli: 0, claseSerie: 0, pack: 0, noEspanol: 0, sinAnio: 0, pasan: 0 };
  const ejemplos: string[] = [];
  const sobreviven: string[] = [];

  for (let t = 0; t < TANDAS; t++) {
    const p = new URLSearchParams({
      q: `mediatype:movies AND subject:"${etiqueta}"`,
      fields: 'identifier,title,subject,description,language,addeddate',
      count: '100',
    });
    if (orden) p.set('sorts', orden);
    if (cursor) p.set('cursor', cursor);
    const res = await axios.get(`https://archive.org/services/search/v1/scrape?${p}`,
      { timeout: 40000, validateStatus: () => true });
    if (res.status >= 400) { console.log(`   [${res.status}] ${JSON.stringify(res.data).slice(0, 120)}`); break; }
    const lote = (res.data?.items || []).filter(Boolean);
    if (!lote.length) break;

    for (const it of lote) {
      c.items++;
      const titulo = String(it?.title || '').trim();
      const clase = claseDeArchive(it?.subject);
      if (!clase) { c.sinClase++; continue; }
      if (clase === 'movie') c.clasePeli++; else c.claseSerie++;
      if (esPackArchive(titulo)) { c.pack++; continue; }
      if (!esEnEspanolLatino(it)) { c.noEspanol++; continue; }
      const anio = anioDeArchive(titulo, String(it?.description || ''));
      if (!anio) {
        c.sinAnio++;
        if (ejemplos.length < 6) ejemplos.push(`sin año: «${titulo}»`);
        continue;
      }
      if (!tituloDeArchive(titulo)) continue;
      c.pasan++;
      if (sobreviven.length < 6) sobreviven.push(`${anio} ${clase === 'movie' ? 'PELI ' : 'SERIE'} «${titulo}»  (${String(it.addeddate || '').slice(0, 10)})`);
    }
    cursor = String(res.data?.cursor || '');
    if (!cursor) break;
  }

  console.log(`\n${etiqueta.padEnd(10)} orden=${orden || '(por defecto)'}`);
  console.log(`   mirados ${c.items} · sin etiqueta de clase ${c.sinClase} · pelis ${c.clasePeli} · series ${c.claseSerie}`);
  console.log(`   caen: pack ${c.pack} · no español latino ${c.noEspanol} · SIN AÑO ${c.sinAnio}`);
  console.log(`   PASAN ${c.pasan}`);
  for (const s of sobreviven) console.log(`      ✔ ${s}`);
  for (const s of ejemplos) console.log(`      ✘ ${s}`);
}

(async () => {
  for (const etiqueta of ['Pelicula', 'Pelis', 'Serie', 'Series']) {
    for (const orden of ['', 'addeddate desc']) await embudo(etiqueta, orden);
  }
})();
