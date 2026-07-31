/**
 * ¿Cuánto costaría que la API NO entregue ni un embed?
 *
 * Cuenta, sobre el catálogo real: fichas que ya reproducen solo con vídeo directo, fichas que se
 * quedarían sin nada si se ocultaran los embed, y —de esas— cuántas son recuperables porque su
 * host TIENE extractor y solo falta pasarle el repaso.
 *
 *   npx ts-node --transpile-only scripts/dev/probe_solo_directo.ts
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { mereceRepasoDeExtraccion } from '../../src/scrapers/directStream';

const db = getSupabaseAdmin();

function hostDe(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '(?)';
  }
}

(async () => {
  const filas: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db
      .from('media_items')
      .select('id,type,title,has_streams,servers')
      .range(f, f + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 1000) break;
  }

  let conServidores = 0;
  let soloDirecto = 0;
  let mixtas = 0;
  let soloEmbed = 0;
  let soloEmbedRecuperable = 0;
  let sinNada = 0;
  let servTotal = 0;
  let servDirecto = 0;
  let servEmbedExtraible = 0;

  const perdidosPorHost = new Map<string, number>();
  const recuperablesPorHost = new Map<string, number>();

  for (const fila of filas) {
    const servers: any[] = Array.isArray(fila.servers) ? fila.servers : [];
    if (!servers.length) {
      sinNada++;
      continue;
    }
    conServidores++;
    const vivos = servers.filter(s => s?.embed_url || s?.direct_stream);
    const directos = vivos.filter(s => s.direct_stream && s.status !== 'offline');
    const embeds = vivos.filter(s => !s.direct_stream);

    servTotal += vivos.length;
    servDirecto += vivos.filter(s => s.direct_stream).length;

    for (const s of embeds) {
      const h = hostDe(s.embed_url || '');
      if (s.embed_url && mereceRepasoDeExtraccion(s.embed_url)) {
        servEmbedExtraible++;
        recuperablesPorHost.set(h, (recuperablesPorHost.get(h) || 0) + 1);
      }
    }

    if (directos.length && !embeds.length) soloDirecto++;
    else if (directos.length) mixtas++;
    else {
      soloEmbed++;
      const recuperable = embeds.some(s => s.embed_url && mereceRepasoDeExtraccion(s.embed_url));
      if (recuperable) soloEmbedRecuperable++;
      else for (const s of embeds) {
        const h = hostDe(s.embed_url || '');
        perdidosPorHost.set(h, (perdidosPorHost.get(h) || 0) + 1);
      }
    }
  }

  const top = (m: Map<string, number>, n = 14) =>
    Array.from(m).sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([h, c]) => `      ${h.padEnd(30)} ${c}`).join('\n');

  console.log(`fichas totales                 ${filas.length}`);
  console.log(`  sin servidores               ${sinNada}`);
  console.log(`  con servidores               ${conServidores}`);
  console.log(`    solo vídeo directo         ${soloDirecto}`);
  console.log(`    directo + embed            ${mixtas}   (el embed ya se oculta hoy)`);
  console.log(`    SOLO EMBED                 ${soloEmbed}   ← se quedarían mudas`);
  console.log(`      de ellas, recuperables   ${soloEmbedRecuperable}   (host con extractor)`);
  console.log(`      sin extractor posible    ${soloEmbed - soloEmbedRecuperable}`);
  console.log(`\nservidores                     ${servTotal}`);
  console.log(`  con vídeo directo            ${servDirecto}  (${(servDirecto / servTotal * 100).toFixed(1)}%)`);
  console.log(`  embed extraíble pendiente    ${servEmbedExtraible}`);
  console.log(`\nhosts de las fichas SOLO EMBED sin extractor:\n${top(perdidosPorHost)}`);
  console.log(`\nhosts con extracción pendiente:\n${top(recuperablesPorHost)}`);
})();
