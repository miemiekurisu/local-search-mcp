export const BROWSER_SESSION_CATALOG = {
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    engine: 'chatgpt',
    homeUrl: 'https://chatgpt.com',
    loginUrl: 'https://chatgpt.com/auth/login'
  },
  google: {
    id: 'google',
    label: 'Google',
    engine: 'google',
    homeUrl: 'https://www.google.com/?hl=en',
    loginUrl: 'https://accounts.google.com/'
  },
  bing: {
    id: 'bing',
    label: 'Bing',
    engine: 'bing',
    homeUrl: 'https://www.bing.com/?setlang=en',
    loginUrl: 'https://login.live.com/'
  }
};

export function getBrowserSession(sessionId) {
  return BROWSER_SESSION_CATALOG[sessionId] || null;
}

export function getBrowserSessionByEngine(engine) {
  return Object.values(BROWSER_SESSION_CATALOG).find(session => session.engine === engine) || null;
}

export function listBrowserSessions() {
  return Object.values(BROWSER_SESSION_CATALOG);
}
