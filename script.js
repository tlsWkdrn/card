const HIGH_PRICE_KRW = 100000;
const state = { sets: [], selectedSet: null, details: new Map(), cardCache: new Map(), searchResult: null, searchLoading: false, searchError: null, view: 'home', filter: 'all', query: '', rarity: '', cardRarity: 'all', minPrice: 0, sort: 'newest', updatedAt: null };
const $ = selector => document.querySelector(selector);
const els = { grid: $('#pack-grid'), cards: $('#card-view'), loading: $('#loading'), empty: $('#empty-state'), notice: $('#notice'), count: $('#result-count'), title: $('#section-title'), subtitle: $('#section-subtitle'), search: $('#search-input'), dialog: $('#card-dialog'), dialogContent: $('#dialog-content') };

const directBase = 'https://api.tcgdex.net/v2';
const directCache = new Map();
async function directJson(url) {
  if (!directCache.has(url)) { const request=fetch(url,{headers:{Accept:'application/json'}}).then(async response=>{if(!response.ok)throw new Error(`카탈로그 응답 오류 (${response.status})`);return response.json();});directCache.set(url,request.catch(error=>{directCache.delete(url);throw error;})); }
  return directCache.get(url);
}
async function directText(url) {
  if (!directCache.has(url)) {const request=fetch(url).then(async response=>{if(!response.ok)throw new Error(`요청 오류 (${response.status})`);return response.text();});directCache.set(url,request.catch(error=>{directCache.delete(url);throw error;}));}
  return directCache.get(url);
}
function parseNameCsv(text) {
  const korean = new Map(), english = new Map();
  for (const line of text.split(/\r?\n/).slice(1)) {
    const values=line.split(',').slice(0,4);
    if (values[1] === '9') english.set(values[0], values[2]);
    if (values[1] === '3') korean.set(values[0], values[2]);
  }
  const aliases = { '가디안':'Gardevoir','피카츄':'Pikachu','리자몽':'Charizard','이상해씨':'Bulbasaur','꼬부기':'Squirtle','뮤츠':'Mewtwo','루카리오':'Lucario','이브이':'Eevee' };
  for (const [id, name] of korean) if (name && english.has(id)) aliases[name] = english.get(id);
  return aliases;
}
let directAliasesPromise;
function getDirectAliases() {
  if (!directAliasesPromise) directAliasesPromise = directText('https://raw.githubusercontent.com/PokeAPI/pokedex/master/pokedex/data/csv/pokemon_species_names.csv').then(parseNameCsv).catch(()=>parseNameCsv('id,language,name\n'));
  return directAliasesPromise;
}
function normalized(value) { return String(value || '').normalize('NFC').trim().toLocaleLowerCase(); }
function translatedQuery(query, aliases) {
  let result = String(query || '').normalize('NFC');
  for (const [ko,en] of Object.entries(aliases).sort((a,b)=>b[0].length-a[0].length)) result = result.replaceAll(ko,en);
  if (normalized(result) === normalized(query)) {
    const prefix = Object.entries(aliases).find(([ko])=>ko.length>=query.length && ko.startsWith(query));
    if (prefix && query.length >= 2) result = result.replace(query,prefix[1]);
  }
  return normalized(result);
}
function localizedName(name, aliases) {
  let result=String(name||'');
  for(const [ko,en] of Object.entries(aliases).sort((a,b)=>b[1].length-a[1].length)) {
    const escaped=en.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    result=result.replace(new RegExp(`\\b${escaped}\\b`,'gi'),ko);
  }
  return result;
}
function directTcgPrice(card) {
  const tcg=card.pricing?.tcgplayer;
  if(tcg){for(const key of ['holofoil','normal','reverse-holofoil',...Object.keys(tcg)]){const data=tcg[key];const value=Number(data?.marketPrice??data?.midPrice);if(data&&Number.isFinite(value)&&value>0)return {cardId:card.id,price:value,currency:'USD',checkedAt:tcg.updated||null,source:'TCGplayer via TCGdex',sourceUrl:data.productId?`https://www.tcgplayer.com/product/${data.productId}`:null,isInternational:true,marketRegion:'US',variant:key};}}
  const market=card.pricing?.cardmarket;const value=Number(market?.avg??market?.trend??market?.low);
  if(Number.isFinite(value)&&value>0)return {cardId:card.id,price:value,currency:market.unit||'EUR',checkedAt:market.updated||null,source:'Cardmarket via TCGdex',sourceUrl:`https://www.cardmarket.com/en/Pokemon/Products/Singles?searchString=${encodeURIComponent(card.name||card.id)}`,isInternational:true,marketRegion:'EU'};
  return null;
}
async function addDirectPrices(cards) {
  const raw=cards.map(directTcgPrice).filter(Boolean);const currencies=[...new Set(raw.map(price=>price.currency).filter(currency=>currency!=='KRW'))];const rates={};
  await Promise.all(currencies.map(async currency=>{try{const fx=await directJson(`https://open.er-api.com/v6/latest/${encodeURIComponent(currency)}`);rates[currency]=Number(fx?.rates?.KRW)||null;}catch{rates[currency]=null;}}));
  const prices=raw.map(item=>({...item,priceKrw:item.currency==='KRW'?Math.round(item.price):rates[item.currency]?Math.round(item.price*rates[item.currency]):null,exchangeRate:rates[item.currency]||null}));
  const map=new Map(prices.map(price=>[price.cardId,price]));
  return {cards:cards.map(card=>({...card,priceInfo:map.get(card.id)||null})),priceConfigured:prices.length>0,priceProviderConfigured:false};
}
async function directSearch(query,offset=0) {
  const key=normalized(query);
  const [koCards,enCards,koSets,enSets,aliases]=await Promise.all([
    directJson(`${directBase}/ko/cards`),directJson(`${directBase}/en/cards`),directJson(`${directBase}/ko/sets`),directJson(`${directBase}/en/sets`),getDirectAliases(),
  ]);
  const english=translatedQuery(query,aliases);
  const sets=koSets.filter(set=>normalized(`${set.name||''} ${set.id||''} ${set.serie?.name||''}`).includes(key)).map(set=>({...set,series:set.series||set.serie||null,language:'ko'}));
  const matches=new Map();
  for(const card of koCards) if(normalized(`${card.name||''} ${card.id||''} ${card.localId||''}`).includes(key)) matches.set(`ko:${card.id}`,{...card,language:'ko',displayName:card.name});
  for(const card of enCards) if(normalized(`${card.name||''} ${card.id||''} ${card.localId||''}`).includes(english)) matches.set(`en:${card.id}`,{...card,language:'en',displayName:localizedName(card.name,aliases)});
  const summaries=[...matches.values()].slice(offset,offset+100);
  let cursor=0;
  const cards=await Promise.all(Array.from({length:Math.min(6,summaries.length)},async()=>{
    const result=[];
    while(cursor<summaries.length){const item=summaries[cursor++],base=`${directBase}/${item.language}`;try{const detail=await directJson(`${base}/cards/${encodeURIComponent(item.id)}`);result.push({...item,...detail,language:item.language,displayName:item.displayName,setName:detail.set?.name||''});}catch{result.push(item);}}
    return result;
  })).then(groups=>groups.flat());
  const enSetMap=new Map(enSets.map(set=>[set.id,set]));
  for(const set of enSets)if(normalized(`${set.name||''} ${set.id||''}`).includes(english))sets.push({...set,language:'en'});
  for(const card of cards){if(card.set?.id&&enSetMap.has(card.set.id))sets.push({...enSetMap.get(card.set.id),language:'en'});}
  const uniqueSets=[...new Map(sets.map(set=>[set.id,{...set,series:set.series||set.serie||null}])).values()];
  const priced=await addDirectPrices(cards);
  return {query,cards:priced.cards,sets:uniqueSets,totalCards:matches.size,nextOffset:offset+summaries.length<matches.size?offset+summaries.length:null,source:'TCGdex 한국어·영어 카드 카탈로그',priceConfigured:priced.priceConfigured,priceProviderConfigured:false,updatedAt:new Date().toISOString()};
}

async function api(url) {
  let originalError;
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `요청 오류 (${response.status})`);
    return data;
  } catch(error) { originalError=error; }
  try {
    const parsed=new URL(url,location.origin==='null'?'http://localhost':location.origin);
    if(parsed.pathname==='/api/health') return {ok:true,catalog:'TCGdex',language:'ko',priceApiConfigured:false,frontendFallback:true,updatedAt:new Date().toISOString()};
    if(parsed.pathname==='/api/sets') { const data=await directJson(`${directBase}/ko/sets`);return {data:data.map(set=>({...set,series:set.series||set.serie||null})),source:'TCGdex API',updatedAt:new Date().toISOString(),frontendFallback:true}; }
    if(parsed.pathname==='/api/search') return await directSearch(parsed.searchParams.get('q')||'',Number(parsed.searchParams.get('offset'))||0);
    const setMatch=parsed.pathname.match(/^\/api\/sets\/([^/]+)$/);
    if(setMatch) {const language=parsed.searchParams.get('lang')==='en'?'en':'ko';const base=`${directBase}/${language}`;const set=await directJson(`${base}/sets/${encodeURIComponent(decodeURIComponent(setMatch[1]))}`);const summaries=set.cards||[];let cursor=0;const groups=await Promise.all(Array.from({length:Math.min(6,summaries.length)},async()=>{const results=[];while(cursor<summaries.length){const summary=summaries[cursor++];try{results.push({...summary,...await directJson(`${base}/cards/${encodeURIComponent(summary.id)}`),language});}catch{results.push({...summary,language});}}return results;}));const priced=await addDirectPrices(groups.flat());return {...set,language,cards:priced.cards,priceConfigured:priced.priceConfigured,priceProviderConfigured:false,frontendFallback:true};}
    const cardMatch=parsed.pathname.match(/^\/api\/cards\/([^/]+)$/);
    if(cardMatch) {const language=parsed.searchParams.get('lang')==='en'?'en':'ko';const card={...await directJson(`${directBase}/${language}/cards/${encodeURIComponent(decodeURIComponent(cardMatch[1]))}`),language};const priced=await addDirectPrices([card]);return {...priced.cards[0],priceConfigured:priced.priceConfigured,priceProviderConfigured:false,frontendFallback:true};}
  } catch(fallbackError) { throw new Error(`${originalError?.message||'백엔드 연결 오류'} · 공개 카탈로그 연결도 실패했습니다: ${fallbackError.message}`); }
  throw originalError;
}
function escapeHtml(value='') { return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
function formatDate(value) { if (!value) return '발매일 정보 없음'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR',{year:'numeric',month:'short',day:'numeric'}).format(date); }
function formatPrice(item) { if (!item) return null; if (item.priceKrw !== null && item.priceKrw !== undefined) return `₩${Number(item.priceKrw).toLocaleString('ko-KR')}`; if (item.price !== null && item.currency) return `${item.currency} ${Number(item.price).toLocaleString('en-US')}`; return null; }
function rarityCategory(rarity) {
  const value=String(rarity||'').trim().toLowerCase().replace(/[._-]+/g,' ');
  if(/special\s+(illustration|art)\s+rare|two\s+star|\bsar\b/.test(value))return 'SAR';
  if(/illustration\s+rare|art\s+rare|one\s+star|\bar\b/.test(value))return 'AR';
  if(/double\s+rare|triple\s+rare|\brrr?\b/.test(value))return 'RR';
  if(/hyper\s+rare|secret\s+rare|three\s+star|\bur\b/.test(value))return 'UR';
  if(/ultra\s+rare|super\s+rare|full\s+art|\bsr\b/.test(value))return 'SR';
  if(/^(common|uncommon|rare|rare holo|holo rare|promo|none|)$/i.test(String(rarity||'').trim())||/^(rare|holo rare)\s+(holo|v|vmax|vstar)/i.test(String(rarity||'')))return '일반';
  return '기타';
}
function rarityChipHtml(cards) {
  const options=[['all','전체'],['AR','AR'],['SR','SR'],['RR','RR'],['UR','UR'],['SAR','SAR'],['일반','일반'],['기타','기타']];
  const counts={};for(const card of cards){const category=rarityCategory(card.rarity);counts[category]=(counts[category]||0)+1;}
  return `<div class="rarity-picker" role="group" aria-label="카드 레어도 선택">${options.map(([key,label])=>`<button type="button" class="rarity-option ${state.cardRarity===key?'active':''}" data-card-rarity="${key}" aria-pressed="${state.cardRarity===key}">${label}<span>${key==='all'?cards.length:(counts[key]||0)}</span></button>`).join('')}</div>`;
}
function setImage(set) { return set.logo || set.image || set.symbol || ''; }
function cardImage(card, high=false) { if (!card.image) return ''; return `${String(card.image).replace(/\/$/,'')}/${high ? 'high' : 'low'}.png`; }
function allLoadedCards() { return [...state.details.values()].flatMap(set => (set.cards || []).map(card => ({ ...card, setName: set.name, setId: set.id }))); }
function visibleCards() {
  const cards=state.query.trim()?state.searchResult?.cards||[]:allLoadedCards();
  return state.query.trim()&&state.cardRarity!=='all'?cards.filter(card=>rarityCategory(card.rarity)===state.cardRarity):cards;
}
function highCards() { return visibleCards().filter(card => Number(card.priceInfo?.priceKrw) >= HIGH_PRICE_KRW); }
function setHighCount(set) { return (set.cards || []).filter(card => Number(card.priceInfo?.priceKrw) >= HIGH_PRICE_KRW).length; }
function setKey(set) { return `${set.language || 'ko'}:${set.id}`; }
function setDetailFor(set) { return state.details.get(setKey(set)) || state.details.get(set.id); }
function cardKey(language,id) { return `${language || 'ko'}:${id}`; }
let searchSequence=0, searchTimer;
function queueCatalogSearch(query) {
  clearTimeout(searchTimer);
  const sequence=++searchSequence;
  state.searchResult=null;state.searchError=null;
  if(query.trim().length<2){state.searchLoading=false;updateStats();render();return;}
  updateStats();
  state.searchLoading=true;render();
  searchTimer=setTimeout(async()=>{
    try { const result=await api(`/api/search?q=${encodeURIComponent(query.trim())}`);if(sequence!==searchSequence)return;state.searchResult=result;state.updatedAt=result.updatedAt||state.updatedAt;for(const card of result.cards||[])state.cardCache.set(cardKey(card.language,card.id),card);state.searchLoading=false;updateStats();render(); }
    catch(error){if(sequence!==searchSequence)return;state.searchLoading=false;state.searchError=error.message;updateStats();render();}
  },300);
}
async function loadMoreSearch() {
  if(!state.searchResult?.nextOffset||state.searchLoading)return;
  state.searchLoading=true;renderSearchResults();
  try{const next=await api(`/api/search?q=${encodeURIComponent(state.query.trim())}&offset=${state.searchResult.nextOffset}`);if(state.query.trim()!==next.query)return;const cards=[...(state.searchResult.cards||[]),...(next.cards||[])];const sets=[...(state.searchResult.sets||[]),...(next.sets||[])];state.searchResult={...next,cards,sets:[...new Map(sets.map(set=>[set.id,set])).values()]};for(const card of next.cards||[])state.cardCache.set(cardKey(card.language,card.id),card);state.searchLoading=false;state.updatedAt=next.updatedAt||state.updatedAt;updateStats();renderSearchResults();}
  catch(error){state.searchLoading=false;state.searchError=error.message;renderSearchResults();}
}
function showNotice(message, isError=false) { els.notice.textContent = message; els.notice.classList.toggle('error', isError); els.notice.classList.remove('hidden'); }
function hideNotice() { els.notice.classList.add('hidden'); }
function updateStatus(isConnected) { const indicator = $('.live-status'); indicator.classList.toggle('connected', isConnected); indicator.innerHTML = `<i></i> ${isConnected?'카탈로그 연결됨':'API 연결 대기'}`; }
function updateStats() {
  $('#stat-sets').textContent = state.sets.length ? state.sets.length.toLocaleString('ko-KR') : '—';
  const high = highCards().length;
  const loaded = visibleCards();
  const pricedCount = loaded.filter(card => Number.isFinite(Number(card.priceInfo?.priceKrw)) && card.priceInfo?.priceKrw !== null && card.priceInfo?.priceKrw !== undefined).length;
  const configured = state.query.trim() ? Boolean(state.searchResult?.priceConfigured) : [...state.details.values()].some(set => set.priceConfigured);
  $('#stat-high').textContent = configured ? high.toLocaleString('ko-KR') : '—';
  $('#stat-coverage').textContent = configured ? `${pricedCount.toLocaleString('ko-KR')}장` : state.query.trim() ? '시세 미확인' : '카드 검색 시 확인';
  $('#stat-updated').textContent = state.updatedAt ? new Intl.DateTimeFormat('ko-KR',{hour:'2-digit',minute:'2-digit'}).format(new Date(state.updatedAt)) : '—';
  $('#insight-high').textContent = configured ? high.toLocaleString('ko-KR') : '가격 미확인';
  $('#insight-ratio').textContent = pricedCount ? `${(high / pricedCount * 100).toFixed(1)}%` : '—';
  $('#insight-catalog').textContent = state.sets.length ? `${state.sets.length.toLocaleString('ko-KR')}개 카드팩` : '불러오는 중';
}
function loadState(showLoading=true) { els.loading.classList.toggle('hidden',!showLoading); els.empty.classList.add('hidden'); els.grid.classList.toggle('hidden',showLoading); els.cards.classList.add('hidden'); }

async function loadSets() {
  loadState(true); hideNotice();
  try {
    const result = await api('/api/sets');
    state.sets = Array.isArray(result.data) ? result.data : [];
    state.updatedAt = result.updatedAt; updateStatus(true); updateStats(); render();
    const health = await api('/api/health').catch(()=>null);
    if (!health?.priceApiConfigured) showNotice('카드 검색 결과에 TCGplayer/Cardmarket 해외 시세가 있으면 환율 환산 참고값으로 표시합니다. 한국판·국내 거래 시세와 다를 수 있으며, 확인할 수 없는 가격은 만들지 않습니다.');
  } catch (error) {
    state.sets = []; updateStatus(false); els.loading.classList.add('hidden'); els.grid.classList.add('hidden'); els.empty.classList.remove('hidden'); $('#empty-title').textContent='카드 카탈로그를 불러오지 못했습니다'; $('#empty-copy').textContent=`${error.message} 서버 연결과 인터넷 상태를 확인해 주세요.`; showNotice(`카탈로그 API 오류: ${error.message}`, true);
  }
}

function filteredSets() {
  const query = state.query.trim().toLocaleLowerCase();
  let result = state.sets.filter(set => {
    if (!query) return true;
    const fields=`${set.name||''} ${set.id||''} ${set.series?.name||''}`.toLocaleLowerCase();
    const cardMatch=(setDetailFor(set)?.cards||[]).some(card=>`${card.name||''} ${card.localId||''} ${card.id||''}`.toLocaleLowerCase().includes(query));
    return fields.includes(query)||cardMatch;
  });
  if (state.filter === 'available') result = []; // Catalog data does not certify Korean retail availability.
  if (state.filter === 'high') result = result.filter(set => setDetailFor(set) && setHighCount(setDetailFor(set)) > 0);
  if (state.minPrice) result = result.filter(set => (setDetailFor(set)?.cards || []).some(card => Number(card.priceInfo?.priceKrw) >= state.minPrice));
  if (state.rarity) result = result.filter(set => (setDetailFor(set)?.cards || []).some(card => card.rarity === state.rarity));
  if (state.sort === 'name') result.sort((a,b)=>(a.name||'').localeCompare(b.name||'','ko'));
  if (state.sort === 'newest') result.sort((a,b)=>(b.releaseDate||'').localeCompare(a.releaseDate||''));
  if (state.sort === 'high') result.sort((a,b)=>setHighCount(setDetailFor(b)||{})-setHighCount(setDetailFor(a)||{}));
  if (state.sort === 'price') result.sort((a,b)=>maxSetPrice(setDetailFor(b))-maxSetPrice(setDetailFor(a)));
  return result;
}
function maxSetPrice(set) { return Math.max(0,...(set?.cards||[]).map(card=>Number(card.priceInfo?.priceKrw)||0)); }
function packCardMarkup(set) {
  const detail=setDetailFor(set); const count=detail?.priceConfigured?setHighCount(detail):null; const max=detail?.priceConfigured?maxSetPrice(detail):null;
  return `<article class="pack-card" data-pack-id="${escapeHtml(set.id||'')}" data-pack-language="${escapeHtml(set.language||'ko')}" tabindex="0" role="button" aria-label="${escapeHtml(set.name||set.id)} 상세 보기"><div class="pack-visual">${setImage(set)?`<img src="${escapeHtml(setImage(set))}" alt="${escapeHtml(set.name||'카드팩 이미지')}" loading="lazy" onerror="this.remove()">`:'<div class="pack-placeholder">✦</div>'}<span class="pack-tag">${escapeHtml(set.series?.name||set.serie?.name||'CARD SET')}</span></div><div class="pack-body"><h3 title="${escapeHtml(set.name||set.id)}">${escapeHtml(set.name||set.id)}</h3><div class="pack-meta">${escapeHtml(formatDate(set.releaseDate))} · ${set.cardCount?.total??set.cardCount?.official??'—'}장 · ${set.language==='en'?'국제판 데이터':'한국어 카탈로그'}</div><div class="pack-facts"><span>₩100,000 이상 카드</span><strong class="pack-high">${count===null?'가격 미확인':`${count}장`}</strong></div><div class="pack-facts"><span>최고 확인 가격</span><strong>${max===null?'—':max?`₩${max.toLocaleString('ko-KR')}`:'가격 정보 없음'}</strong></div><div class="pack-status"><i class="status-dot"></i> 국내 판매 여부 미확인</div></div></article>`;
}
function bindPackCards(container) {
  container.querySelectorAll('.pack-card').forEach(card=>{
    const open=()=>openSet({id:card.dataset.packId,language:card.dataset.packLanguage,name:card.querySelector('h3')?.textContent});
    card.addEventListener('click',open);card.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}});
  });
}
function renderSets() {
  const sets=filteredSets(); els.count.textContent=`${sets.length.toLocaleString('ko-KR')}개`;
  els.loading.classList.add('hidden'); els.cards.classList.add('hidden'); els.grid.classList.remove('hidden'); els.grid.innerHTML='';
  if (!sets.length) { els.grid.classList.add('hidden'); els.empty.classList.remove('hidden'); $('#empty-title').textContent=state.filter==='available'?'공식 판매 여부가 확인된 카드팩이 없습니다':'검색 결과가 없습니다'; $('#empty-copy').textContent=state.filter==='available'?'TCGdex는 카드 데이터 카탈로그이며 국내 판매 중 여부를 제공하지 않습니다. 확인되지 않은 상품은 판매 중으로 표시하지 않습니다.':'검색어와 필터를 바꾸거나 다른 카드팩을 확인해 주세요.'; return; }
  els.empty.classList.add('hidden');
  els.grid.innerHTML=sets.map(packCardMarkup).join('');bindPackCards(els.grid);
}

function renderSearchResults() {
  els.loading.classList.add('hidden');els.empty.classList.add('hidden');els.grid.classList.add('hidden');els.cards.classList.remove('hidden');
  els.title.textContent='검색 결과';els.subtitle.textContent=`“${state.query.trim()}” 카드·카드팩 통합 검색`;
  if(state.query.trim().length<2){els.cards.innerHTML='<div class="empty-state"><strong>검색어를 두 글자 이상 입력해 주세요</strong><p>한국어·영어 포켓몬 이름, 카드명, 카드 번호, 카드팩 이름을 검색할 수 있습니다.</p></div>';els.count.textContent='검색어 입력';return;}
  if(state.searchLoading&& !state.searchResult){els.cards.innerHTML='<div class="loading-state"><span class="spinner"></span><strong>카드와 카드팩을 검색하고 있어요</strong><span>전체 카탈로그와 한국어 포켓몬 이름을 확인 중입니다.</span></div>';els.count.textContent='검색 중';return;}
  if(state.searchError){els.cards.innerHTML=`<div class="empty-state"><strong>검색 요청을 완료하지 못했습니다</strong><p>${escapeHtml(state.searchError)} 공개 카탈로그에 다시 연결할 수 있는지 확인해 주세요.</p><button class="primary-button" id="search-retry">다시 검색 <span>→</span></button></div>`;$('#search-retry').addEventListener('click',()=>queueCatalogSearch(state.query));els.count.textContent='오류';return;}
  const result=state.searchResult||{cards:[],sets:[],totalCards:0};
  const allCards=result.cards||[];
  let cards=allCards;
  if(state.cardRarity!=='all')cards=cards.filter(card=>rarityCategory(card.rarity)===state.cardRarity);
  if(state.rarity)cards=cards.filter(card=>card.rarity===state.rarity);
  if(state.minPrice)cards=cards.filter(card=>Number(card.priceInfo?.priceKrw)>=state.minPrice);
  if(state.filter==='high')cards=cards.filter(card=>Number(card.priceInfo?.priceKrw)>=HIGH_PRICE_KRW);
  cards=[...cards].sort((a,b)=>(Number(b.priceInfo?.priceKrw)||0)-(Number(a.priceInfo?.priceKrw)||0));
  const sets=result.sets||[];
  els.count.textContent=`${cards.length}장 · ${sets.length}팩`;
  const hasInternationalPrice=allCards.some(card=>card.priceInfo?.isInternational);
  const disclaimer=hasInternationalPrice?`<div class="market-disclaimer">표시 가격은 TCGplayer/Cardmarket 해외 시세를 환율로 원화 환산한 참고값이며 한국판·국내 거래 가격과 다를 수 있습니다.${result.priceError?` 가격 API 오류: ${escapeHtml(result.priceError)}`:''}</div>`:result.priceProviderConfigured?'':`<div class="market-disclaimer">이 검색 결과에서 확인 가능한 시세가 없습니다. 가격은 임의로 만들지 않으며, 가격 제공처가 연결되면 표시합니다.${result.priceError?` 가격 API 오류: ${escapeHtml(result.priceError)}`:''}</div>`;
  const cardSection=allCards.length?`${rarityChipHtml(allCards)}<div class="search-result-heading">카드 <span>${cards.length}${result.totalCards>cards.length?` / ${result.totalCards}`:''}장</span></div>${cards.length?`<div class="card-list">${cards.map(cardMarkup).join('')}</div>${result.nextOffset?'<button class="primary-button search-more" id="search-more">더 많은 카드 보기 →</button>':''}`:`<div class="empty-state compact-empty"><strong>${state.cardRarity==='all'?'일치하는 카드가 없습니다':`${state.cardRarity} 카드가 없습니다`}</strong><p>다른 레어도 필터를 선택하거나 검색어를 바꿔 보세요.</p></div>`}`:`${rarityChipHtml([])}<div class="empty-state compact-empty"><strong>일치하는 카드가 없습니다</strong><p>관련 카드팩을 확인하거나 검색어를 바꿔 보세요.</p></div>`;
  const packSection=sets.length?`<div class="search-result-heading">관련 카드팩 <span>${sets.length}개</span></div><div class="pack-grid search-pack-grid">${sets.map(packCardMarkup).join('')}</div>`:'';
  els.cards.innerHTML=`<div class="card-toolbar"><button class="back-button" data-clear-search>← 전체 카드팩</button><strong class="set-detail-title">${escapeHtml(state.query.trim())} 검색 결과 <span class="heading-count">${result.totalCards>allCards.length?`${allCards.length}/${result.totalCards}장`: `${allCards.length}장`}</span></strong><span class="unknown-price">TCGdex · ${escapeHtml(result.updatedAt?new Date(result.updatedAt).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}):'갱신 정보 없음')}</span></div>${disclaimer}${cardSection}${packSection}${state.searchLoading?'<p class="price-disclaimer search-more-loading">추가 카드 결과를 불러오는 중입니다…</p>':''}`;
  els.cards.querySelector('[data-clear-search]').addEventListener('click',()=>{clearTimeout(searchTimer);searchSequence++;state.searchLoading=false;els.search.value='';state.query='';state.searchResult=null;state.searchError=null;updateStats();render();});
  bindPackCards(els.cards);
  els.cards.querySelectorAll('.trading-card').forEach(card=>card.addEventListener('click',()=>openCard(card.dataset.id,card.dataset.language)));
  const moreButton=$('#search-more');moreButton?.addEventListener('click',loadMoreSearch);if(moreButton&&state.searchLoading){moreButton.disabled=true;moreButton.textContent='불러오는 중…';}
  els.cards.querySelectorAll('[data-card-rarity]').forEach(button=>button.addEventListener('click',()=>{state.cardRarity=button.dataset.cardRarity;updateStats();renderSearchResults();}));
}

function renderCardView() {
  els.loading.classList.add('hidden'); els.grid.classList.add('hidden'); els.empty.classList.add('hidden'); els.cards.classList.remove('hidden');
  const cards=allLoadedCards();
  const query=state.query.trim().toLocaleLowerCase();
  let filtered=cards.filter(card=>!query||`${card.name||''} ${card.localId||''} ${card.id||''} ${card.setName||''}`.toLocaleLowerCase().includes(query));
  if(state.rarity) filtered=filtered.filter(card=>card.rarity===state.rarity);
  if(state.minPrice) filtered=filtered.filter(card=>Number(card.priceInfo?.priceKrw)>=state.minPrice);
  if(state.view==='ranking') filtered=filtered.filter(card=>Number(card.priceInfo?.priceKrw)>=HIGH_PRICE_KRW).sort((a,b)=>Number(b.priceInfo.priceKrw)-Number(a.priceInfo.priceKrw)).slice(0,20);
  else filtered.sort((a,b)=>(a.name||'').localeCompare(b.name||'','ko'));
  const label=state.view==='ranking'?'가격 랭킹':'카드 탐색';
  els.cards.innerHTML=`<div class="card-toolbar"><button class="back-button" data-back>← 카드팩 목록</button><strong class="set-detail-title">${label} <span class="heading-count">${filtered.length}장</span></strong><div class="card-filter-row">${state.selectedSet?`<button class="quiet-button" data-back>카드팩으로 돌아가기</button>`:''}</div></div>${cards.length===0?`<div class="empty-state"><div class="empty-icon">▧</div><strong>카드 목록을 불러와 주세요</strong><p>카드팩을 선택하면 카드 상세 정보를 가져옵니다. 전체 카탈로그를 한꺼번에 요청하지 않아 데이터 제공처에 부담을 주지 않습니다.</p><button class="primary-button" data-back>카드팩 둘러보기 <span>→</span></button></div>`:state.view==='ranking'&&!filtered.length?`<div class="empty-state"><strong>표시할 고가 카드가 없습니다</strong><p>가격 API가 연결되고 ₩100,000 이상인 가격이 확인되면 여기에 표시됩니다.</p></div>`:`<p class="price-disclaimer">확인된 가격이 없는 카드는 ‘가격 정보 없음’으로 표시됩니다. 출처와 확인 시각은 각 카드 상세에서 확인할 수 있습니다.</p><div class="card-list">${filtered.map(card=>cardMarkup(card)).join('')}</div>`}`;
  els.cards.querySelectorAll('[data-back]').forEach(button=>button.addEventListener('click',()=>{state.selectedSet=null;state.view='home';setNav('home');render();}));
  els.cards.querySelectorAll('.trading-card').forEach(card=>card.addEventListener('click',()=>openCard(card.dataset.id,card.dataset.language)));
  els.count.textContent=`${filtered.length.toLocaleString('ko-KR')}장`;
}
function cardMarkup(card) {
  const price=formatPrice(card.priceInfo); const image=cardImage(card);const category=rarityCategory(card.rarity);
  const imageMarkup=image?`<img src="${escapeHtml(image)}" alt="${escapeHtml(card.displayName||card.name||'카드 이미지')}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'card-image-placeholder',textContent:'이미지 없음'}))">`:'<div class="card-image-placeholder">이미지 없음</div>';
  const marketNote=card.priceInfo?.isInternational?`<small class="market-note">${escapeHtml(card.priceInfo.currency||'')} ${Number(card.priceInfo.price).toLocaleString('en-US')}${card.priceInfo.variant?` · ${escapeHtml(card.priceInfo.variant)}`:''} · ${escapeHtml(card.priceInfo.marketRegion||'해외')} 참고 시세</small>`:'';
  return `<article class="trading-card" data-id="${escapeHtml(card.id||'')}" data-language="${escapeHtml(card.language||'ko')}" tabindex="0">${imageMarkup}<div class="trading-card-body"><h3>${escapeHtml(card.displayName||card.name||card.id||'이름 정보 없음')} <span class="rarity-category rarity-${escapeHtml(category)}">${escapeHtml(category)}</span></h3><div class="subline">${escapeHtml(card.setName||card.set?.name||'')} · No. ${escapeHtml(card.localId||'—')} · ${escapeHtml(card.rarity||'레어도 미확인')} · ${card.language==='en'?'국제판':'한국어'}</div><div class="card-price"><strong>${price?escapeHtml(price):'<span class="unknown-price">가격 정보 없음</span>'}</strong>${Number(card.priceInfo?.priceKrw)>=HIGH_PRICE_KRW?'<span class="high-badge">HIGH VALUE</span>':''}</div>${marketNote}</div></article>`;
}

async function openSet(set) {
  state.selectedSet=set; state.view='set'; els.title.textContent=set.name||'카드팩 상세'; els.subtitle.textContent='카드 정보를 불러오는 중입니다.'; loadState(true); hideNotice();
  try {
    const key=setKey(set);const detail=state.details.get(key)||await api(`/api/sets/${encodeURIComponent(set.id)}${set.language==='en'?'?lang=en':''}`);
    state.details.set(key,detail);for(const card of detail.cards||[])state.cardCache.set(cardKey(detail.language||set.language,card.id),card);state.updatedAt=detail.updatedAt||state.updatedAt;
     state.view='set'; setNav('cards'); updateStats(); renderSetCards(detail); refreshRarityOptions();
     const total=detail.cards?.length||0; const high=setHighCount(detail); const priceApi=detail.priceConfigured;
     els.subtitle.textContent=`${formatDate(detail.releaseDate)} · ${total}장 · 100,000원 이상 ${priceApi?`${high}장`:'가격 미확인'} · 국내 판매 여부 미확인`;
     if(detail.priceError) showNotice(`가격 API 오류: ${detail.priceError} 카드 목록은 계속 이용할 수 있으며, 확인된 해외 시세는 환산 참고값으로 표시합니다.`,true);
     else if(detail.cards?.some(card=>card.priceInfo?.isInternational)) showNotice('표시 가격은 TCGplayer/Cardmarket 해외 시세의 원화 환산 참고값이며 한국판·국내 거래 가격과 다를 수 있습니다.');
     else if(!priceApi) showNotice('이 카드팩에서 확인 가능한 시세가 없습니다. 가격 정보가 없으면 임의로 표시하지 않습니다.');
  } catch(error) { state.view='set'; els.loading.classList.add('hidden'); els.grid.classList.add('hidden'); els.cards.classList.remove('hidden'); els.cards.innerHTML=`<div class="empty-state"><strong>카드팩 데이터를 불러오지 못했습니다</strong><p>${escapeHtml(error.message)}</p><button class="primary-button" id="detail-retry">다시 시도 →</button><button class="back-button" id="detail-back">카드팩 목록</button></div>`; $('#detail-retry').addEventListener('click',()=>openSet(set));$('#detail-back').addEventListener('click',()=>{state.view='home';state.selectedSet=null;setNav('home');render();}); }
}
function renderSetCards(detail) {
  const cards=detail.cards||[];
  const ordered=[...cards].sort((a,b)=>(Number(b.priceInfo?.priceKrw)||-1)-(Number(a.priceInfo?.priceKrw)||-1));
  els.loading.classList.add('hidden'); els.grid.classList.add('hidden'); els.empty.classList.add('hidden'); els.cards.classList.remove('hidden');
   els.cards.innerHTML=`<div class="card-toolbar"><button class="back-button" data-back>← 카드팩 목록</button><strong class="set-detail-title">${escapeHtml(detail.name||detail.id)} <span class="heading-count">${cards.length}장</span></strong><div class="card-filter-row"><button class="quiet-button" data-copy-set>정보 복사</button></div></div>${cards.length?`<p class="price-disclaimer">카드 번호 · 레어도 · 가격 높은 순 · 가격 미확인 카드는 아래쪽에 표시됩니다.</p><div class="card-list">${ordered.map(card=>cardMarkup({...card,language:card.language||detail.language,setName:detail.name})).join('')}</div>`:`<div class="empty-state"><strong>이 카드팩의 카드 목록을 확인할 수 없습니다</strong><p>카탈로그 출처에서 이 세트의 카드별 정보를 제공하지 않습니다.</p></div>`}`;
  els.cards.querySelector('[data-back]').addEventListener('click',()=>{state.view='home';state.selectedSet=null;setNav('home');render();});
  els.cards.querySelector('[data-copy-set]').addEventListener('click',async()=>{const text=`${detail.name||detail.id} | ${formatDate(detail.releaseDate)} | ${cards.length} cards | TCGdex`;try{await navigator.clipboard.writeText(text);showNotice('카드팩 정보가 클립보드에 복사되었습니다.');}catch{showNotice('클립보드 복사 권한이 없습니다.',true);}});
  els.cards.querySelectorAll('.trading-card').forEach(card=>card.addEventListener('click',()=>openCard(card.dataset.id,card.dataset.language)));
  els.count.textContent=`${cards.length.toLocaleString('ko-KR')}장`;
}
async function openCard(id,language='ko') {
  try {
    const card=state.cardCache.get(cardKey(language,id))||await api(`/api/cards/${encodeURIComponent(id)}${language==='en'?'?lang=en':''}`);state.cardCache.set(cardKey(language,id),card);const price=formatPrice(card.priceInfo); const image=cardImage(card,true)||cardImage(card);
    if(card.priceError) showNotice(`가격 API 오류: ${card.priceError} 카드 정보는 계속 이용할 수 있습니다.`,true);
    const priceText=price?escapeHtml(price):'가격 정보 없음';
    els.dialogContent.innerHTML=`<div class="dialog-card">${image?`<img src="${escapeHtml(image)}" alt="${escapeHtml(card.displayName||card.name||'카드 이미지')}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'dialog-art-empty',textContent:'이미지 없음'}))">`:'<div class="dialog-art-empty">이미지 미제공</div>'}<div class="dialog-info"><span class="eyebrow section-eyebrow">POKÉMON CARD</span><h2>${escapeHtml(card.displayName||card.name||'이름 정보 없음')}</h2><p class="dialog-set">${escapeHtml(card.set?.name||card.setName||'카드팩 정보 없음')} · No. ${escapeHtml(card.localId||'—')}</p><div class="dialog-price">${priceText}</div><span class="unknown-price">${Number(card.priceInfo?.priceKrw)>=HIGH_PRICE_KRW?'₩100,000 이상':''}</span><dl><dt>레어도</dt><dd>${escapeHtml(card.rarity||'정보 없음')} (${rarityCategory(card.rarity)})</dd><dt>카드 번호</dt><dd>${escapeHtml(card.localId||'정보 없음')}</dd><dt>가격 변동</dt><dd>${card.priceInfo?.changePercent===null||card.priceInfo?.changePercent===undefined?'데이터를 확인할 수 없음':`${card.priceInfo.changePercent>0?'+':''}${card.priceInfo.changePercent}%`}</dd><dt>가격 출처</dt><dd>${escapeHtml(card.priceInfo?.source||'가격 정보 없음')}</dd><dt>최종 확인</dt><dd>${escapeHtml(card.priceInfo?.checkedAt?new Date(card.priceInfo.checkedAt).toLocaleString('ko-KR'):'가격 데이터 미확인')}</dd><dt>판매 여부</dt><dd>한국 내 판매 정보 미확인</dd></dl><div class="dialog-actions"><button id="copy-card">정보 복사</button>${card.priceInfo?.sourceUrl?`<a href="${escapeHtml(card.priceInfo.sourceUrl)}" target="_blank" rel="noopener noreferrer">가격 출처 열기 ↗</a>`:''}${card.set?.id?`<a href="https://www.tcgdex.net/database/${encodeURIComponent(card.set.id)}/${encodeURIComponent(card.id)}" target="_blank" rel="noopener noreferrer">카드 정보 출처 ↗</a>`:''}</div></div></div>`;
    if(card.priceInfo?.isInternational){const note=document.createElement('small');note.className='market-note dialog-market-note';note.textContent=`${card.priceInfo.currency||''} ${Number(card.priceInfo.price).toLocaleString('en-US')} · ${card.priceInfo.marketRegion||'해외'} 시세 참고값 (국내 가격 아님)`;els.dialogContent.querySelector('.dialog-price').after(note);}
    $('#copy-card').addEventListener('click',async()=>{const text=[card.displayName||card.name,card.set?.name||card.setName,`No. ${card.localId||'—'}`,card.rarity||'레어도 미확인',priceText,card.priceInfo?.source||'시세 미확인'].join(' | ');try{await navigator.clipboard.writeText(text);showNotice('카드 정보가 클립보드에 복사되었습니다.');}catch{showNotice('클립보드 복사 권한이 없습니다.',true);}});
    els.dialog.showModal();
  } catch(error) { showNotice(`카드 상세 정보를 불러오지 못했습니다: ${error.message}`,true); }
}
function refreshRarityOptions() {
  const values=[...new Set(allLoadedCards().map(card=>card.rarity).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ko'));
  $('#rarity-filter').innerHTML='<option value="">전체 레어도</option>'+values.map(value=>`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
}
function setNav(view) { document.querySelectorAll('.nav-link').forEach(link=>link.classList.toggle('active',link.dataset.view===view)); }
function render() {
  if(state.view==='home'&&state.query.trim()){renderSearchResults();return;}
  if(state.view==='cards'||state.view==='ranking') { els.title.textContent=state.view==='ranking'?'가격 랭킹':'카드 탐색';els.subtitle.textContent=state.view==='ranking'?'확인된 가격 기준으로 상위 20장을 표시합니다.':'카드팩을 선택해 해당 카드 목록을 불러오세요.';renderCardView();return; }
  if(state.view==='set'&&state.selectedSet){renderSetCards(setDetailFor(state.selectedSet)||{...state.selectedSet,cards:[]});return;}
  els.title.textContent='카드팩 둘러보기';els.subtitle.textContent='카탈로그에 등록된 카드팩과 발매 정보를 확인해 보세요.';renderSets();
}

document.querySelectorAll('.nav-link').forEach(link=>link.addEventListener('click',()=>{const view=link.dataset.view;if(!view)return;state.view=view;state.selectedSet=null;setNav(view);render();document.querySelector('#catalog').scrollIntoView({behavior:'smooth',block:'start'});}));
document.querySelectorAll('.filter-chip').forEach(button=>button.addEventListener('click',()=>{state.filter=button.dataset.filter;document.querySelectorAll('.filter-chip').forEach(item=>item.classList.toggle('active',item===button));render();}));
$('#search-input').addEventListener('input',event=>{state.query=event.target.value;state.view='home';setNav('home');queueCatalogSearch(state.query);});
$('#sort-select').addEventListener('change',event=>{state.sort=event.target.value;render();});
$('#rarity-filter').addEventListener('change',event=>{state.rarity=event.target.value;render();});
$('#price-filter').addEventListener('change',event=>{state.minPrice=Number(event.target.value)||0;render();});
$('#refresh-button').addEventListener('click',()=>{state.details.clear();loadSets();});
$('#empty-retry').addEventListener('click',loadSets);
$('#theme-toggle').addEventListener('click',()=>{document.body.classList.toggle('dark');localStorage.setItem('cardlog-theme',document.body.classList.contains('dark')?'dark':'light');});
if(localStorage.getItem('cardlog-theme')==='dark')document.body.classList.add('dark');
$('.dialog-close').addEventListener('click',()=>els.dialog.close());
els.dialog.addEventListener('click',event=>{if(event.target===els.dialog)els.dialog.close();});
document.addEventListener('keydown',event=>{if(event.key==='/'&&document.activeElement.tagName!=='INPUT'&&document.activeElement.tagName!=='TEXTAREA'){event.preventDefault();els.search.focus();}if(event.key==='Escape'&&els.dialog.open)els.dialog.close();});
loadSets();
