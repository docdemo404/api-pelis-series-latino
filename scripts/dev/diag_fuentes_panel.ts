/** ¿Qué lista de fuentes devuelve SourceManager tras fusionar con las del código? */
import 'dotenv/config';
import { SourceManager } from '../../src/services/sourceManager';
import { DEFAULT_SOURCES } from '../../src/config/sources';
(async () => {
  console.log('DEFAULT_SOURCES (código):');
  for (const s of DEFAULT_SOURCES) console.log(`   ${String(s.priority).padStart(2)}  ${s.id.padEnd(14)} enabled=${s.enabled}`);
  const vivas = await SourceManager.getSourcesAsync();
  console.log('\ngetSourcesAsync() (código + almacén):');
  for (const s of vivas) console.log(`   ${String(s.priority).padStart(2)}  ${s.id.padEnd(14)} enabled=${s.enabled}`);
  const faltan = DEFAULT_SOURCES.filter(d => !vivas.some(v => v.id === d.id));
  console.log(faltan.length ? `\n  ✗ FALTAN: ${faltan.map(f => f.id).join(', ')}` : '\n  ✓ ninguna fuente del código se pierde');
})();
