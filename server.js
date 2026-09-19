// JustPreview backend — zero dependencies, needs Node 18+.
// Serves ./public and exposes /api/* (TMDB proxy + a simple JSON-file watchlist).

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// ---------- tiny .env loader (works on any OS / Node version) ----------
try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch (_) { /* no .env file — fine on Render, env vars are set in the dashboard */ }

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TMDB_ACCESS_TOKEN;
const TMDB_BASE = process.env.TMDB_BASE || 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p/w342';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'watchlist.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_WATCHLIST = 500;

// ---------- helpers ----------
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 10 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (_) { reject(httpError(400, 'Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ---------- TMDB ----------
const cache = new Map();

async function tmdb(pathAndQuery, ttlMs = 0) {
  if (!TOKEN) throw httpError(500, 'TMDB_ACCESS_TOKEN is not set on the server');

  const hit = cache.get(pathAndQuery);
  if (hit && hit.exp > Date.now()) return hit.data;

  let res;
  try {
    res = await fetch(TMDB_BASE + pathAndQuery, {
      headers: { Authorization: 'Bearer ' + TOKEN, accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
  } catch (_) {
    throw httpError(502, 'Could not reach TMDB');
  }
  if (!res.ok) {
    throw httpError(502, res.status === 401
      ? 'TMDB rejected the token (401) — check TMDB_ACCESS_TOKEN'
      : 'TMDB error ' + res.status);
  }
  const data = await res.json();

  if (ttlMs) {
    cache.set(pathAndQuery, { data, exp: Date.now() + ttlMs });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
  }
  return data;
}

const shape = (m) => ({
  id: m.id,
  title: m.title || m.name || 'Untitled',
  year: (m.release_date || '').slice(0, 4),
  poster: m.poster_path ? IMG_BASE + m.poster_path : '',
  rating: m.vote_average || 0,
});

// ---------- watchlist (JSON file) ----------
let watchlist = [];
try {
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (Array.isArray(parsed)) watchlist = parsed;
} catch (_) { /* first run — start empty */ }

let writeChain = Promise.resolve();
function saveWatchlist() {
  const snapshot = JSON.stringify(watchlist, null, 2);
  writeChain = writeChain.catch(() => {}).then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    await fsp.writeFile(tmp, snapshot);
    await fsp.rename(tmp, DATA_FILE);   // atomic swap, no half-written file
  });
  return writeChain;
}

// ---------- routes ----------
async function handleApi(req, res, url) {
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/trending') {
    const d = await tmdb('/trending/movie/week', 5 * 60 * 1000);
    return sendJson(res, 200, (d.results || []).map(shape));
  }

  if (req.method === 'GET' && p === '/api/now-playing') {
    const d = await tmdb('/movie/now_playing', 5 * 60 * 1000);
    return sendJson(res, 200, (d.results || []).map(shape));
  }

  if (req.method === 'GET' && p === '/api/search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) throw httpError(400, 'Missing search query');
    if (q.length > 100) throw httpError(400, 'Search query too long');
    const d = await tmdb('/search/movie?include_adult=false&query=' + encodeURIComponent(q), 60 * 1000);
    return sendJson(res, 200, (d.results || []).map(shape));
  }

  if (p === '/api/watchlist') {
    if (req.method === 'GET') return sendJson(res, 200, watchlist);

    if (req.method === 'POST') {
      const b = await readBody(req);
      const id = Number(b.id);
      const title = typeof b.title === 'string' ? b.title.trim().slice(0, 300) : '';
      if (!Number.isInteger(id) || id <= 0 || !title) throw httpError(400, 'id and title are required');

      const poster = typeof b.poster_path === 'string' && /^https?:\/\//i.test(b.poster_path)
        ? b.poster_path.slice(0, 500) : '';
      const year = String(b.year ?? '').slice(0, 10);

      if (watchlist.some((r) => r.id === id)) return sendJson(res, 200, { ok: true, already: true });
      if (watchlist.length >= MAX_WATCHLIST) throw httpError(400, 'Watchlist is full');

      watchlist.push({ id, title, year, poster_path: poster });
      await saveWatchlist();
      return sendJson(res, 201, { ok: true });
    }
  }

  const del = p.match(/^\/api\/watchlist\/(\d+)$/);
  if (del && req.method === 'DELETE') {
    const id = Number(del[1]);
    const before = watchlist.length;
    watchlist = watchlist.filter((r) => r.id !== id);
    if (watchlist.length !== before) await saveWatchlist();
    return sendJson(res, 200, { ok: true });
  }

  throw httpError(404, 'Not found');
}

// ---------- static files ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

async function serveStatic(res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); }
  catch (_) { return sendJson(res, 400, { error: 'Bad request' }); }

  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });

  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  } catch (_) {
    sendJson(res, 404, { error: 'Not found' });
  }
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Method not allowed');
    return await serveStatic(res, url.pathname);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.status ? e.message : 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log('JustPreview running on http://localhost:' + PORT);
  if (!TOKEN) console.warn('WARNING: TMDB_ACCESS_TOKEN is not set — /api/trending etc. will fail.');
});
