import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import panelRoutes from '../src/routes/panel.routes';
import catalogRoutes from '../src/routes/catalog.routes';
import searchRoutes from '../src/routes/search.routes';
import mediaRoutes from '../src/routes/media.routes';
import streamRoutes from '../src/routes/stream.routes';
import { sendErrorResponse } from '../src/utils/apiHelpers';

/**
 * Bootstrap de la API: middlewares globales, estáticos y montaje de routers.
 * Las rutas viven en src/routes/* (panel, catálogo, búsqueda, detalle, streaming).
 */
const app = express();
app.use(cors());
app.use(express.json());

// Cabeceras HTTP de Caché en Borde (Edge CDN & Stale-While-Revalidate)
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/v1')) {
    if (req.path.includes('/panel') || req.path.includes('/stream/resolve') || req.path.includes('/revalidate') || req.path.includes('/cache')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    } else if (req.path.includes('/search')) {
      // Búsqueda: cacheable en borde (Vercel/Cloudflare) por variante de ?q=&page=&limit=.
      // TTL medio + stale-while-revalidate: respuestas instantáneas y refresco en segundo
      // plano, para que los títulos recién crawleados aparezcan pronto.
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=600, stale-while-revalidate=86400');
      res.setHeader('CDN-Cache-Control', 'public, max-age=600, stale-while-revalidate=86400');
      res.setHeader('Vercel-CDN-Cache-Control', 'public, max-age=600, stale-while-revalidate=86400');
    } else if (req.path.includes('/media/') || req.path.includes('/series/')) {
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600');
      res.setHeader('CDN-Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
      res.setHeader('Vercel-CDN-Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
      res.setHeader('CDN-Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      res.setHeader('Vercel-CDN-Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    }
  }
  next();
});

// Portal de documentación estático
app.use('/docs', express.static(path.join(__dirname, '../public')));

// Especificación OpenAPI 3.0 para Agentes de IA y Clientes Automatizados
app.get('/api/v1/openapi.json', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/openapi.json'));
});

// Routers por dominio. El ORDEN importa:
// catalogRoutes registra /api/v1/media/batch ANTES de que mediaRoutes registre /api/v1/media/:id.
app.use(panelRoutes);
app.use(catalogRoutes);
app.use(searchRoutes);
app.use(mediaRoutes);
app.use(streamRoutes);

// Manejador global de errores inesperados (Zero 500 HTML Pages)
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Global API Exception]:', err);
  sendErrorResponse(res, 500, 'INTERNAL_SERVER_ERROR', 'Ocurrió un error inesperado al procesar la solicitud.');
});

// Manejador global 404 para la API
app.use('/api/v1/*', (_req: Request, res: Response) => {
  sendErrorResponse(res, 404, 'RESOURCE_NOT_FOUND', 'El endpoint o contenido solicitado no existe.');
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 API Servidor corriendo en http://localhost:${PORT}/api/v1`);
  });
}

export default app;
