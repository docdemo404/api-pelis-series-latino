/**
 * FIRMA SigV4 PARA S3-COMPATIBLES (Cloudflare R2 y Backblaze B2), A MANO.
 *
 * Los casilleros son cuentas de R2/B2, y las dos hablan el mismo dialecto S3. Para subir y servir
 * sin que los bytes pasen por Vercel hacen falta URLs PREFIRMADAS: un enlace que ya lleva la firma
 * en la query, así el navegador sube directo al bucket (PUT) y el reproductor baja directo (GET).
 *
 * SE FIRMA A MANO, con el `crypto` de Node, y NO con `@aws-sdk/*` a propósito: el SDK de AWS pesa
 * varios MB y arrastra decenas de paquetes, y esta API vive en una lambda de Vercel donde el
 * tamaño importa. Todo lo que se necesita —presign de GET/PUT y una consulta firmada para validar
 * credenciales— cabe en este archivo.
 *
 * ESTILO DE RUTA: path-style (el bucket va en la ruta, `/bucket/clave`), que es lo que aceptan
 * tanto R2 (`https://<cuenta>.r2.cloudflarestorage.com/<bucket>/…`) como el endpoint S3 de B2
 * (`https://s3.<region>.backblazeb2.com/<bucket>/…`). El `host` firmado es el del endpoint.
 */
import crypto from 'crypto';

export interface CredencialesS3 {
  /** Origen del endpoint, sin barra final. Ej: https://abc123.r2.cloudflarestorage.com */
  endpoint: string;
  /** Región de firma. R2 usa 'auto'; B2 usa su región, ej 'us-west-004'. */
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const sha256Hex = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => crypto.createHmac('sha256', key).update(data).digest();

/** Codifica un componente RFC-3986: como encodeURIComponent pero también `!*'()`. */
function enc(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Codifica una clave con `/` como separadores de segmento (cada segmento va codificado aparte). */
function encPath(key: string): string {
  return key.split('/').map(enc).join('/');
}

/** Query canónica: pares codificados y ordenados por clave. */
function queryCanonica(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map(k => `${enc(k)}=${enc(params[k])}`)
    .join('&');
}

function ahoraAmz(): { amzDate: string; fecha: string } {
  const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260923T101112Z
  return { amzDate: iso, fecha: iso.slice(0, 8) };
}

function claveDeFirma(secret: string, fecha: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac('AWS4' + secret, fecha), region), 's3'), 'aws4_request');
}

interface OpcionesFirma {
  metodo: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  /** Clave del objeto dentro del bucket. Vacía para operar sobre el bucket (listar). */
  clave?: string;
  /** Parámetros de query EXTRA a incluir y firmar (ej. `response-content-type`, `list-type`). */
  extra?: Record<string, string>;
  /** Segundos de validez de la URL prefirmada. */
  expiraEn?: number;
}

/**
 * Una URL PREFIRMADA (la firma viaja en la query). Vale para que el navegador haga PUT directo o
 * el reproductor haga GET directo, sin credenciales y sin pasar por el servidor.
 */
export function urlPrefirmada(cred: CredencialesS3, opts: OpcionesFirma): string {
  const { amzDate, fecha } = ahoraAmz();
  const host = new URL(cred.endpoint).host;
  const clave = opts.clave || '';
  const uri = `/${cred.bucket}${clave ? '/' + encPath(clave) : ''}`;
  const scope = `${fecha}/${cred.region}/s3/aws4_request`;

  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cred.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(opts.expiraEn ?? 3600),
    'X-Amz-SignedHeaders': 'host',
    ...(opts.extra || {}),
  };

  const qc = queryCanonica(params);
  const canonica = [
    opts.metodo,
    uri,
    qc,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const paraFirmar = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonica)].join('\n');
  const firma = crypto.createHmac('sha256', claveDeFirma(cred.secretAccessKey, fecha, cred.region))
    .update(paraFirmar).digest('hex');

  return `${cred.endpoint}${uri}?${qc}&X-Amz-Signature=${firma}`;
}

/** GET prefirmado de un objeto. `contentType` fuerza el tipo con que se sirve (útil para .mkv). */
export function getPrefirmado(cred: CredencialesS3, clave: string, expiraEn = 3600, contentType?: string): string {
  return urlPrefirmada(cred, {
    metodo: 'GET',
    clave,
    expiraEn,
    extra: contentType ? { 'response-content-type': contentType } : undefined,
  });
}

/** PUT prefirmado para subir un objeto directo al bucket. */
export function putPrefirmado(cred: CredencialesS3, clave: string, expiraEn = 3600): string {
  return urlPrefirmada(cred, { metodo: 'PUT', clave, expiraEn });
}

/** DELETE prefirmado para borrar un objeto. */
export function deletePrefirmado(cred: CredencialesS3, clave: string, expiraEn = 900): string {
  return urlPrefirmada(cred, { metodo: 'DELETE', clave, expiraEn });
}

/**
 * URL firmada para LISTAR el bucket (list-type=2, max-keys=1). Sirve para validar credenciales al
 * añadir una cuenta: si contesta 200, las llaves y el bucket son correctos. Es de solo lectura, así
 * que no escribe nada en el casillero.
 */
export function listarPrefirmado(cred: CredencialesS3, expiraEn = 120): string {
  return urlPrefirmada(cred, { metodo: 'GET', clave: '', extra: { 'list-type': '2', 'max-keys': '1' }, expiraEn });
}

/**
 * FIRMA SigV4 CON CABECERA (Authorization), para peticiones CON CUERPO como `PutBucketCors`. A
 * diferencia de las URLs prefirmadas (payload sin firmar), aquí el cuerpo SÍ se firma —su sha256 y
 * su MD5— porque S3 lo exige para configurar el bucket. Devuelve la URL y las cabeceras a mandar.
 */
export function firmarConCabecera(cred: CredencialesS3, opts: {
  metodo: 'PUT' | 'GET' | 'DELETE' | 'POST';
  /** Clave del objeto. Vacía para operar sobre el bucket (ej. CORS). */
  clave?: string;
  /** Parámetros de query a firmar, ej. `{ cors: '' }`, `{ uploads: '' }`, `{ uploadId: '...' }`. */
  query?: Record<string, string>;
  body?: string;
  contentType?: string;
}): { url: string; headers: Record<string, string> } {
  const { amzDate, fecha } = ahoraAmz();
  const host = new URL(cred.endpoint).host;
  const clave = opts.clave || '';
  const uri = `/${cred.bucket}${clave ? '/' + encPath(clave) : ''}`;
  const body = opts.body || '';
  const payloadHash = sha256Hex(body);
  const scope = `${fecha}/${cred.region}/s3/aws4_request`;

  const query: Record<string, string> = opts.query || {};
  const qc = queryCanonica(query);

  // Cabeceras a firmar, claves en minúscula (como exige el canónico), ordenadas.
  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (body) headers['content-md5'] = crypto.createHash('md5').update(body).digest('base64');
  if (opts.contentType) headers['content-type'] = opts.contentType;

  const nombres = Object.keys(headers).sort();
  const canonicalHeaders = nombres.map(n => `${n}:${headers[n].trim()}\n`).join('');
  const signedHeaders = nombres.join(';');

  const canonica = [opts.metodo, uri, qc, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const paraFirmar = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonica)].join('\n');
  const firma = crypto.createHmac('sha256', claveDeFirma(cred.secretAccessKey, fecha, cred.region))
    .update(paraFirmar).digest('hex');

  const auth = `AWS4-HMAC-SHA256 Credential=${cred.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${firma}`;
  return {
    url: `${cred.endpoint}${uri}${qc ? '?' + qc : ''}`,
    headers: { ...headers, Authorization: auth },
  };
}

/** PUT prefirmado de UNA PARTE de una subida multipart. */
export function putPartePrefirmado(cred: CredencialesS3, clave: string, uploadId: string, partNumber: number, expiraEn = 3600): string {
  return urlPrefirmada(cred, { metodo: 'PUT', clave, expiraEn, extra: { partNumber: String(partNumber), uploadId } });
}

/** El XML de una regla CORS S3 que permite subir (PUT) y leer (GET/HEAD) desde `origenes`. */
export function corsXml(origenes: string[]): string {
  const orig = origenes.map(o => `<AllowedOrigin>${o}</AllowedOrigin>`).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
    '<CORSRule>' + orig +
    '<AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>' +
    '<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds>' +
    '</CORSRule></CORSConfiguration>';
}
