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

## 🗂 Migraciones de la base de datos

```bash
npm run migrar                                  # dice cuáles faltan, no toca nada
npm run migrar -- --apply                       # aplica las pendientes, en orden
```

Necesita `SUPABASE_DB_URL` en el `.env` (panel de Supabase → **Connect** → *Session pooler*). La
clave REST que usa la API no sirve: sabe leer y escribir filas, no cambiar la forma de la tabla.

**La primera vez, en una base que ya existe, hay que fijar el punto de partida:**

```bash
npm run migrar -- --baseline=011_subtitulos.sql
```

Da por aplicadas la 011 y todas las anteriores **sin ejecutarlas**, que es lo correcto porque ya se
pegaron a mano en el SQL Editor. Sin este paso, volver a lanzar la 007 recalcularía `has_streams`
de todo el catálogo y borraría el resultado de las verificaciones de reproducción reales.

## 🧩 Metadata: rellenar los huecos que TMDB no cubre

Al 23,5 % del catálogo le falta el logo, al 21,8 % el tráiler, al 20 % la clasificación por edades
y al 17,7 % la duración; 27 fichas se quedaron con la sinopsis en inglés. **El 92 % de esos huecos
son huecos de TMDB**, no fallos del emparejado: son cine argentino y venezolano viejo con ficha
creada y vacía. Medido con `npx ts-node scripts/dev/diag_hueco_tmdb.ts`, que le vuelve a preguntar
a TMDB sin filtros por cada ficha incompleta.

`metadatos:rellenar` los tapa en cascada y campo por campo — TMDB otra vez → Wikidata/Wikipedia en
español → Fanart.tv para los logos:

```bash
npm run metadatos:rellenar                    # informa (dry-run), no escribe nada
npm run metadatos:rellenar -- --apply         # …y lo escribe en Supabase
npm run metadatos:rellenar -- --solo=overview --limit=20 --detalle
```

Antes del primer `--apply`, ejecuta **`src/db/migrations/012_metadata_fuentes.sql`** en el SQL
Editor de Supabase: sin esa columna el barrido rellena igual pero no deja constancia de qué campo
vino prestado, y entonces no hay vuelta atrás el día que TMDB publique lo que hoy no tiene.
Opcional: `FANART_API_KEY` en el entorno activa el paso de logos (clave personal gratuita); sin
ella ese paso se salta solo.

Radiografía del estado actual en cualquier momento:

```bash
npx ts-node scripts/dev/diag_metadatos.ts
```

## ☁️ Despliegue en Vercel (Gratis $0/mes)

```bash
npx vercel
```
