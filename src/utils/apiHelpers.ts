import { Request, Response } from 'express';

/**
 * Formato de error unificado de la API (único en todo el proyecto):
 * { status: 'error', success: false, error: { code, message } }
 *
 * Un error NUNCA se cachea. El middleware de cabeceras decide la política por la RUTA, mucho
 * antes de saber si la petición va a salir bien, así que sin esto un 502 pasajero de un segmento
 * heredaba el `s-maxage=600` de la ruta y el borde lo servía durante diez minutos: un parpadeo
 * del CDN se convertía en una avería. Se pisa aquí, que es por donde salen todos los errores.
 */
export function sendErrorResponse(res: Response, statusCode: number, code: string, message: string) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  return res.status(statusCode).json({
    status: 'error',
    success: false,
    error: {
      code,
      message
    }
  });
}

export const parsePositiveInteger = (value: unknown, fallback: number): number => {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const getPaginationParams = (req: Request, defaultLimit: number = 20, maxLimit: number = 100) => {
  const page = parsePositiveInteger(req.query.page, 1);
  const requestedLimit = req.query.limit ?? req.query.size;
  const limit = Math.min(parsePositiveInteger(requestedLimit, defaultLimit), maxLimit);
  return { page, limit };
};
