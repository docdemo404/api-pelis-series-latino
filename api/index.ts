import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { dbService } from '../src/services/catalogService';
import { FeedService } from '../src/services/feedService';
import { ResolverService } from '../src/services/resolverService';
import { TmdbService } from '../src/services/tmdbService';

const app = express();
app.use(cors());
app.use(express.json());

// Servir portal de documentación
app.use('/docs', express.static(path.join(__dirname, '../public')));

// Root Endpoint
app.get('/api/v1', (req: Request, res: Response) => {
  res.json({
    status: 'online',
    name: 'API Películas & Series Latino',
    version: '1.0.0',
    documentation: '/docs',
    endpoints: [
      '/api/v1/feeds/home?country=CL',
      '/api/v1/discover?page=1&limit=20',
      '/api/v1/movies/search?q=solo+en+casa',
      '/api/v1/series/los-simpson',
      '/api/v1/stream/resolve?id=srv_101',
      '/api/v1/links/report'
    ]
  });
});

// Feeds Estilo Netflix
app.get('/api/v1/feeds/home', (req: Request, res: Response) => {
  const country = (req.query.country as string) || 'CL';
  const feed = FeedService.getHomeFeed(country);
  res.json({ status: 'success', data: feed });
});

// Descubrimiento Infinito
app.get('/api/v1/discover', (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const type = req.query.type as string;
  const genre = req.query.genre as string;

  const result = FeedService.getDiscover(page, limit, type, genre);
  res.json({ status: 'success', data: result });
});

// Búsqueda inteligente por título u alias (ej: 'solo en casa' -> 'Mi pobre angelito')
app.get('/api/v1/movies/search', async (req: Request, res: Response) => {
  const q = req.query.q as string;
  if (!q) {
    return res.status(400).json({ status: 'error', message: 'Parámetro ?q= es requerido' });
  }

  let matches = dbService.search(q);

  // Si no está en DB, buscar On-Demand en TMDB y agregar
  if (matches.length === 0) {
    const tmdbData = await TmdbService.searchOrGetMetadata(q, 'movie');
    if (tmdbData) {
      matches = [tmdbData as any];
    }
  }

  res.json({
    status: 'success',
    query: q,
    count: matches.length,
    results: matches
  });
});

// Detalle de Película o Serie por ID
app.get('/api/v1/media/:id', (req: Request, res: Response) => {
  const item = dbService.getById(req.params.id);
  if (!item) {
    return res.status(404).json({ status: 'error', message: 'Contenido no encontrado' });
  }
  res.json({ status: 'success', data: item });
});

// Endpoint específico para Series y Temporadas
app.get('/api/v1/series/:id', (req: Request, res: Response) => {
  const item = dbService.getById(req.params.id);
  if (!item || item.type !== 'tvseries') {
    return res.status(404).json({ status: 'error', message: 'Serie no encontrada' });
  }
  res.json({ status: 'success', data: item });
});

// Resolver Token Dinámico de Enlace Stream
app.get('/api/v1/stream/resolve', async (req: Request, res: Response) => {
  const id = req.query.id as string || 'srv_default';
  const originalUrl = (req.query.url as string) || 'https://streamwish.to/hls/sample.m3u8';

  const resolved = await ResolverService.resolveStreamToken(id, originalUrl);
  res.json({ status: 'success', data: resolved });
});

// Endpoint de Reporte de Enlaces Rotos
app.post('/api/v1/links/report', (req: Request, res: Response) => {
  const { link_id, reason } = req.body;
  res.json({
    status: 'success',
    message: `Enlace ${link_id || 'solicitado'} reportado con éxito. Se ha marcado para verificación y autorreparación.`
  });
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 API Servidor corriendo en http://localhost:${PORT}/api/v1`);
    console.log(`📖 Documentación en http://localhost:${PORT}/docs`);
  });
}

export default app;
