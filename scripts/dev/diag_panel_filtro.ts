import 'dotenv/config';
import { CatalogService } from '../../src/services/catalogService';
(async () => {
  for (const fuente of ['', 'moviedays', 'archive', 'fuegocine']) {
    const r = await CatalogService.contenidoParaPanel({ fuente: fuente || undefined, porPagina: 5, pagina: 1 });
    console.log(`fuente="${fuente || '(todas)'}" -> total=${r.total} · pagina 1 trae ${r.filas.length}`);
    r.filas.slice(0, 3).forEach((f: any) => console.log('     ', f.id, '|', String(f.titulo).slice(0, 34), '|', (f.fuentes || []).join(',')));
  }
  // Y que la paginacion del filtro sea coherente: la pagina 2 no debe repetir la 1.
  const p1 = await CatalogService.contenidoParaPanel({ fuente: 'moviedays', porPagina: 5, pagina: 1 });
  const p2 = await CatalogService.contenidoParaPanel({ fuente: 'moviedays', porPagina: 5, pagina: 2 });
  const ids1 = new Set(p1.filas.map((f: any) => f.id));
  const repes = p2.filas.filter((f: any) => ids1.has(f.id));
  console.log(`\npagina 2: ${p2.filas.length} filas, ${repes.length} repetidas de la 1 (deben ser 0)`);
  process.exit(0);
})();
