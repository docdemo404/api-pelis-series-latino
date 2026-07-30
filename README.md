# 🎬 API de Películas y Series Latino (Servidores Activos + Super Metadatos)

API REST completa de alto rendimiento construida en Node.js y TypeScript. Entrega catálogo completo de Películas y Series con temporadas, episodios, super metadatos en Español Latino y enlaces de video 100% verificados.

> **¿Vas a añadir otra web al scraping?** Lee primero **[FUENTES.md](FUENTES.md)**. Es el contrato
> que garantiza que cada ficha sirva SU contenido, SU carátula y SU sinopsis, y no las de otra
> película: qué señales tiene que entregar la fuente, qué no se puede hacer nunca, las trampas que
> ya nos han costado un arreglo y cómo comprobarlo antes de dar el trabajo por hecho.

## 🚀 Características Principales
- 🌟 **Feeds Estilo Netflix**: Endpoint `/api/v1/feeds/home` con carruseles por país (`CL`, `MX`, `LATAM`).
- 📺 **Soporte para Series y Temporadas**: Desglose por temporada, número de capítulo, fotos de episodios y reproductores funcionales.
- 🎯 **Selección de Servidor Preferido (`primary_stream`)**: Prioriza por defecto enlaces funcionales (`online`), en **Español Latino** y con **máxima resolución** (1080p/4K).
- 🏷️ **Búsqueda con Alias**: Resuelve nombres regionales (ej. busca `"solo en casa"` y entrega `"Mi pobre angelito"`).
- 🔓 **Acceso Libre**: Sin rate-limiting ni restricciones.
- 🔑 **Tokens Dinámicos**: Endpoint `/api/v1/stream/resolve` para refrescar URLs de video HLS (`.m3u8`).

## 🛠️ Instalación Local

```bash
npm install
npm run dev
```

La API estará lista en: `http://localhost:3000/api/v1`
Documentación gráfica en: `http://localhost:3000/docs`

## ☁️ Despliegue en Vercel (Gratis $0/mes)

```bash
npx vercel
```
