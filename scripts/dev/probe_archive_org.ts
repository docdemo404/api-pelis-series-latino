/**
 * ¿DA INTERNET ARCHIVE UNA FUENTE DE VERDAD?
 *
 * Es el mejor candidato con diferencia para el modelo actual, y no por corazonada: archive.org ya
 * es el host que más urls permanentes aporta al catálogo (145 títulos), sus direcciones NO
 * caducan —son ficheros públicos, sin firma ni token—, no hay captcha, y tiene API abierta. O
 * sea, todo lo que las demás webs no tienen.
 *
 * Esto pregunta a su buscador por películas en español latino y comprueba, sobre una muestra, que
 * los ficheros existen y devuelven vídeo.
 *
 *   npx ts-node -T scripts/dev/probe_archive_org.ts [cuantas]
 */
import 'dotenv/config';
import { httpClient } from '../../src/utils/httpClient';

const N = Number(process.argv[2]) || 12;
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0' };

const get = (u: string, tipo: 'json' | 'arraybuffer' = 'json', ms = 30000) =>
  httpClient.get(u, {
    headers: UA, timeout: ms, responseType: tipo as any,
    validateStatus: () => true, maxRedirects: 5,
  } as any);

(async () => {
  // Su buscador: colecciones de vídeo con audio/título en español latino.
  const consulta = encodeURIComponent('collection:(moviesandfilms OR peliculas-latino OR peliculas-en-espanol-latino) AND mediatype:(movies)');
  const url = `https://archive.org/advancedsearch.php?q=${consulta}` +
    `&fl[]=identifier&fl[]=title&fl[]=year&fl[]=downloads&rows=${N * 3}&page=1&output=json&sort[]=downloads+desc`;

  const r = await get(url);
  const docs = (r.data as any)?.response?.docs || [];
  console.log(`El buscador devuelve ${docs.length} items (http=${r.status})\n`);
  if (!docs.length) {
    console.log('   Sin resultados: habría que afinar la consulta o la colección.');
    return;
  }

  let conVideo = 0, sinVideo = 0;
  const ejemplos: string[] = [];

  for (const d of docs.slice(0, N)) {
    // `/metadata/<id>` lista los ficheros: es una llamada y trae todo.
    const meta = await get(`https://archive.org/metadata/${encodeURIComponent(d.identifier)}`);
    const ficheros = ((meta.data as any)?.files || []) as any[];
    const video = ficheros.find(f => /\.(mp4|mkv|webm)$/i.test(String(f?.name || '')) && Number(f?.size || 0) > 20_000_000);
    if (!video) { sinVideo++; console.log(`  ✗ ${String(d.title).slice(0, 44).padEnd(44)} sin fichero de vídeo grande`); continue; }

    const enlace = `https://archive.org/download/${d.identifier}/${encodeURIComponent(video.name)}`;
    const prueba = await get(enlace, 'arraybuffer', 30000);
    const kb = ((prueba.data as ArrayBuffer)?.byteLength ?? 0) / 1024;
    const ok = prueba.status < 400 && kb > 8;
    if (ok) { conVideo++; if (ejemplos.length < 5) ejemplos.push(`${String(d.title).slice(0, 40)} (${d.year || '?'})  ${enlace.slice(0, 86)}`); }
    else sinVideo++;
    console.log(`  ${ok ? '✓' : '✗'} ${String(d.title).slice(0, 44).padEnd(44)} ${(Number(video.size) / 1e9).toFixed(2)} GB  http=${prueba.status}`);
  }

  console.log(`\n  con vídeo descargable: ${conVideo}/${conVideo + sinVideo}`);
  if (ejemplos.length) console.log(`\n  Ejemplos:\n    ${ejemplos.join('\n    ')}`);
  console.log(`\n  Nota: las urls de archive.org NO llevan firma ni caducidad — son exactamente el`);
  console.log(`  tipo de enlace que este catálogo puede guardar tal cual.`);
})();
