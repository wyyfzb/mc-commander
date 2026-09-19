// CORS 中间件
export function cors(options = {}) {
  const defaultOptions = {
    origin: false, // 仅允许同源请求：面板与 API 同源部署，不开放跨域
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    credentials: false,
    maxAge: 86400,
  };

  const opts = { ...defaultOptions, ...options };

  return (req, res, next) => {
    // 设置 Origin
    if (opts.origin === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (typeof opts.origin === 'string') {
      res.setHeader('Access-Control-Allow-Origin', opts.origin);
    } else if (typeof opts.origin === 'function') {
      const origin = req.headers.origin;
      if (opts.origin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    } else if (Array.isArray(opts.origin)) {
      const origin = req.headers.origin;
      if (opts.origin.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    }

    // 设置 Methods
    res.setHeader('Access-Control-Allow-Methods', opts.methods.join(', '));

    // 设置 Allowed Headers - 与白名单取交集，不直接回显客户端请求
    if (req.headers['access-control-request-headers']) {
      const requested = req.headers['access-control-request-headers']
        .split(',')
        .map((h) => h.trim().toLowerCase());
      const allowed = opts.allowedHeaders.map((h) => h.toLowerCase());
      const intersection = requested.filter((h) => allowed.includes(h));
      res.setHeader(
        'Access-Control-Allow-Headers',
        intersection.length > 0 ? intersection.join(', ') : opts.allowedHeaders.join(', '),
      );
    } else {
      res.setHeader('Access-Control-Allow-Headers', opts.allowedHeaders.join(', '));
    }

    // 设置 Exposed Headers
    if (opts.exposedHeaders.length > 0) {
      res.setHeader('Access-Control-Expose-Headers', opts.exposedHeaders.join(', '));
    }

    // Credentials
    if (opts.credentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    // Max Age
    if (opts.maxAge) {
      res.setHeader('Access-Control-Max-Age', opts.maxAge.toString());
    }

    // 处理 OPTIONS 预检请求
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    next();
  };
}

export default cors;
