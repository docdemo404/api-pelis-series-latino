/**
 * ¿QUÉ HAY DETRÁS DE LOS EMBEDS DE LAMOVIEBOT? (2026-09-20)
 *
 * El aporte de fichas ya está medido (`diag_fuentes_candidatas.ts`): ~650 obras que no tenemos.
 * Pero una ficha sin vídeo que reproduzca no es una ficha, y esta fuente tiene el mismo perfil que
 * tumbó a cinecalidad: si todos sus embeds salen por `vimeos.net`, es un cliente del proveedor al
 * que YA le hablamos (videoapi, moviedays) por una puerta peor.
 *
 * Así que esto cuenta los hosts uno a uno y separa tres casillas:
 *
 *   · REDUNDANTE  — `vimeos.net` y compañía: mismo CDN que ya servimos, y el que da 403 a workerd.
 *   · YA EXTRAEMOS — tiene extractor en `directStream.ts`, entra gratis.
 *   · NUEVO       — host sin extractor. Aquí es donde estaría el trabajo, y hay que saber cuánto
 *                   vídeo hay al otro lado antes de decidir si merece la pena escribirlo.
 *
 *   npx ts-node --transpile-only scripts/dev/diag_lamoviebot_hosts.ts
 *   npx ts-node --transpile-only scripts/dev/diag_lamoviebot_hosts.ts --fichas=40
 */
import 'dotenv/config';
import { httpClient } from '../../src/utils/httpClient';

const LMB = 'https://lamoviebot.tvymas.workers.dev';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const CUANTAS = Number(process.argv.find((a) => a.startsWith('--fichas='))?.split('=')[1] || 30);

/** El mismo CDN que ya nos sirve videoapi y moviedays: lo que salga por aquí no es contenido nuevo. */
const REDUNDANTES = ['vimeos', 'unlimplay'];

async function json(url: string, timeout = 45000): Promise<any> {
  const r = await httpClient.get(url, { timeout, headers: { 'User-Agent': UA }, validateStatus: () => true });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return r.data;
}

function hostDe(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '?'; }
}

async function main() {
  // Páginas repartidas, por lo mismo de siempre: las primeras son estrenos y no representan al resto.
  const cabeza = await json(`${LMB}/peliculas`);
  const totalPaginas = Number(cabeza.total_pages) || 1;
  const slugs: string[] = [];
  for (let i = 0; slugs.length < CUANTAS && i < CUANTAS; i++) {
    const p = 1 + Math.floor((i * totalPaginas) / CUANTAS);
    try {
      const cuerpo = await json(`${LMB}/peliculas?page=${p}`);
      const m = (cuerpo.movies || [])[0];
      if (m?.slug) slugs.push(m.slug);
    } catch {}
  }

  const porHost = new Map<string, number>();
  const porFicha: Array<{ slug: string; hosts: string[] }> = [];
  let sinEmbeds = 0;

  for (const slug of slugs) {
    try {
      const d = await json(`${LMB}/pelicula/${slug}`);
      const listas: any[] = Object.values(d?.embeds || {}).flat() as any[];
      const hosts = listas.map((e: any) => hostDe(String(e?.link || ''))).filter((h) => h !== '?');
      if (!hosts.length) { sinEmbeds++; continue; }
      hosts.forEach((h) => porHost.set(h, (porHost.get(h) || 0) + 1));
      porFicha.push({ slug, hosts: [...new Set(hosts)] });
    } catch { sinEmbeds++; }
  }

  const total = [...porHost.values()].reduce((a, b) => a + b, 0);
  console.log(`\nREPARTO DE HOSTS · ${porFicha.length} fichas leídas, ${sinEmbeds} sin embeds, ${total} servidores\n`);
  const filas = [...porHost.entries()].sort((a, b) => b[1] - a[1]);
  for (const [host, n] of filas) {
    const casilla = REDUNDANTES.some((r) => host.includes(r))
      ? 'REDUNDANTE (mismo CDN que ya servimos)'
      : 'NUEVO (sin extractor propio)';
    console.log(`  ${String(n).padStart(4)}  ${host.padEnd(24)} ${Math.round((n / total) * 100)}%  ${casilla}`);
  }

  // Cuántas fichas quedarían SIN NADA si solo contamos con lo que no es redundante.
  const soloRedundante = porFicha.filter((f) => f.hosts.every((h) => REDUNDANTES.some((r) => h.includes(r))));
  console.log(`\n  fichas cuyo ÚNICO servidor es el CDN que ya tenemos: ${soloRedundante.length} de ${porFicha.length}`);
  console.log(`  fichas con al menos un host distinto:                 ${porFicha.length - soloRedundante.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
