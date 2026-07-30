/**
 * ¿Qué costaría dejar de ofrecer los embeds y servir SOLO vídeo extraído?
 *
 * La idea es tentadora: un embed no se puede comprobar (es un iframe de un tercero), no se puede
 * ordenar por calidad y no se puede medir. Servir solo vídeo directo haría el catálogo entero
 * verificable. La pregunta es qué se queda sin reproducir por el camino, y eso no es opinable: se
 * cuenta.
 *
 *   npx ts-node --transpile-only scripts/dev/diag_solo_embed.ts
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';

const db = getSupabaseAdmin();

/** Familia de host de un embed, para saber quién concentra el problema. */
function hostDe(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '(ilegible)';
  }
}

(async () => {
  const filas: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('media_items')
      .select('id,title,type,servers,has_streams')
      .not('servers', 'eq', '[]')
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    filas.push(...data);
    if (data.length < 1000) break;
  }

  const { count: total } = await db.from('media_items').select('id', { count: 'exact', head: true });

  let conDirecto = 0;
  let soloEmbed = 0;
  const hostsQueSalvan = new Map<string, number>();   // hosts que son el ÚNICO sostén de una ficha
  const ejemplos: string[] = [];

  for (const f of filas) {
    const servers = (f.servers || []).filter((s: any) => s && s.embed_url);
    if (servers.length === 0) continue;
    const directos = servers.filter((s: any) => s.direct_stream);

    if (directos.length > 0) {
      conDirecto++;
      continue;
    }

    soloEmbed++;
    // Esta ficha se quedaría SIN reproducir. ¿De qué hosts dependía?
    for (const h of new Set(servers.map((s: any) => hostDe(s.embed_url)))) {
      hostsQueSalvan.set(h as string, (hostsQueSalvan.get(h as string) || 0) + 1);
    }
    if (ejemplos.length < 12) {
      ejemplos.push(`${f.id} · "${f.title}" [${f.type}] · ${servers.length} servidor(es): ` +
        Array.from(new Set(servers.map((s: any) => hostDe(s.embed_url)))).join(', '));
    }
  }

  const conServidores = conDirecto + soloEmbed;
  console.log(`catálogo: ${total} fichas · con servidores guardados: ${conServidores}\n`);
  console.log(`   con al menos un vídeo directo:  ${conDirecto}  (${((conDirecto / conServidores) * 100).toFixed(1)}%)`);
  console.log(`   SOLO embeds:                    ${soloEmbed}  (${((soloEmbed / conServidores) * 100).toFixed(1)}%)`);
  console.log(`\nSi se dejaran de ofrecer los embeds, esas ${soloEmbed} fichas se quedarían sin nada que reproducir.`);

  console.log('\nHosts de los que dependen esas fichas (los que habría que extraer para no perderlas):');
  for (const [h, n] of Array.from(hostsQueSalvan).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`   ${h.padEnd(30)} sostiene ${String(n).padStart(5)} fichas`);
  }

  /**
   * Y la versión ÚTIL de la idea: retirar los embeds SOLO donde la ficha YA tiene vídeo directo.
   * Ahí no se pierde nada — son opciones que no aportan y que, cuando fallan, es exactamente lo
   * que ve el espectador.
   */
  let embedsRetirables = 0;
  let fichasAfectadas = 0;
  for (const f of filas) {
    const servers = (f.servers || []).filter((s: any) => s && s.embed_url);
    const directos = servers.filter((s: any) => s.direct_stream);
    if (directos.length === 0) continue;
    const soloEmbeds = servers.length - directos.length;
    if (soloEmbeds > 0) {
      embedsRetirables += soloEmbeds;
      fichasAfectadas++;
    }
  }
  console.log('\nSi los embeds se retiraran SOLO donde ya hay vídeo directo:');
  console.log(`   ${embedsRetirables} servidores retirados en ${fichasAfectadas} fichas`);
  console.log('   y ninguna ficha se quedaría sin reproducir.');

  console.log('\nEjemplos de fichas que se perderían:');
  for (const e of ejemplos) console.log(`   · ${e}`);
})();
