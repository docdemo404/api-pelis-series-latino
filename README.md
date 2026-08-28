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

**Esto ya no hay que acordarse de lanzarlo.** La cascada vive en `completarHuecos`
(`src/services/complementoService.ts`) y corre sola en la puerta de entrada del catálogo: cada
título que entra por el rastreo pasa por TMDB y, si TMDB lo deja incompleto, por Wikidata,
Wikipedia y Fanart antes de guardarse. Se apaga con `refresh:catalog -- --sin-complemento` cuando
lo que importa es el volumen y no la calidad de cada ficha.

Va encendido en el rastreo y **apagado en las peticiones en vivo**, que usan la misma función:
Wikidata tarda uno o dos segundos, que en un crawl no se notan y en una portada son un carrusel
que no aparece.

`metadatos:rellenar` es el mismo trabajo sobre lo YA guardado — para las fichas que entraron antes
de que esto existiera:

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

### Lo que no se puede rellenar, se ordena más abajo

Agotadas TMDB, Wikidata, Wikipedia y Fanart, quedan fichas que nadie tiene completas — 151 sin logo
sobre 895. Se reproducen igual de bien, así que no se esconden: se hunden. La migración 013 añade
`metadata_score`, una **columna generada** (0-100) que Postgres calcula de la propia fila, con los
pesos puestos en cuánto se nota la ausencia mirando la app: sin carátula la ficha es un rectángulo
gris en el carrusel (22 puntos), sin clasificación por edades no lo nota nadie (4).

Entra en el orden del home, del "ver todo" y de la búsqueda, siempre **por delante de la nota y
por detrás del acierto de nombre**: quien escribe "matilda" quiere Matilda, pero entre dos
resultados que encajan igual manda el que se puede mirar. Y no reordena el catálogo bueno — 822 de
895 fichas puntúan entre 82 y 100, así que el grueso queda empatado y dentro de él manda el orden
de siempre.

Es generada y no un campo mantenido a mano porque hay cuatro caminos que escriben fichas (crawl,
relleno, reparaciones y panel): el primero que se olvidara dejaría puntuaciones mentirosas.

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

## 🎬 Un HLS sin firma es tan permanente como un mp4 (2026-08-27)

`esUrlDeFicheroPermanente` decidía con `/\.(mp4|mkv|webm)$/` sobre el `pathname`, así que **ningún
`.m3u8` podía pasar jamás**, llevara token o no. Y HLS es lo que publican tioplus, videoapi y la
mayoría de las webs modernas: por eso las «fuentes probadas» acabaron siendo las dos que sirven
ficheros sueltos.

Un `.mp4` se juzga por su forma; un `.m3u8` no, porque el manifiesto puede estar limpio y apuntar a
segmentos firmados. Así que el trabajo se partió en dos: la **forma** sigue en
`esUrlDeFicheroPermanente` —síncrona y pura, que es lo que hace que el crawl y el barrido den la
misma respuesta— y el **contenido** en `entregaHls`, que abre el manifiesto, rechaza si alguna url
de dentro lleva firma, baja un escalón si es maestro (las variantes de turboviplay viven en otro
host) y exige que un segmento del medio entregue vídeo con la misma prueba que un mp4.

> `entregaHls` **no** reutiliza `segmentoDescargable` aunque haga casi lo mismo. Su regla es
> «devuelve true cuando no hay nada que comprobar», correcta allí porque decide qué se BORRA. Aquí
> se decide qué ENTRA, y la carga de la prueba va al revés: lo que no se ha podido comprobar no es
> permanente.

De paso, la función ahora rechaza por sí misma lo que lleva token. `pathname` no incluye la query,
así que un `pelicula.mp4?e=1784869872` pasaba entero; se salvaba porque **uno** de los cinco sitios
que la llaman encadenaba `hasVolatileToken` en la línea siguiente.

**El barrido no necesitó nada**: ya sabía de HLS (`manifiestoArranca` + la regla de dos avisos de
`fallos_arranque`), así que el caso «el host empezó a firmar» sale como «sus trozos no llegan».

Medido antes de tocar producción, comparando la regla vieja y la nueva sobre los 2.287 servidores
guardados: **0 pierden el sello** y 5 lo ganan —los `.m3u8` pegados a mano que el barrido borraba—.

Y una tanda real de tioplus:

```bash
npx ts-node scripts/refreshCatalog.ts --solo=peliculas --saltar-guardados --minutos=18 --completar-minutos=20 300
```

| | Antes | Después |
|---|---|---|
| `N/300 títulos tienen url directa permanente y funcional` | **0** | **256** |
| Filas en la tabla | 610 | **808** |
| Publicables | 575 | **773** |
| Fichas de tioplus | 86 | **332** |
| Servidores directos | 659 fichero · 0 HLS | 659 fichero · **567 HLS** |

**Riesgo que queda anotado:** los segmentos de turboviplay salen de `lh3.googleusercontent.com`, y
`IP_BOUND_HOSTS` lista `googleusercontent` como host que ata el vídeo a la IP que lo pidió. Un
segmento bajó bien desde una máquina sin sesión previa, lo que apunta a que no está atado, pero el
crawl corre en un runner y el aparato del espectador es una tercera IP. Si una ficha nueva da 403,
es esto.

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
> — y **cinecalidad, cero**. *(Cinecalidad se retiró el 2026-08-27; ver más abajo.)*

Arreglado: la matriz de `poblar.yml` pasa de `[fuegocine, archive]` a las seis
(`peliculas`/`series`/`animes` son las categorías de tioplus, y arrastran a las demás porque
`scrapeLatest` las pide por la misma puerta), y el crawl diario lleva `--saltar-guardados`
salvo que se pida lo contrario. `moviedays` recibe además un `--desde` rotado con el número de
corrida: es la única fuente sin índice —baja por TMDB por número de votos— y sin eso repetiría
siempre las mismas páginas.

El precio: una vuelta entera de la matriz pasa de ~45 min a ~2 h y salen menos vueltas al día, así
que FuegoCine pierde unas tres tandas diarias. A cambio, cuatro webs pasan de cero.

Para ver si una corrida aportó algo, sin abrir la interfaz de GitHub:

```bash
gh run view <id> --log | grep -E "recolectados|ya estaban guardados|url directa permanente|Refresh completado"
```

## 📚 VideoAPI: la primera fuente que no se crawlea (2026-08-27)

Se llegó a ella por `modocine.com`, pero **modocine no es la fuente: es un cliente**. No tiene
catálogo propio —su portada son ~286 tarjetas que TMDB considera populares hoy— y le pinta una piel
encima a `videoapi.la`, que es un proveedor de embeds con documentación pública
(`https://videoapi.la/api`), panel y plugin de WordPress. Se le habla al proveedor.

Lo que la hace distinta de las seis fuentes anteriores es que **publica su catálogo entero** en
listas de ids de TMDB, sin autenticación:

```bash
curl -s https://videoapi.la/api/v1/public/wordpress/ids/movies.txt | wc -l    # 7.916
curl -s https://videoapi.la/api/v1/public/wordpress/ids/tvshows.txt | wc -l   # 1.005
curl -s https://videoapi.la/api/v1/public/wordpress/ids/episodes.txt | wc -l  # 34.001
curl -s https://videoapi.la/api/v1/public/wordpress/ids/anime.txt | wc -l     # 795
curl -s https://videoapi.la/api/v1/public/wordpress/ids/anime-episodes.txt | wc -l  # 16.863
```

O sea: no hay índice que recorrer, ni plantilla que parsear, ni identidad que demostrar. Se piden
las listas, se restan las que ya tenemos, y lo que sobra se pide por su número. **Todo el capítulo
1 de [FUENTES.md](FUENTES.md) —homónimos, `originalContradice`, el hash de la imagen— no es que se
cumpla: es que no llega a aplicar, porque no hay título de por medio en ningún momento.**

Cuánto aporta, calculado y no estimado (las dos partes hablan en ids de TMDB):

| | ellos | nosotros | compartido | **nuevo** |
|---|---|---|---|---|
| Películas | 7.916 | 1.033 | 739 | **7.177** (91 %) |
| Series y anime | 1.800 | 175 | 86 | **1.714** (95 %) |

```bash
npx ts-node --transpile-only scripts/dev/diag_videoapi_solape.ts   # la tabla de arriba, hoy
npx ts-node --transpile-only scripts/dev/diag_videoapi.ts          # la cadena entera, de id a bytes
npx ts-node --transpile-only scripts/dev/diag_videoapi_fondo.ts    # hasta dónde llega su fondo
```

**No hizo falta escribir extractor.** Su reproductor es `vimeos.net`, que ya se extraía y ya tenía
perfil medido en `hostPolicy`. Lo único que se añadió a `directStream` es que `videoapi.la` es un
agregador cuyo HTML trae el reproductor real en un `<iframe>` — y **que hay que quitarle el `cf=`**:
con el token puesto, vimeos devuelve una cáscara de 901 bytes y no hay vídeo; a secas devuelve el
reproductor entero de 49 KB. Es la diferencia entre que la fuente funcione y que no.

### Cargarlo y mantenerlo al día es el mismo comando

```bash
npm run importar:videoapi -- --dry           # qué haría, sin escribir
npm run importar:videoapi                    # una tanda (300 fichas, 20 min)
npm run importar:videoapi -- --limite=900 --minutos=40
npm run importar:videoapi -- --solo=series
```

No hay modo «carga inicial» y modo «sincronizar», **y eso es el diseño, no un atajo**: lo nuevo es,
por definición, lo que está en su lista y no en la nuestra. La primera corrida encuentra 8.891
diferencias; la de dentro de seis horas encontrará las que hayan publicado. Dos modos serían dos
criterios de «qué es nuevo» destinados a separarse.

Lo automatiza [`videoapi.yml`](.github/workflows/videoapi.yml), cada 6 h (02, 08, 14 y 20), 900
fichas por tanda. Cabe porque **cada ficha cuesta 2,4 s verificada de verdad** —resolver, bajar el
manifiesto y descargar un segmento— frente a los ~24 s de la media del catálogo: la cadena es corta
y siempre la misma. Unas 8.891 fichas a 6 a la vez son ~1 h de reloj para la primera vuelta.

Y se escribe con la regla de la puerta de siempre: **lo que no reproduce no entra**. Sin eso el
catálogo crecería en títulos y no en cosas que se puedan ver.

La sincronización cubre **lo que aparece**, y eso incluye los capítulos: cuando publican el 4x27 de
una serie que ya tenemos, la corrida siguiente lo ve porque no está en nuestro árbol
(`capitulosPendientes`), y solo resuelve ese.

Lo que **no** hace es enterarse de lo que RETIRAN. Si mañana quitan un título, su fila se queda con
un servidor que ya no resuelve. No hace falta código nuevo para eso y es a propósito: el sello de
`verified_at` caduca a las 6 h, `verificar.yml` lo intenta, falla, y la ficha deja de anunciarse
sola. Retirar es barato y reversible por el mismo camino que el resto del catálogo — añadir una
purga propia sería un segundo criterio de «esto está muerto» compitiendo con el que ya existe.

### Lo que queda por medir

**No está comprobado desde Vercel.** Todo lo de arriba se midió desde una IP residencial y desde los
runners de GitHub (que sí son datacenter). `vimeos.net` está medido y entrega desde Vercel —es lo
que sostiene a moviedays—, pero `videoapi.la` está detrás de Cloudflare y no se ha probado desde
allí. Importa porque el segundo salto se da al REPRODUCIR, o sea en una función de Vercel: si esa
puerta está cerrada, las fichas se anuncian y no se ven. Se comprueba abriendo una y dándole a
reproducir.

## 🗑️ Cinecalidad se retiró (2026-08-27)

No por estar rota: por **redundante**. Aportaba cero —cero fichas y cero servidores sobre 8.524
filas, ni una con página suya— y encima fallaba en silencio, porque su llamada se tragaba el error
dos veces (`catch { break }` dentro y `.catch(() => [])` fuera): no aparecía ni una vez en el
registro del crawl.

Lo que decidió la retirada fue mirar **qué había detrás**. Publica sus reproductores a la vista, en
`data-option`, y el bueno es `vimeos.net` — el mismo host que ya sirve videoapi. Para «Pelotas en
juego» era literalmente el mismo fichero (`embed-20ls07ugclbo`, el que videoapi devuelve para tmdb
9472). Era un cliente del mismo proveedor al que ya le hablamos, por una puerta peor.

Se fue entera: su scraper (`scrapeCinecalidadLatest`, `…Search`, `…Detail`, `parseCinecalidadCards`,
`tituloDeCinecalidad`, `cinecalidadTemporadas`), sus moldes de url en `tipoDeLaRuta`, su cupo
reservado en `scrapeLatest`, su contador del panel y sus dos sondas de `scripts/dev`.

> **Y de paso salió otro fallo**: `SourceManager.isEnabled` existía y **no lo llamaba nadie**.
> Apagar una fuente desde el panel escondía sus servidores (`sortServersBySourcePriority` sí mira
> `enabled`) pero el crawl seguía saliendo a rastrearla en cada tanda para tirar lo que trajera. Un
> interruptor que apagaba la luz y no el motor. Ahora tiene su primer llamador.

## ☁️ UN SOLO DESPLIEGUE, y por qué se llegó a eso (2026-08-28)

Este repositorio llegó a estar conectado a **dos proyectos de Vercel, en dos cuentas distintas**, y
acabaron cruzados de la peor forma posible. Medido pidiéndoles `/api/v1/panel` a los dos:

| | código | escritura Supabase | Redis |
|---|---|---|---|
| `...-gilt.vercel.app` | viejo | ✅ | ✅ |
| `api-pelis-series-latino.vercel.app` | nuevo | ❌ | ❌ |

El que tenía las claves no sabía reproducir lo nuevo —502 en las 7.200 fichas de videoapi— y el que
sí sabía perdía en silencio todo lo que aprendía al servir: sin `SUPABASE_SERVICE_ROLE_KEY`, un
UPDATE bloqueado por RLS **no da error**, contesta 204 y cero filas.

Y con dos nombres casi iguales, mirar el panel equivocado y sacar conclusiones falsas era cuestión
de tiempo. Pasó.

**Ahora hay uno: `api-catalogo-latino.vercel.app`.** Los dos viejos se borran.

Cambiar de dominio no obligó a migrar nada: los `direct_stream` se guardan **relativos**
(`/api/v1/stream/direct/…`) y se absolutizan al servir. Comprobado sobre 2.247: ninguno llevaba un
dominio dentro.

> **La pregunta que destapa este problema en diez segundos**, y hay que hacérsela al host al que
> apunta la app, no al del nombre más bonito:
>
> ```bash
> curl -s https://<host>/api/v1/panel | grep -oE '"catalog_writable":[a-z]+|"shared_counter":[a-z]+'
> ```
>
> Si sale `false`, ese despliegue está sordo: sirve, pero no aprende.

## ☁️ Despliegue en Vercel (Gratis $0/mes)

```bash
npx vercel
```
