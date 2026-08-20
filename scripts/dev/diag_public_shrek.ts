/**
 * ¿SOBREVIVE EL MODO `public` HASTA LA SALIDA?
 *
 * Coge la fila REAL de la base y la pasa por las dos funciones que la tocan al servirla
 * (`sortServersBySourcePriority` → `paraElCliente`), que es exactamente el camino de
 * `toPublicItem`. Si aquí sale la url del CDN con `direct_mode: public`, la app la recibe así.
 *
 *   npx ts-node -T scripts/dev/diag_public_shrek.ts [id]
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { sortServersBySourcePriority, paraElCliente } from '../../src/services/streamSorter';
import { esFicheroDirecto, isPubliclyShareable } from '../../src/scrapers/directStream';

(async () => {
  const id = process.argv[2];
  const q = supabase.from('media_items').select('id,title,servers');
  const { data } = id ? await q.eq('id', id) : await q.limit(5);

  for (const fila of (data || []) as any[]) {
    console.log(`\n▶ ${fila.id}  «${fila.title}»`);
    for (const sv of fila.servers || []) {
      console.log(`   guardado : modo=${sv.direct_mode}  verified_at=${sv.verified_at}  status=${sv.status}`);
      console.log(`      direct_stream: ${String(sv.direct_stream).slice(0, 100)}`);
      console.log(`      embed_url    : ${String(sv.embed_url).slice(0, 100)}`);
      console.log(`      esFicheroDirecto(embed)=${esFicheroDirecto(String(sv.embed_url || ''))}  isPubliclyShareable(embed)=${isPubliclyShareable(String(sv.embed_url || ''))}`);
    }
    const ordenados = await sortServersBySourcePriority(fila.servers || []);
    const salida = paraElCliente(ordenados);
    if (!salida.length) { console.log('   ENTREGADO: (nada — sin sello vigente o sin direct_stream)'); continue; }
    for (const sv of salida) {
      const porLaApi = String(sv.direct_stream).includes('/api/v1/stream/direct');
      console.log(`   ENTREGADO: modo=${sv.direct_mode}  ${porLaApi ? '⚠ POR LA API' : '✓ url cruda'}  ${String(sv.direct_stream).slice(0, 90)}`);
    }
  }
})();
