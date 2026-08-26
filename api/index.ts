import 'dotenv/config';
import { asegurarHostsConCache } from '../src/services/hostsConCache';
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
      //
      // La ventana de gracia era de UN DÍA. Es el mismo error que se corrigió en las fichas y por
      // el mismo motivo: un título que deja de poder reproducirse desaparece del origen al
      // instante y el borde lo seguía entregando hasta 24 h después. Buscarlo por su nombre era
      // justamente por donde volvía a aparecer lo que ya se había retirado.
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
      res.setHeader('CDN-Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
      res.setHeader('Vercel-CDN-Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    } else if (req.path.includes('/media/') || req.path.includes('/series/')) {
      /**
       * Fichas y episodios.
       *
       * La ventana de `stale-while-revalidate` era de UN DÍA, y se puso por una razón que ya no se
       * sostiene: pasada la ventana, el siguiente en pedir una ficha pagaba la reconstrucción
       * entera —3-7 s en un episodio, porque había que scrapear su página y sondear sus
       * servidores—. Desde que los capítulos se resuelven por adelantado y se guardan, esa
       * reconstrucción cuesta 0,33 s: leer la base de datos. El golpe que justificaba el día de
       * ventana ya no existe.
       *
       * Y el precio de esa ventana sí seguía ahí, escondido: el borde puede entregar una respuesta
       * de hasta 24 h aunque el origen ya devuelva la corregida. Un capítulo que se demostró
       * muerto y dejó de anunciarse seguía apareciendo un día entero — el usuario lo reportó con
       * Trollhunters, cuyo 1x1 ya no viajaba en la respuesta del origen y la app seguía viéndolo.
       * En un catálogo cuya regla es «lo que se entrega, funciona», servir un día de retraso es
       * exactamente incumplirla.
       *
       * 5 min frescos + 10 de gracia: la peor demora pasa de 24 h a un cuarto de hora, y el borde
       * sigue absorbiendo la inmensa mayoría de las peticiones. El caché propio (Redis) sí se
       * invalida al escribir; este no se puede purgar, así que la única palanca es la ventana.
       *
       * Y BAJA OTRA VEZ: DE UN CUARTO DE HORA A DOS MINUTOS.
       *
       * El cuarto de hora seguía siendo demasiado para el caso que de verdad se sufre, que no es
       * un título retirándose solo —eso puede esperar— sino **añadir algo a mano por el panel y
       * quedarse mirando la app sin ver el cambio**. Reportado tal cual con una serie de la fuente
       * propia: se añadieron sus capítulos, la app siguió enseñando la ficha vieja, y acabó
       * borrándose los datos de la app persiguiendo un fallo que no existía. Quince minutos sin
       * respuesta no se leen como caché, se leen como que algo está roto.
       *
       * Se puede bajar tanto por lo que ya dice el párrafo de arriba: al origen una ficha le
       * cuesta 0,33 s, que es leer la base. Lo que el borde absorbe aquí no es una
       * reconstrucción, es una consulta barata.
       *
       * 1 min fresco + 1 de gracia. Y `max-age=30` para el cliente, que es lo que decide cuánto
       * guarda la caché en disco de la app — la de Android sí honra esta cabecera, así que sin
       * bajarla también aquí, el aparato seguiría enseñando lo suyo aunque el borde ya no.
       */
      res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=60');
      res.setHeader('CDN-Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
      res.setHeader('Vercel-CDN-Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
    } else {
      /**
       * PORTADA Y CATÁLOGO — y aquí estaba lo peor de todo.
       *
       * Esta rama recoge `/home`, `/feeds/home`, `/discover`, `/movies` y `/series`: o sea las
       * TRES pantallas donde el usuario ve el catálogo. Y las servía el borde con un día de
       * frescura y SIETE de gracia.
       *
       * O sea que todo el trabajo de no anunciar lo que no se puede ver —el veredicto que escribe
       * la petición, el conjunto de retirados que descuentan los listados— se quedaba en el
       * origen, sin llegar a nadie: la app pedía la portada y recibía una copia de hasta una
       * semana. Se midió: el origen ya devolvía la lista corregida y la app seguía viendo los
       * mismos títulos muertos. No era el filtro, era que nadie lo estaba ejecutando.
       *
       * Bajar esto no cuesta lo que parece, y por eso se puede bajar tanto: la portada NO se
       * reconstruye en cada petición al origen. Tiene su propio caché en Redis con dos horas de
       * frescura y doce de vida, y sirve la copia guardada al instante mientras se rehace por
       * detrás (ver `FeedService.getHomeFeed`). Lo que el borde absorbía era una lectura de Redis,
       * no los ocho segundos y medio de reconstruirla.
       *
       * Mismos números que las fichas: 5 min frescos y 10 de gracia. La peor demora entre retirar
       * un título y dejar de enseñarlo pasa de una semana a un cuarto de hora.
       */
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
      res.setHeader('CDN-Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
      res.setHeader('Vercel-CDN-Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    }
  }
  next();
});

// Portal de documentación estático
/**
 * QUÉ DOMINIOS PASAN POR LA CACHÉ, LEÍDO ANTES DE ATENDER NADA.
 *
 * Va aquí y no dentro de una ruta porque el ajuste decide la URL que sale por VARIOS caminos —el
 * listado de servidores, el detalle y `/stream/direct`—, y ponerlo en uno solo produce justo el
 * fallo que costó encontrar: el panel enseñaba el dominio encendido, `/streams` seguía entregando
 * la url directa, y `/stream/direct` delegaba en el Worker por el camino de siempre. Tres
 * comportamientos distintos para un mismo interruptor.
 *
 * Cuesta UNA petición en el primer uso de cada proceso y cero en los siguientes: `asegurar…` sale
 * por la puerta en cuanto la lista ya está leída. Hace falta porque con poco tráfico Vercel arranca
 * un proceso nuevo casi por petición, y una lectura en segundo plano al cargar el módulo no llega
 * nunca a tiempo — medido.
 */
app.use(async (_req: Request, _res: Response, next: NextFunction) => {
  try {
    await asegurarHostsConCache();
  } catch {
    // Si no se puede leer, se sigue sin caché: es la opción que no cambia el comportamiento de
    // nadie. Un ajuste ilegible no puede encender algo que estaba apagado.
  }
  next();
});

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
