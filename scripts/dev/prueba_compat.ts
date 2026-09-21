/**
 * Prueba del adaptador (src/db/compat.ts) contra una base local vacía. Cada bloque es una forma
 * de consulta que el repositorio usa de verdad. Falla fuerte a la primera diferencia.
 *
 *   TURSO_DATABASE_URL=file:data/prueba_compat.db npx ts-node scripts/dev/prueba_compat.ts
 */
import 'dotenv/config';
import { supabase, getSupabaseAdmin } from '../../src/services/supabaseService';
import { asegurarEsquema, getDb } from '../../src/db/libsql';
import { filasEscritas } from '../../src/db/contadorEscrituras';

const db = getSupabaseAdmin();
let fallos = 0;
function ok(nombre: string, cond: unknown, detalle?: unknown) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else { fallos++; console.log(`  ✗ ${nombre}`, detalle === undefined ? '' : JSON.stringify(detalle).slice(0, 300)); }
}

async function main() {
  await asegurarEsquema();
  await getDb().execute('DELETE FROM media_items');

  const ahora = new Date().toISOString();
  const viejo = new Date(Date.now() - 40 * 86400_000).toISOString();

  // ── escritura ──
  const { error: e1 } = await db.from('media_items').insert([
    { id: 'md-1', tmdb_id: 1, type: 'movie', title: 'Dune', original_title: 'Dune', title_normalized: 'dune',
      genres: ['Sci-Fi', 'Drama'], aliases: [], poster: 'p', rating: 8.1, has_streams: true,
      servers: [{ embed_url: 'https://www.videoapi.la/e/1', direct_stream: 'https://cdn/1.m3u8', direct_mode: 'public', source_id: 'videoapi' }],
      streams_checked_at: ahora, source_urls: ['https://fuente/x'] },
    { id: 'md-2', tmdb_id: 2, type: 'movie', title: 'Alien', original_title: 'Alien', title_normalized: 'alien',
      genres: ['Terror'], poster: null, rating: 7, has_streams: false, servers: [], streams_checked_at: viejo },
    { id: 'sr-3', tmdb_id: 3, type: 'tvseries', title: 'Merlina', original_title: 'Wednesday', title_normalized: 'merlina',
      genres: ['Drama'], subcategories: ['Anime'], poster: 'p', rating: 9, has_streams: true, servers: [],
      seasons: [{ season_number: 1, episodes: [
        { episode_number: 1, checked_at: ahora, servers: [{ embed_url: 'https://h.com/a', direct_stream: 'https://cdn/a', direct_mode: 'public' }] },
        { episode_number: 2, servers: [] },
      ] }] },
  ]);
  ok('insert de 3 filas', !e1, e1);

  // ── lectura y tipos ──
  const { data: f1 } = await db.from('media_items').select('*').eq('id', 'md-1').maybeSingle();
  ok('maybeSingle devuelve objeto', f1 && f1.id === 'md-1');
  ok('array text[] vuelve como array', Array.isArray(f1?.genres) && f1.genres[1] === 'Drama', f1?.genres);
  ok('jsonb vuelve como objeto', Array.isArray(f1?.servers) && f1.servers[0].source_id === 'videoapi');
  ok('boolean vuelve como true', f1?.has_streams === true);
  ok('boolean false', (await db.from('media_items').select('has_streams').eq('id', 'md-2').maybeSingle()).data?.has_streams === false);
  ok('enlace_permanente calculado por el disparador', f1?.enlace_permanente === true);
  ok('metadata_score generado', typeof f1?.metadata_score === 'number' && f1.metadata_score > 0, f1?.metadata_score);
  const { data: nada } = await db.from('media_items').select('id').eq('id', 'no-existe').maybeSingle();
  ok('maybeSingle sin filas → null sin error', nada === null);
  const { error: eSingle } = await db.from('media_items').select('id').eq('id', 'no-existe').single();
  ok('single sin filas → error PGRST116', eSingle?.code === 'PGRST116');

  // ── filtros ──
  const cuenta = async (q: any) => ((await q).data || []).length;
  ok('eq + not eq []', await cuenta(db.from('media_items').select('id').not('servers', 'eq', '[]')) === 1);
  ok('neq', await cuenta(db.from('media_items').select('id').neq('type', 'movie')) === 1);
  ok('is null', await cuenta(db.from('media_items').select('id').is('streams_updated_at', null)) === 3);
  ok('not is null', await cuenta(db.from('media_items').select('id').not('poster', 'is', null)) === 2);
  ok('not is true (oculto_manual)', await cuenta(db.from('media_items').select('id').not('oculto_manual', 'is', true)) === 3);
  ok('not genres eq {}', await cuenta(db.from('media_items').select('id').not('genres', 'eq', '{}')) === 3);
  ok('ilike', await cuenta(db.from('media_items').select('id').ilike('title', '%DUN%')) === 1);
  ok('in', await cuenta(db.from('media_items').select('id').in('id', ['md-1', 'sr-3', 'zz'])) === 2);
  ok('gt sobre número', await cuenta(db.from('media_items').select('id').gt('rating', 7.5)) === 2);
  ok('gt sobre fecha ISO', await cuenta(db.from('media_items').select('id').gt('streams_checked_at', viejo)) === 1);
  ok('contains text[]', await cuenta(db.from('media_items').select('id').contains('genres', ['Drama'])) === 2);
  ok('contains subcategories Anime', await cuenta(db.from('media_items').select('id').contains('subcategories', ['Anime'])) === 1);
  ok('overlaps', await cuenta(db.from('media_items').select('id').overlaps('genres', ['Terror', 'Sci-Fi'])) === 2);
  ok('contains jsonb servers direct_mode public', await cuenta(db.from('media_items').select('id').contains('servers', '[{"direct_mode":"public"}]')) === 1);
  ok('contains jsonb anidado en seasons', await cuenta(db.from('media_items').select('id').contains('seasons', '[{"episodes":[{"servers":[{"direct_mode":"public"}]}]}]')) === 1);
  ok('contains jsonb source_id', await cuenta(db.from('media_items').select('id').contains('servers', [{ source_id: 'videoapi' }])) === 1);
  ok('or simple', await cuenta(db.from('media_items').select('id').or('title.ilike.%merlina%,id.ilike.%md-2%')) === 2);
  ok('or con is.null', await cuenta(db.from('media_items').select('id').or('streams_updated_at.is.null,has_streams.is.null')) === 3);
  ok('or con cs.{}', await cuenta(db.from('media_items').select('id').or('source_urls.cs.{https://fuente/x},source_url.ilike.%/nada')) === 1);
  const desde = new Date(Date.now() - 7 * 86400_000).toISOString();
  ok('or con and() anidado y is.true', await cuenta(db.from('media_items').select('id')
    .or(`streams_checked_at.gt.${desde},and(enlace_permanente.is.true,streams_checked_at.gt.${viejo})`)) === 1);
  ok('or con tmdb_id.eq', await cuenta(db.from('media_items').select('id').or('tmdb_id.eq.2,id.eq.sr-3')) === 2);

  // ── forma ──
  const { data: ordenados } = await db.from('media_items').select('id,rating').order('rating', { ascending: false });
  ok('order desc', ordenados?.map((r: any) => r.id).join() === 'sr-3,md-1,md-2', ordenados);
  const { data: pagina } = await db.from('media_items').select('id').order('id').range(1, 1);
  ok('range(1,1) = segunda fila', pagina?.length === 1 && pagina[0].id === 'md-2', pagina);
  const { count, data: sinDatos } = await db.from('media_items').select('id', { count: 'exact', head: true }).eq('type', 'movie');
  ok('count head', count === 2 && sinDatos === null, { count, sinDatos });
  const { count: c2, data: conDatos } = await db.from('media_items').select('id', { count: 'exact' }).limit(1);
  ok('count con datos', c2 === 3 && conDatos?.length === 1);
  ok('order nullsFirst', ((await db.from('media_items').select('id').order('poster', { ascending: true, nullsFirst: true })).data || [])[0].id === 'md-2');

  // ── update / upsert / delete ──
  const { error: eU } = await db.from('media_items').update({ has_streams: true, streams_updated_at: ahora, servers: [{ embed_url: 'x', direct_stream: 'y' }] }).eq('id', 'md-2');
  ok('update', !eU, eU);
  ok('update aplicado', (await db.from('media_items').select('has_streams,servers').eq('id', 'md-2').maybeSingle()).data?.servers?.[0]?.embed_url === 'x');
  const { data: tocadas, error: eSel } = await db.from('media_items').update({ id: 'md-2' }).eq('id', 'md-2').select('id');
  ok('update ... select devuelve filas (puedeEscribirCatalogo)', !eSel && tocadas?.length === 1, eSel);
  const { error: eUp } = await db.from('media_items').upsert({ id: 'md-2', tmdb_id: 2, type: 'movie', title: 'Alien (1979)', original_title: 'Alien', rating: 7.5 }, { onConflict: 'id' });
  ok('upsert', !eUp, eUp);
  const alien = (await db.from('media_items').select('title,servers').eq('id', 'md-2').maybeSingle()).data;
  ok('upsert actualiza y no pisa lo no enviado', alien?.title === 'Alien (1979)' && alien.servers?.[0]?.embed_url === 'x', alien);
  const { error: eDup } = await db.from('media_items').insert({ id: 'md-99', tmdb_id: 2, type: 'movie', title: 'x', original_title: 'x' });
  ok('duplicado (tmdb_id,type) → duplicate key', /duplicate key/i.test(eDup?.message || '') && eDup?.code === '23505', eDup);
  const { error: eNm } = await db.from('netmirror_cache').upsert({ tmdb_id: 1, temporada: 0, episodio: 0, disponible: true, idiomas_audio: ['es'] }, { onConflict: 'tmdb_id,temporada,episodio' });
  ok('upsert netmirror_cache', !eNm, eNm);
  ok('netmirror bool/json', (await db.from('netmirror_cache').select('*').eq('tmdb_id', 1).maybeSingle()).data?.disponible === true);
  const { error: eCola } = await db.from('subtitulos_cola').upsert({ media_id: 'md-1', episodio_id: '', prioridad: 0 }, { onConflict: 'media_id,episodio_id', ignoreDuplicates: true });
  ok('upsert ignoreDuplicates', !eCola, eCola);
  const { error: eCola2 } = await db.from('subtitulos_cola').upsert({ media_id: 'md-1', episodio_id: '', prioridad: 5 }, { onConflict: 'media_id,episodio_id', ignoreDuplicates: true });
  ok('ignoreDuplicates no pisa', !eCola2 && (await db.from('subtitulos_cola').select('prioridad').eq('media_id', 'md-1').maybeSingle()).data?.prioridad === 0);
  const { error: eDel } = await db.from('subtitulos_cola').delete().eq('media_id', 'md-1');
  ok('delete', !eDel && (await cuenta(db.from('subtitulos_cola').select('id'))) === 0);
  const { error: eCol } = await db.from('media_items').select('columna_que_no_existe').limit(1);
  ok('columna ausente → error 42703', eCol?.code === '42703', eCol);
  const { error: eTab } = await db.from('tabla_que_no_existe').select('id').limit(1);
  ok('tabla ausente → error 42P01', eTab?.code === '42P01', eTab);

  // ── no se escribe lo que no cambia (cuota de filas escritas) ──
  const antes = filasEscritas();
  const igual = (await db.from('media_items').select('servers,has_streams').eq('id', 'md-1').maybeSingle()).data;
  const { error: eIg } = await db.from('media_items').update({ servers: igual.servers, has_streams: igual.has_streams, updated_at: new Date().toISOString() }).eq('id', 'md-1');
  ok('update idéntico (solo cambia updated_at) no escribe', !eIg && filasEscritas() === antes, { eIg, filas: filasEscritas() - antes });
  const { data: devuelta } = await db.from('media_items').update({ has_streams: igual.has_streams }).eq('id', 'md-1').select('id');
  ok('update idéntico con .select() devuelve la fila igual', devuelta?.length === 1 && filasEscritas() === antes, devuelta);
  await db.from('media_items').update({ rating: 8.2 }).eq('id', 'md-1');
  ok('update que cambia algo sí escribe 1 fila', filasEscritas() === antes + 1, filasEscritas() - antes);
  // total_changes() sí cuenta lo que escribe el disparador (rowsAffected no).
  const tc = async () => Number((await getDb().execute('SELECT total_changes() AS n')).rows[0].n);
  let t0 = await tc();
  await getDb().execute("UPDATE media_items SET servers = servers WHERE id='md-1'");
  ok('disparador no reescribe enlace_permanente si no cambia (1 cambio, no 2)', (await tc()) - t0 === 1, (await tc()) - t0);
  const r0 = filasEscritas();
  await db.from('media_items').upsert({ id: 'md-1', tmdb_id: 1, type: 'movie', title: 'Dune', original_title: 'Dune' }, { onConflict: 'id' });
  ok('upsert idéntico no escribe', filasEscritas() === r0, filasEscritas() - r0);
  await db.from('media_items').upsert({ id: 'md-1', tmdb_id: 1, type: 'movie', title: 'Dune (2021)', original_title: 'Dune' }, { onConflict: 'id' });
  ok('upsert que cambia sí escribe', filasEscritas() === r0 + 1, filasEscritas() - r0);
  await db.from('media_items').update({ title: 'Dune' }).eq('id', 'md-1');

  // ── vistas y rpc ──
  const { data: emb, error: eEmb } = await db.from('embeds_publicados').select('embed_url,sello,fichas').order('sello', { ascending: true, nullsFirst: true }).limit(10);
  ok('vista embeds_publicados con fichas como array', !eEmb && emb?.length === 3 && emb.every((r: any) => Array.isArray(r.fichas)), eEmb || emb);
  const { data: caps } = await db.from('capitulos_por_comprobar').select('media_id,season_number,episode_number,faltan').order('faltan');
  ok('vista capitulos_por_comprobar', caps?.length === 1 && caps[0].episode_number === 2, caps);
  const { data: busq, error: eRpc } = await supabase.rpc('search_media', { q: 'dun', lim: 10, off: 0 });
  ok('rpc search_media', !eRpc && busq?.length === 1 && busq[0].item.id === 'md-1' && busq[0].total === 1, eRpc || busq);

  console.log(fallos ? `\n${fallos} fallos` : '\ntodo bien');
  process.exit(fallos ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
