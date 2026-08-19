/**
 * ¿CUÁNTAS FICHAS TENDRÍAN UNA URL DIRECTA QUE NO CADUCA?
 *
 * Lo pedido es un catálogo tipo hoja de cálculo: título → url directa, permanente, y si no la
 * hay, la ficha no se muestra. Antes de construirlo hay que saber si queda catálogo.
 *
 * El proyecto ya sabe distinguirlo y no hay que inventar nada: `isPubliclyShareable` y
 * `hasVolatileToken` (src/scrapers/directStream.ts) marcan las urls con firma, caducidad o IP
 * dentro. Se usan aquí tal cual para que la respuesta no dependa de mi criterio.
 *
 *   npx ts-node -T scripts/dev/diag_url_permanente.ts
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { isPubliclyShareable, hasVolatileToken, decodeEmbedParam } from '../../src/scrapers/directStream';

/**
 * `direct_stream` guarda la url de ESTA API (`/stream/direct?e=<embed en base64>`), no la del CDN:
 * la del CDN se acuña al reproducir justo porque caduca. Así que para saber si el destino es
 * permanente hay que mirar el EMBED, que es lo que sí está guardado.
 */
function urlDeDestino(s: any): string {
  const directo = String(s?.direct_stream || '');
  const e = directo.match(/[?&]e=([^&]+)/)?.[1];
  const delParam = e ? decodeEmbedParam(e) : null;
  return delParam || String(s?.embed_url || '');
}

const hostDe = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '(ilegible)'; } };

(async () => {
  let ultimoId = '';
  let filas = 0, conDirecto = 0, conPermanente = 0;
  const hostsPermanentes: Record<string, number> = {};
  const hostsEfimeros: Record<string, number> = {};
  const ejemplos: string[] = [];

  for (;;) {
    const { data, error } = await supabase.from('media_items')
      .select('id,title,type,servers').gt('id', ultimoId).order('id').limit(500);
    if (error) { console.error(error.message); break; }
    if (!data?.length) break;
    ultimoId = (data[data.length - 1] as any).id;

    for (const r of data as any[]) {
      filas++;
      const srv = (r.servers ?? []).filter((s: any) => s?.direct_stream && s.status !== 'offline');
      if (!srv.length) continue;
      conDirecto++;

      let permanente: string | null = null;
      for (const s of srv) {
        const destino = urlDeDestino(s);
        if (!destino) continue;
        const host = hostDe(destino);
        // Permanente = se puede compartir tal cual y no lleva firma ni caducidad dentro.
        if (isPubliclyShareable(destino) && !hasVolatileToken(destino)) {
          permanente = destino;
          hostsPermanentes[host] = (hostsPermanentes[host] || 0) + 1;
          break;
        }
        hostsEfimeros[host] = (hostsEfimeros[host] || 0) + 1;
      }
      if (permanente) {
        conPermanente++;
        if (ejemplos.length < 8) ejemplos.push(`${String(r.title).slice(0, 34).padEnd(34)} ${permanente.slice(0, 92)}`);
      }
    }
    process.stderr.write(`  …${filas}\r`);
  }

  const p = (a: number) => `${((a / filas) * 100).toFixed(1)}%`;
  console.log(`\nSobre ${filas} fichas del catálogo:`);
  console.log(`   con algún vídeo directo publicado   ${conDirecto}  (${p(conDirecto)})`);
  console.log(`   con una URL que NO CADUCA           ${conPermanente}  (${p(conPermanente)})   ← el catálogo que pides`);

  const top = (h: Record<string, number>, n = 10) =>
    Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([k, v]) => `      ${String(v).padStart(6)}  ${k}`).join('\n') || '      (ninguno)';
  console.log(`\n   Hosts que dan URL permanente:\n${top(hostsPermanentes)}`);
  console.log(`\n   Hosts cuya URL caduca (firma, expiración o IP dentro):\n${top(hostsEfimeros)}`);
  if (ejemplos.length) console.log(`\n   Ejemplos de lo que tendría la hoja:\n      ${ejemplos.join('\n      ')}`);
})();
