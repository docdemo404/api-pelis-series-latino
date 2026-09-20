/**
 * Retira servidores NetMirror cuyo master no demuestra multipista + Español Latino.
 *
 * Las fichas `nm-*` creadas únicamente por el importador se eliminan si pierden su único
 * servidor. En fichas compartidas se conserva intacta cualquier otra fuente.
 *
 *   npx ts-node -T scripts/dev/limpiar_netmirror_sin_latino.ts          # ensayo
 *   npx ts-node -T scripts/dev/limpiar_netmirror_sin_latino.ts --apply  # aplicar
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { CatalogService } from '../../src/services/catalogService';
import { tieneEspanolLatino } from '../../src/utils/idiomas';

const db = getSupabaseAdmin();
const apply = process.argv.includes('--apply');

function esNetmirror(s: any): boolean {
  return String(s?.source_id || '').toLowerCase() === 'netmirror'
    || /^nm-/i.test(String(s?.id || ''))
    || /\/api\/v1\/netmirror\/stream\//i.test(String(s?.embed_url || s?.direct_stream || ''));
}

async function todas(tabla: string, columnas: string): Promise<any[]> {
  const filas: any[] = [];
  for (let off = 0; ; off += 1000) {
    let query = db.from(tabla).select(columnas);
    query = tabla === 'media_items'
      ? query.order('id')
      : query.order('tmdb_id').order('temporada').order('episodio').order('netflix_id');
    const { data, error } = await query.range(off, off + 999);
    if (error) throw new Error(`${tabla}: ${error.message}`);
    filas.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return filas;
}

(async () => {
  const cache = await todas('netmirror_cache', 'tmdb_id,temporada,episodio,disponible,netflix_id,idiomas_audio');
  const cumple = new Set<number>();
  for (const f of cache) {
    if (Number(f.temporada) !== 0 || Number(f.episodio) !== 0 || f.disponible !== true || !f.netflix_id) continue;
    if (Array.isArray(f.idiomas_audio) && f.idiomas_audio.length >= 2 && tieneEspanolLatino(f.idiomas_audio)) {
      cumple.add(Number(f.tmdb_id));
    }
  }

  const fichas = await todas('media_items', 'id,tmdb_id,type,servers,manual_servers,source_url,source_urls');
  const afectadas = fichas.filter((f) => {
    const servers = Array.isArray(f.servers) ? f.servers : [];
    return servers.some(esNetmirror) && !cumple.has(Number(f.tmdb_id));
  });

  let borradas = 0;
  let corregidas = 0;
  let errores = 0;
  console.log(`${afectadas.length} fichas con NetMirror sin Español Latino demostrado${apply ? '' : ' (ENSAYO)'}.`);

  const corregir = async (f: any): Promise<void> => {
    const restantes = (Array.isArray(f.servers) ? f.servers : []).filter((s: any) => !esNetmirror(s));
    const manuales = Array.isArray(f.manual_servers) ? f.manual_servers : [];
    if (!apply) return;

    if (/^nm-/i.test(String(f.id)) && restantes.length === 0 && manuales.length === 0) {
      const { error } = await db.from('media_items').delete().eq('id', f.id);
      if (error) { errores++; console.warn(`   ! ${f.id}: ${error.message}`); }
      else borradas++;
      return;
    }

    const urls = (Array.isArray(f.source_urls) ? f.source_urls : []).filter((u: any) => !/\/netmirror\/stream\//i.test(String(u)));
    const fuenteActual = /\/netmirror\/stream\//i.test(String(f.source_url || ''))
      ? String(restantes[0]?.embed_url || restantes[0]?.direct_stream || urls[0] || '')
      : f.source_url;
    const { error } = await db.from('media_items').update({
      servers: restantes,
      source_url: fuenteActual,
      source_urls: urls,
      has_streams: restantes.length > 0 || manuales.length > 0,
      streams_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', f.id);
    if (error) { errores++; console.warn(`   ! ${f.id}: ${error.message}`); }
    else corregidas++;
  };

  // Escrituras independientes e idempotentes. Doce workers reducen una limpieza de miles de
  // filas a minutos sin mandar una ráfaga ilimitada a Turso.
  let siguiente = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (siguiente < afectadas.length) {
      const f = afectadas[siguiente++];
      await corregir(f);
    }
  }));

  if (apply && (borradas || corregidas)) await CatalogService.invalidateListings().catch(() => {});
  console.log(`${borradas} fichas exclusivas borradas · ${corregidas} fichas compartidas corregidas · ${errores} errores.`);
  if (!apply && afectadas.length) console.log('Ejecuta con --apply para aplicar la limpieza.');
})().catch((e) => { console.error(e); process.exit(1); });
