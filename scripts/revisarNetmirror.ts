/**
 * RETIRA LOS SERVIDORES DE NETMIRROR QUE APUNTAN A TÍTULOS QUE NETMIRROR YA NO TIENE.
 *
 * Medido el 2026-09-21: de 25 películas con NetMirror, 5 daban 404 «NetMirror no tiene este
 * título» al reproducir. El verificador corre en GitHub, que no llega a NetMirror, así que nadie
 * las retiraba: se anunciaban y fallaban al pulsar Ver.
 *
 * Un «no» de NetMirror ya costó una vez 105 retiradas falsas (bloqueo de IP leído como ausencia),
 * así que aquí:
 *   · se pregunta por «El Origen» (27205), que sí tiene; si no contesta `tiene`, no se toca nada;
 *   · un servidor solo se quita si NetMirror dice «no» DOS veces seguidas;
 *   · veinte `sin-respuesta` seguidos paran la corrida.
 * Lo que queda en la ficha se recalcula igual que al retirar Pluto: si no le queda nada que el
 * cliente pueda usar, deja de anunciarse (no se borra).
 *
 *   npx ts-node scripts/revisarNetmirror.ts --dry
 *   npx ts-node scripts/revisarNetmirror.ts --via=api      ← desde GitHub, preguntando a Vercel
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { getDb } from '../src/db/libsql';
import { paraElCliente } from '../src/services/streamSorter';
import { consultarPelicula, ConsultaNetmirror } from '../src/scrapers/netmirror';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const VIA = (argv.find((a) => a.startsWith('--via=')) || '').split('=')[1] || 'directo';
const LIMITE = Number((argv.find((a) => a.startsWith('--limite=')) || '').split('=')[1]) || 0;
const API = process.env.API_PELIS_URL || 'https://api-catalogo-latino.vercel.app';
const db = getSupabaseAdmin();
const cuenta = { revisadas: 0, siguen: 0, retiradas: 0, quedanSinNada: 0, sinRespuesta: 0, errores: 0 };

async function consultar(tmdb: number): Promise<ConsultaNetmirror> {
  if (VIA !== 'api') return consultarPelicula(tmdb);
  try {
    const r = await fetch(`${API}/api/v1/netmirror/probe/${tmdb}`, { signal: AbortSignal.timeout(30_000) });
    if (r.status === 404) return { estado: 'no' };
    if (!r.ok) return { estado: 'sin-respuesta', detalle: `API HTTP ${r.status}` };
    const j = (await r.json()) as any;
    return j?.data?.mp4 ? { estado: 'tiene', fuente: j.data } : { estado: 'sin-respuesta', detalle: 'API sin fuente' };
  } catch (e: any) {
    return { estado: 'sin-respuesta', detalle: e?.message || String(e) };
  }
}

const esNetmirror = (s: any) => s?.source_id === 'netmirror';

async function main() {
  console.log(`REVISANDO NETMIRROR${DRY ? ' (--dry, no escribe)' : ''} · vía ${VIA}\n`);
  const canario = await consultar(27205);
  if (canario.estado !== 'tiene') {
    console.log(`✗ NetMirror no reconoce «El Origen» (${canario.estado}); no se toca nada.`);
    process.exit(1);
  }

  const r = await getDb().execute(
    `SELECT id, tmdb_id FROM media_items WHERE type='movie' AND tmdb_id>0
       AND EXISTS (SELECT 1 FROM json_each(servers) WHERE json_extract(value,'$.source_id')='netmirror')
     ORDER BY tmdb_id`
  );
  const filas = (r.rows as any[]).map((f) => ({ id: String(f[0]), tmdb: Number(f[1]) }));
  const tanda = LIMITE ? filas.slice(0, LIMITE) : filas;
  console.log(`${filas.length} películas con NetMirror · esta corrida: ${tanda.length}\n`);

  let sinRespuestaSeguidos = 0;
  let i = 0;
  const obrero = async () => {
    while (i < tanda.length && sinRespuestaSeguidos < 20) {
      const { id, tmdb } = tanda[i++];
      cuenta.revisadas++;
      let q = await consultar(tmdb);
      if (q.estado === 'no') {
        await new Promise((ok) => setTimeout(ok, 2000));
        q = await consultar(tmdb);
      }
      if (q.estado === 'sin-respuesta') {
        cuenta.sinRespuesta++;
        sinRespuestaSeguidos++;
        continue;
      }
      sinRespuestaSeguidos = 0;
      if (q.estado === 'tiene') {
        cuenta.siguen++;
        continue;
      }
      try {
        const { data, error } = await db.from('media_items').select('servers').eq('id', id).maybeSingle();
        if (error) throw new Error(error.message);
        const restantes = ((data as any)?.servers || []).filter((s: any) => !esNetmirror(s));
        const vivas = paraElCliente(restantes).length > 0;
        if (!vivas) cuenta.quedanSinNada++;
        cuenta.retiradas++;
        console.log(`   − ${id} (tmdb ${tmdb})${vivas ? '' : ' · se queda sin servidores'}`);
        if (DRY) continue;
        const ahora = new Date().toISOString();
        const { error: e2 } = await db.from('media_items').update({
          servers: restantes, has_streams: vivas, streams_checked_at: ahora, updated_at: ahora,
        }).eq('id', id);
        if (e2) throw new Error(e2.message);
      } catch (e: any) {
        cuenta.errores++;
        console.log(`   ! ${id}: ${e?.message}`);
      }
    }
  };
  await Promise.all([1, 2, 3, 4].map(obrero));
  if (sinRespuestaSeguidos >= 20) console.log('\n(parada: 20 sin respuesta seguidos)');

  console.log(
    `\nRESULTADO${DRY ? ' (simulado)' : ''}\n` +
      `  revisadas:              ${cuenta.revisadas}\n` +
      `  NetMirror aún las tiene: ${cuenta.siguen}\n` +
      `  servidor retirado:      ${cuenta.retiradas}  (de ellas, sin nada más: ${cuenta.quedanSinNada})\n` +
      `  sin respuesta:          ${cuenta.sinRespuesta}\n` +
      `  errores:                ${cuenta.errores}`
  );
  if (sinRespuestaSeguidos >= 20) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
