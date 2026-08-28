/**
 * ¿SE ESTÁ EXTRAYENDO TODO LO EXTRAÍBLE? — por fuente y sin listas copiadas.
 *
 * Cada servidor guardado cae en una de estas casillas, y solo la primera es trabajo pendiente:
 *
 *   YA EXTRAÍDO    tiene `direct_stream` y no está offline
 *   PENDIENTE      su host tiene extractor y nadie ha pasado todavía  → lo vacía el barrido
 *   IMPOSIBLE      su host exige captcha o huella de navegador        → decidido no hacerlo
 *   SIN EXTRACTOR  no sabemos sacar el vídeo de ese host              → habría que escribirlo
 *
 * Las dos listas salen del CÓDIGO (`mereceRepasoDeExtraccion` y los hosts señuelo), no de una
 * copia en este fichero, para que no se desincronicen — que es como se pierden los inventarios.
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { mereceRepasoDeExtraccion, extractDirectFast } from '../../src/scrapers/directStream';

type Casilla = 'YA EXTRAÍDO' | 'PENDIENTE' | 'IMPOSIBLE' | 'SIN EXTRACTOR';

/** Un host es "imposible" si el extractor lo da por concluyente sin sacar nada y sin red. */
async function esImposible(url: string): Promise<boolean> {
  try {
    const r = await extractDirectFast(url, { allowNetwork: false });
    return r.conclusive && !r.direct && !mereceRepasoDeExtraccion(url);
  } catch {
    return false;
  }
}

function fuenteDe(id: string): 'fuegocine' | 'tioplus' {
  if (/^fc-/.test(id) || /^\d{4}-\d{2}-/.test(id)) return 'fuegocine';
  return 'tioplus';
}

(async () => {
  const cache = new Map<string, boolean>();
  const cuenta: Record<string, Record<Casilla, number>> = {};
  const fichasPendientes: Record<string, Set<string>> = {};
  const hostsSinExtractor: Record<string, number> = {};
  const hostsImposibles: Record<string, number> = {};
  let ultimoId = '';
  let filas = 0;

  for (;;) {
    const { data, error } = await supabase.from('media_items')
      .select('id,servers,seasons').gt('id', ultimoId).order('id').limit(500);
    if (error) { console.error(error.message); break; }
    if (!data?.length) break;
    ultimoId = (data[data.length - 1] as any).id;

    for (const r of data as any[]) {
      filas++;
      const fuente = fuenteDe(r.id);
      cuenta[fuente] ??= { 'YA EXTRAÍDO': 0, PENDIENTE: 0, IMPOSIBLE: 0, 'SIN EXTRACTOR': 0 };
      fichasPendientes[fuente] ??= new Set();

      const todos = [
        ...(Array.isArray(r.servers) ? r.servers : []),
        ...(Array.isArray(r.seasons) ? r.seasons : [])
          .flatMap((s: any) => Array.isArray(s?.episodes) ? s.episodes : [])
          .flatMap((e: any) => Array.isArray(e?.servers) ? e.servers : []),
      ];

      for (const s of todos) {
        const u: string = s?.embed_url || s?.url || '';
        if (!u) continue;
        if (s?.direct_stream && s.status !== 'offline') { cuenta[fuente]['YA EXTRAÍDO']++; continue; }

        let host = '';
        try { host = new URL(u).hostname.replace(/^www\./, ''); } catch { continue; }

        if (mereceRepasoDeExtraccion(u)) {
          cuenta[fuente].PENDIENTE++;
          fichasPendientes[fuente].add(r.id);
          continue;
        }
        if (!cache.has(host)) cache.set(host, await esImposible(u));
        if (cache.get(host)) {
          cuenta[fuente].IMPOSIBLE++;
          hostsImposibles[host] = (hostsImposibles[host] || 0) + 1;
        }
        else {
          cuenta[fuente]['SIN EXTRACTOR']++;
          hostsSinExtractor[host] = (hostsSinExtractor[host] || 0) + 1;
        }
      }
    }
    process.stderr.write(`  …${filas}\r`);
  }

  console.log(`\nSERVIDORES GUARDADOS, por fuente y estado (${filas} fichas)\n`);
  console.log(`${'fuente'.padEnd(13)} ${'ya extraído'.padStart(12)} ${'PENDIENTE'.padStart(11)} ${'imposible'.padStart(10)} ${'sin extractor'.padStart(14)}`);
  const totales: Record<Casilla, number> = { 'YA EXTRAÍDO': 0, PENDIENTE: 0, IMPOSIBLE: 0, 'SIN EXTRACTOR': 0 };
  for (const [f, c] of Object.entries(cuenta)) {
    console.log(`${f.padEnd(13)} ${String(c['YA EXTRAÍDO']).padStart(12)} ${String(c.PENDIENTE).padStart(11)} ${String(c.IMPOSIBLE).padStart(10)} ${String(c['SIN EXTRACTOR']).padStart(14)}`);
    for (const k of Object.keys(totales) as Casilla[]) totales[k] += c[k];
  }
  console.log(`${'TOTAL'.padEnd(13)} ${String(totales['YA EXTRAÍDO']).padStart(12)} ${String(totales.PENDIENTE).padStart(11)} ${String(totales.IMPOSIBLE).padStart(10)} ${String(totales['SIN EXTRACTOR']).padStart(14)}`);

  console.log(`\nFICHAS con algo pendiente de extraer:`);
  for (const [f, s] of Object.entries(fichasPendientes)) console.log(`   ${f.padEnd(13)} ${s.size}`);

  const imp = Object.entries(hostsImposibles).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`\nHosts IMPOSIBLES (comprobación humana que no se salta, o host apagado):`);
  console.log(imp.map(([h, n]) => `   ${String(n).padStart(6)}  ${h}`).join('\n') || '   ninguno');

  const sin = Object.entries(hostsSinExtractor).sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`\nHosts SIN extractor (aquí habría código que escribir):`);
  console.log(sin.length ? sin.map(([h, n]) => `   ${String(n).padStart(6)}  ${h}`).join('\n') : '   ninguno');
})();
