/**
 * EL INFORME DE PLUTO QUE HACE EL MÓVIL, LANZADO DESDE ESTE PC.
 *
 * Hace exactamente lo de `PlutoCatalogWorker` (app Android): pide el catálogo a Pluto desde ESTA
 * red, lo manda a la API en lotes y mira el audio de los ids que la API devuelve. Sirve cuando el
 * móvil no está a mano, y solo tiene sentido desde una red latinoamericana: Pluto decide por IP.
 *
 *   npx ts-node --transpile-only scripts/dev/pluto_informe_manual.ts
 *   npx ts-node --transpile-only scripts/dev/pluto_informe_manual.ts --api=http://localhost:3000
 */
import 'dotenv/config';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { urlApiProduccion } from '../../src/config/produccion';

const API = (process.argv.find((a) => a.startsWith('--api='))?.split('=')[1] || urlApiProduccion('')).replace(/\/$/, '');
const DEVICE = 'pc-manual-' + randomUUID();

async function main() {
  const { data: boot } = await axios.get('https://boot.pluto.tv/v4/start', {
    params: {
      appName: 'web', appVersion: '9.0.0', deviceVersion: '120.0.0', deviceModel: 'web', deviceMake: 'chrome',
      deviceType: 'web', clientID: randomUUID(), clientModelNumber: '1.0.0', serverSideAds: 'false',
    },
    timeout: 15000,
  });
  const pais = boot.session?.countryCode || '';
  console.log(`Pluto: país ${pais} · mercado ${boot.session?.marketingRegion} · API ${API}`);
  if (boot.session?.marketingRegion !== 'LATAM') console.log('  ⚠ esta red no es LATAM: se informaría OTRO catálogo');

  const { data } = await axios.get(`${boot.servers.vod}/v4/vod/categories`, {
    params: { includeItems: true, offset: 1000, page: 1 },
    headers: { Authorization: `Bearer ${boot.sessionToken}` }, timeout: 60000,
  });
  const pelis = new Map<string, any>();
  for (const c of data.categories || []) for (const it of c.items || []) {
    if (it.type !== 'movie' || pelis.has(it._id)) continue;
    pelis.set(it._id, {
      id: it._id, nombre: it.name,
      anio: Number(String(it.clip?.originalReleaseDate || '').slice(0, 4)) || null,
      minutos: Math.round((it.originalContentDuration || 0) / 60000) || null,
      directores: it.clip?.directors || [],
    });
  }
  const lista = [...pelis.values()];
  const pendientes: string[] = [];
  for (let i = 0; i < lista.length; i += 300) {
    const r = await axios.post(`${API}/api/v1/pluto/catalogo`, { device_id: DEVICE, pais, items: lista.slice(i, i + 300) }, { timeout: 60000 });
    pendientes.push(...(r.data?.data?.audios_pendientes || []));
  }
  console.log(`catálogo: ${lista.length} películas enviadas · audio por mirar: ${pendientes.length}`);

  const audios: { id: string; audios: string[] }[] = [];
  let k = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (k < pendientes.length) {
      const id = pendientes[k++];
      const url = `${boot.servers.stitcher}/v2/stitch/hls/episode/${id}/master.m3u8?${boot.stitcherParams}&jwt=${boot.sessionToken}&masterJWTPassthrough=true`;
      try {
        const m: string = (await axios.get(url, { timeout: 15000, responseType: 'text' })).data;
        if (!m.startsWith('#EXTM3U')) continue;
        audios.push({ id, audios: [...new Set([...m.matchAll(/TYPE=AUDIO[^\n]*?LANGUAGE="([^"]+)"/g)].map((x) => x[1].toLowerCase()))] });
      } catch { /* esta vuelta no; la siguiente lo vuelve a pedir */ }
    }
  }));
  for (let i = 0; i < audios.length; i += 300) {
    await axios.post(`${API}/api/v1/pluto/audios`, { device_id: DEVICE, items: audios.slice(i, i + 300) }, { timeout: 60000 });
  }
  const conEs = audios.filter((a) => a.audios.some((x) => x.startsWith('es') || x.startsWith('spa'))).length;
  console.log(`audio mirado: ${audios.length} (${conEs} con español)`);
  console.log((await axios.get(`${API}/api/v1/pluto/estado`)).data.data);
}

main().catch((e) => { console.error(e?.response?.data || e); process.exit(1); });
