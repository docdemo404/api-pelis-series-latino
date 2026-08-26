/**
 * ¿El hueco es NUESTRO o es de TMDB?
 *
 * Para cada ficha a la que le falta un campo, le vuelve a preguntar a TMDB SIN filtros
 * (todos los idiomas de imagen, todas las traducciones) y dice si el dato existe allí.
 *
 *   npx ts-node scripts/dev/diag_hueco_tmdb.ts [--limit=N]
 */
import 'dotenv/config';
import axios from 'axios';
import { supabase } from '../../src/services/supabaseService';

const KEY = '99b8bc99e85e79fabd52b64513c9780d';
const LIMIT = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1] || 60);

const get = async (url: string, params: any) =>
  (await axios.get(`https://api.themoviedb.org/3${url}`, { params: { api_key: KEY, ...params }, timeout: 8000, validateStatus: () => true })).data;

const ES = /\b(que|de|la|el|los|las|una|con|para|por|su|es|se|del|pero|cuando|más)\b/gi;
const EN = /\b(the|and|of|to|in|is|his|her|with|for|from|when|after|their|who)\b/gi;
const enIngles = (t: string | null) => {
  const s = (t || '').trim(); if (s.length < 40) return false;
  const e = (s.match(ES) || []).length, i = (s.match(EN) || []).length;
  return i >= 3 && i > e * 2;
};

(async () => {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('media_items')
      .select('id,tmdb_id,type,title,overview,logo,backdrop,trailer,runtime,content_rating,director')
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }

  const conId = rows.filter(r => r.tmdb_id > 0);
  const grupos: Array<[string, any[]]> = [
    ['logo', conId.filter(r => !r.logo)],
    ['trailer', conId.filter(r => !r.trailer)],
    ['runtime', conId.filter(r => !r.runtime)],
    ['content_rating', conId.filter(r => !r.content_rating)],
    ['backdrop', conId.filter(r => !r.backdrop)],
    ['sinopsis en inglés', conId.filter(r => enIngles(r.overview))],
  ];

  for (const [campo, lista] of grupos) {
    const muestra = lista.slice(0, LIMIT);
    let tmdbLoTiene = 0, tmdbNoLoTiene = 0;
    const detalles: string[] = [];
    for (const r of muestra) {
      const ep = r.type === 'tvseries' ? 'tv' : 'movie';
      try {
        if (campo === 'logo' || campo === 'backdrop') {
          const img = await get(`/${ep}/${r.tmdb_id}/images`, {});           // sin include_image_language: TODOS
          const lista2 = campo === 'logo' ? (img?.logos || []) : (img?.backdrops || []);
          if (lista2.length) { tmdbLoTiene++; detalles.push(`${r.title} → ${lista2.length} (${[...new Set(lista2.map((l: any) => l.iso_639_1))].join(',')})`); }
          else tmdbNoLoTiene++;
        } else if (campo === 'trailer') {
          const v = await get(`/${ep}/${r.tmdb_id}/videos`, {});             // sin idioma: todos
          const yt = (v?.results || []).filter((x: any) => x.site === 'YouTube' && /Trailer|Teaser|Clip/.test(x.type));
          if (yt.length) { tmdbLoTiene++; detalles.push(`${r.title} → ${yt.length} (${[...new Set(yt.map((x: any) => x.iso_639_1))].join(',')})`); }
          else tmdbNoLoTiene++;
        } else if (campo === 'runtime') {
          const d = await get(`/${ep}/${r.tmdb_id}`, {});
          const rt = d?.runtime || (d?.episode_run_time || [])[0];
          if (rt) { tmdbLoTiene++; detalles.push(`${r.title} → ${rt} min`); } else tmdbNoLoTiene++;
        } else if (campo === 'content_rating') {
          const d = await get(`/${ep}/${r.tmdb_id}`, { append_to_response: ep === 'tv' ? 'content_ratings' : 'release_dates' });
          const res = ep === 'tv'
            ? (d?.content_ratings?.results || []).filter((x: any) => x.rating)
            : (d?.release_dates?.results || []).filter((x: any) => (x.release_dates || []).some((y: any) => y.certification));
          if (res.length) { tmdbLoTiene++; detalles.push(`${r.title} → ${res.map((x: any) => x.iso_3166_1).join(',')}`); } else tmdbNoLoTiene++;
        } else {
          const d = await get(`/${ep}/${r.tmdb_id}`, { append_to_response: 'translations' });
          const tr = (d?.translations?.translations || []).filter((t: any) => t?.iso_639_1 === 'es' && (t?.data?.overview || '').trim());
          if (tr.length) { tmdbLoTiene++; detalles.push(`${r.title} → es en ${tr.map((t: any) => t.iso_3166_1).join(',')}`); } else tmdbNoLoTiene++;
        }
      } catch { /* red */ }
    }
    console.log(`\n${campo.toUpperCase()} — nos faltan ${lista.length}; sondeadas ${muestra.length}`);
    console.log(`   TMDB SÍ lo tiene (lo perdimos nosotros)  ${tmdbLoTiene}`);
    console.log(`   TMDB tampoco lo tiene                    ${tmdbNoLoTiene}`);
    for (const d of detalles.slice(0, 8)) console.log(`      · ${d}`);
  }
})();
