import { Request, Response } from 'express';

/**
 * Formato de error unificado de la API (único en todo el proyecto):
 * { status: 'error', success: false, error: { code, message } }
 */
export function sendErrorResponse(res: Response, statusCode: number, code: string, message: string) {
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
