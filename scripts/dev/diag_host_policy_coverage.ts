import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { policyFor, CONSERVATIVE } from '../../src/scrapers/hostPolicy';
import { unwrapRedirector } from '../../src/scrapers/directStream';

/**
 * ¿A cuántos servidores del catálogo les aplica de verdad `hostPolicy`?
 *
 * `diag_direct_coverage.ts` responde a "de qué hosts sabemos SACAR el vídeo". Esto responde a la
 * otra mitad: de los que sabemos sacarlo, a cuáles les toca reenviar bytes SOLO porque su host no
 * casa con ninguna entrada de la tabla y cae en `CONSERVATIVE`.
 *
 * Existe porque esa distinción se puede perder de vista con facilidad: `policyFor` compara contra
 * el hostname del EMBED, así que una entrada cuyo `match` lleve por error un dominio de CDN no
 * casa nunca y su host de embed real se queda pagando el proxy para siempre. Un `match` muerto no
 * da ningún error, solo tránsito de más.
 *
 *   npx ts-node scripts/dev/diag_host_policy_coverage.ts
 *   npx ts-node scripts/dev/diag_host_policy_coverage.ts 3000
 */

interface HostStat {
  servidores: number;
  conDirect: number;
  /**
   * Embeds para pasarle a la sonda. Se guardan SOLO los que ya tienen `direct_stream`: un embed
   * cualquiera del host suele estar muerto y la sonda diría "sin extracción", que no responde a
   * lo que se pregunta aquí (si el host puede salir del proxy, no si ese enlace sigue vivo).
   */
  ejemplos: string[];
  modos: Set<string>;
}

const MAX_EJEMPLOS = 3;

async function main() {
  const limite = parseInt(process.argv[2] || '4000', 10);
  const porPagina = 1000;
  const stats = new Map<string, HostStat>();

  for (let desde = 0; desde < limite; desde += porPagina) {
    const { data, error } = await getSupabaseAdmin()
      .from('media_items')
      .select('servers,seasons')
      .range(desde, Math.min(desde + porPagina, limite) - 1);
    if (error) {
      console.error(`Supabase: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;

    for (const fila of data as any[]) {
      // Los episodios guardan sus servidores dentro de `seasons`, y son la mayoría del catálogo:
      // mirar solo `servers` dejaría fuera todas las series.
      const servidores: any[] = [...(fila.servers || [])];
      for (const temporada of fila.seasons || []) {
        for (const episodio of temporada?.episodes || []) {
          servidores.push(...(episodio?.servers || []));
        }
      }

      for (const servidor of servidores) {
        if (!servidor?.embed_url) continue;
        const embed = unwrapRedirector(servidor.embed_url);
        let host: string;
        try {
          host = new URL(embed).hostname.toLowerCase();
        } catch {
          continue;
        }
        const stat = stats.get(host) || { servidores: 0, conDirect: 0, ejemplos: [], modos: new Set<string>() };
        stat.servidores++;
        if (servidor.direct_stream) {
          stat.conDirect++;
          if (stat.ejemplos.length < MAX_EJEMPLOS && !stat.ejemplos.includes(embed)) stat.ejemplos.push(embed);
        }
        if (servidor.direct_mode) stat.modos.add(servidor.direct_mode);
        stats.set(host, stat);
      }
    }

    if (data.length < porPagina) break;
  }

  const filas = [...stats.entries()].sort((a, b) => b[1].servidores - a[1].servidores);
  console.log('host                                   servidores  con-vídeo  política         modos guardados');
  let sinPolitica = 0;
  const huerfanos: string[] = [];

  for (const [host, stat] of filas) {
    const policy = policyFor(`https://${host}/`);
    const cubierto = policy !== CONSERVATIVE;
    if (!cubierto) {
      sinPolitica += stat.servidores;
      huerfanos.push(...stat.ejemplos);
    }
    console.log(
      `${host.padEnd(38)} ${String(stat.servidores).padStart(10)}  ${String(stat.conDirect).padStart(9)}  ` +
      `${(cubierto ? policy.match[0] : '*** NINGUNA ***').padEnd(16)} ${[...stat.modos].join(',') || '-'}`
    );
  }

  const total = filas.reduce((acc, [, s]) => acc + s.servidores, 0);
  console.log(`\n${filas.length} hosts, ${total} servidores.`);
  console.log(`Sin política (proxy forzado): ${sinPolitica} servidores (${total ? (sinPolitica / total * 100).toFixed(1) : '0'}%).`);

  if (huerfanos.length) {
    console.log('\nEmbeds de los que SÍ se saca vídeo pero no casan con ninguna entrada.');
    console.log('Pásaselos a probe_hosts.ts para saber si pueden salir del proxy:\n');
    console.log(`  npx ts-node scripts/dev/probe_hosts.ts --remote=<api> \\\n    ${huerfanos.slice(0, 8).map(u => `"${u}"`).join(' \\\n    ')}`);
  }
}

main().then(() => setTimeout(() => process.exit(0), 300).unref());
