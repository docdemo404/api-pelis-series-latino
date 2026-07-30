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
import { publicOrigin, withAbsoluteDirectStreams } from '../src/utils/publicUrl';

/**
 * Bootstrap de la API: middlewares globales, estáticos y montaje de routers.
 * Las rutas viven en src/routes/* (panel, catálogo, búsqueda, detalle, streaming).
 */
const app = express();
// `exposedHeaders` no es opcional para el vídeo: sin ellas un reproductor web servido desde
// otro origen no puede LEER el Content-Range que devuelve el proxy, y el salto por la barra de
// tiempo se degrada aunque el servidor esté respondiendo 206 correctamente.
app.use(cors({ exposedHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges'] }));

// El parseo de JSON se salta el camino de vídeo. Esas rutas son GET sin cuerpo y se piden cientos
// de veces por película: no tiene sentido montarles un parser de body a cada segmento.
const parseJson = express.json();
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.includes('/stream/direct')) return next();
  return parseJson(req, res, next);
});

// `direct_stream` se guarda relativo (portable entre despliegues) pero se ENTREGA absoluto: un
// reproductor resuelve una ruta relativa contra su propio dominio, no contra el de esta API, y
// entonces no reproduce nada. Se hace aquí, envolviendo `res.json`, porque los servidores salen
// por muchas puertas —listados, detalle, `primary_stream`, y los de cada episodio dentro de
// `seasons`— y no hay un serializador común donde ponerlo una sola vez. Ver src/utils/publicUrl.ts.
//
// El camino de vídeo se salta el envoltorio por el mismo motivo que se salta el parser de JSON:
// son cientos de peticiones por película y ahí no viaja ninguna ficha que reescribir.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.includes('/stream/direct')) return next();
  const origin = publicOrigin(req);
  if (!origin) return next();

  const json = res.json.bind(res);
  res.json = (body: any) => json(withAbsoluteDirectStreams(body, origin));
  next();
});

// Cabeceras HTTP de Caché en Borde (Edge CDN & Stale-While-Revalidate)
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/v1')) {
    // Los SEGMENTOS sí se cachean, y es la diferencia entre volver al CDN una vez o una por
    // espectador: la respuesta está determinada por la URL firmada que viaja en `?u=`, que es
    // la misma para todo el que vea lo mismo mientras dure el acuñado (compartido vía KV). El
    // propio endpoint rebaja esto a `no-store` cuando la petición trae Range, porque una
    // respuesta parcial cacheada serviría los bytes equivocados a quien pida otro tramo.
    //
    // El TTL tiene que ser EL MISMO que `SEGMENT_CACHE` en stream.routes.ts: en el borde de
    // Vercel estas dos cabeceras mandan sobre `Cache-Control`, así que subirlo solo allí no
    // habría cambiado nada. Una semana, porque la clave identifica el contenido y una firma
    // caducada simplemente genera otra clave.
    if (req.path.includes('/stream/direct/seg')) {
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=604800, stale-while-revalidate=86400');
      res.setHeader('CDN-Cache-Control', 'public, max-age=604800');
      res.setHeader('Vercel-CDN-Cache-Control', 'public, max-age=604800');
    // `/stream/direct` NO puede cachearse en el borde: acuña una URL nueva en cada reproducción
    // y, según el host, responde con un 302 distinto cada vez.
    } else if (req.path.includes('/panel') || req.path.includes('/stream/resolve') || req.path.includes('/stream/direct') || req.path.includes('/revalidate') || req.path.includes('/cache')) {
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
      /**
       * Fichas y episodios: lo que más se pide y lo más caro de reconstruir.
       *
       * La ventana de `stale-while-revalidate` era de 1 h, y ahí estaba el coste escondido: pasada
       * esa hora sin que nadie pidiera una ficha, su entrada desaparece del borde y el siguiente
       * paga la reconstrucción entera — 3-7 s en un episodio, porque hay que scrapear su página y
       * sondear sus servidores. Con un día de ventana, ese golpe deja de tocarle a un usuario.
       *
       * `stale-while-revalidate` no sirve nada viejo a nadie a cambio de nada: entrega al instante
       * lo que tiene y refresca por detrás, así que el que llega tarde recibe rápido y el siguiente
       * ya tiene lo nuevo. Los 15 min de `s-maxage` son el margen en el que una reparación tarda en
       * verse en el borde (el caché propio sí se purga al reparar, el de Vercel no se puede).
       */
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=900, stale-while-revalidate=86400');
      res.setHeader('CDN-Cache-Control', 'public, max-age=900, stale-while-revalidate=86400');
      res.setHeader('Vercel-CDN-Cache-Control', 'public, max-age=900, stale-while-revalidate=86400');
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
