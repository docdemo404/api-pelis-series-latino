# Añadir una fuente nueva sin romper las fichas

Esta API junta varias webs de scraping en un solo catálogo, y cada ficha tiene que servir **su**
contenido, **su** carátula y **su** sinopsis. Nunca las de otra. Este documento existe porque casi
todos los fallos graves que ha tenido el catálogo salieron del mismo sitio: dar por buena la
identidad de una ficha sin tener con qué demostrarla.

Si vas a enchufar una fuente nueva, lee esto antes de escribir el scraper.

---

## 1. La regla, en una frase

> **Nada adopta la identidad de otra cosa sin una prueba independiente del título.**

El título NO identifica una obra. El catálogo está lleno de homónimos exactos, y encima el nombre
con el que se muestra una ficha es el de TMDB en español, que es el que más colisiona:

| Título | Cuántas obras distintas son |
|---|---|
| "Sin salida" | **cuatro** películas (2011, 2014, 2022, 2024) — y *The Firm* (1993) se llama igual en es-MX |
| "Carrie" | tres (1976, 2002, 2013) |
| "Drácula" | cuatro, mezclando películas y series |
| "El botín" | dos, **las dos de 2026** |

Medido en vivo, la fusión por título llegó a permitir 42 adopciones indebidas en solo cinco
títulos, y dejó 411 fuentes ajenas escritas en la base de datos.

**Prueba independiente** significa una de estas, por orden de fuerza:

1. **La página pertenece a otra ficha del catálogo** (su slug es el id de otra fila con distinto
   `tmdb_id`) → prueba definitiva de que NO es tuya, y gratis, sin salir a la red. Es la única que
   separa homónimos del mismo año.
2. **La imagen**: si la página publica una ruta de `image.tmdb.org`, ese hash señala UNA ficha
   concreta de TMDB. Confirma la identidad aunque el título no se parezca en nada.
3. **El título original** ("Home Alone"), que es independiente del nombre regional.
4. **El año**, con ±1 de tolerancia (desfase de distribución: festival un año, estreno el
   siguiente).

Y **la clase** (película o serie) forma parte de la identidad: TMDB numera los dos catálogos por
separado y los números se repiten, así que buscar en el catálogo equivocado no da un 404 — da los
datos de otra obra.

---

## 2. Qué tiene que entregar tu fuente

### 2.1 `SourceSignals` — el contrato mínimo

Añade una rama para tu fuente en `RealScraperService.fetchSourceSignals`
([src/services/realScraperService.ts](src/services/realScraperService.ts)). Es UNA petición por
ficha y de ella sale todo el respaldo. Cuantos más campos rellenes, menos fichas acabarán con la
metadata pobre de la fuente en vez de la de TMDB:

| Campo | Para qué | Si falta |
|---|---|---|
| `title` | la consulta a TMDB | la ficha no se puede ni buscar: `fetchSourceSignals` devuelve `null` |
| `year` | descarta homónimos de otra época | el matcher empareja a ciegas de época |
| `originalTitle` | segunda señal independiente del nombre regional | menos fichas verificadas |
| `imageHint` | **la confirmación más fuerte**, si apunta a `image.tmdb.org` | se pierde la vía de la imagen |
| `type` | en qué catálogo de TMDB buscar | la ficha puede acabar siendo una serie ajena |

Mira cómo lo hacen las dos fuentes actuales, porque el patrón se repite:

- **TioPlus** lo pone en la ruta (`/pelicula/` frente a `/serie|anime|dorama/`) y su `og:image` ya
  apunta a TMDB. El título original va en un `h2` cuyo hermano `<b>` dice "Titulo Original".
- **FuegoCine** lo publica todo en una tabla `ul.post-details` con atributos `data-*`:
  `data-backdrop` (¡una ruta de `image.tmdb.org`!), `data-original-title`, `data-year`,
  `data-release-data`, `data-seasons-count`, `data-episodes-count`.

> **Busca la tabla de datos de la plantilla antes de conformarte con el `og:image`.** El `og:image`
> de FuegoCine es un proxy de Blogger que no identifica nada, y por eso durante meses **ninguna** de
> sus 2.866 fichas se pudo confirmar por imagen. El dato bueno estaba en un atributo `data-*` a
> tres líneas de distancia. Cuando se leyó, las fichas confirmadas por imagen subieron de 6.889 a
> 7.740 y las que no se podían emparejar bajaron de 53 a 17.

### 2.2 La clase la dice la fuente, no el título del post

No deduzcas película/serie del título. La miniserie **"Eric" (2024)** se publicó en un post titulado
solo "Eric (2024)": se guardó como película, se buscó en el catálogo de películas de TMDB y acabó
con la ficha de *Eric André Live Near Broadway*, un especial de monólogos. La página declaraba
`data-seasons-count="1"` y `data-episodes-count="6"`.

Señales válidas, por orden: lo que declare la ficha de datos (temporadas/episodios) → la categoría
de la ruta → y solo como último recurso, el título.

### 2.3 El id de la fila ES el slug de su página

Esto no es un detalle interno: media API depende de poder preguntar **"¿de quién es esta página?"**
sin salir a la red, y eso se hace mapeando la url a un id. Cuando añadas una fuente, registra su
molde en `candidateIdsForUrl` ([src/services/catalogService.ts](src/services/catalogService.ts)):

```
TioPlus    /pelicula/sin-salida-2011        → id "sin-salida-2011"        (último tramo)
FuegoCine  /2026/03/sin-salida-2022.html    → id "2026-03-sin-salida-2022-html"  (ruta sluguificada)
```

Sin esto, la auditoría de contenido cruzado (`check:catalog` PASO 3) no ve tus fichas y la purga de
fuentes intrusas no puede reconocer las tuyas. Y **la correspondencia tiene que ser exacta**: valía
que el id fuera el *final* del slug de la url, y con eso la ficha `sobre-ruedas` daba por suya la
página `/pelicula/amor-sobre-ruedas` —otra película— y se libraba de todas las comprobaciones.

---

## 3. Lo que NO debes hacer nunca

- ❌ **Combinar servidores, fuentes o alias de dos fichas porque los títulos coincidan.** Ni siquiera
  si coinciden al 100%: eso es exactamente lo que mezcla homónimos.
- ❌ **Adoptar una ficha de TMDB con solo `matched`.** `matched` significa "el título se parece ≥ 0,6".
  Hace falta `verified`. Sin respaldo, la ficha se queda con la metadata de su fuente —un póster
  peor, pero SUYO— y con un `tmdb_id` **sintético**, nunca el ajeno: ese número es lo que después
  suelda dos fichas en una.
- ❌ **Fundir dos filas solo porque comparten `tmdb_id`.** Ese número no lo publica la fuente, lo
  deduce el matcher; cuando se equivoca, fundir suelda dos películas para siempre.
- ❌ **Exigir que los títulos se PAREZCAN para dar dos cosas por la misma.** Los nombres regionales de
  la misma película no se parecen entre sí: "En la tormenta" *es* "Sin salida" (No Exit, 2022),
  "Ella" *es* "Her", "Volver al Futuro 2" *es* "Regreso al futuro: Parte II". Retira solo con prueba
  EN CONTRA, nunca por falta de parecido.
- ❌ **Quitar un nombre porque TMDB no lo registre.** TMDB no tiene todos los títulos regionales:
  "El banquete de bodas" es exactamente como se llama *The Wedding Banquet* en español y TMDB no lo
  lleva. Perder un nombre no rompe la ficha, pero la deja imposible de encontrar por él.

---

## 4. Trampas que ya nos han costado un arreglo

Están todas comentadas en el código, pero conviene conocerlas antes de escribir el scraper:

| Trampa | Qué pasó |
|---|---|
| `canonicalTitle` solo conserva `[a-z0-9]` | Un título tailandés, japonés o coreano se queda **vacío** y puntúa 0 **contra sí mismo**. La auditoría de alias señalaba 1.280 fichas; 1.140 eran falsas alarmas. Por eso `similarity` compara primero letra por letra. |
| Prefijos a nivel de carácter | "Humo" es prefijo de "Humor", así que "Humo" (2025) se llevó la carátula de "Humor - Eine Reise mit Bully". El prefijo se mide **por palabras completas**; a nivel de carácter solo vale si los dos títulos miden casi lo mismo (variantes como "SpiderMan: Loto" / "Spider-Man: Lotus"). |
| TMDB registra las secuelas como títulos alternativos de la serie | "Die Hart 2: Die Harter" (película, 2024) figura como alias de la SERIE "Die Hart" (2020). El rescate por título alternativo daba por respaldado un desfase de 5 años; ahora confirmar exige ±1. |
| TMDB devuelve el título ORIGINAL cuando no hay traducción | 48 fichas quedaron rotuladas "機動警察パトレイバー 劇場版", "Болевой порог", "فرانكلين". Si la fuente publica un nombre legible, manda el de la fuente (`pickDisplayTitle`). |
| Números de entrega | Un guard que anulaba el parecido con entregas discordantes dejó "Rápidos y Furiosos 4" (2009) **sin emparejar**, porque TMDB la titula "Rápidos y furiosos" a secas. A las entregas de una saga las separan AÑOS: deja que el año haga su trabajo. |
| Años dentro del título | "Blade Runner 2049", "Madrid 1987", "Cherry 2000", "Mujer Maravilla 1984". No los confundas con el año de estreno ni con un número de entrega. |
| `release_date` de una fila mal emparejada | Es el año de la película equivocada. Para decidir sobre una fila, usa el año de su **página**. |
| Parsear la misma página en dos sitios | La lectura de la ficha de datos de FuegoCine estaba duplicada: se arregló en `fetchSourceSignals` (crawl y reparaciones) y `scrapeFuegocineDetail` (la API, cuando le piden un slug que no está en la base) siguió tipando por el título. Pedir `2026-01-eric-2024-html` seguía devolviendo **en vivo** la ficha equivocada. Si tu fuente publica datos útiles, léelos en UNA función y úsala en los dos caminos. |
| El id de la fila NO es siempre el slug de la fuente | Construir la url de un episodio con el id daba 404 en toda serie cuyo id no calque el slug —todas las de FuegoCine—: la ficha del anime de One Piece es `fc-one-piece` y su página es `/anime/one-piece-1999`. La url del episodio se saca de `source_urls`, no del id. |
| Rellenar un episodio con los enlaces de la serie | Es el fallo peor sin dar error: pides el capítulo 1 y ves otro. Todos los episodios de One Piece servían el mismo vídeo. Si no hay enlaces DEL capítulo, el capítulo va sin enlaces. Y si la página rotula su temporada/capítulo ("S01 E01"), se COMPRUEBA que sea el pedido. |
| Entregar servidores sin comprobar que REPRODUCEN | La comprobación de reproducción (`revisarServidores`, que baja hasta un segmento real) solo corría en el camino de las películas. Los episodios se entregaban tal cual salían del scraping, con el vídeo directo primero — que es justo el que más caduca —, así que el primer servidor daba error al darle a Reproducir. Todo camino que entregue servidores tiene que pasar por ella. |
| El caché tapa las reparaciones | La metadata se cachea 6 h y, con Redis compartido, las claves **sobreviven a los despliegues**. Arreglar la fila no basta: hay que retirarla del caché (`CatalogService.invalidateItem`, que ya llaman los modos de reparación). Y una ficha BORRADA al fundir un duplicado deja su entrada viva respondiendo 200 con la obra equivocada: esas hay que nombrarlas (`--purgar-cache --ids=…`). |

---

## 4 bis. Los CUATRO caminos por los que una ficha acaba con metadata ajena

Durante mucho tiempo aquí solo estaba tapado UNO: fusionar dos fichas porque sus títulos
coinciden. Esa puerta sigue cerrada y la auditoría la vigila. Pero el usuario no compra "no
fusionar", compra que la ficha sea la correcta — y a eso se llega por más caminos. Estos cuatro
salieron de casos reportados, uno a uno, después de haber dado el problema por resuelto:

| Camino | Qué pasó | Qué lo tapa ahora |
|---|---|---|
| **El año tapa un desmentido** | La página decía `data-original-title="Bunker"` y `data-year="2025"`. El candidato de TMDB se llamaba "Sin salida" y era de 2024. Un año de diferencia bastaba para marcar `verified`, y con eso se adoptó el póster, la sinopsis y el título de **otra película**. El vídeo era el correcto: lo que estaba mal era la ficha entera. | El año ya **no puede** respaldar cuando la fuente publica un original que no se parece a ninguno de los nombres del candidato (`originalContradice`). |
| **El hash se tira por el nombre del host** | `tmdbImagePath` solo reconocía `image.tmdb.org`, y FuegoCine enlaza desde `www.themoviedb.org` — misma ruta `/t/p/<tamaño>/<hash>`, otro servidor. La prueba de identidad más fuerte que existe se descartaba por eso. | Se aceptan los dos hosts. |
| **La imagen se busca en un solo sitio** | Se leía solo de `ul.post-details[data-backdrop]`. Las páginas de EPISODIO no tienen esa lista: su imagen vive en `link[rel=image_src]` y en un `div[data-backdrop]` suelto. Y como esas páginas son el origen de las series agrupadas, "Invencible" se quedó sin año, sin sinopsis y con un tmdb_id sintético. | Se busca en cuatro sitios, y si el hash es el **fotograma del episodio** (`4x8`) también confirma: una petición, solo cuando no hay nada más. |
| **TMDB sin texto en español** | "Max Is Missing" tenía póster, título y tmdb_id de TMDB y de sinopsis "Ver Max ha desaparecido online gratis en HD con audio Latino". TMDB la tiene vacía en es-MX y es-ES, y ahí se rendía el código. La ficha **parecía completa**. Eran 174. | Se buscan las traducciones (español primero, luego inglés) sin peticiones extra, y `--sinopsis` recupera las viejas. |

**La lección que hay detrás de las cuatro**: cada una era un dato que estaba EN LA PÁGINA o EN
TMDB y que no se llegaba a mirar. Ninguna fue un fallo de lógica de emparejamiento — fue no ir a
buscar lo que ya estaba ahí. Cuando dudes entre "el matcher se equivocó" y "no le dimos lo que
necesitaba", mira primero lo segundo.

Cómo se vigilan a futuro:

```bash
npm run check:catalog -- --fallar-si-hay-cruces   # PASO 3, 4 y 5; sale en rojo si algo se cuela
npx ts-node --transpile-only scripts/dev/probe_original_contradice.ts   # ¿alguien contradice a su fuente?
npm run repair:catalog -- --verify --apply        # re-lee la página de cada ficha y re-resuelve
npm run repair:catalog -- --sinopsis --apply      # rellena lo que TMDB sí tiene
```

> **PASO 5 no usa umbrales, y es lo que lo hace utilizable a diario.** Busca fichas a las que les
> falta algo, le PREGUNTA a TMDB si él lo tiene, y solo cuenta las que sí. Una película cuya
> sinopsis TMDB tampoco conoce no deja la corrida en rojo para siempre; un hueco que sí se puede
> rellenar sale como error desde el primer día.

> Y un aviso sobre los detectores: **el primero que escribí se inventó nueve de cada diez avisos.**
> Leía `data-original-title` con una expresión regular sobre el HTML crudo, así que
> `"Pete's Dragon"` se cortaba en el apóstrofo y daba `"Pete"`, y `Marley &amp; Me` llegaba sin
> decodificar. Lee las páginas con cheerio, igual que el scraper de verdad, o acabarás persiguiendo
> fantasmas.

---

## 5. Los SERVIDORES de tu fuente: extraer el vídeo y no ofrecer lo que está muerto

Todo lo anterior va de que la ficha sea la correcta. Esto va de que lo que hay dentro **reproduzca**.

### 5.1 "No se puede extraer" son cuatro cosas distintas

Mezclarlas hace perder semanas trabajando donde no hay nada que ganar. Cada embed sin vídeo directo
cae en una de estas casillas, y solo una pide escribir código:

| Casilla | Qué significa | Qué hacer |
|---|---|---|
| **Muerto** | El host declara que el fichero no está: 404/410, "file is no longer available", dominio aparcado en `wwN.` | **Retirarlo.** No hay nada que extraer. |
| **Ya extrae** | El extractor funciona; la ficha se guardó antes de que existiera | Repasar la ficha (`--direct-only`) |
| **Falta extractor** | La página vive y tiene reproductor, pero no encontramos la URL | Escribir el extractor |
| **No se alcanza** | Ni llegamos a mirar (TLS, DNS, timeout) | Casi siempre es problema **nuestro** |

`scripts/dev/probe_extraccion.ts` clasifica el catálogo entero en estas cuatro casillas, por host y
por número de servidores en juego. **Córrelo antes de escribir una sola línea de extractor.** La
primera vez que se corrió, de los 8.075 servidores sin vídeo directo casi la mitad estaban en la
casilla equivocada: se creía que faltaban extractores y lo que había eran ficheros borrados.

### 5.2 Trampas de servidores que ya nos han costado un arreglo

| Trampa | Qué pasó |
|---|---|
| **La URL guardada no es la que hay que pedir** | unlimplay cambió sus rutas y la fuente siguió publicando las viejas. `/play.php/embed/…` responde **200 con su página de bienvenida**: 116 KB de HTML sanísimo que ningún control de salud puede distinguir de un reproductor. 461 servidores dados por perdidos porque nadie sospechó de la propia URL. Normaliza en `unwrapRedirector`, no en el scraper: el molde viejo lo emite la fuente y volvería en cada crawl. |
| **El envoltorio está vivo y el fichero de dentro, borrado** | 940 embeds de FuegoCine son un fluidplayer de Blogger con `link=https://pixeldrain.com/api/file/<id>`. La página carga perfecta **esté el vídeo o no**, porque la página es suya y el fichero es de otro. Todos los controles miraban el envoltorio. Si tu fuente envuelve ficheros ajenos, **pregunta por el fichero** (`Range: bytes=0-1` basta). |
| **Exigir una extensión para reconocer un vídeo** | Ese mismo `pixeldrain.com/api/file/<id>` es el fichero, pero no acaba en `.mp4`. Se rechazaban 940 servidores por la FORMA de la URL teniendo el vídeo delante. |
| **La fuente es un agregador, no un host** | unlimplay no aloja nada: su HTML trae `const EMBEDS = {…}` con los hosts reales y con `remux`, su propio reensamblador, que devuelve `video/mp4` con CORS abierto. No hacía falta ningún extractor nuevo: hacía falta **leer un objeto que ya venía en el HTML**. |
| **Un mensaje de error en la plantilla no es un error mostrado** | Todas las páginas de waaw.to llevan escrito "We can't find the file you are looking for…" dentro de un `<div>` que solo se enseña si el fichero falta. Ya había pasado igual con emturbovid (`throw new Error("Subtitle file not found")` en su JS) y sus 6.265 servidores. **Comprueba siempre si la frase está en todas las páginas del host o solo en las caídas.** |
| **Un 200 no es señal de vida** | La página `/f/` de waaw responde 200 con título "Video player" aunque el vídeo esté borrado; solo su iframe interno `/e/` enseña el aviso. Y un dominio aparcado (`ww1.listeamed.net`, `ww38.vudeo.co`) responde 200 encantado. Baja hasta donde de verdad está el vídeo. |
| **Nuestro propio almacén de certificados** | `ahvsh.com` y `streamlare.com` (199 servidores) llevaban meses sin poder ni mirarse: `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. Su certificado cuelga de `ISRG Root YE`, una raíz de Let's Encrypt de 2025 que Node aún no trae. Antes de culpar al host, **comprueba si el fallo es tuyo**. Ver `src/utils/extraRoots.ts`. |
| **Nuestra propia ráfaga de peticiones** | Con 16 comprobaciones en paralelo aparecieron 19 `http-429` en 600 embeds. Un 429 provocado por nosotros no dice nada del servidor. |

### 5.3 Para BORRAR hay que ser más estricto que para ordenar

`inspectEmbed` decide si un servidor se ordena detrás; `--servidores-muertos` decide si desaparece.
Solo autorizan a borrar los motivos que significan *"el host afirma que el fichero no está"*:
404/410/451, el aviso de borrado en la página o en su iframe, el dominio aparcado, el fichero
envuelto ausente. **Nunca** un `excepcion`, un `cuerpo-vacio`, un 5xx ni una heurística de tamaño.
La lista vive en `motivoAutorizaBorrar` y el motivo de cada veredicto viaja en `EmbedInspection.motivo`
justamente para poder auditarlo:

```bash
npx ts-node --transpile-only scripts/dev/probe_extraccion.ts   # ¿dónde hay trabajo?
npx ts-node --transpile-only scripts/dev/probe_muertos.ts      # ¿por qué se condena cada uno?
npm run repair:catalog -- --servidores-muertos                 # mide
npm run repair:catalog -- --servidores-muertos --apply         # y retira
```

### 5.4 Si escribes un extractor nuevo

1. Vive en `src/scrapers/directStream.ts`, **aislado**: si el sitio cambia, ese host se queda con su
   embed y ningún otro se entera.
2. Si necesita red, va en la rama diferida (`hostDiferido`) y se resuelve **al reproducir**, no al
   crawlear: llamar a la API de un host 30.000 veces seguidas devuelve 429, y ese 429 se persistiría
   como "este servidor no tiene vídeo", que es mentira.
3. **Añade el host a `mereceRepasoDeExtraccion`.** Es la diferencia entre que el arreglo alcance a
   las 14.000 fichas ya guardadas o solo a las nuevas.
4. Si la URL lleva `ip=` o `expire=` dentro, es atada y caduca: dale su entrada en `hostPolicy.ts`
   con `ipBound: true` o entregarás un 302 que da 403 en cuanto el cliente lo pida desde su red.

### 5.5 Dónde está el límite, y por qué no se cruza

Dos hosts se quedan **a propósito** en embed, y no por falta de intentarlo:

- **waaw.to** (2.492 servidores). Su vídeo se pide con un POST a `/player/get_md5.php` que exige el
  resultado de su detección de bloqueadores, la firma de un servicio antifraude publicitario, y un
  hash de clic con sus coordenadas. Sin esas señales contesta `{"try_again":"1"}` — medido. Lo que
  hay en su HTML es un **señuelo** con marca de tiempo de 2020 que se extrae sin problema y no
  reproduce. Falsificar prueba de interacción humana y engañar a un antifraude queda fuera.
- **filemoon.to** (77 servidores). SPA que además exige una prueba de trabajo (`pow.js`) antes de
  entregar el vídeo.
- **krakenfiles.com** (43 servidores). reCAPTCHA de Google + FingerprintJS + su propio detector de
  bloqueadores. Resolver un CAPTCHA por programa queda fuera, y punto.

Y uno que se queda por tamaño, no por muro: **vidsonic.net** (38 servidores, 0,4% de los que no
tienen vídeo directo) monta un video.js que pide su fuente aparte. Se puede, simplemente no ha
tocado todavía — si algún día crece, ahí está.

Publicar un `direct_stream` muerto es **peor** que no publicar ninguno: el cliente pierde el tiempo
antes de caer al embed. Cuando no se puede extraer, se deja el embed y ya está.

---

## 6. Después de enchufar la fuente: comprobarlo

```bash
npm run check:catalog
```

- **PASO 3 · Cada ficha sirve SU contenido** — determinista y sin red: ninguna ficha puede tener en
  `source_urls` la página propia de otra. Si esto sale en rojo, hay una vía de fusión sin comprobar
  el año. `--fallar-si-hay-cruces` devuelve código 1, y es lo que pone en rojo la tarea diaria.
- **PASO 4 · Cada ficha tiene SU carátula y SU sinopsis** — se estima con una muestra, porque solo se
  puede comprobar contra la página de origen.

Reparaciones, todas con `dry-run` por defecto y `--apply` para escribir:

```bash
npm run repair:catalog -- --purgar-cache     # retira del caché lo cambiado en 24 h (¡o no se ve!)
npm run repair:catalog -- --fuentes          # retira fuentes que son de otra película
npm run repair:catalog -- --verify           # repasa fichas contra su página (carátula, sinopsis, clase)
npm run repair:catalog -- --verify --tipos   # solo las que tienen la clase volteada
npm run repair:catalog -- --unfuse           # retira alias que pertenecen a otra obra
npm run repair:catalog -- --verify --ids=a,b # solo esas fichas
```

Y lo que corre **solo** todos los días (`.github/workflows/scraper.yml`), en este orden: crawl →
purga de fuentes intrusas → repaso de 700 fichas con ventana rotatoria (da la vuelta al catálogo
cada ~21 días y vuelve a empezar) → auditoría que falla en rojo si algo se cuela.

> La ventana es **rotatoria** porque el punto de guardado es un archivo local y en un runner de CI se
> pierde en cada corrida: sin `--rotar` se repasaban eternamente las mismas primeras fichas y el
> resto del catálogo no se revisaba nunca.

---

## 7. Resumen para pegar en la pared

1. El título no identifica nada. El año, la imagen de TMDB, el título original y el dueño de la
   página sí.
2. Sin respaldo, la metadata de la fuente. Nunca la de otra obra.
3. La clase la dice la fuente.
4. Retira solo con prueba en contra.
5. Registra el molde url→id de tu fuente.
6. Lee la página en UNA función y úsala en todos los caminos que la necesiten.
7. Después de reparar, purga el caché: si no, el arreglo no se ve y parece que no funcionó.
8. Corre `check:catalog` y no te vayas hasta que los PASOS 3 y 4 estén en verde.
9. **Antes de escribir un extractor, clasifica**: muerto ≠ ya extrae ≠ falta extractor ≠ no se
   alcanza. La mitad de lo que parece faltar por extraer son ficheros borrados.
10. **Un 200 no es señal de vida**, y un mensaje de error en la plantilla no es un error mostrado.
11. **Para borrar, exige que el host lo declare.** Un timeout nuestro no es una baja suya.
12. **Una señal que confirma cuando coincide tiene que restar cuando contradice.** Si solo suma,
    no es una prueba: es un atajo.
13. **Antes de culpar al matcher, comprueba que le diste todo lo que la página publica.** Los
    cuatro cruces de metadata que han aparecido eran datos que estaban ahí y no se miraban.
14. **Un detector mal escrito es peor que ninguno**: te hace perseguir fantasmas y desconfiar de
    los avisos buenos. Lee las páginas como las lee el scraper.
