const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const API_BASE = process.env.TCGDEX_API_BASE || 'https://api.tcgdex.net/v2/ko';
const EN_API_BASE = process.env.TCGDEX_EN_API_BASE || 'https://api.tcgdex.net/v2/en';
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
  if (current && (current.promise || current.expires > Date.now())) return current.promise || current.value;
  const entry = { value: undefined, expires: 0, updatedAt: new Date().toISOString() };
  entry.promise = Promise.resolve().then(loader).then(value => {
    entry.value = value; entry.promise = null; entry.updatedAt = new Date().toISOString(); entry.expires = Date.now() + ttl;
    return value;
  }).catch(error => { if (cache.get(key) === entry) cache.delete(key); throw error; });
  cache.set(key, entry);
  return entry.promise;
}

async function fetchJson(url, options) {
  const response = await fetch(url, { headers: { Accept: 'application/json', ...(options?.headers || {}) }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`데이터 제공처 응답 오류 (${response.status})`);
  return response.json();
}

async function convertPrices(rawPrices, sourceData = {}) {
  if (!rawPrices.length) return { prices: [], exchangeRates: {} };
  const currencies = [...new Set(rawPrices.map(item => String(item.currency || '').toUpperCase()).filter(currency => currency && currency !== 'KRW'))];
  const rates = {};
  await Promise.all(currencies.map(async currency => {
    try {
      const exchange = await cached(`fx:${currency}`, () => fetchJson(`https://open.er-api.com/v6/latest/${encodeURIComponent(currency)}`), 6 * 60 * 60 * 1000);
      rates[currency] = Number(exchange?.rates?.KRW) || null;
    } catch { rates[currency] = null; }
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
      checkedAt: item.checkedAt || sourceData.checkedAt || null,
      source: item.source || sourceData.source || '가격 제공처',
      sourceUrl: item.sourceUrl || null,
      exchangeRate: rate || null,
      isInternational: item.isInternational === true,
      marketRegion: item.marketRegion || null,
      variant: item.variant || null,
    };
  }).filter(Boolean);
  return { prices, exchangeRates: rates };
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
  const converted = await convertPrices(rawPrices, { source: data.source || '외부 가격 API', checkedAt: data.checkedAt || new Date().toISOString() });
  return { ...converted, configured: true, source: data.source || '외부 가격 API', checkedAt: data.checkedAt || new Date().toISOString() };
}

function tcgdexMarketPrice(card) {
  const tcgplayer = card.pricing?.tcgplayer;
  if (tcgplayer) {
    const preferred = ['holofoil', 'normal', 'reverse-holofoil', '1stEditionHolofoil', 'unlimitedHolofoil'];
    const variants = [...preferred.map(key => [key, tcgplayer[key]]), ...Object.entries(tcgplayer)];
    for (const [variant, data] of variants) {
      const value = Number(data?.marketPrice ?? data?.midPrice);
      if (Number.isFinite(value) && value > 0) return {
        cardId: card.id, price: value, currency: 'USD', checkedAt: tcgplayer.updated || null,
        source: 'TCGplayer via TCGdex', sourceUrl: data.productId ? `https://www.tcgplayer.com/product/${data.productId}` : null,
        isInternational: true, marketRegion: 'US', variant,
      };
    }
  }
  const market = card.pricing?.cardmarket;
  const value = Number(market?.avg ?? market?.trend ?? market?.low);
  if (Number.isFinite(value) && value > 0) return {
    cardId: card.id, price: value, currency: market.unit || 'EUR', checkedAt: market.updated || null,
    source: 'Cardmarket via TCGdex', sourceUrl: market.idProduct ? `https://www.cardmarket.com/en/Pokemon/Products/Singles?searchString=${encodeURIComponent(card.name || card.id)}` : null,
    isInternational: true, marketRegion: 'EU',
  };
  return null;
}

async function pricesForCards(cards) {
  let provider = { prices: [], configured: false, source: null, checkedAt: null };
  let error = null;
  try { provider = await fetchPrices(cards.map(card => card.id).filter(Boolean)); }
  catch (caught) { error = caught.message || '가격 API 오류'; }
  const prices = [...provider.prices];
  const found = new Set(prices.map(item => item.cardId));
  const internationalRaw = cards.filter(card => card.id && !found.has(card.id)).map(tcgdexMarketPrice).filter(Boolean);
  const international = await convertPrices(internationalRaw, { source: 'TCGdex 국제 시세' });
  prices.push(...international.prices);
  return {
    prices,
    configured: prices.length > 0,
    providerConfigured: provider.configured,
    source: provider.source || (international.prices.length ? 'TCGdex 국제 시세' : null),
    checkedAt: provider.checkedAt || international.prices.find(item => item.checkedAt)?.checkedAt || null,
    error,
  };
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

function parseCsvLine(line) {
  // The species-name CSV keeps the ID, language ID, and name in its first three
  // columns. Pokémon display names themselves do not contain commas.
  return line.split(',').slice(0, 4);
}

async function pokemonNames() {
  return cached('pokemon-names-ko-en', async () => {
    const fallback = { '가디안': 'Gardevoir', '피카츄': 'Pikachu', '리자몽': 'Charizard', '이상해씨': 'Bulbasaur', '꼬부기': 'Squirtle', '뮤츠': 'Mewtwo', '루카리오': 'Lucario', '이브이': 'Eevee' };
    try {
      const csv = await fetch('https://raw.githubusercontent.com/PokeAPI/pokedex/master/pokedex/data/csv/pokemon_species_names.csv', { signal: AbortSignal.timeout(8000) }).then(async response => {
        if (!response.ok) throw new Error('Korean name dictionary unavailable');
        return response.text();
      });
      const korean = new Map();
      const english = new Map();
      for (const line of csv.split(/\r?\n/).slice(1)) {
        const [speciesId, languageId, name] = parseCsvLine(line);
        if (languageId === '9') english.set(speciesId, name);
        if (languageId === '3') korean.set(speciesId, name);
      }
      const aliases = { ...fallback };
      for (const [id, name] of korean) if (name && english.has(id)) aliases[name] = english.get(id);
      return aliases;
    } catch {
      return fallback;
    }
  }, 24 * 60 * 60 * 1000);
}

function normalizeSearch(value) { return String(value || '').normalize('NFC').trim().toLocaleLowerCase(); }

function localizePokemonName(name, aliases) {
  let result = String(name || '');
  const entries = Object.entries(aliases).sort((a, b) => b[1].length - a[1].length);
  for (const [korean, english] of entries) {
    const escaped = english.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), korean);
  }
  return result;
}

function englishSearchTerms(query, aliases) {
  let translated = String(query || '').normalize('NFC');
  for (const [korean, english] of Object.entries(aliases).sort((a, b) => b[0].length - a[0].length)) {
    translated = translated.replaceAll(korean, english);
  }
  return normalizeSearch(translated);
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
  if (pathname === '/api/search') {
    const query = (searchParams.get('q') || '').trim();
    if (query.length < 1) return send(res, 200, { query, cards: [], sets: [], source: 'TCGdex API', updatedAt: new Date().toISOString(), priceConfigured: Boolean(process.env.PRICE_API_URL) });
    const [koCards, enCards, koSets, enSets, aliases] = await Promise.all([
      cached('cards:ko', () => fetchJson(`${API_BASE}/cards`)),
      cached('cards:en', () => fetchJson(`${EN_API_BASE}/cards`)),
      cached('sets', () => fetchJson(`${API_BASE}/sets`)),
      cached('sets:en', () => fetchJson(`${EN_API_BASE}/sets`)),
      pokemonNames(),
    ]);
    const queryKey = normalizeSearch(query);
    const translated = englishSearchTerms(query, aliases);
    const packHits = koSets.filter(set => normalizeSearch(`${set.name || ''} ${set.id || ''} ${set.serie?.name || ''}`).includes(queryKey));
    for (const set of enSets) if (normalizeSearch(`${set.name || ''} ${set.id || ''}`).includes(translated)) packHits.push({ ...set, language: 'en' });
    const koreanCardHits = koCards.filter(card => normalizeSearch(`${card.name || ''} ${card.id || ''} ${card.localId || ''}`).includes(queryKey));
    const englishCardHits = enCards.filter(card => normalizeSearch(`${card.name || ''} ${card.id || ''} ${card.localId || ''}`).includes(translated));
    const matching = new Map();
    for (const card of koreanCardHits) matching.set(`ko:${card.id}`, { ...card, language: 'ko', displayName: card.name });
    for (const card of englishCardHits) matching.set(`en:${card.id}`, { ...card, language: 'en', displayName: localizePokemonName(card.name, aliases) });
    const offset = Math.max(0, Number.parseInt(searchParams.get('offset') || '0', 10) || 0);
    const summaries = [...matching.values()].slice(offset, offset + 100);
    const detailed = await mapLimit(summaries, 8, async summary => {
      const base = summary.language === 'ko' ? API_BASE : EN_API_BASE;
      try {
        const detail = await cached(`card:${summary.language}:${summary.id}`, () => fetchJson(`${base}/cards/${encodeURIComponent(summary.id)}`));
        return { ...summary, ...detail, language: summary.language, displayName: summary.displayName };
      } catch { return summary; }
    });
    const pricing = await pricesForCards(detailed);
    const priceMap = new Map(pricing.prices.map(price => [price.cardId, price]));
    const cards = detailed.map(card => ({
      ...card,
      displayName: card.displayName || (card.language === 'en' ? localizePokemonName(card.name, aliases) : card.name),
      setName: card.set?.name || card.setName || '',
      priceInfo: priceMap.get(card.id) || null,
    }));
    const englishSetMap = new Map(enSets.map(set => [set.id, set]));
    const relatedIds = new Set(cards.map(card => card.set?.id).filter(Boolean));
    for (const id of relatedIds) {
      const set = englishSetMap.get(id);
      if (set) packHits.push({ ...set, language: 'en' });
    }
    const uniqueSets = [...new Map(packHits.map(set => [set.id, { ...set, series: set.series || set.serie || null }])).values()];
    return send(res, 200, {
      query, cards, sets: uniqueSets, totalCards: matching.size,
      nextOffset: offset + summaries.length < matching.size ? offset + summaries.length : null,
      source: 'TCGdex 한국어·영어 카드 카탈로그', priceConfigured: pricing.configured,
      priceProviderConfigured: pricing.providerConfigured, priceSource: pricing.source, priceCheckedAt: pricing.checkedAt, priceError: pricing.error,
      updatedAt: new Date().toISOString(),
    });
  }
  const setMatch = pathname.match(/^\/api\/sets\/([^/]+)$/);
  if (setMatch) {
    const id = decodeURIComponent(setMatch[1]);
    const language = searchParams.get('lang') === 'en' ? 'en' : 'ko';
    const base = language === 'en' ? EN_API_BASE : API_BASE;
    const set = await cached(`set:${language}:${id}`, () => fetchJson(`${base}/sets/${encodeURIComponent(id)}`));
    const summaries = Array.isArray(set.cards) ? set.cards : [];
    // Set records contain compact card summaries. Enrich only the selected set, with a
    // small concurrency limit and per-card caching, so details are real API data.
    const cards = await mapLimit(summaries, 6, async summary => {
      if (!summary.id) return summary;
      try { return { ...summary, ...await cached(`card:${language}:${summary.id}`, () => fetchJson(`${base}/cards/${encodeURIComponent(summary.id)}`)), language }; }
      catch { return summary; }
    });
    const pricing = await pricesForCards(cards);
    const priceMap = new Map(pricing.prices.map(price => [price.cardId, price]));
    return send(res, 200, { ...set, series: set.series || set.serie || null, language, cards: cards.map(card => ({ ...card, priceInfo: priceMap.get(card.id) || null })), priceConfigured: pricing.configured, priceProviderConfigured: pricing.providerConfigured, priceSource: pricing.source, priceCheckedAt: pricing.checkedAt, priceError: pricing.error, updatedAt: new Date().toISOString() });
  }
  const cardMatch = pathname.match(/^\/api\/cards\/([^/]+)$/);
  if (cardMatch) {
    const id = decodeURIComponent(cardMatch[1]);
    const language = searchParams.get('lang') === 'en' ? 'en' : 'ko';
    const base = language === 'en' ? EN_API_BASE : API_BASE;
    const card = await cached(`card:${language}:${id}`, () => fetchJson(`${base}/cards/${encodeURIComponent(id)}`));
    const pricing = await pricesForCards([{ ...card, id }]);
    return send(res, 200, { ...card, language, priceInfo: pricing.prices.find(price => price.cardId === id) || null, priceConfigured: pricing.configured, priceProviderConfigured: pricing.providerConfigured, priceSource: pricing.source, priceCheckedAt: pricing.checkedAt, priceError: pricing.error });
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
