export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  if (error?.name === 'ZodError') {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request data is invalid.',
        details: error.issues.map(({ path, message }) => ({
          field: path.join('.'),
          message,
        })),
      },
    });
  }

  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'Request body must contain valid JSON.' },
    });
  }
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the 20 KB limit.' },
    });
  }

  if (error instanceof HttpError) {
    const body = {
      error: {
        code: error.code,
        message: error.message,
      },
    };
    if (error.details) body.error.details = error.details;
    return res.status(error.status).json(body);
  }

  if (error?.code === '23505') {
    return res.status(409).json({
      error: { code: 'CONFLICT', message: 'A record with that value already exists.' },
    });
  }

  console.error('Unhandled request error:', error);
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
  });
}
