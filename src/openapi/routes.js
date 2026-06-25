import { buildOpenApiSpec } from './schema.js';

function redactBrowserSession(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const { cdp_url, state_path, visible_browser_profile_dir, ...rest } = obj;
  return rest;
}

function redactErrorDetails(details) {
  if (!details || typeof details !== 'object') return details;
  const redacted = { ...details };
  if (redacted.browser_session) {
    redacted.browser_session = redactBrowserSession(redacted.browser_session);
  }
  return redacted;
}

function normalizeToolError(err) {
  const errorObject = err && typeof err === 'object' ? err : {};
  return {
    ok: false,
    error: {
      code: errorObject.code || 'TOOL_ERROR',
      message: errorObject.message || String(err),
      engine: errorObject.engine,
      details: redactErrorDetails(errorObject.details),
      stack: process.env.NODE_ENV === 'production' ? undefined : errorObject.stack,
    },
  };
}

export function openApiRoute(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req.body || {});
      res.json({ ok: true, result });
    } catch (err) {
      const statusCode = err.statusCode || 500;
      res.status(statusCode).json(normalizeToolError(err));
    }
  };
}

export function registerOpenApiRoutes(app, kernel) {
  app.get('/openapi.json', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json(buildOpenApiSpec(baseUrl));
  });

  app.post('/tools/search_web', openApiRoute(args => kernel.searchWeb(args)));
  app.post('/tools/fetch_page', openApiRoute(args => kernel.fetchPage(args)));
  app.post('/tools/search_and_fetch', openApiRoute(args => kernel.searchAndFetch(args)));
  app.post('/tools/research_problem', openApiRoute(args => kernel.researchProblem(args)));
  app.post('/tools/engine_status', openApiRoute(async () => kernel.engineStatus()));
  app.post('/tools/get_time', openApiRoute(async (args) => {
    const { getCurrentTime } = await import('../tools/time.js');
    return getCurrentTime(args?.query);
  }));
  app.post('/tools/get_weather', openApiRoute(async (args) => {
    const { searchWeather } = await import('../tools/weather.js');
    return searchWeather(args?.location);
  }));
}
