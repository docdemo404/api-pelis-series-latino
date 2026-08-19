/**
 * FUEGOCINE, POR SEPARADO. Es la segunda fuente del catálogo y sus fichas no fallan por lo mismo
 * que las de TioPlus: su reproductor es un envoltorio de Blogger (`repfuegocinefree.blogspot.com`)
 * con la url real dentro de un parámetro, y buena parte de sus enlaces son de la familia upns,
 * que está apagada.
 *
 * Separa lo que en el total se confunde: cuántas fichas suyas hay, cuántas se anuncian, y qué host
 * hay detrás de las que no.
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';

const H = 3600 * 1000;
const esFuegocine = (id: string) => /^fc-/.test(id) || /^\d{4}-\d{2}-/.test(id);

(async () => {
  let ultimoId = '';
  let total = 0, conServidores = 0, conDirecto = 0, anunciables = 0, sinServidores = 0;
  const porTipo: Record<string, number> = {};
  const hostsSinDirecto: Record<string, number> = {};
  const hostsConDirecto: Record<string, number> = {};
  const sinNadaEjemplos: string[] = [];

  for (;;) {
    const { data, error } = await supabase.from('media_items')
      .select('id,type,title,servers,seasons,has_streams,poster,streams_checked_at')
      .gt('id', ultimoId).order('id').limit(500);
    if (error) { console.error(error.message); break; }
    if (!data?.length) break;
    ultimoId = (data[data.length - 1] as any).id;

    for (const r of data as any[]) {
      if (!esFuegocine(r.id)) continue;
      total++;
      porTipo[r.type] = (porTipo[r.type] || 0) + 1;

      const todos = [
        ...(Array.isArray(r.servers) ? r.servers : []),
        ...(Array.isArray(r.seasons) ? r.seasons : [])
          .flatMap((s: any) => Array.isArray(s?.episodes) ? s.episodes : [])
          .flatMap((e: any) => Array.isArray(e?.servers) ? e.servers : []),
      ];
      if (!todos.length) {
        sinServidores++;
        if (sinNadaEjemplos.length < 6) sinNadaEjemplos.push(`${r.id}  «${r.title}»`);
        continue;
      }
      conServidores++;

      const directos = todos.filter((s: any) => s?.direct_stream && s.status !== 'offline');
      if (directos.length) conDirecto++;

      for (const s of todos) {
        let host = '';
        try { host = new URL(s?.embed_url || s?.url || '').hostname.replace(/^www\./, ''); } catch { continue; }
        const destino = (s?.direct_stream && s.status !== 'offline') ? hostsConDirecto : hostsSinDirecto;
        destino[host] = (destino[host] || 0) + 1;
      }

      const sello = r.streams_checked_at ? Date.now() - Date.parse(r.streams_checked_at) : Infinity;
      if (r.has_streams === true && r.poster && sello < 6 * H) anunciables++;
    }
    process.stderr.write(`  …${total}\r`);
  }

  const p = (a: number) => total ? `${((a / total) * 100).toFixed(1)}%` : '—';
  console.log(`\nFICHAS DE FUEGOCINE            ${total}`);
  for (const [t, n] of Object.entries(porTipo)) console.log(`  ${t.padEnd(28)} ${n}`);
  console.log(`  sin NINGÚN servidor          ${sinServidores}  (${p(sinServidores)})`);
  console.log(`  con servidores               ${conServidores}  (${p(conServidores)})`);
  console.log(`  con vídeo directo            ${conDirecto}  (${p(conDirecto)})`);
  console.log(`  ANUNCIABLES en la app        ${anunciables}  (${p(anunciables)})`);

  const top = (h: Record<string, number>, n = 10) =>
    Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([k, v]) => `      ${String(v).padStart(6)}  ${k}`).join('\n') || '      (ninguno)';
  console.log(`\n  Hosts CON vídeo directo:\n${top(hostsConDirecto)}`);
  console.log(`\n  Hosts SIN vídeo directo:\n${top(hostsSinDirecto)}`);
  if (sinNadaEjemplos.length) console.log(`\n  Ejemplos sin servidores:\n      ${sinNadaEjemplos.join('\n      ')}`);
})();
