import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { CatalogService } from '../src/services/catalogService';
import { FeedService } from '../src/services/feedService';
import { ResolverService } from '../src/services/resolverService';
import { RealScraperService } from '../src/services/realScraperService';
import { SourceManager } from '../src/services/sourceManager';

const app = express();
app.use(cors());
app.use(express.json());

// Servir portal de documentación
app.use('/docs', express.static(path.join(__dirname, '../public')));

// Panel de Control Interactivo de Fuentes (/panel y /api/v1/panel)
app.get('/panel', (req: Request, res: Response) => {
  const sources = SourceManager.getSources();
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Panel de Gestión de Fuentes - API Películas & Series</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css">
  <style>
    body { background-color: #0f172a; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; }
    .card-panel { background-color: #1e293b; border: 1px solid #334155; border-radius: 12px; }
    .source-item { background: #090d16; border: 1px solid #334155; border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem; }
  </style>
</head>
<body>
  <div class="container my-5">
    <div class="row justify-content-center">
      <div class="col-lg-8">
        <div class="card card-panel p-4 shadow">
          <div class="d-flex justify-content-between align-items-center mb-4">
            <h2 class="text-warning fw-bold m-0">⚙️ Panel de Gestión de Fuentes</h2>
            <span class="badge bg-success fs-6">Catálogo Unificado Activo</span>
          </div>

          <p class="text-secondary mb-4">
            Gestiona en tiempo real las fuentes de scraping del catálogo. Puedes activar/desactivar proveedores y ajustar el orden de prioridad para determinar qué servidores aparecen primero en la API.
          </p>

          <form id="sourcesForm">
            <div id="sourcesList">
              ${sources.map((s, idx) => `
                <div class="source-item d-flex align-items-center justify-content-between" data-id="${s.id}">
                  <div class="d-flex align-items-center gap-3">
                    <span class="badge bg-secondary fs-6">#${idx + 1}</span>
                    <div class="form-check form-switch m-0 fs-5">
                      <input class="form-check-input source-switch" type="checkbox" id="switch_${s.id}" ${s.enabled ? 'checked' : ''}>
                      <label class="form-check-input-label text-white fw-bold ms-2" for="switch_${s.id}">${s.name}</label>
                    </div>
                  </div>
                  <div class="btn-group">
                    <button type="button" class="btn btn-sm btn-outline-secondary text-white btn-up" ${idx === 0 ? 'disabled' : ''}>▲ Subir</button>
                    <button type="button" class="btn btn-sm btn-outline-secondary text-white btn-down" ${idx === sources.length - 1 ? 'disabled' : ''}>▼ Bajar</button>
                  </div>
                </div>
              `).join('')}
            </div>

            <div class="d-flex justify-content-between align-items-center mt-4">
              <a href="/api/v1" class="btn btn-outline-info">🔍 Probar API /api/v1</a>
              <button type="button" id="saveBtn" class="btn btn-warning fw-bold px-4">💾 Guardar Cambios</button>
            </div>
          </form>

          <div id="alertBox" class="mt-3"></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const form = document.getElementById('sourcesForm');
    const list = document.getElementById('sourcesList');
    const saveBtn = document.getElementById('saveBtn');
    const alertBox = document.getElementById('alertBox');

    function updateButtons() {
      const items = Array.from(list.children);
      items.forEach((item, idx) => {
        item.querySelector('.badge').textContent = '#' + (idx + 1);
        item.querySelector('.btn-up').disabled = idx === 0;
        item.querySelector('.btn-down').disabled = idx === items.length - 1;
      });
    }

    list.addEventListener('click', (e) => {
      const btnUp = e.target.closest('.btn-up');
      const btnDown = e.target.closest('.btn-down');
      if (btnUp) {
        const item = btnUp.closest('.source-item');
        if (item.previousElementSibling) {
          list.insertBefore(item, item.previousElementSibling);
          updateButtons();
        }
      }
      if (btnDown) {
        const item = btnDown.closest('.source-item');
        if (item.nextElementSibling) {
          list.insertBefore(item.nextElementSibling, item);
          updateButtons();
        }
      }
    });

    saveBtn.addEventListener('click', async () => {
      const items = Array.from(list.children);
      const sourcesData = items.map((item, idx) => {
        const id = item.getAttribute('data-id');
        const enabled = item.querySelector('.source-switch').checked;
        return { id, enabled, priority: idx + 1 };
      });

      try {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Guardando...';
        const res = await fetch('/api/v1/panel/sources', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sources: sourcesData })
        });
        const json = await res.json();
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Guardar Cambios';

        if (json.status === 'success') {
          alertBox.innerHTML = '<div class="alert alert-success">✅ Fuentes y prioridades actualizadas con éxito.</div>';
        } else {
          alertBox.innerHTML = '<div class="alert alert-danger">❌ Error actualizando fuentes.</div>';
        }
      } catch (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Guardar Cambios';
        alertBox.innerHTML = '<div class="alert alert-danger">❌ Error de conexión.</div>';
      }
    });
  </script>
</body>
</html>`);
});

// Endpoint API para obtener estado del Panel y fuentes
app.get('/api/v1/panel', (req: Request, res: Response) => {
  res.json({
    status: 'success',
    sources: SourceManager.getSources()
  });
});

// Endpoint API para actualizar fuentes y su orden de prioridad
app.post('/api/v1/panel/sources', (req: Request, res: Response) => {
  const { sources } = req.body;
  if (!Array.isArray(sources)) {
    return res.status(400).json({ status: 'error', message: 'Se requiere un arreglo "sources"' });
  }

  const updated = SourceManager.updateSources(sources);
  res.json({
    status: 'success',
    message: 'Fuentes de catálogo y orden de prioridad actualizados con éxito',
    sources: updated
  });
});

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
    control_panel: '/panel',
    openapi_spec: '/api/v1/openapi.json',
    machine_readable: true,
    active_sources: SourceManager.getSources(),
    endpoints: [
      '/api/v1/search?q=spiderman',
      '/api/v1/panel',
      '/api/v1/openapi.json',
      '/api/v1/feeds/home?country=CL',
      '/api/v1/media/scary-movie-6',
      '/api/v1/series/naruto/season/1/episode/1',
      '/api/v1/stream/resolve?id=srv_101'
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

// Detalle de Episodio específico (Servidores de reproducción del episodio)
app.get('/api/v1/series/:id/season/:season/episode/:episode', async (req: Request, res: Response) => {
  const { id, season, episode } = req.params;
  const epDetail = await RealScraperService.scrapeEpisodeDetail(id, parseInt(season), parseInt(episode));
  if (!epDetail) {
    return res.status(404).json({ status: 'error', message: 'Episodio no encontrado' });
  }
  res.json({ status: 'success', data: epDetail });
});

// Detalle específico para Series
app.get('/api/v1/series/:id', async (req: Request, res: Response) => {
  const { season, episode } = req.query;
  if (season && episode) {
    const epDetail = await RealScraperService.scrapeEpisodeDetail(req.params.id, parseInt(season as string), parseInt(episode as string));
    if (epDetail) return res.json({ status: 'success', data: epDetail });
  }
  const item = await CatalogService.getById(req.params.id);
  if (!item) {
    return res.status(404).json({ status: 'error', message: 'Serie no encontrada' });
  }
  res.json({ status: 'success', data: item });
});

// Detalle por ID o Slug (Películas o Series con soporte de ?season=1&episode=1)
app.get('/api/v1/media/:id', async (req: Request, res: Response) => {
  const { season, episode } = req.query;
  if (season && episode) {
    const epDetail = await RealScraperService.scrapeEpisodeDetail(req.params.id, parseInt(season as string), parseInt(episode as string));
    if (epDetail) return res.json({ status: 'success', data: epDetail });
  }
  const item = await CatalogService.getById(req.params.id);
  if (!item) {
    return res.status(404).json({ status: 'error', message: 'Contenido no encontrado' });
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
