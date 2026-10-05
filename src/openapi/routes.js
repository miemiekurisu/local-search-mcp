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

// cancellable routes hand the handler an AbortSignal that fires when the client
// hangs up. Without it an abandoned /tools/search_web kept its engine and its
// browser page slot alive for the full engine timeout, which on a host with one or
// two slots is how one dead client makes every other client wait.
export function openApiRoute(fn, { cancellable = false } = {}) {
  return async (req, res) => {
    let args = req.body || {};
    let onClose = null;
    // req.destroyed is useless here (Node destroys an IncomingMessage as soon as
    // its body has been read), so the disconnect is tracked explicitly.
    let clientGone = false;
    if (cancellable) {
      const controller = new AbortController();
      onClose = () => {
        if (!res.writableEnded) {
          clientGone = true;
          controller.abort('OpenAPI client disconnected');
        }
      };
      res.on('close', onClose);
      args = { ...args, signal: controller.signal };
    }
    try {
      const result = await fn(args);
      res.json({ ok: true, result });
    } catch (err) {
      // The caller is gone; the rejection is our own cancellation and there is
      // nobody left to read a body. Everything else must still be reported.
      if (clientGone || res.writableEnded || res.headersSent) return;
      const statusCode = err.statusCode || 500;
      res.status(statusCode).json(normalizeToolError(err));
    } finally {
      if (onClose) res.removeListener('close', onClose);
    }
  };
}

export function registerOpenApiRoutes(app, kernel) {
  app.get('/openapi.json', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json(buildOpenApiSpec(baseUrl));
  });

  app.post('/tools/search_web', openApiRoute(args => kernel.searchWeb(args), { cancellable: true }));
  app.post('/tools/fetch_page', openApiRoute(args => kernel.fetchPage(args), { cancellable: true }));
  app.post('/tools/search_and_fetch', openApiRoute(args => kernel.searchAndFetch(args), { cancellable: true }));
  app.post('/tools/research_problem', openApiRoute(args => kernel.researchProblem(args), { cancellable: true }));
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
