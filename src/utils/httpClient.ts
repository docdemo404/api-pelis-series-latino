import axios, { AxiosRequestConfig, AxiosInstance } from 'axios';
import * as tls from 'tls';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { ISRG_ROOT_YE_BY_X2 } from './extraRoots';

/** User-Agent de navegador único para todo el proyecto (antes duplicado en 4 archivos). */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const DEFAULT_TIMEOUT = 8000;

/**
 * Almacén de confianza de todas las peticiones salientes: las raíces de Node MÁS el eslabón
 * cruzado de Let's Encrypt que a Node le falta. Ver src/utils/extraRoots.ts para el por qué.
 *
 * Se pasa a los agentes de HTTPS, así que lo hereda todo lo que salga por `httpClient` o
 * `streamClient` sin tener que acordarse en cada llamada.
 */
export const CA_BUNDLE: string[] = [...tls.rootCertificates, ISRG_ROOT_YE_BY_X2];
const CA = CA_BUNDLE;

// Agentes con keep-alive para reutilizar conexiones TCP/TLS entre peticiones
// (clave para reducir latencia en el scraping de una misma fuente).
const keepAliveHttp = new HttpAgent({ keepAlive: true, maxSockets: 64 });
const keepAliveHttps = new HttpsAgent({ keepAlive: true, maxSockets: 64, ca: CA });

/**
 * Agentes SOLO para el vídeo, separados de los del scraping.
 *
 * Compartirlos significaba compartir el cupo de 64 sockets por host: un refresco de catálogo en
 * marcha podía dejar sin conexión a quien estuviera reproduciendo, y eso se nota como un parón,
 * no como un error.
 *
 * `maxFreeSockets` y un `keepAliveMsecs` alto existen para que el socket abierto contra el CDN
 * SOBREVIVA entre segmentos: llegan cada pocos segundos, y con el default de 1 s el socket ya se
 * había cerrado, así que cada segmento volvía a pagar el handshake TLS.
 */
const streamHttp = new HttpAgent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32, keepAliveMsecs: 30000 });
const streamHttps = new HttpsAgent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32, keepAliveMsecs: 30000, ca: CA });

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
 * Nace de que el proxy usaba `axios` pelado y abría un handshake TCP+TLS nuevo por cada segmento
 * HLS, cientos por película. Tiene keep-alive PROPIO (ver arriba) para que el scraping no le
 * quite sockets, y un timeout mayor: los 8 s por defecto sirven para scrapear una página, no para
 * empezar a servir bytes de un CDN cargado.
 */
export const streamClient: AxiosInstance = axios.create({
  timeout: 20000,
  httpAgent: streamHttp,
  httpsAgent: streamHttps,
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
