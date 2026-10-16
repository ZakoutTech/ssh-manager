// `npm run preview`: serve the webview GUI in a browser with a fake extension host.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { build } from 'tsdown';

const port = Number(process.env.PORT ?? 5178);
const root = join(import.meta.dirname, '..', 'preview');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };

/** Open `/reload` event streams; each gets a `change` event after every rebuild. */
const clients = new Set();

await build({
  config: false,
  entry: { main: 'preview/main.ts' },
  outDir: 'preview/dist',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  dts: false,
  hash: false,
  outputOptions: { entryFileNames: '[name].js' },
  css: { fileName: 'main.css' },
  watch: ['src', 'preview/host.ts', 'preview/main.ts'],
  onSuccess: () => clients.forEach((res) => res.write('event: change\ndata: \n\n')),
});

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/reload') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const file = normalize(join(root, path === '/' ? 'index.html' : decodeURIComponent(path)));
  if (!file.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`\n  SSH Config Manager preview: http://127.0.0.1:${port}/\n  Edits to src/ rebuild and reload the page. Ctrl+C to stop.\n`);
});
