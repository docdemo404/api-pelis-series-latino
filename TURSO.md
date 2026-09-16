# Turso: qué tienes que hacer tú

La base de datos ya no es Supabase. El código habla con **Turso** (SQLite gestionado, plan
gratuito: 5 GB, 500 M filas leídas al mes, sin cobro por salida). Falta lo único que no puedo
hacer yo: crear la base y dar las claves a los tres sitios que la usan. Unos 10 minutos.

---

## 1 · Crear la base — 3 minutos

1. Entra en <https://app.turso.tech> y regístrate con GitHub (no pide tarjeta).
2. **Create Database** → nombre `api-pelis` → región la más cercana a `gru1` (São Paulo) si la
   ofrece; si no, la que quieras. **Create**.
3. En la base, pestaña **Connect** (o *Generate token*): copia dos cosas:
   - la **URL**, que empieza por `libsql://api-pelis-….turso.io`
   - un **token** (*Read & Write*, sin caducidad o la más larga que deje)

## 2 · Ponerlas en tres sitios — 5 minutos

**a) En tu máquina**, al final de `.env`:

```
TURSO_DATABASE_URL=libsql://api-pelis-….turso.io
TURSO_AUTH_TOKEN=eyJ…
```

y crea el esquema (tablas, índices, vistas). Solo hace falta una vez; repetirlo no rompe nada:

```bash
npm run db:esquema
```

**b) En Vercel**: proyecto `api-pelis-series-latino` → *Settings* → *Environment Variables* →
añade las dos (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`) para *Production*. Luego despliega:

```bash
npx vercel deploy --prod --yes --scope demo159
```

**c) En GitHub**: repo → *Settings* → *Secrets and variables* → *Actions* → *New repository
secret*, las mismas dos. Los `SUPABASE_*` ya no se usan; se pueden borrar.

## 3 · Comprobar — 2 minutos

```bash
curl -s https://api-catalogo-latino.vercel.app/api/v1/panel/estado
```

Recién creada dirá `"total":0`. Para que el catálogo empiece a llenarse sin esperar al reloj:

```bash
gh workflow run videoapi.yml
gh workflow run poblar.yml
```

Y a la media hora `panel/estado` ya da películas y series. Si en Vercel sale `500` con
`Falta TURSO_DATABASE_URL`, es que las variables no están en *Production* o el despliegue es
anterior a ponerlas.

---

## Lo que se pierde al empezar de cero (y sigue en Supabase, pausado)

No se borra nada de Supabase: si el día 21 se restaura, esto sigue allí y se podría rescatar.

- `manual_servers`: las urls de la **fuente propia** que se pegaron desde el panel.
- `subtitulos`: los subtítulos ya transcritos/traducidos (se vuelven a generar, pero cuestan).
- `playback_events`: lo que midieron los aparatos.
- Los veredictos y sellos de comprobación: el catálogo nuevo arranca sin comprobar y los jobs lo
  van sellando.

## Por qué no va a pasar lo mismo que con Supabase

Lo que tumbó Supabase fueron **bytes de salida**: jobs que se bajaban el catálogo entero
(89 MB) nueve veces al día. Turso no cobra salida; cuenta **filas leídas** (500 M/mes). Un
barrido que recorre las 15.000 fichas son 15.000 filas; nueve al día, 4 M al mes. Y los tres jobs
que hacían eso ya preguntan a vistas en vez de bajarse la tabla, así que ni eso.

Lo que sí hay que vigilar es **filas escritas** (10 M/mes): cada `update` de una ficha es una
fila. El crawl escribe unas pocas miles al día. Sobra.
