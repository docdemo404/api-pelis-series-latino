# Quitar el techo de ancho de banda

Todo el código está hecho y desplegado. Quedan **dos cosas** que requieren crear cuentas, y por
eso no las puedo hacer yo. Las dos son gratis.

Mientras no las hagas, la API funciona exactamente igual que ahora: el código nuevo está apagado
hasta que existan las variables de entorno.

---

## Por qué hacen falta (los números)

De 28 744 reproducciones posibles del catálogo:

| se sirve como | reproducciones | coste por película |
| --- | --- | --- |
| `redirect` | 19 961 (75,6 %) | **0 bytes** |
| `manifest` | 5 661 (21,4 %) | ~200 KB |
| `proxy` | **797 (3,0 %)** | **~3,2 GB** |

Todo el riesgo está en ese 3 %: con ~3,2 GB por película, unas 30 reproducciones agotan los 100 GB
del plan Hobby de Vercel.

Y hay un detalle que condiciona la solución: **793 de esas 797 están atadas por IP** (vidhideplus
772, ok.ru 26). Medido — la misma URL responde 200 desde la máquina que la acuñó y 403 desde
cualquier otra. Por eso el proxy externo no puede limitarse a reenviar: tiene que acuñar y
descargar él mismo.

---

## Tarea 1 — Contador de tránsito compartido (5 minutos)

**Qué arregla:** ahora mismo el límite de 80 GB **no funciona**. Está comprobado
(`shared_counter: false`): sin Redis, cada instancia de Vercel cuenta solo sus propios bytes, así
que el tope no se dispara nunca. Tienes la protección apagada sin saberlo.

1. Crea una base gratuita en <https://upstash.com> → *Create Database* → tipo **Redis**.
2. Copia `UPSTASH_REDIS_REST_URL` y `UPSTASH_REDIS_REST_TOKEN` de la pestaña *REST API*.
3. Ejecuta esto y pega cada valor cuando lo pida:

```bash
npx vercel env add UPSTASH_REDIS_REST_URL production
```

```bash
npx vercel env add UPSTASH_REDIS_REST_TOKEN production
```

Con esto el contador pasa a ser real y, al llegar al tope, los vídeos que atan por IP caen al
`embed_url` en vez de dejar al usuario con la pantalla en negro.

---

## Tarea 2 — Proxy en Cloudflare (10 minutos)

**Qué arregla:** el 3 % caro deja de gastar plan. Cloudflare no cobra egreso, así que el vídeo
puede pasar por ahí sin límite de tránsito.

1. Crea una cuenta gratuita en <https://dash.cloudflare.com/sign-up>.
2. Inventa una contraseña larga cualquiera (es el secreto compartido; sirve cualquier cosa difícil
   de adivinar) y guárdala a mano — hace falta en los pasos 4 y 6.
3. Desde la carpeta `worker/`, entra con tu cuenta:

```bash
npx wrangler login
```

4. Sube el secreto (te pedirá pegar la contraseña del paso 2):

```bash
npx wrangler secret put PROXY_SIGNING_KEY
```

5. Despliega el Worker. Al terminar imprime su URL, algo como
   `https://api-pelis-proxy.TU-CUENTA.workers.dev` — cópiala:

```bash
npx wrangler deploy
```

6. Vuelve a la carpeta raíz del proyecto y dale a la API esos dos datos (la URL del paso 5 y la
   contraseña del paso 2):

```bash
npx vercel env add VIDEO_PROXY_URL production
```

```bash
npx vercel env add VIDEO_PROXY_KEY production
```

7. Redespliega para que la API recoja las variables:

```bash
npx vercel --prod
```

---

## Cómo saber que funcionó

Pásame la URL del Worker y lo verifico yo. Si prefieres comprobarlo tú, esto tiene que devolver
`302` y apuntar al Worker:

```bash
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" "https://api-pelis-series-latino.vercel.app/api/v1/stream/direct?e=aHR0cHM6Ly92aWRoaWRlcGx1cy5jb20vdi8xMTlid290ZmJ4MXI"
```

Antes de la tarea 2 responde `200` y sirve el vídeo desde Vercel (gastando plan). Después responde
`302` hacia Cloudflare y Vercel no transporta ni un byte.

---

## Lo que queda sin resolver, para que lo sepas

El Worker acuña y descarga en la misma invocación, que es lo que permite servir hosts atados por
IP. Lo que **no está medido todavía** es si Cloudflare mantiene la misma IP de salida entre la
petición del embed y la de cada segmento. Si no la mantuviera, el Worker lo detecta (un 403) y
vuelve a acuñar por su cuenta, que es la misma red de seguridad que ya usa la API — pero eso hay
que verlo funcionando de verdad, no darlo por hecho. Es lo primero que comprobaré en cuanto esté
desplegado.

Si resultara que no aguanta, la alternativa es un VPS pequeño con IP fija (unos 4-5 €/mes con
20 TB de tráfico), donde el problema desaparece por completo. El mismo código del Worker sirve
casi igual.
