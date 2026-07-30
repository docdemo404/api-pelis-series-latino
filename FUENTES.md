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

---

## 5. Después de enchufar la fuente: comprobarlo

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

## 6. Resumen para pegar en la pared

1. El título no identifica nada. El año, la imagen de TMDB, el título original y el dueño de la
   página sí.
2. Sin respaldo, la metadata de la fuente. Nunca la de otra obra.
3. La clase la dice la fuente.
4. Retira solo con prueba en contra.
5. Registra el molde url→id de tu fuente.
6. Corre `check:catalog` y no te vayas hasta que los PASOS 3 y 4 estén en verde.
