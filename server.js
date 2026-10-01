const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const API_BASE = process.env.TCGDEX_API_BASE || 'https://api.tcgdex.net/v2/ko';
const CACHE_TTL = Number(process.env.CACHE_TTL_SECONDS || 900) * 1000;
const cache = new Map();
const root = __dirname;

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

async function cached(key, loader, ttl = CACHE_TTL) {
  const current = cache.get(key);
  if (current && current.expires > Date.now()) return current.value;
  const value = await loader();
  cache.set(key, { value, expires: Date.now() + ttl, updatedAt: new Date().toISOString() });
  return value;
}

async function fetchJson(url, options) {
  const response = await fetch(url, { headers: { Accept: 'application/json', ...(options?.headers || {}) }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`데이터 제공처 응답 오류 (${response.status})`);
  return response.json();
}

async function fetchPrices(ids) {
  const endpoint = process.env.PRICE_API_URL;
  if (!endpoint || !ids.length) return { prices: [], configured: Boolean(endpoint), source: endpoint ? '외부 가격 API' : null, checkedAt: null };
  const unique = [...new Set(ids)].slice(0, 250);
  const url = new URL(endpoint);
  url.searchParams.set('ids', unique.join(','));
  const headers = {};
  if (process.env.PRICE_API_KEY) headers.Authorization = `Bearer ${process.env.PRICE_API_KEY}`;
  const data = await cached(`prices:${url.toString()}`, () => fetchJson(url, { headers }), 5 * 60 * 1000);
  const rawPrices = Array.isArray(data) ? data : data.prices;
  if (!Array.isArray(rawPrices)) return { prices: [], configured: true, source: data.source || '외부 가격 API', checkedAt: data.checkedAt || null };
  const currencies = [...new Set(rawPrices.map(item => String(item.currency || '').toUpperCase()).filter(currency => currency && currency !== 'KRW'))];
  const rates = {};
  await Promise.all(currencies.map(async currency => {
    try {
      const exchange = await cached(`fx:${currency}`, () => fetchJson(`https://open.er-api.com/v6/latest/${encodeURIComponent(currency)}`), 6 * 60 * 60 * 1000);
      rates[currency] = Number(exchange?.rates?.KRW) || null;
    } catch { rates[currency] = null; /* Keep original currency if no verified rate is available. */ }
  }));
  const prices = rawPrices.map(item => {
    if (item.price === null || item.price === undefined || item.price === '') return null;
    const amount = Number(item.price);
    const currency = String(item.currency || '').toUpperCase();
    if (!item.cardId || !Number.isFinite(amount) || amount < 0) return null;
    const rate = rates[currency];
    const krw = currency === 'KRW' ? amount : rate ? amount * rate : null;
    return {
      cardId: String(item.cardId), price: amount, currency: currency || null,
      priceKrw: krw === null ? null : Math.round(krw),
      changePercent: item.changePercent !== null && item.changePercent !== undefined && item.changePercent !== '' && Number.isFinite(Number(item.changePercent)) ? Number(item.changePercent) : null,
      checkedAt: item.checkedAt || data.checkedAt || null,
      source: item.source || data.source || '외부 가격 API',
      sourceUrl: item.sourceUrl || null,
      exchangeRate: rate || null,
    };
  }).filter(Boolean);
  return { prices, configured: true, source: data.source || '외부 가격 API', checkedAt: data.checkedAt || new Date().toISOString(), exchangeRates: rates };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function api(req, res, pathname, searchParams) {
  if (pathname === '/api/health') return send(res, 200, { ok: true, catalog: 'TCGdex', language: 'ko', priceApiConfigured: Boolean(process.env.PRICE_API_URL), updatedAt: new Date().toISOString() });
  if (pathname === '/api/sets') {
    const data = await cached('sets', () => fetchJson(`${API_BASE}/sets`));
    return send(res, 200, { data: data.map(set => ({ ...set, series: set.series || set.serie || null })), source: 'TCGdex API', updatedAt: cache.get('sets')?.updatedAt || new Date().toISOString() });
  }
  if (pathname === '/api/prices') {
    const ids = (searchParams.get('ids') || '').split(',').filter(Boolean);
    const result = await fetchPrices(ids);
    return send(res, 200, { ...result, updatedAt: new Date().toISOString() });
  }
  const setMatch = pathname.match(/^\/api\/sets\/([^/]+)$/);
  if (setMatch) {
    const id = decodeURIComponent(setMatch[1]);
    const set = await cached(`set:${id}`, () => fetchJson(`${API_BASE}/sets/${encodeURIComponent(id)}`));
    const summaries = Array.isArray(set.cards) ? set.cards : [];
    // Set records contain compact card summaries. Enrich only the selected set, with a
    // small concurrency limit and per-card caching, so details are real API data.
    const cards = await mapLimit(summaries, 6, async summary => {
      if (!summary.id) return summary;
      try { return { ...summary, ...await cached(`card:${summary.id}`, () => fetchJson(`${API_BASE}/cards/${encodeURIComponent(summary.id)}`)) }; }
      catch { return summary; }
    });
    let pricing;
    let priceError = null;
    try { pricing = await fetchPrices(cards.map(card => card.id).filter(Boolean)); }
    catch (error) { pricing = { prices: [], configured: false, source: null, checkedAt: null }; priceError = error.message || '가격 API 오류'; }
    const priceMap = new Map(pricing.prices.map(price => [price.cardId, price]));
    return send(res, 200, { ...set, series: set.series || set.serie || null, cards: cards.map(card => ({ ...card, priceInfo: priceMap.get(card.id) || null })), priceConfigured: pricing.configured, priceSource: pricing.source, priceCheckedAt: pricing.checkedAt, priceError, updatedAt: new Date().toISOString() });
  }
  const cardMatch = pathname.match(/^\/api\/cards\/([^/]+)$/);
  if (cardMatch) {
    const id = decodeURIComponent(cardMatch[1]);
    const card = await cached(`card:${id}`, () => fetchJson(`${API_BASE}/cards/${encodeURIComponent(id)}`));
    let pricing;
    let priceError = null;
    try { pricing = await fetchPrices([id]); }
    catch (error) { pricing = { prices: [], configured: false, source: null, checkedAt: null }; priceError = error.message || '가격 API 오류'; }
    return send(res, 200, { ...card, priceInfo: pricing.prices.find(price => price.cardId === id) || null, priceConfigured: pricing.configured, priceSource: pricing.source, priceCheckedAt: pricing.checkedAt, priceError });
  }
  return send(res, 404, { error: '요청한 API 경로를 찾을 수 없습니다.' });
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    try { await api(req, res, url.pathname, url.searchParams); }
    catch (error) { send(res, 502, { error: error.message || '데이터 제공처에 연결할 수 없습니다.', source: url.pathname.includes('/sets') || url.pathname === '/api/sets' ? 'TCGdex API' : '가격 API' }); }
    return;
  }
  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = path.resolve(root, `.${requested}`);
  if (!filePath.startsWith(root + path.sep) && filePath !== root) return send(res, 403, 'Forbidden');
  fs.readFile(filePath, (error, content) => {
    if (error) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(content);
  });
});

server.listen(PORT, () => console.log(`Cardlog is ready at http://localhost:${PORT}`));
