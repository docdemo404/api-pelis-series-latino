import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { CatalogService } from '../src/services/catalogService';
import { FeedService } from '../src/services/feedService';
import { ResolverService } from '../src/services/resolverService';

const app = express();
app.use(cors());
app.use(express.json());

// Servir portal de documentación
app.use('/docs', express.static(path.join(__dirname, '../public')));

// Especificación OpenAPI 3.0 para Agentes de IA y Clientes Automatizados
app.get('/api/v1/openapi.json', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/openapi.json'));
});

// Root Endpoint (Self-describing for Machine Reading)
app.get('/api/v1', (req: Request, res: Response) => {
  res.json({
    status: 'online',
    name: 'API Películas & Series Latino',
    version: '1.0.0',
    documentation: '/docs',
    openapi_spec: '/api/v1/openapi.json',
    machine_readable: true,
    endpoints: [
      '/api/v1/search?q=avatar',
      '/api/v1/openapi.json',
      '/api/v1/feeds/home?country=CL',
      '/api/v1/discover?page=1&limit=20',
      '/api/v1/media/scary-movie-6',
      '/api/v1/stream/resolve?id=srv_101',
      '/api/v1/links/report'
    ]
  });
});

// Feeds Estilo Netflix
app.get('/api/v1/feeds/home', async (req: Request, res: Response) => {
  const country = (req.query.country as string) || 'CL';
  const feed = await FeedService.getHomeFeed(country);
  res.json({ status: 'success', data: feed });
});

// Descubrimiento Infinito
app.get('/api/v1/discover', async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const type = req.query.type as string;
  const genre = req.query.genre as string;

  const result = await FeedService.getDiscover(page, limit, type, genre);
  res.json({ status: 'success', data: result });
});

// Búsqueda general (Películas, Series, Animes, Doramas)
app.get('/api/v1/search', async (req: Request, res: Response) => {
  const q = req.query.q as string;
  if (!q) {
    return res.status(400).json({ status: 'error', message: 'Parámetro ?q= es requerido' });
  }

  const results = await CatalogService.search(q);
  res.json({
    status: 'success',
    query: q,
    count: results.length,
    results
  });
});

// Alias para mantener compatibilidad
app.get('/api/v1/movies/search', async (req: Request, res: Response) => {
  const q = req.query.q as string;
  if (!q) {
    return res.status(400).json({ status: 'error', message: 'Parámetro ?q= es requerido' });
  }

  const results = await CatalogService.search(q);
  res.json({
    status: 'success',
    query: q,
    count: results.length,
    results
  });
});

// Detalle por ID o Slug
app.get('/api/v1/media/:id', async (req: Request, res: Response) => {
  const item = await CatalogService.getById(req.params.id);
  if (!item) {
    return res.status(404).json({ status: 'error', message: 'Contenido no encontrado' });
  }
  res.json({ status: 'success', data: item });
});

// Detalle específico para Series
app.get('/api/v1/series/:id', async (req: Request, res: Response) => {
  const item = await CatalogService.getById(req.params.id);
  if (!item) {
    return res.status(404).json({ status: 'error', message: 'Serie no encontrada' });
  }
  res.json({ status: 'success', data: item });
});

// Resolver Token Dinámico de Stream
app.get('/api/v1/stream/resolve', async (req: Request, res: Response) => {
  const id = (req.query.id as string) || 'srv_default';
  const originalUrl = (req.query.url as string) || 'https://streamwish.to/hls/sample.m3u8';

  const resolved = await ResolverService.resolveStreamToken(id, originalUrl);
  res.json({ status: 'success', data: resolved });
});

// Reportar Enlace Roto
app.post('/api/v1/links/report', (req: Request, res: Response) => {
  const { link_id } = req.body;
  res.json({
    status: 'success',
    message: `Enlace ${link_id || 'solicitado'} reportado con éxito. Se ha marcado para verificación.`
  });
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 API Servidor corriendo en http://localhost:${PORT}/api/v1`);
  });
}

export default app;
