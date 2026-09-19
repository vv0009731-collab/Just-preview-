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
const LOGO_BASE = 'https://image.tmdb.org/t/p/w92';
const WATCH_REGION = (process.env.WATCH_REGION || 'IN').toUpperCase();   // country for "where to watch"
const SITE_URL = (process.env.SITE_URL || 'https://just-preview.onrender.com').replace(/\/$/, '');
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

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(html);
}

function sendXml(res, status, xml) {
  res.writeHead(status, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(xml);
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
  if (res.status === 404) throw httpError(404, 'Not found on TMDB');
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

// Full details for one movie: overview, cast, trailer, streaming providers
function shapeDetail(d) {
  const vids = ((d.videos || {}).results || [])
    .filter((v) => v.site === 'YouTube' && /^[\w-]{6,20}$/.test(v.key || ''));
  const pick = vids.find((v) => v.type === 'Trailer' && v.official)
    || vids.find((v) => v.type === 'Trailer')
    || vids.find((v) => v.type === 'Teaser');

  const raw = (((d['watch/providers'] || {}).results || {})[WATCH_REGION]) || {};
  const providers = {};
  for (const k of ['flatrate', 'free', 'ads', 'rent', 'buy']) {
    if (Array.isArray(raw[k]) && raw[k].length) {
      providers[k] = raw[k].slice(0, 8).map((p) => ({
        name: p.provider_name,
        logo: p.logo_path ? LOGO_BASE + p.logo_path : '',
      }));
    }
  }
  const watchLink = raw.link || '';

  return {
    ...shape(d),
    runtime: d.runtime || 0,
    tagline: d.tagline || '',
    overview: d.overview || '',
    genres: (d.genres || []).map((g) => g.name),
    cast: ((d.credits || {}).cast || []).slice(0, 10).map((c) => ({ name: c.name, character: c.character || '' })),
    trailer: pick ? { key: pick.key, name: pick.name } : null,
    region: WATCH_REGION,
    providers,
    watchLink,
  };
}

// ---------- SEO: server-rendered movie page ----------
function renderMoviePage(d) {
  const title = d.title || 'Untitled';
  const year = d.year || '';
  const pageTitle = `${title}${year ? ' (' + year + ')' : ''} — Watch Trailer & Where to Stream | JustPreview`;
  const description = (d.overview || `Details, cast, trailer and streaming availability for ${title}.`).slice(0, 155);
  const poster = d.poster || '';
  const canonical = `${SITE_URL}/movie/${d.id}`;
  const genres = (d.genres || []).join(', ');
  const cast = (d.cast || []).map((c) => c.name).filter(Boolean).slice(0, 8).join(', ');
  const providers = Object.values(d.providers || {}).flat().map((p) => p.name).filter(Boolean);
  const providerList = [...new Set(providers)].join(', ');

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Movie',
    name: title,
    description: d.overview || undefined,
    image: poster || undefined,
    dateCreated: year || undefined,
    genre: d.genres && d.genres.length ? d.genres : undefined,
    aggregateRating: d.rating ? {
      '@type': 'AggregateRating',
      ratingValue: Number(d.rating).toFixed(1),
      bestRating: '10',
    } : undefined,
    actor: d.cast && d.cast.length
      ? d.cast.slice(0, 8).map((c) => ({ '@type': 'Person', name: c.name }))
      : undefined,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(pageTitle)}</title>
<meta name="description" content="${escHtml(description)}">
<link rel="canonical" href="${escHtml(canonical)}">
<meta property="og:type" content="video.movie">
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(description)}">
${poster ? `<meta property="og:image" content="${escHtml(poster)}">` : ''}
<meta property="og:url" content="${escHtml(canonical)}">
<meta name="twitter:card" content="summary_large_image">
<style>body{margin:0;background:#0a1414;color:#eafaf7;font-family:system-ui,sans-serif;line-height:1.5}.frame{max-width:700px;margin:0 auto;padding:24px 20px 60px}.d-head{display:flex;gap:16px;margin-bottom:12px}.d-head img{border-radius:8px;flex:none}a{color:#2dd4bf}</style>
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
</head>
<body>
<div class="frame">
  <p><a href="/">&larr; Back to JustPreview</a></p>
  <div class="d-head">
    ${poster ? `<img src="${escHtml(poster)}" alt="${escHtml(title)} poster" width="220">` : ''}
    <div>
      <h1>${escHtml(title)}${year ? ` (${escHtml(year)})` : ''}</h1>
      <p>${[d.runtime ? d.runtime + ' min' : '', genres, d.rating ? 'Rating: ' + Number(d.rating).toFixed(1) + '/10' : ''].filter(Boolean).map(escHtml).join(' · ')}</p>
    </div>
  </div>
  ${d.tagline ? `<p><em>${escHtml(d.tagline)}</em></p>` : ''}
  <h2>Overview</h2>
  <p>${escHtml(d.overview || 'No summary available yet.')}</p>
  ${cast ? `<h2>Cast</h2><p>${escHtml(cast)}</p>` : ''}
  ${providerList ? `<h2>Where to watch in ${escHtml(d.region || 'your region')}</h2><p>${escHtml(providerList)}</p>${d.watchLink ? `<p><a href="${escHtml(d.watchLink)}" target="_blank" rel="noopener noreferrer nofollow">View streaming options &rarr;</a></p>` : ''}` : ''}
  <p><a href="/">Open ${escHtml(title)} in the JustPreview app &rarr;</a></p>
</div>
</body>
</html>`;
}

function buildSitemapXml(ids) {
  const urls = [`${SITE_URL}/`, ...ids.map((id) => `${SITE_URL}/movie/${id}`)];
  const body = urls.map((u) => `  <url><loc>${escHtml(u)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`;
}

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

  const mv = p.match(/^\/api\/movie\/(\d+)$/);
  if (mv && req.method === 'GET') {
    const d = await tmdb('/movie/' + mv[1] + '?append_to_response=videos,credits,watch/providers&include_video_language=en,hi,null', 10 * 60 * 1000);
    return sendJson(res, 200, shapeDetail(d));
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

    if (url.pathname === '/robots.txt') {
      return sendHtml(res, 200, `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
    }

    if (url.pathname === '/sitemap.xml') {
      const [trending, nowPlaying] = await Promise.all([
        tmdb('/trending/movie/week', 5 * 60 * 1000).catch(() => ({ results: [] })),
        tmdb('/movie/now_playing', 5 * 60 * 1000).catch(() => ({ results: [] })),
      ]);
      const ids = [...new Set([...(trending.results || []), ...(nowPlaying.results || [])].map((m) => m.id))];
      return sendXml(res, 200, buildSitemapXml(ids));
    }

    const moviePage = url.pathname.match(/^\/movie\/(\d+)(?:-[\w-]*)?$/);
    if (moviePage) {
      const d = await tmdb('/movie/' + moviePage[1] + '?append_to_response=videos,credits,watch/providers&include_video_language=en,hi,null', 10 * 60 * 1000);
      return sendHtml(res, 200, renderMoviePage(shapeDetail(d)));
    }

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
