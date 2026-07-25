import axios, { AxiosRequestConfig, AxiosInstance } from 'axios';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';

/** User-Agent de navegador único para todo el proyecto (antes duplicado en 4 archivos). */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const DEFAULT_TIMEOUT = 8000;

// Agentes con keep-alive para reutilizar conexiones TCP/TLS entre peticiones
// (clave para reducir latencia en el scraping de una misma fuente).
const keepAliveHttp = new HttpAgent({ keepAlive: true, maxSockets: 64 });
const keepAliveHttps = new HttpsAgent({ keepAlive: true, maxSockets: 64 });

/** Cliente axios compartido con User-Agent, timeout y keep-alive por defecto. */
export const httpClient: AxiosInstance = axios.create({
  timeout: DEFAULT_TIMEOUT,
  httpAgent: keepAliveHttp,
  httpsAgent: keepAliveHttps,
  headers: { 'User-Agent': USER_AGENT },
});

/**
 * Cliente para el camino de VÍDEO (proxy y manifiestos).
 *
 * Es hermano de `httpClient` y comparte sus agentes —que es justo el punto: el proxy usaba
 * `axios` pelado y abría un handshake TCP+TLS nuevo por cada segmento HLS, cientos por
 * película. Lo que cambia es el timeout: los 8 s por defecto sirven para scrapear una página,
 * no para empezar a servir bytes de un CDN cargado.
 */
export const streamClient: AxiosInstance = axios.create({
  timeout: 20000,
  httpAgent: keepAliveHttp,
  httpsAgent: keepAliveHttps,
  headers: { 'User-Agent': USER_AGENT },
  // OJO: `decompress` se queda en su valor por defecto (true) a propósito. Desactivarlo aquí
  // afecta también a la descarga del MANIFIESTO, que se lee como texto: el CDN lo sirve gzip,
  // los bytes crudos se decodificaban como UTF-8 y el manifiesto salía lleno de caracteres de
  // reemplazo, así que las URLs de segmento reescritas ya no existían y el CDN devolvía 400.
  // Donde sí hay que desactivarlo es en el reenvío de bytes, y se hace en esa llamada.
});

/** GET de una página HTML con cabeceras típicas de navegador (es-ES). */
export function httpGetHtml(url: string, config: AxiosRequestConfig = {}) {
  return httpClient.get(url, {
    ...config,
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9',
      ...config.headers,
    },
  });
}
