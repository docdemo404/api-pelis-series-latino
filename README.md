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

## 🚚 Cuándo se retira un host — y, sobre todo, cuándo no

`--entrega` comprueba que la API sepa servir cada host **por el camino del reproductor**, y al que
no puede le quita el sello a sus servidores. El 2026-08-26 a las 20:19 condenó **once hosts de
quince y retiró 1.939 sellos: 217 títulos dejaron de anunciarse en una sola corrida.** Nueve de
los once habían contestado `429`, que no significa «este host no entrega» sino «vas demasiado
rápido» — y se lo provocaba el propio sondeo, disparando sin pausa.

Ahora un `429`, `503`, `504`, `408` o un corte de red cuentan como **sin veredicto** y no condenan
a nadie; las sondas van espaciadas; a los que fallan se les vuelve a preguntar al final de la
corrida; y hacen falta **dos corridas con fallo concluyente** antes de retirar un sello, que es la
misma regla que `verificarPermanentes` ya tenía desde el principio.

```bash
npm run repair:catalog -- --entrega                        # informa, no escribe
npm run repair:catalog -- --entrega --incluir-sin-sello    # …y pregunta también por los ya condenados
```

El segundo comando existe porque había un punto ciego: en cuanto un host se condena, sus
servidores se quedan sin sello y dejan de entrar en el muestreo, así que este paso no podía
enterarse nunca de que el host había vuelto.

Medido con él el 2026-08-27: de los once condenados, **siete entregan vídeo real** —ok.ru,
archive.org, emturbovid, mp4upload, yourupload, fast.wistia y unlimplay—. Quedan cuatro que fallan
con `502` en las dos vueltas: vidhideplus, drive.google, dropload y gumlet. Ese `502` sí es un
veredicto —la API llega al host y el host no entrega— y de vidhideplus ya se sabe por qué: sus
ficheros están borrados (`scripts/dev/probe_entrega_host.ts`).

## 🐌 Por qué el catálogo crecía a un título al día (2026-08-27)

La queja era «hay muy poco contenido». **El crawl no era el problema**: los índices se recorren
enteros y se releen en cada tanda, así que lo que la fuente publica hoy entra hoy. Medido en el log
de la tanda de las 00:24:

| | FuegoCine | archive.org |
|---|---|---|
| Títulos que ve en el índice | 3.240 | 1.414 |
| Ya guardados | 337 | 218 |
| Trabajados en la corrida | 300 | 300 |
| Con url directa **permanente y funcional** | 2 | 0 |
| Filas guardadas | **1** | **0** |

Lo que estrangula es la regla de la puerta (`refreshCatalog.ts`, «SOLO ENTRA LO QUE TIENE URL
DIRECTA Y FUNCIONA», y además permanente). Eso es una **decisión**, no un fallo, y se mantiene.

Lo que sí era un fallo son dos cosas que dejaban cuatro fuentes apagadas:

**1. El crawl diario nunca pasaba `--saltar-guardados`.** Ese flag es el que activa las dos cribas
—lo que ya está en la base y la memoria de 14 días de lo que se miró sin vídeo—, y solo se añadía
si alguien marcaba la casilla a mano. La corrida programada, la de todos los días, no lo llevaba:
se gastaba sus cuatro horas de presupuesto remidiendo los ficheros de las 610 fichas que ya tenía
antes de llegar a lo que no había mirado nunca. Cinco corridas seguidas en `failure`/`cancelled`,
la última anotada por GitHub como *«exceeded the maximum execution time of 6h0m0s»*.

**2. `poblar.yml` solo rotaba dos fuentes.** Las demás dependían del crawl diario, que no
terminaba. Se ve en el reparto del catálogo:

```bash
node -e "require('dotenv').config();const{createClient}=require('@supabase/supabase-js');const sb=createClient(process.env.SUPABASE_URL||'https://kgeytmocuitbchpdcoad.supabase.co',process.env.SUPABASE_SERVICE_ROLE_KEY);(async()=>{const c={};let f=0;for(;;){const{data}=await sb.from('media_items').select('id,source_url,source_urls').order('id').range(f,f+999);if(!data?.length)break;for(const r of data){const u=[r.source_url,...(r.source_urls||[])].filter(Boolean);const h=new Set(u.map(x=>{try{return new URL(x).hostname.replace(/^www\./,'')}catch{return 'sin-pagina'}}));(h.size?[...h]:['sin-pagina']).forEach(k=>c[k]=(c[k]||0)+1)}f+=1000}console.log(c)})()"
```

> `{ 'fuegocine.com': 353, 'archive.org': 218, 'tioplus.app': 86, 'moviedays.lat': 50 }`
> — y **cinecalidad, cero**.

Arreglado: la matriz de `poblar.yml` pasa de `[fuegocine, archive]` a las seis
(`peliculas`/`series`/`animes` son las categorías de tioplus, y arrastran a cinecalidad y moviedays
porque `scrapeLatest` las pide por la misma puerta), y el crawl diario lleva `--saltar-guardados`
salvo que se pida lo contrario. `moviedays` recibe además un `--desde` rotado con el número de
corrida: es la única fuente sin índice —baja por TMDB por número de votos— y sin eso repetiría
siempre las mismas páginas.

El precio: una vuelta entera de la matriz pasa de ~45 min a ~2 h y salen menos vueltas al día, así
que FuegoCine pierde unas tres tandas diarias. A cambio, cuatro webs pasan de cero.

Para ver si una corrida aportó algo, sin abrir la interfaz de GitHub:

```bash
gh run view <id> --log | grep -E "recolectados|ya estaban guardados|url directa permanente|Refresh completado"
```

## ☁️ Despliegue en Vercel (Gratis $0/mes)

```bash
npx vercel
```
