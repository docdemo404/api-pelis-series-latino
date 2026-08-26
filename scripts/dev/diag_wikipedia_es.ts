/**
 * ¿Cubre Wikipedia en español lo que TMDB deja vacío?
 *
 * Va del tmdb_id a Wikidata (P4947 películas / P4983 series) y de ahí al artículo en
 * español. Mide cuántas de las fichas incompletas tienen artículo, y con qué datos.
 *
 *   npx ts-node scripts/dev/diag_wikipedia_es.ts
 */
import 'dotenv/config';
import axios from 'axios';
import { supabase } from '../../src/services/supabaseService';

const ES = /\b(que|de|la|el|los|las|una|con|para|por|su|es|se|del|pero|cuando|más)\b/gi;
const EN = /\b(the|and|of|to|in|is|his|her|with|for|from|when|after|their|who)\b/gi;
const enIngles = (t: string | null) => {
  const s = (t || '').trim(); if (s.length < 40) return false;
  const e = (s.match(ES) || []).length, i = (s.match(EN) || []).length;
  return i >= 3 && i > e * 2;
};

/** Wikidata por id de TMDB. Devuelve { titulo eswiki, duración, director }. */
async function wikidataPorTmdb(tmdbId: number, tipo: 'movie' | 'tv') {
  const prop = tipo === 'movie' ? 'P4947' : 'P4983';
  const sparql = `SELECT ?item ?articulo ?duracion ?directorLabel WHERE {
    ?item wdt:${prop} "${tmdbId}" .
    OPTIONAL { ?item wdt:P2047 ?duracion }
    OPTIONAL { ?item wdt:P57 ?director }
    OPTIONAL { ?articulo schema:about ?item ; schema:isPartOf <https://es.wikipedia.org/> }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "es". }
  } LIMIT 1`;
  const r = await axios.get('https://query.wikidata.org/sparql', {
    params: { query: sparql, format: 'json' },
    headers: { 'User-Agent': 'api-pelis-diag/1.0 (diagnostico de cobertura)' },
    timeout: 20000, validateStatus: () => true,
  });
  const b = r.data?.results?.bindings?.[0];
  if (!b) return null;
  return {
    articulo: b.articulo?.value || null,
    duracion: b.duracion?.value ? Math.round(Number(b.duracion.value)) : null,
    director: b.directorLabel?.value || null,
  };
}

/** Primer párrafo del artículo en español. */
async function extractoEs(urlArticulo: string): Promise<string | null> {
  const titulo = decodeURIComponent(urlArticulo.split('/wiki/')[1] || '');
  if (!titulo) return null;
  const r = await axios.get('https://es.wikipedia.org/w/api.php', {
    params: { action: 'query', prop: 'extracts', exintro: 1, explaintext: 1, format: 'json', titles: titulo, redirects: 1 },
    headers: { 'User-Agent': 'api-pelis-diag/1.0' }, timeout: 15000, validateStatus: () => true,
  });
  const pages = r.data?.query?.pages || {};
  const p: any = Object.values(pages)[0];
  const t = (p?.extract || '').trim();
  return t.length > 60 ? t : null;
}

(async () => {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase.from('media_items')
      .select('id,tmdb_id,type,title,overview,runtime,director,logo').range(from, from + 999);
    if (!data?.length) break; rows.push(...data); if (data.length < 1000) break;
  }
  const conId = rows.filter(r => r.tmdb_id > 0);

  const grupos: Array<[string, any[]]> = [
    ['sinopsis en inglés', conId.filter(r => enIngles(r.overview))],
    ['sin runtime', conId.filter(r => !r.runtime).slice(0, 40)],
    ['sin director', conId.filter(r => !r.director).slice(0, 40)],
  ];

  for (const [campo, lista] of grupos) {
    let conArticulo = 0, conExtracto = 0, conDuracion = 0, conDirector = 0, sinNada = 0;
    const ejemplos: string[] = [];
    for (const r of lista) {
      const w = await wikidataPorTmdb(r.tmdb_id, r.type === 'tvseries' ? 'tv' : 'movie');
      if (!w) { sinNada++; continue; }
      if (w.duracion) conDuracion++;
      if (w.director) conDirector++;
      if (w.articulo) {
        conArticulo++;
        const ex = await extractoEs(w.articulo);
        if (ex) {
          conExtracto++;
          if (ejemplos.length < 6) ejemplos.push(`${r.title}\n        ${ex.slice(0, 180).replace(/\n/g, ' ')}…`);
        }
      } else sinNada++;
    }
    console.log(`\n${campo.toUpperCase()} — sondeadas ${lista.length}`);
    console.log(`   con artículo en Wikipedia ES   ${conArticulo}`);
    console.log(`   …y con sinopsis aprovechable  ${conExtracto}`);
    console.log(`   Wikidata da duración           ${conDuracion}`);
    console.log(`   Wikidata da director           ${conDirector}`);
    console.log(`   sin nada                       ${sinNada}`);
    for (const e of ejemplos) console.log(`      · ${e}`);
  }
})();
