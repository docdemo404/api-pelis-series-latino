import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';

/**
 * ¿APUNTA EL VÍDEO DIRECTO AL MISMO SITIO QUE SU EMBED?
 *
 * Un servidor guarda dos cosas: `embed_url`, la página de la fuente, y `direct_stream`, que para
 * moviedays es nuestro proxy con ESE embed metido en base64 (`?e=…`). Son el mismo enlace escrito
 * de dos maneras, así que tienen que coincidir.
 *
 * Si no coinciden, la ficha enseña un capítulo y entrega OTRO — y no se nota por ninguna vía que
 * mire solo una de las dos: el catálogo parece correcto mirando `embed_url`, y el proxy resuelve
 * limpiamente el que le llega. Solo se ve poniéndolos uno al lado del otro.
 */
(async () => {
  const db = getSupabaseAdmin();
  const filas: any[] = [];
  for (let desde = 0; ; desde += 200) {
    const { data, error } = await db
      .from('media_items').select('id,title,servers,seasons').order('id').range(desde, desde + 199);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 200) break;
  }

  const embedDentroDelDirecto = (u: string): string | null => {
    const m = /[?&]e=([A-Za-z0-9_-]+)/.exec(String(u || ''));
    if (!m) return null;
    try { return Buffer.from(m[1], 'base64url').toString('utf8'); } catch { return null; }
  };

  let mirados = 0, descuadres = 0;
  const detalle: string[] = [];

  for (const r of filas) {
    const revisar = (sv: any, sitio: string) => {
      const dentro = embedDentroDelDirecto(sv?.direct_stream);
      if (!dentro) return;                 // directo que no es de nuestro proxy: nada que comparar
      mirados++;
      const suyo = String(sv?.embed_url || '');
      if (!suyo || dentro === suyo) return;
      descuadres++;
      detalle.push(`  ${r.id} «${r.title}» ${sitio}\n     enseña:  ${suyo}\n     entrega: ${dentro}`);
    };
    for (const sv of (r.servers || [])) revisar(sv, 'FICHA');
    for (const t of (r.seasons || [])) {
      for (const e of (t?.episodes || [])) {
        for (const sv of (e?.servers || [])) revisar(sv, `${t.season_number}x${e.episode_number}`);
      }
    }
  }

  console.log(`servidores con vídeo directo por nuestro proxy: ${mirados}`);
  console.log(`descuadres entre lo que enseña y lo que entrega: ${descuadres}\n`);
  detalle.slice(0, 25).forEach(d => console.log(d));
  if (!descuadres) console.log('✅ todos coinciden');
  process.exit(0);
})();
