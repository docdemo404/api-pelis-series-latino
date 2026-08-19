/** Cuando un título está en TioPlus y en FuegoCine, ¿queda la página de FuegoCine como fuente? */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
(async () => {
  for (const id of ['toy-story-5', 'linternas']) {
    const { data } = await supabase.from('media_items')
      .select('id,title,tmdb_id,source_url,source_urls,servers').eq('id', id).maybeSingle();
    if (!data) { console.log(`${id}: no está`); continue; }
    console.log(`\n«${data.title}»  ${data.id}  tmdb=${data.tmdb_id}`);
    console.log(`   source_url : ${data.source_url}`);
    console.log(`   source_urls: ${JSON.stringify(data.source_urls)}`);
    const hosts = (data.servers ?? []).map((s: any) => { try { return new URL(s.embed_url || '').hostname; } catch { return '?'; } });
    console.log(`   servidores : ${hosts.join(', ') || 'ninguno'}`);
  }

  // ¿Cuántas fichas del catálogo tienen a la vez una fuente de tioplus y una de fuegocine?
  let conDos = 0, soloTio = 0, soloFuego = 0, filas = 0, ultimoId = '';
  for (;;) {
    const { data } = await supabase.from('media_items').select('id,source_urls').gt('id', ultimoId).order('id').limit(1000);
    if (!data?.length) break;
    ultimoId = data[data.length - 1].id;
    for (const r of data as any[]) {
      filas++;
      const u = (r.source_urls || []).join(' ');
      const tio = /tioplus/.test(u), fuego = /fuegocine/.test(u);
      if (tio && fuego) conDos++; else if (tio) soloTio++; else if (fuego) soloFuego++;
    }
  }
  console.log(`\nSobre ${filas} fichas:`);
  console.log(`   con fuente de las DOS webs  ${conDos}`);
  console.log(`   solo tioplus                ${soloTio}`);
  console.log(`   solo fuegocine              ${soloFuego}`);
})();
