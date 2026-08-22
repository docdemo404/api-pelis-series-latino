import 'dotenv/config';
import { CatalogService } from '../../src/services/catalogService';
import { TmdbService } from '../../src/services/tmdbService';

/**
 * ¿CADA URL VA A SU CAPÍTULO, O SE AMONTONAN TODAS EN EL PRIMERO?
 *
 * Construye el árbol de temporadas exactamente como lo hace el formulario de la fuente propia
 * —misma función, mismos argumentos— con una url distinta y reconocible por capítulo, y luego
 * comprueba dónde acabó cada una. No escribe nada en la base: solo mira el reparto.
 */
(async () => {
  const tmdbId = Number(process.argv[2]) || 1396; // Breaking Bad
  const detalle = await TmdbService.getTmdbDetails(tmdbId, 'tvseries');
  if (!detalle) { console.error('TMDB no contesta'); process.exit(1); }

  // Una url por capítulo, con el capítulo escrito dentro para poder reconocerla después.
  const pedido = [
    { season: 1, episode: 1, urls: ['https://ejemplo.test/S1E1.mp4'] },
    { season: 1, episode: 2, urls: ['https://ejemplo.test/S1E2.mp4'] },
    { season: 1, episode: 3, urls: ['https://ejemplo.test/S1E3.mp4', 'https://ejemplo.test/S1E3-respaldo.mp4'] },
    { season: 2, episode: 5, urls: ['https://ejemplo.test/S2E5.mp4'] },
    { season: 3, episode: 7, urls: ['https://ejemplo.test/S3E7.mp4'] },
  ];

  const seasons = await (CatalogService as any).temporadasConCapitulosManuales(
    tmdbId, detalle, 'prueba', pedido);

  console.log(`«${detalle.name || detalle.title}» · ${seasons.length} temporadas construidas\n`);

  let bien = 0, mal = 0;
  for (const t of seasons) {
    for (const e of (t.episodes || [])) {
      const urls = (e.servers || [])
        .filter((sv: any) => String(sv?.source_id).toLowerCase() === 'manual')
        .map((sv: any) => String(sv.direct_stream));
      if (!urls.length) continue;
      const donde = `${t.season_number}x${e.episode_number}`;
      const esperado = `S${t.season_number}E${e.episode_number}`;
      const todasSuyas = urls.every((u: string) => u.includes(esperado));
      console.log(`  ${todasSuyas ? '✅' : '❌'} ${donde.padEnd(5)} ${urls.join('  ')}`);
      todasSuyas ? bien++ : mal++;
    }
  }

  const pedidos = pedido.length;
  console.log(`\ncapítulos pedidos: ${pedidos} · con SU url: ${bien} · mal colocados: ${mal}`);
  if (bien !== pedidos || mal) {
    console.log('\n❌ el reparto NO es correcto');
    process.exit(1);
  }
  console.log('\n✅ cada url en su capítulo, y ninguna de más');
  process.exit(0);
})();
