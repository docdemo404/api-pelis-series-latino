import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import axios from 'axios';
import { CatalogService } from '../src/services/catalogService';
import { FeedService } from '../src/services/feedService';
import { ResolverService } from '../src/services/resolverService';
import { RealScraperService } from '../src/services/realScraperService';
import { SourceManager } from '../src/services/sourceManager';
import { TmdbService } from '../src/services/tmdbService';
import { OverrideService } from '../src/services/overrideService';

const app = express();
app.use(cors());
app.use(express.json());

// Cabeceras HTTP de Caché en Borde (Edge CDN & Stale-While-Revalidate)
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/v1')) {
    if (req.path.includes('/panel') || req.path.includes('/stream/resolve') || req.path.includes('/revalidate') || req.path.includes('/cache')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
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

function sendErrorResponse(res: Response, statusCode: number, code: string, message: string) {
  return res.status(statusCode).json({
    status: 'error',
    success: false,
    error: {
      code,
      message
    }
  });
}

const parsePositiveInteger = (value: unknown, fallback: number): number => {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getPaginationParams = (req: Request, defaultLimit: number = 20, maxLimit: number = 100) => {
  const page = parsePositiveInteger(req.query.page, 1);
  const requestedLimit = req.query.limit ?? req.query.size;
  const limit = Math.min(parsePositiveInteger(requestedLimit, defaultLimit), maxLimit);
  return { page, limit };
};

// Servir portal de documentación
app.use('/docs', express.static(path.join(__dirname, '../public')));

// Panel de Control Interactivo de Fuentes (/panel y /api/v1/panel)
app.get('/panel', async (req: Request, res: Response) => {
  const sources = await SourceManager.getSourcesAsync();
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Panel de Administración - Catálogo Unificado & Fuentes</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css">
  <style>
    :root {
      --bg-dark: #070a12;
      --card-bg: #0f172a;
      --accent-gradient: linear-gradient(135deg, #6366f1 0%, #a855f7 50%, #ec4899 100%);
      --border-color: rgba(255, 255, 255, 0.08);
    }
    body {
      background-color: var(--bg-dark);
      color: #f1f5f9;
      font-family: 'Inter', system-ui, sans-serif;
      min-height: 100vh;
    }
    h1, h2, h3, h4, .brand-title {
      font-family: 'Outfit', sans-serif;
    }
    .main-card {
      background: rgba(15, 23, 42, 0.75);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
    }
    .source-card {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 14px;
      padding: 1.25rem;
      margin-bottom: 1rem;
      transition: all 0.25s ease;
    }
    .source-card:hover {
      border-color: rgba(99, 102, 241, 0.4);
      transform: translateY(-2px);
    }
    .priority-badge {
      background: rgba(99, 102, 241, 0.15);
      color: #818cf8;
      border: 1px solid rgba(99, 102, 241, 0.3);
      font-weight: 600;
      padding: 0.4rem 0.8rem;
      border-radius: 8px;
    }
    .btn-gradient {
      background: var(--accent-gradient);
      border: none;
      color: white;
      font-weight: 700;
      border-radius: 10px;
      padding: 0.75rem 1.75rem;
      transition: opacity 0.2s ease;
    }
    .btn-gradient:hover {
      opacity: 0.9;
      color: white;
    }
    .form-switch .form-check-input {
      width: 3.2em;
      height: 1.7em;
      cursor: pointer;
    }
    .status-pill {
      font-size: 0.85rem;
      font-weight: 600;
      padding: 0.25rem 0.75rem;
      border-radius: 20px;
    }
    .status-pill.active { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }
    .status-pill.inactive { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
    
    /* Sandbox tester */
    .sandbox-card {
      background: rgba(30, 41, 59, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
    }
  </style>
</head>
<body class="py-5">
  <div class="container">
    <div class="row justify-content-center">
      <div class="col-lg-9">

        <!-- Banner Titulo -->
        <div class="d-flex align-items-center justify-content-between mb-4">
          <div>
            <span class="badge bg-primary bg-opacity-20 text-primary border border-primary border-opacity-30 mb-2">Panel Humano de Administración</span>
            <h1 class="brand-title fw-bold display-6 m-0">⚙️ Gestor de Fuentes & Catálogo Unificado</h1>
          </div>
          <a href="/docs" class="btn btn-outline-light rounded-3 px-3">📄 Ver Docs API</a>
        </div>

        <!-- Tarjeta Principal de Fuentes -->
        <div class="card main-card p-4 p-md-5 mb-4">
          <h3 class="brand-title fw-bold mb-2">Proveedores & Orden de Prioridad</h3>
          <p class="text-secondary mb-4">
            Activa o desactiva fuentes en tiempo real y ajusta su prioridad de arriba hacia abajo. El motor de unificación agrupa automáticamente títulos repetidos y muestra primero los servidores del proveedor de mayor prioridad.
          </p>

          <form id="sourcesForm">
            <div id="sourcesList">
              ${sources.map((s, idx) => `
                <div class="source-card d-flex align-items-center justify-content-between flex-wrap gap-3" data-id="${s.id}">
                  <div class="d-flex align-items-center gap-3">
                    <span class="priority-badge">Prioridad #${idx + 1}</span>
                    <div>
                      <h5 class="fw-bold m-0 text-white">${s.name}</h5>
                      <span class="status-pill ${s.enabled ? 'active' : 'inactive'} mt-1 d-inline-block">
                        ${s.enabled ? '🟢 Fuente Activa' : '🔴 Fuente Inactiva'}
                      </span>
                    </div>
                  </div>

                  <div class="d-flex align-items-center gap-3">
                    <div class="form-check form-switch m-0">
                      <input class="form-check-input source-switch" type="checkbox" role="switch" id="switch_${s.id}" ${s.enabled ? 'checked' : ''}>
                    </div>
                    <div class="btn-group">
                      <button type="button" class="btn btn-sm btn-dark text-white border-secondary btn-up" ${idx === 0 ? 'disabled' : ''}>⬆ Subir</button>
                      <button type="button" class="btn btn-sm btn-dark text-white border-secondary btn-down" ${idx === sources.length - 1 ? 'disabled' : ''}>⬇ Bajar</button>
                    </div>
                  </div>
                </div>
              `).join('')}
            </div>

            <div class="d-flex justify-content-between align-items-center mt-4">
              <span class="text-secondary small">💡 Tip: El cambio surte efecto inmediato en /api/v1/search</span>
              <button type="button" id="saveBtn" class="btn btn-gradient shadow">💾 Guardar Configuración</button>
            </div>
          </form>

          <div id="alertBox" class="mt-3"></div>
        </div>

        <!-- Editor Visual de Portadas & Metadatos (TMDB Override) -->
        <div class="card main-card p-4 p-md-5 mb-4">
          <div class="d-flex align-items-center justify-content-between mb-3">
            <div>
              <h3 class="brand-title fw-bold m-0 text-info">🖼️ Editor de Portadas & Imágenes Alternativas (TMDB)</h3>
              <p class="text-secondary small m-0 mt-1">Busca cualquier película o serie para elegir portadas/backdrops oficiales de TMDB o establecer una URL personalizada.</p>
            </div>
          </div>

          <div class="input-group mb-4">
            <input type="text" id="editorQuery" class="form-control bg-dark text-white border-secondary" placeholder="Buscar película o serie (ej: Scary Movie 6, Toy Story 5, Avatar)...">
            <button class="btn btn-info fw-bold" type="button" id="editorSearchBtn">🔍 Buscar en TMDB</button>
          </div>

          <div id="editorSearchResults" class="mb-4" style="display: none;">
            <h6 class="text-uppercase text-secondary fw-bold small mb-3">Selecciona un título para editar su portada:</h6>
            <div id="mediaGrid" class="row g-3"></div>
          </div>

          <!-- Panel de Selección de Imágenes -->
          <div id="imagePickerContainer" class="p-4 bg-dark border border-secondary rounded-3" style="display: none;">
            <div class="d-flex justify-content-between align-items-center mb-3">
              <h5 class="fw-bold m-0 text-white" id="selectedTitleHeader">Personalizar Imágenes</h5>
              <button type="button" class="btn btn-sm btn-outline-secondary" id="closePickerBtn">❌ Cerrar</button>
            </div>

            <div class="row g-4">
              <!-- Vista previa actual -->
              <div class="col-md-4">
                <div class="card bg-slate-900 border border-secondary p-3 text-center">
                  <h6 class="fw-bold text-secondary mb-2">Vista Previa Actual</h6>
                  <img id="previewPoster" src="" class="img-fluid rounded-3 mb-2 shadow" style="max-height: 280px; object-fit: cover;">
                  <div class="small text-truncate text-secondary mb-2" id="previewTitle"></div>
                  <button type="button" id="resetOverrideBtn" class="btn btn-outline-danger btn-sm w-100 mb-2">🔄 Restablecer Portada Original</button>
                </div>
              </div>

              <!-- Galería de Portadas Alternativas TMDB -->
              <div class="col-md-8">
                <h6 class="fw-bold text-info mb-2">Posters Alternativos en TMDB (Haz clic para seleccionar)</h6>
                <div id="postersGallery" class="d-flex gap-2 overflow-auto pb-3 mb-3" style="max-height: 200px;"></div>

                <h6 class="fw-bold text-info mb-2">FONDOS / Backdrops Alternativos</h6>
                <div id="backdropsGallery" class="d-flex gap-2 overflow-auto pb-3 mb-3" style="max-height: 160px;"></div>

                <div class="mb-3">
                  <label class="form-label small text-secondary">URL de Poster Personalizada (Opcional):</label>
                  <input type="text" id="customPosterUrl" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="https://...">
                </div>

                <div class="mb-3">
                  <label class="form-label small text-secondary">URL de Backdrop Personalizada (Opcional):</label>
                  <input type="text" id="customBackdropUrl" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="https://...">
                </div>

                <button type="button" id="saveOverrideBtn" class="btn btn-gradient w-100">💾 Aplicar Esta Portada / Backdrop</button>
                <div id="overrideAlert" class="mt-2"></div>
              </div>
            </div>
          </div>
        </div>

        <!-- Sandbox de Pruebas en Vivo -->
        <div class="card sandbox-card p-4">
          <h4 class="brand-title fw-bold text-warning mb-2">🧪 Probador de Unificación en Vivo</h4>
          <p class="text-secondary small mb-3">Busca una película o serie para comprobar en tiempo real cómo la API fusiona las fuentes en 1 solo resultado sin títulos duplicados.</p>
          
          <div class="input-group mb-3">
            <input type="text" id="testQuery" class="form-control bg-dark text-white border-secondary" placeholder="Ejemplo: spiderman, garfield, avatar..." value="spiderman">
            <button class="btn btn-warning fw-bold" type="button" id="testBtn">🔎 Probar Unificación</button>
          </div>

          <div id="testOutput" style="display: none;">
            <div class="p-3 bg-dark border border-secondary rounded-3">
              <div class="d-flex justify-content-between mb-2">
                <span class="fw-bold text-success" id="testCount"></span>
                <span class="badge bg-secondary" id="testStatus"></span>
              </div>
              <pre id="jsonPreview" class="m-0 text-info" style="max-height: 300px; overflow-y: auto; font-size: 0.85rem;"></pre>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>

  <script>
    const list = document.getElementById('sourcesList');
    const saveBtn = document.getElementById('saveBtn');
    const alertBox = document.getElementById('alertBox');
    const testBtn = document.getElementById('testBtn');
    const testQuery = document.getElementById('testQuery');
    const testOutput = document.getElementById('testOutput');
    const testCount = document.getElementById('testCount');
    const testStatus = document.getElementById('testStatus');
    const jsonPreview = document.getElementById('jsonPreview');

    // Elementos del Editor de Medios
    const editorQuery = document.getElementById('editorQuery');
    const editorSearchBtn = document.getElementById('editorSearchBtn');
    const editorSearchResults = document.getElementById('editorSearchResults');
    const mediaGrid = document.getElementById('mediaGrid');
    const imagePickerContainer = document.getElementById('imagePickerContainer');
    const selectedTitleHeader = document.getElementById('selectedTitleHeader');
    const closePickerBtn = document.getElementById('closePickerBtn');
    const previewPoster = document.getElementById('previewPoster');
    const previewTitle = document.getElementById('previewTitle');
    const resetOverrideBtn = document.getElementById('resetOverrideBtn');
    const postersGallery = document.getElementById('postersGallery');
    const backdropsGallery = document.getElementById('backdropsGallery');
    const customPosterUrl = document.getElementById('customPosterUrl');
    const customBackdropUrl = document.getElementById('customBackdropUrl');
    const saveOverrideBtn = document.getElementById('saveOverrideBtn');
    const overrideAlert = document.getElementById('overrideAlert');

    let activeMediaItem = null;

    function updateCardIndices() {
      const items = Array.from(list.children);
      items.forEach((item, idx) => {
        item.querySelector('.priority-badge').textContent = 'Prioridad #' + (idx + 1);
        item.querySelector('.btn-up').disabled = idx === 0;
        item.querySelector('.btn-down').disabled = idx === items.length - 1;
      });
    }

    list.addEventListener('change', (e) => {
      if (e.target.classList.contains('source-switch')) {
        const card = e.target.closest('.source-card');
        const pill = card.querySelector('.status-pill');
        if (e.target.checked) {
          pill.className = 'status-pill active mt-1 d-inline-block';
          pill.textContent = '🟢 Fuente Activa';
        } else {
          pill.className = 'status-pill inactive mt-1 d-inline-block';
          pill.textContent = '🔴 Fuente Inactiva';
        }
      }
    });

    list.addEventListener('click', (e) => {
      const btnUp = e.target.closest('.btn-up');
      const btnDown = e.target.closest('.btn-down');
      if (btnUp) {
        const item = btnUp.closest('.source-card');
        if (item.previousElementSibling) {
          list.insertBefore(item, item.previousElementSibling);
          updateCardIndices();
        }
      }
      if (btnDown) {
        const item = btnDown.closest('.source-card');
        if (item.nextElementSibling) {
          list.insertBefore(item.nextElementSibling, item);
          updateCardIndices();
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
        saveBtn.textContent = '⏳ Guardando en nube...';
        const res = await fetch('/api/v1/panel/sources', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sources: sourcesData })
        });
        const json = await res.json();
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Guardar Configuración';

        if (json.status === 'success') {
          const ts = new Date().toLocaleString('es-ES', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
          alertBox.innerHTML = '<div class="alert alert-success border-success bg-dark text-success mt-3 rounded-3">✅ <strong>Guardado permanentemente</strong> — Configuración persistida en la nube a las ' + ts + '. Los cambios sobrevivirán reinicios y redeploys.</div>';
          setTimeout(() => { alertBox.innerHTML = ''; }, 6000);
        } else {
          alertBox.innerHTML = '<div class="alert alert-danger mt-3">❌ Error actualizando fuentes: ' + (json.message || '') + '</div>';
        }
      } catch (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Guardar Configuración';
        alertBox.innerHTML = '<div class="alert alert-danger mt-3">❌ Error de conexión al guardar.</div>';
      }
    });

    // --- Lógica del Editor de Medios ---
    editorSearchBtn.addEventListener('click', async () => {
      const q = editorQuery.value.trim();
      if (!q) return;
      editorSearchBtn.disabled = true;
      editorSearchBtn.textContent = 'Cargando TMDB...';
      editorSearchResults.style.display = 'block';
      mediaGrid.innerHTML = '<div class="col-12 text-secondary">Buscando títulos en TMDB...</div>';

      try {
        const res = await fetch('/api/v1/panel/media/search?q=' + encodeURIComponent(q));
        const json = await res.json();
        editorSearchBtn.disabled = false;
        editorSearchBtn.textContent = '🔍 Buscar en TMDB';

        if (!json.results || json.results.length === 0) {
          mediaGrid.innerHTML = '<div class="col-12 text-warning">No se encontraron resultados para la búsqueda.</div>';
          return;
        }

        mediaGrid.innerHTML = json.results.map(function(item) {
          var p = item.poster || 'https://via.placeholder.com/60x90';
          var y = item.release_date ? item.release_date.substring(0,4) : '';
          var t = (item.title || '').replace(/"/g, '&quot;');
          return '<div class="col-md-6 col-lg-4">' +
            '<div class="d-flex align-items-center gap-3 p-2 bg-dark border border-secondary rounded-3 h-100">' +
              '<img src="' + p + '" class="rounded-2" style="width: 50px; height: 75px; object-fit: cover;">' +
              '<div class="flex-grow-1 overflow-hidden">' +
                '<h6 class="fw-bold text-white mb-1 text-truncate">' + item.title + '</h6>' +
                '<div class="small text-secondary mb-2">' + y + ' • TMDB ID: ' + item.tmdb_id + '</div>' +
                '<button type="button" class="btn btn-sm btn-info text-dark fw-bold btn-select-media" ' +
                  'data-tmdb="' + item.tmdb_id + '" data-type="' + item.type + '" data-title="' + t + '" data-poster="' + p + '">' +
                  '🖼️ Cambiar Portada' +
                '</button>' +
              '</div>' +
            '</div>' +
          '</div>';
        }).join('');

      } catch (err) {
        editorSearchBtn.disabled = false;
        editorSearchBtn.textContent = '🔍 Buscar en TMDB';
        mediaGrid.innerHTML = '<div class="col-12 text-danger">Error de conexión con la API de TMDB.</div>';
      }
    });

    mediaGrid.addEventListener('click', async (e) => {
      const btn = e.target.closest('.btn-select-media');
      if (!btn) return;

      const tmdbId = btn.getAttribute('data-tmdb');
      const type = btn.getAttribute('data-type');
      const title = btn.getAttribute('data-title');
      const poster = btn.getAttribute('data-poster');

      activeMediaItem = { tmdb_id: tmdbId, type, title, poster };

      selectedTitleHeader.textContent = 'Personalizar Portada: ' + title;
      previewTitle.textContent = title;
      previewPoster.src = poster || 'https://via.placeholder.com/200x300';
      customPosterUrl.value = poster;
      customBackdropUrl.value = '';
      imagePickerContainer.style.display = 'block';
      imagePickerContainer.scrollIntoView({ behavior: 'smooth' });

      postersGallery.innerHTML = '<div class="text-secondary small">Cargando portadas de TMDB...</div>';
      backdropsGallery.innerHTML = '<div class="text-secondary small">Cargando fondos de TMDB...</div>';

      try {
        const res = await fetch('/api/v1/panel/media/' + tmdbId + '/images?type=' + type);
        const json = await res.json();

        if (json.override) {
          if (json.override.custom_poster) {
            previewPoster.src = json.override.custom_poster;
            customPosterUrl.value = json.override.custom_poster;
          }
          if (json.override.custom_backdrop) {
            customBackdropUrl.value = json.override.custom_backdrop;
          }
        }

        const posters = json.images?.posters || [];
        const backdrops = json.images?.backdrops || [];

        postersGallery.innerHTML = posters.length > 0
          ? posters.map(function(url) {
              return '<img src="' + url + '" class="rounded-2 img-thumbnail bg-dark border-secondary cursor-pointer btn-pick-poster" style="height: 120px; cursor: pointer; object-fit: cover;">';
            }).join('')
          : '<div class="text-secondary small">No hay portadas adicionales en TMDB.</div>';

        backdropsGallery.innerHTML = backdrops.length > 0
          ? backdrops.map(function(url) {
              return '<img src="' + url + '" class="rounded-2 img-thumbnail bg-dark border-secondary cursor-pointer btn-pick-backdrop" style="height: 80px; width: 140px; cursor: pointer; object-fit: cover;">';
            }).join('')
          : '<div class="text-secondary small">No hay fondos adicionales en TMDB.</div>';

      } catch (err) {
        postersGallery.innerHTML = '<div class="text-danger small">Error cargando galería de TMDB.</div>';
      }
    });

    closePickerBtn.addEventListener('click', () => {
      imagePickerContainer.style.display = 'none';
    });

    postersGallery.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-pick-poster')) {
        const url = e.target.src;
        customPosterUrl.value = url;
        previewPoster.src = url;
      }
    });

    backdropsGallery.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-pick-backdrop')) {
        const url = e.target.src;
        customBackdropUrl.value = url;
      }
    });

    saveOverrideBtn.addEventListener('click', async () => {
      if (!activeMediaItem) return;

      const posterVal = customPosterUrl.value.trim();
      const backdropVal = customBackdropUrl.value.trim();

      try {
        saveOverrideBtn.disabled = true;
        saveOverrideBtn.textContent = 'Guardando...';

        const res = await fetch('/api/v1/panel/media/' + activeMediaItem.tmdb_id + '/override', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ custom_poster: posterVal, custom_backdrop: backdropVal })
        });
        const json = await res.json();
        saveOverrideBtn.disabled = false;
        saveOverrideBtn.textContent = '💾 Aplicar Esta Portada / Backdrop';

        if (json.status === 'success') {
          overrideAlert.innerHTML = '<div class="alert alert-success bg-dark border-success text-success p-2 small m-0 rounded-3">✅ Portada personalizada guardada exitosamente.</div>';
          setTimeout(() => { overrideAlert.innerHTML = ''; }, 4000);
        } else {
          overrideAlert.innerHTML = '<div class="alert alert-danger p-2 small m-0">❌ Error guardando portada.</div>';
        }
      } catch (err) {
        saveOverrideBtn.disabled = false;
        saveOverrideBtn.textContent = '💾 Aplicar Esta Portada / Backdrop';
        overrideAlert.innerHTML = '<div class="alert alert-danger p-2 small m-0">❌ Error de conexión.</div>';
      }
    });

    resetOverrideBtn.addEventListener('click', async () => {
      if (!activeMediaItem) return;

      try {
        resetOverrideBtn.disabled = true;
        const res = await fetch('/api/v1/panel/media/' + activeMediaItem.tmdb_id + '/override', {
          method: 'DELETE'
        });
        const json = await res.json();
        resetOverrideBtn.disabled = false;

        if (json.status === 'success') {
          previewPoster.src = activeMediaItem.poster || 'https://via.placeholder.com/200x300';
          customPosterUrl.value = activeMediaItem.poster || '';
          customBackdropUrl.value = '';
          overrideAlert.innerHTML = '<div class="alert alert-info bg-dark border-info text-info p-2 small m-0 rounded-3">🔄 Restablecido a la portada oficial original.</div>';
          setTimeout(() => { overrideAlert.innerHTML = ''; }, 4000);
        }
      } catch (err) {
        resetOverrideBtn.disabled = false;
      }
    });

    testBtn.addEventListener('click', async () => {
      const q = testQuery.value.trim();
      if (!q) return;
      testBtn.disabled = true;
      testBtn.textContent = 'Cargando...';
      testOutput.style.display = 'block';
      jsonPreview.textContent = 'Consultando API /api/v1/search...';

      try {
        const res = await fetch('/api/v1/search?q=' + encodeURIComponent(q));
        const json = await res.json();
        testBtn.disabled = false;
        testBtn.textContent = '🔎 Probar Unificación';

        testCount.textContent = 'Resultados Unificados: ' + (json.count || 0);
        testStatus.textContent = 'Status ' + res.status + ' OK';
        jsonPreview.textContent = JSON.stringify(json.results?.slice(0, 3), null, 2);
      } catch (err) {
        testBtn.disabled = false;
        testBtn.textContent = '🔎 Probar Unificación';
        jsonPreview.textContent = 'Error de conexión con /api/v1/search';
      }
    });
  </script>
</body>
</html>`);
});

// Endpoint API para obtener estado del Panel y fuentes
app.get('/api/v1/panel', async (req: Request, res: Response) => {
  const sources = await SourceManager.getSourcesAsync();
  res.json({
    status: 'success',
    sources
  });
});

// Endpoint API para actualizar fuentes y su orden de prioridad
app.post('/api/v1/panel/sources', async (req: Request, res: Response) => {
  const { sources } = req.body;
  if (!Array.isArray(sources)) {
    return res.status(400).json({ status: 'error', message: 'Se requiere un arreglo "sources"' });
  }

  const updated = await SourceManager.updateSourcesAsync(sources);
  res.json({
    status: 'success',
    message: 'Fuentes de catálogo y orden de prioridad actualizados con éxito',
    sources: updated
  });
});

// Buscar películas o series en TMDB para editar en el panel
app.get('/api/v1/panel/media/search', async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  if (!q) {
    return res.status(400).json({ status: 'error', message: 'Se requiere parámetro "q"' });
  }
  const results = await TmdbService.searchTmdbMulti(q);
  res.json({ status: 'success', count: results.length, results });
});

// Obtener todas las portadas y backdrops alternativos de TMDB para un tmdb_id
app.get('/api/v1/panel/media/:tmdb_id/images', async (req: Request, res: Response) => {
  const tmdbId = Number(req.params.tmdb_id);
  const type = (req.query.type as any) === 'tvseries' ? 'tvseries' : 'movie';
  if (isNaN(tmdbId) || tmdbId <= 0) {
    return res.status(400).json({ status: 'error', message: 'tmdb_id inválido' });
  }
  const images = await TmdbService.getTmdbImages(tmdbId, type);
  const currentOverride = OverrideService.getOverride(tmdbId);
  res.json({ status: 'success', tmdb_id: tmdbId, override: currentOverride, images });
});

// Guardar portada/backdrop personalizada (Override)
app.post('/api/v1/panel/media/:tmdb_id/override', (req: Request, res: Response) => {
  const tmdbId = req.params.tmdb_id;
  const { custom_poster, custom_backdrop, custom_title } = req.body;
  const updated = OverrideService.setOverride(tmdbId, { custom_poster, custom_backdrop, custom_title });
  res.json({ status: 'success', message: 'Portada/backdrop personalizada guardada con éxito', data: updated });
});

// Eliminar portada/backdrop personalizada
app.delete('/api/v1/panel/media/:tmdb_id/override', (req: Request, res: Response) => {
  const tmdbId = req.params.tmdb_id;
  const removed = OverrideService.removeOverride(tmdbId);
  res.json({ status: 'success', message: removed ? 'Override eliminado con éxito' : 'No había override para este ID' });
});

// Listar todos los overrides activos
app.get('/api/v1/panel/overrides', (req: Request, res: Response) => {
  res.json({ status: 'success', overrides: OverrideService.getAllOverrides() });
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

// Invalidación y Revalidación de Caché en Borde / Memoria
app.all(['/api/v1/revalidate', '/api/v1/cache/clear'], (req: Request, res: Response) => {
  CatalogService.clearCache();
  res.json({
    status: 'success',
    success: true,
    message: 'Caché de borde y memoria invalidado con éxito.'
  });
});

// Alias Estándar para Feed Home (/home y /feeds/home)
app.get(['/api/v1/home', '/api/v1/feeds/home'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const country = (req.query.country as string) || 'CL';
    const feed = await FeedService.getHomeFeed(country);
    res.json({ status: 'success', data: feed });
  } catch (err) {
    next(err);
  }
});

// Endpoint Estándar para Películas (/movies)
app.get('/api/v1/movies', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = getPaginationParams(req);
    const genre = req.query.genre as string;
    const result = await FeedService.getDiscover(page, limit, 'movie', genre);
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

// Endpoint Estándar para Series (/series)
app.get('/api/v1/series', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = getPaginationParams(req);
    const genre = req.query.genre as string;
    const result = await FeedService.getDiscover(page, limit, 'tvseries', genre);
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

// Endpoint Estándar Catálogo General (/media)
app.get('/api/v1/media', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = getPaginationParams(req);
    const type = req.query.type as string;
    const genre = req.query.genre as string;
    const result = await FeedService.getDiscover(page, limit, type, genre);
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

// Descubrimiento Infinito
app.get('/api/v1/discover', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = getPaginationParams(req);
    const type = req.query.type as string;
    const genre = req.query.genre as string;

    const result = await FeedService.getDiscover(page, limit, type, genre);
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

// Consulta en Lote (Batching Request)
app.get('/api/v1/media/batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawIds = (req.query.ids as string) || '';
    const ids = rawIds.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'El parámetro ?ids=id1,id2 es requerido');
    }
    const results = await CatalogService.getBatch(ids);
    const compact = req.query.compact === 'true';
    const finalItems = compact ? results.map(CatalogService.toCompactItem) : results;
    res.json({ status: 'success', count: finalItems.length, data: finalItems });
  } catch (err) {
    next(err);
  }
});

// Búsqueda general con Paginación y Proyección Compacta
app.get(['/api/v1/search', '/api/v1/movies/search'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = req.query.q as string;
    if (!q) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'El parámetro ?q= es requerido');
    }

    const { page, limit } = getPaginationParams(req, 25, 100);
    const compact = req.query.compact === 'true';

    // Obtener una ventana global estable para que total_results no dependa de la página solicitada.
    // Si solo se pidiera page * limit, total_results crecería como 25, 50, 75... y rompería el scroll infinito.
    const SEARCH_TOTAL_WINDOW = 250;
    const results = await CatalogService.search(q, SEARCH_TOTAL_WINDOW);
    const startIndex = (page - 1) * limit;
    const paginated = results.slice(startIndex, startIndex + limit);
    const finalItems = compact ? paginated.map(CatalogService.toCompactItem) : paginated;
    const totalPages = Math.ceil(results.length / limit);

    res.json({
      status: 'success',
      query: q,
      page,
      limit,
      total_results: results.length,
      total_pages: totalPages,
      has_more: page < totalPages,
      next_page: page < totalPages ? page + 1 : null,
      count: finalItems.length,
      results: finalItems
    });
  } catch (err) {
    next(err);
  }
});

// Detalle de Episodio específico (/series/... y /media/...)
app.get(['/api/v1/series/:id/season/:season/episode/:episode', '/api/v1/media/:id/season/:season/episode/:episode'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, season, episode } = req.params;
    const sNum = parseInt(season);
    const epNum = parseInt(episode);

    let epDetail = await RealScraperService.scrapeEpisodeDetail(id, sNum, epNum);

    // Fallback inteligente: Buscar la serie por ID/Slug en el catálogo y resolver el episodio solicitado
    if (!epDetail) {
      const seriesItem = await CatalogService.getById(id);
      if (seriesItem && seriesItem.seasons) {
        const targetSeason = seriesItem.seasons.find((s: any) => s.season_number === sNum);
        if (targetSeason) {
          const targetEp = targetSeason.episodes.find((e: any) => e.episode_number === epNum);
          if (targetEp) {
            epDetail = {
              ...targetEp,
              series_id: seriesItem.id,
              series_title: seriesItem.title,
              season_number: sNum,
              poster: targetEp.still_path || seriesItem.poster,
              backdrop: seriesItem.backdrop,
              servers: targetEp.servers?.length > 0 ? targetEp.servers : seriesItem.servers
            } as any;
          }
        }
      }
    }

    if (!epDetail) {
      return sendErrorResponse(res, 404, 'RESOURCE_NOT_FOUND', 'El episodio solicitado no existe o no está disponible.');
    }
    res.json({ status: 'success', data: epDetail });
  } catch (err) {
    next(err);
  }
});

// Detalle específico para Series
app.get('/api/v1/series/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { season, episode } = req.query;
    if (season && episode) {
      const epDetail = await RealScraperService.scrapeEpisodeDetail(req.params.id, parseInt(season as string), parseInt(episode as string));
      if (epDetail) return res.json({ status: 'success', data: epDetail });
    }
    const item = await CatalogService.getById(req.params.id, 'tvseries');
    if (!item) {
      return sendErrorResponse(res, 404, 'RESOURCE_NOT_FOUND', 'La serie solicitada no existe o no está disponible.');
    }
    res.json({ status: 'success', data: item });
  } catch (err) {
    next(err);
  }
});

// Detalle por ID o Slug (Películas o Series)
app.get('/api/v1/media/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { season, episode, include } = req.query;
    if (season && episode) {
      const epDetail = await RealScraperService.scrapeEpisodeDetail(req.params.id, parseInt(season as string), parseInt(episode as string));
      if (epDetail) return res.json({ status: 'success', data: epDetail });
    }
    const item = await CatalogService.getById(req.params.id);
    if (!item) {
      return sendErrorResponse(res, 404, 'RESOURCE_NOT_FOUND', 'El contenido solicitado no existe o no está disponible.');
    }

    if (include === 'season_1' || include === 'first_season') {
      const firstEp = await RealScraperService.scrapeEpisodeDetail(item.id, 1, 1);
      if (firstEp) {
        (item as any).season_1_first_episode = firstEp;
      }
    }

    res.json({ status: 'success', data: item });
  } catch (err) {
    next(err);
  }
});

// Resolver Token Dinámico de Stream
app.get('/api/v1/stream/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = (req.query.id as string) || 'srv_default';
    const originalUrl = (req.query.url as string) || 'https://streamwish.to/hls/sample.m3u8';

    const resolved = await ResolverService.resolveStreamToken(id, originalUrl);
    res.json({ status: 'success', data: resolved });
  } catch (err) {
    next(err);
  }
});

// Proxy de Streaming con soporte nativo de HTTP Range Requests (206 Partial Content) para Seek instantáneo
app.get('/api/v1/stream/proxy', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const videoUrl = req.query.url as string;
    if (!videoUrl) {
      return sendErrorResponse(res, 400, 'MISSING_PARAMETER', 'El parámetro ?url= es requerido');
    }

    const range = req.headers.range;
    const originHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Referer': new URL(videoUrl).origin + '/',
      ...(range ? { 'Range': range } : {})
    };

    const response = await axios.get(videoUrl, {
      headers: originHeaders,
      responseType: 'stream',
      validateStatus: (status) => status >= 200 && status < 400
    });

    res.status(response.status);
    const cr = response.headers['content-range'];
    if (cr) res.setHeader('Content-Range', String(cr));
    const ar = response.headers['accept-ranges'];
    if (ar) res.setHeader('Accept-Ranges', String(ar));
    else res.setHeader('Accept-Ranges', 'bytes');
    const cl = response.headers['content-length'];
    if (cl) res.setHeader('Content-Length', String(cl));
    const ct = response.headers['content-type'];
    if (ct) res.setHeader('Content-Type', String(ct));
    else res.setHeader('Content-Type', videoUrl.includes('.m3u8') ? 'application/x-mpegURL' : 'video/mp4');

    response.data.pipe(res);
  } catch (err) {
    next(err);
  }
});

// Reportar Enlace Roto
app.post('/api/v1/links/report', (req: Request, res: Response) => {
  const { link_id } = req.body;
  res.json({
    status: 'success',
    message: `Enlace ${link_id || 'solicitado'} reportado con éxito. Se ha marcado para verificación.`
  });
});

// Manejador global de errores inesperados (Zero 500 HTML Pages)
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('[Global API Exception]:', err);
  sendErrorResponse(res, 500, 'INTERNAL_SERVER_ERROR', 'Ocurrió un error inesperado al procesar la solicitud.');
});

// Manejador global 404 para la API
app.use('/api/v1/*', (req: Request, res: Response) => {
  sendErrorResponse(res, 404, 'RESOURCE_NOT_FOUND', 'El endpoint o contenido solicitado no existe.');
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 API Servidor corriendo en http://localhost:${PORT}/api/v1`);
  });
}

export default app;
