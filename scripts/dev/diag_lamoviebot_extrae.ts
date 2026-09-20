/**
 * ¿SABEMOS YA EXTRAER LOS HOSTS DE LAMOVIEBOT? (2026-09-20)
 *
 * Antes de escribir un extractor conviene preguntar si hace falta. `extractDirect` tiene camino
 * genérico —buscar el m3u8 en el texto, y si no, desempaquetar el P.A.C.K.E.R. y volver a buscar—
 * y los dos hosts que más aparecen encajan en él sobre el papel: `goodstream.one` publica el
 * manifiesto en claro y `hlswish.com` va con `eval(function(p,a,c,k,e,d))`.
 *
 * Esto lo comprueba de verdad, host por host, y encima baja un segmento: que se extraiga una url
 * no dice que reproduzca, y esa distinción es la que el repositorio paga cada vez que la olvida.
 *
 *   npx ts-node --transpile-only scripts/dev/diag_lamoviebot_extrae.ts
 *   npx ts-node --transpile-only scripts/dev/diag_lamoviebot_extrae.ts --fichas=12
 */
import 'dotenv/config';
import { httpClient } from '../../src/utils/httpClient';
import { extractDirect } from '../../src/scrapers/directStream';
import { bajarManifiesto, segmentoDescargable } from '../../src/services/manifestHealth';

const LMB = 'https://lamoviebot.tvymas.workers.dev';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const CUANTAS = Number(process.argv.find((a) => a.startsWith('--fichas='))?.split('=')[1] || 8);

async function json(url: string): Promise<any> {
  const r = await httpClient.get(url, { timeout: 45000, headers: { 'User-Agent': UA }, validateStatus: () => true });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return r.data;
}

interface Marca { intentos: number; extrae: number; reproduce: number; motivos: string[] }

async function main() {
  const cabeza = await json(`${LMB}/peliculas`);
  const totalPaginas = Number(cabeza.total_pages) || 1;

  const enlaces: Array<{ host: string; url: string; ficha: string }> = [];
  for (let i = 0; i < CUANTAS; i++) {
    const p = 1 + Math.floor((i * totalPaginas) / CUANTAS);
    try {
      const slug = (await json(`${LMB}/peliculas?page=${p}`)).movies?.[0]?.slug;
      if (!slug) continue;
      const d = await json(`${LMB}/pelicula/${slug}`);
      for (const e of Object.values(d?.embeds || {}).flat() as any[]) {
        const url = String(e?.link || '');
        if (!url) continue;
        let host = '';
        try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
        enlaces.push({ host, url, ficha: slug });
      }
    } catch {}
  }

  const por = new Map<string, Marca>();
  for (const { host, url } of enlaces) {
    const m = por.get(host) || { intentos: 0, extrae: 0, reproduce: 0, motivos: [] };
    m.intentos++;
    try {
      const r = await httpClient.get(url, {
        timeout: 25000,
        responseType: 'text',
        transformResponse: [(d: unknown) => d],
        headers: { 'User-Agent': UA, Referer: 'https://lamovie.org/' },
        validateStatus: () => true,
      });
      if (r.status !== 200) {
        m.motivos.push(`http-${r.status}`);
      } else {
        const directo = await extractDirect(url, String(r.data), { allowNetwork: true });
        if (!directo) {
          m.motivos.push('sin-url');
        } else {
          m.extrae++;
          // Que salga una url no es que reproduzca: hay que bajar bytes.
          if (directo.kind === 'hls') {
            const man = await bajarManifiesto(directo.url, url);
            if (man && (await segmentoDescargable(man, directo.url, url))) m.reproduce++;
            else m.motivos.push('hls-sin-segmento');
          } else {
            m.reproduce++;
          }
        }
      }
    } catch (e: any) {
      m.motivos.push(String(e?.code || e?.message || 'excepcion').slice(0, 20));
    }
    por.set(host, m);
  }

  console.log(`\nEXTRACCIÓN POR HOST · ${enlaces.length} embeds de ${CUANTAS} fichas\n`);
  console.log('  host                       intentos  extrae  REPRODUCE   motivos');
  for (const [host, m] of [...por.entries()].sort((a, b) => b[1].reproduce - a[1].reproduce)) {
    const motivos = [...new Set(m.motivos)].slice(0, 3).join(' ');
    console.log(
      `  ${host.padEnd(26)} ${String(m.intentos).padStart(5)}   ${String(m.extrae).padStart(5)}   ${String(m.reproduce).padStart(6)}      ${motivos}`
    );
  }
  const totalRep = [...por.values()].reduce((a, b) => a + b.reproduce, 0);
  console.log(`\n  embeds que REPRODUCEN sin escribir extractor nuevo: ${totalRep} de ${enlaces.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
