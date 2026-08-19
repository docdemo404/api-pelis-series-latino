/**
 * EL EMBUDO: de una ficha del catálogo a una ficha que la app puede enseñar.
 * Cuenta cuántas se caen en cada escalón, que es lo que dice DÓNDE está el tapón.
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { paraElCliente } from '../../src/services/streamSorter';

const H = 3600 * 1000;

(async () => {
  const pageSize = 1000;
  let from = 0;
  let filas = 0, conSrv = 0, conDirecto = 0, conSelloVigente = 0, conSelloAlguna = 0, publicable = 0;
  let epsConSrv = 0, epsConDirecto = 0, epsPublicable = 0;
  const edades: number[] = [];
  const porTipo: Record<string, { total: number; directo: number; vigente: number }> = {};

  for (;;) {
    const { data, error } = await supabase
      .from('media_items')
      .select('id,type,servers,seasons,has_streams')
      .order('id')
      .range(from, from + pageSize - 1);
    if (error) { console.error(error.message); break; }
    if (!data?.length) break;

    for (const r of data as any[]) {
      filas++;
      const t = r.type === 'tvseries' ? 'serie' : 'peli';
      porTipo[t] ??= { total: 0, directo: 0, vigente: 0 };
      porTipo[t].total++;

      const srv: any[] = Array.isArray(r.servers) ? r.servers : [];
      const eps: any[] = (Array.isArray(r.seasons) ? r.seasons : [])
        .flatMap((s: any) => Array.isArray(s?.episodes) ? s.episodes : []);
      const epSrv: any[] = eps.flatMap((e: any) => Array.isArray(e?.servers) ? e.servers : []);
      const todos = [...srv, ...epSrv];

      if (todos.length) conSrv++;
      const directos = todos.filter(s => s?.direct_stream && s.status !== 'offline');
      if (directos.length) { conDirecto++; porTipo[t].directo++; }
      const sellados = directos.filter(s => s?.verified_at);
      if (sellados.length) conSelloAlguna++;
      const vigentes = directos.filter(s => s?.verified_at && Date.now() - Date.parse(s.verified_at) < 6 * H);
      if (vigentes.length) { conSelloVigente++; porTipo[t].vigente++; }

      for (const s of sellados) edades.push((Date.now() - Date.parse(s.verified_at)) / H);

      const puede = r.type === 'tvseries'
        ? eps.some((e: any) => paraElCliente(e?.servers).length > 0)
        : paraElCliente(srv).length > 0 || eps.some((e: any) => paraElCliente(e?.servers).length > 0);
      if (puede) publicable++;

      if (epSrv.length) epsConSrv++;
      if (epSrv.some(s => s?.direct_stream && s.status !== 'offline')) epsConDirecto++;
      if (eps.some((e: any) => paraElCliente(e?.servers).length > 0)) epsPublicable++;
    }
    from += pageSize;
    process.stderr.write(`  …${filas}\r`);
  }

  const p = (a: number) => `${((a / filas) * 100).toFixed(1)}%`;
  console.log(`\nEMBUDO sobre ${filas} fichas`);
  console.log(`  1. con algún servidor guardado      ${conSrv}  (${p(conSrv)})`);
  console.log(`  2. con vídeo DIRECTO no-offline     ${conDirecto}  (${p(conDirecto)})   <- extracción`);
  console.log(`  3. con algún sello alguna vez       ${conSelloAlguna}  (${p(conSelloAlguna)})   <- verificación`);
  console.log(`  4. con sello VIGENTE (<6 h)         ${conSelloVigente}  (${p(conSelloVigente)})   <- caducidad`);
  console.log(`  5. reproducible según el criterio   ${publicable}  (${p(publicable)})`);

  console.log(`\nPor tipo:`);
  for (const [k, v] of Object.entries(porTipo)) {
    console.log(`  ${k}: ${v.total} total · ${v.directo} con directo (${((v.directo / v.total) * 100).toFixed(1)}%) · ${v.vigente} con sello vigente (${((v.vigente / v.total) * 100).toFixed(1)}%)`);
  }

  console.log(`\nSeries: ${epsConSrv} con servidores de capítulo · ${epsConDirecto} con directo en capítulo · ${epsPublicable} con capítulo anunciable`);

  edades.sort((a, b) => a - b);
  const q = (x: number) => edades.length ? edades[Math.floor(edades.length * x)].toFixed(1) : '—';
  console.log(`\nEdad del sello de los ${edades.length} servidores sellados (horas): p10=${q(0.1)} p50=${q(0.5)} p90=${q(0.9)} p99=${q(0.99)} max=${edades.length ? edades[edades.length - 1].toFixed(1) : '—'}`);
})();
