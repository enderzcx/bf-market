type StaticFile = { file: string; type: string };

// Explicit SPA routes keep unknown API paths and files out of the HTML fallback.
const pages = new Set([
  '/', '/index.html', '/login', '/console', '/console/orders',
  '/console/settlements', '/console/wallet', '/docs', '/progress', '/progress-lab',
  '/market', '/records',
]);
const types: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

export function staticFileFor(path: string): StaticFile | null {
  if (path === '/demo') return { file: 'demo.html', type: 'text/html; charset=utf-8' };
  if (pages.has(path)) return { file: 'index.html', type: 'text/html; charset=utf-8' };
  // Legacy names remain available for existing HTTP fixtures. No source maps,
  // arbitrary root files, encoded separators or dot-directory traversal.
  if (path === '/app.js' || path === '/style.css') {
    return { file: path.slice(1), type: types[path.endsWith('.js') ? 'js' : 'css']! };
  }
  if (path === '/global-icon.svg' || path === '/favicon.ico') {
    return { file: path.slice(1), type: path.endsWith('.svg') ? types.svg! : types.ico! };
  }
  if (['/licenses/new-api.txt', '/fonts/geist-mono-OFL.txt', '/fonts/schibsted-OFL.txt'].includes(path)) {
    return { file: path.slice(1), type: 'text/plain; charset=utf-8' };
  }
  const match = /^\/(?:assets|fonts|images|global|brand)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.([a-z0-9]+)$/.exec(path);
  if (!match || !types[match[1]!]) return null;
  return { file: path.slice(1), type: types[match[1]!]! };
}
