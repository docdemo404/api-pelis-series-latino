/**
 * BANCO DE PRUEBAS DEL LIBRO DE LA FUENTE PROPIA.
 *
 * Sin red y sin base de datos: son funciones puras, y lo que se comprueba aquí es exactamente lo
 * que ha fallado cuatro veces en producción. Que esto esté en verde es lo que permite tocar
 * cualquier escritor del catálogo sin volver a perder una url pegada a mano.
 *
 *   npx ts-node -T scripts/dev/test_manual_ledger.ts
 */
import {
  extraerManuales,
  fusionarConLedger,
  leerLedger,
  ledgerVacio,
  todoElLedger,
} from '../../src/services/manualLedger';

let fallos = 0;
function comprobar(que: string, condicion: boolean): void {
  console.log(`${condicion ? '  ✅' : '  ❌'} ${que}`);
  if (!condicion) fallos++;
}

const manual = (url: string, extra: Record<string, unknown> = {}) => ({
  id: `x_manual_${url.slice(-6)}`,
  name: 'Manual 1',
  source_id: 'manual',
  embed_url: url,
  direct_stream: url,
  direct_mode: 'public',
  direct_kind: 'mp4',
  status: 'online',
  verified_at: '2026-08-23T05:50:00.000Z',
  ...extra,
});

const scrapeado = (url: string) => ({
  id: 'srv_md_1',
  name: 'Vimeos',
  source_id: 'moviedays',
  embed_url: 'https://vimeos.net/embed-abc.html',
  direct_stream: url,
  direct_mode: 'redirect',
  status: 'online',
  verified_at: '2026-08-23T05:20:00.000Z',
});

const URL_MANUAL = 'https://archive.org/download/shr-2010/Shr2010.mp4';
const URL_CAP = 'https://archive.org/download/bb-1x1/bb101.mp4';

console.log('\n① Una película a la que el rastreo le pisó los servidores');
{
  const original = { servers: [manual(URL_MANUAL), scrapeado('https://cdn.x/y.m3u8')], seasons: [] };
  const libro = extraerManuales(original);
  comprobar('el libro se queda solo con lo manual', libro.ficha.length === 1 && !libro.capitulos.length);

  // El crawl reemplaza `servers` entero: la url manual ya no está.
  const pisada = { servers: [scrapeado('https://cdn.x/y.m3u8')], seasons: [] };
  const { servers, recuperados } = fusionarConLedger(pisada, libro);
  comprobar('se recupera la url perdida', recuperados === 1);
  comprobar('vuelve la PRIMERA, como la puso el panel', String(servers[0]?.source_id) === 'manual');
  comprobar('el servidor scrapeado sigue ahí', servers.length === 2);
  comprobar('vuelve SIN sello: anunciarla otra vez exige prueba', !(servers[0] as any).verified_at);
  comprobar('y vuelve con su dirección intacta', String((servers[0] as any).direct_stream) === URL_MANUAL);
}

console.log('\n② La fila está bien: el libro no tiene que tocar nada');
{
  const fila = { servers: [manual(URL_MANUAL), scrapeado('https://cdn.x/y.m3u8')], seasons: [] };
  const { servers, recuperados } = fusionarConLedger(fila, extraerManuales(fila));
  comprobar('no se recupera nada', recuperados === 0);
  comprobar('no se duplica', servers.length === 2);
  comprobar('se conserva el sello de la fila', Boolean((servers[0] as any).verified_at));
}

console.log('\n③ La url guardada ya venía envuelta en la caché por trozos');
{
  const envueltaUrl = `https://worker.example.dev/v?e=${Buffer.from(URL_MANUAL).toString('base64url')}&s=abc`;
  const libro = extraerManuales({ servers: [manual(URL_MANUAL)], seasons: [] });
  // Lo que se persiste se fosiliza: la fila tiene la forma `/v?e=…`, no la del origen. Y esto
  // tiene que funcionar SIN las variables del Worker, que es como corren los scripts.
  const { servers, recuperados } = fusionarConLedger({ servers: [manual(envueltaUrl)], seasons: [] }, libro);
  comprobar('se reconoce como la misma url y no se re-inyecta', recuperados === 0 && servers.length === 1);
}

console.log('\n④ El mismo fichero guardado DOS veces (lo que le pasó a Shrek)');
{
  const envueltaUrl = `https://worker.example.dev/v?e=${Buffer.from(URL_MANUAL).toString('base64url')}&s=abc`;
  const fila = { servers: [manual(URL_MANUAL, { verified_at: undefined }), manual(envueltaUrl)], seasons: [] };

  const libro = extraerManuales(fila);
  comprobar('el libro guarda UNA sola entrada', libro.ficha.length === 1);
  comprobar('y con la url del ORIGEN, que es la estable', String((libro.ficha[0] as any).direct_stream) === URL_MANUAL);
  comprobar('conservando el sello de la copia que lo tenía', Boolean((libro.ficha[0] as any).verified_at));

  const { servers, recuperados, duplicados } = fusionarConLedger(fila, libro);
  comprobar('la fila queda con una sola copia', servers.length === 1 && duplicados === 1);
  comprobar('y no se recupera nada de más', recuperados === 0);
}

console.log('\n⑤ Una serie a la que le pisaron el capítulo');
{
  const arbol = [{
    season_number: 1,
    episodes: [
      { episode_number: 1, servers: [manual(URL_CAP), scrapeado('https://cdn.x/1x1.m3u8')] },
      { episode_number: 2, servers: [scrapeado('https://cdn.x/1x2.m3u8')] },
    ],
  }];
  const libro = extraerManuales({ servers: [], seasons: arbol });
  comprobar('el libro anota el capítulo al que pertenece', libro.capitulos.length === 1 && libro.capitulos[0].episode === 1);

  const pisado = [{
    season_number: 1,
    episodes: [
      { episode_number: 1, servers: [scrapeado('https://cdn.x/1x1.m3u8')] },
      { episode_number: 2, servers: [scrapeado('https://cdn.x/1x2.m3u8')] },
    ],
  }];
  const { seasons, recuperados } = fusionarConLedger({ servers: [], seasons: pisado }, libro);
  const cap1 = (seasons[0] as any).episodes[0];
  const cap2 = (seasons[0] as any).episodes[1];
  comprobar('se recupera la url del 1x01', recuperados === 1);
  comprobar('vuelve a SU capítulo y la primera', String(cap1.servers[0].source_id) === 'manual');
  comprobar('el 1x02 no se toca (nadie le pegó nada)', cap2.servers.length === 1);
}

console.log('\n⑥ Un capítulo que ya no existe NO se inventa');
{
  const libro = leerLedger({
    ficha: [],
    capitulos: [{ season: 9, episode: 99, servers: [manual('https://archive.org/download/x/9x99.mp4')] }],
  });
  const arbol = [{ season_number: 1, episodes: [{ episode_number: 1, servers: [] }] }];
  const { seasons, recuperados } = fusionarConLedger({ servers: [], seasons: arbol }, libro);
  comprobar('no se recupera nada', recuperados === 0);
  comprobar('el árbol se queda como estaba', (seasons[0] as any).episodes.length === 1);
}

console.log('\n⑦ Lecturas defensivas de la columna');
{
  comprobar('null es un libro vacío', ledgerVacio(leerLedger(null)));
  comprobar('basura es un libro vacío', ledgerVacio(leerLedger('{"ficha":3}')));
  comprobar('un libro con solo capítulos NO está vacío',
    !ledgerVacio(leerLedger({ ficha: [], capitulos: [{ season: 1, episode: 1, servers: [manual(URL_CAP)] }] })));
  comprobar('todoElLedger junta los dos niveles',
    todoElLedger(leerLedger({ ficha: [manual(URL_MANUAL)], capitulos: [{ season: 1, episode: 1, servers: [manual(URL_CAP)] }] })).length === 2);
}

console.log(fallos === 0 ? '\n✅ Todo en verde\n' : `\n❌ ${fallos} comprobación(es) en rojo\n`);
process.exit(fallos === 0 ? 0 : 1);
