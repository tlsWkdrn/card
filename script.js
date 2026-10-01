const HIGH_PRICE_KRW = 100000;
const state = { sets: [], selectedSet: null, details: new Map(), view: 'home', filter: 'all', query: '', rarity: '', minPrice: 0, sort: 'newest', updatedAt: null };
const $ = selector => document.querySelector(selector);
const els = { grid: $('#pack-grid'), cards: $('#card-view'), loading: $('#loading'), empty: $('#empty-state'), notice: $('#notice'), count: $('#result-count'), title: $('#section-title'), subtitle: $('#section-subtitle'), search: $('#search-input'), dialog: $('#card-dialog'), dialogContent: $('#dialog-content') };

async function api(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `요청 오류 (${response.status})`);
  return data;
}
function escapeHtml(value='') { return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
function formatDate(value) { if (!value) return '발매일 정보 없음'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR',{year:'numeric',month:'short',day:'numeric'}).format(date); }
function formatPrice(item) { if (!item) return null; if (item.priceKrw !== null && item.priceKrw !== undefined) return `₩${Number(item.priceKrw).toLocaleString('ko-KR')}`; if (item.price !== null && item.currency) return `${item.currency} ${Number(item.price).toLocaleString('en-US')}`; return null; }
function setImage(set) { return set.logo || set.image || set.symbol || ''; }
function cardImage(card, high=false) { if (!card.image) return ''; return `${String(card.image).replace(/\/$/,'')}/${high ? 'high' : 'low'}.png`; }
function allLoadedCards() { return [...state.details.values()].flatMap(set => (set.cards || []).map(card => ({ ...card, setName: set.name, setId: set.id }))); }
function highCards() { return allLoadedCards().filter(card => Number(card.priceInfo?.priceKrw) >= HIGH_PRICE_KRW); }
function setHighCount(set) { return (set.cards || []).filter(card => Number(card.priceInfo?.priceKrw) >= HIGH_PRICE_KRW).length; }
function showNotice(message, isError=false) { els.notice.textContent = message; els.notice.classList.toggle('error', isError); els.notice.classList.remove('hidden'); }
function hideNotice() { els.notice.classList.add('hidden'); }
function updateStatus(isConnected) { const indicator = $('.live-status'); indicator.classList.toggle('connected', isConnected); indicator.innerHTML = `<i></i> ${isConnected?'카탈로그 연결됨':'API 연결 대기'}`; }
function updateStats() {
  $('#stat-sets').textContent = state.sets.length ? state.sets.length.toLocaleString('ko-KR') : '—';
  const high = highCards().length;
  const loaded = allLoadedCards();
  const pricedCount = loaded.filter(card => Number.isFinite(Number(card.priceInfo?.priceKrw)) && card.priceInfo?.priceKrw !== null && card.priceInfo?.priceKrw !== undefined).length;
  const configured = [...state.details.values()].some(set => set.priceConfigured);
  $('#stat-high').textContent = configured ? high.toLocaleString('ko-KR') : '—';
  $('#stat-coverage').textContent = configured ? `${pricedCount.toLocaleString('ko-KR')}장` : '가격 API 미연동';
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
    if (!health?.priceApiConfigured) showNotice('카드명·카드팩 정보는 TCGdex에서 가져왔습니다. 한국판 카드의 검증된 시세 API는 기본 제공되지 않아 가격은 표시하지 않습니다. 가격을 임의로 추정하지 않으며, 가격 공급처를 연결하면 원화와 변동률을 표시합니다.');
  } catch (error) {
    state.sets = []; updateStatus(false); els.loading.classList.add('hidden'); els.grid.classList.add('hidden'); els.empty.classList.remove('hidden'); $('#empty-title').textContent='카드 카탈로그를 불러오지 못했습니다'; $('#empty-copy').textContent=`${error.message} 서버 연결과 인터넷 상태를 확인해 주세요.`; showNotice(`카탈로그 API 오류: ${error.message}`, true);
  }
}

function filteredSets() {
  const query = state.query.trim().toLocaleLowerCase();
  let result = state.sets.filter(set => {
    if (!query) return true;
    const fields=`${set.name||''} ${set.id||''} ${set.series?.name||''}`.toLocaleLowerCase();
    const cardMatch=(state.details.get(set.id)?.cards||[]).some(card=>`${card.name||''} ${card.localId||''} ${card.id||''}`.toLocaleLowerCase().includes(query));
    return fields.includes(query)||cardMatch;
  });
  if (state.filter === 'available') result = []; // Catalog data does not certify Korean retail availability.
  if (state.filter === 'high') result = result.filter(set => state.details.has(set.id) && setHighCount(state.details.get(set.id)) > 0);
  if (state.minPrice) result = result.filter(set => (state.details.get(set.id)?.cards || []).some(card => Number(card.priceInfo?.priceKrw) >= state.minPrice));
  if (state.rarity) result = result.filter(set => (state.details.get(set.id)?.cards || []).some(card => card.rarity === state.rarity));
  if (state.sort === 'name') result.sort((a,b)=>(a.name||'').localeCompare(b.name||'','ko'));
  if (state.sort === 'newest') result.sort((a,b)=>(b.releaseDate||'').localeCompare(a.releaseDate||''));
  if (state.sort === 'high') result.sort((a,b)=>setHighCount(state.details.get(b.id)||{})-setHighCount(state.details.get(a.id)||{}));
  if (state.sort === 'price') result.sort((a,b)=>maxSetPrice(state.details.get(b.id))-maxSetPrice(state.details.get(a.id)));
  return result;
}
function maxSetPrice(set) { return Math.max(0,...(set?.cards||[]).map(card=>Number(card.priceInfo?.priceKrw)||0)); }
function renderSets() {
  const sets=filteredSets(); els.count.textContent=`${sets.length.toLocaleString('ko-KR')}개`;
  els.loading.classList.add('hidden'); els.cards.classList.add('hidden'); els.grid.classList.remove('hidden'); els.grid.innerHTML='';
  if (!sets.length) { els.grid.classList.add('hidden'); els.empty.classList.remove('hidden'); $('#empty-title').textContent=state.filter==='available'?'공식 판매 여부가 확인된 카드팩이 없습니다':'검색 결과가 없습니다'; $('#empty-copy').textContent=state.filter==='available'?'TCGdex는 카드 데이터 카탈로그이며 국내 판매 중 여부를 제공하지 않습니다. 확인되지 않은 상품은 판매 중으로 표시하지 않습니다.':'검색어와 필터를 바꾸거나 다른 카드팩을 확인해 주세요.'; return; }
  els.empty.classList.add('hidden');
  const fragment=document.createDocumentFragment();
  for(const set of sets) {
    const detail=state.details.get(set.id); const count=detail?setHighCount(detail):null; const max=detail?maxSetPrice(detail):null;
    const card=document.createElement('article'); card.className='pack-card'; card.tabIndex=0; card.setAttribute('role','button'); card.setAttribute('aria-label',`${set.name||set.id} 상세 보기`); card.innerHTML=`<div class="pack-visual">${setImage(set)?`<img src="${escapeHtml(setImage(set))}" alt="${escapeHtml(set.name||'카드팩 이미지')}" loading="lazy" onerror="this.remove()">`:'<div class="pack-placeholder">✦</div>'}<span class="pack-tag">${escapeHtml(set.series?.name||'CARD SET')}</span></div><div class="pack-body"><h3 title="${escapeHtml(set.name||set.id)}">${escapeHtml(set.name||set.id)}</h3><div class="pack-meta">${escapeHtml(formatDate(set.releaseDate))} · ${set.cardCount?.total??set.cardCount?.official??'—'}장</div><div class="pack-facts"><span>₩100,000 이상 카드</span><strong class="pack-high">${count===null?'가격 미확인':`${count}장`}</strong></div><div class="pack-facts"><span>최고 확인 가격</span><strong>${max===null?'—':max?`₩${max.toLocaleString('ko-KR')}`:'가격 정보 없음'}</strong></div><div class="pack-status"><i class="status-dot"></i> 국내 판매 여부 미확인</div></div>`;
    const open=()=>openSet(set); card.addEventListener('click',open); card.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}}); fragment.append(card);
  }
  els.grid.append(fragment);
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
  els.cards.querySelectorAll('.trading-card').forEach(card=>card.addEventListener('click',()=>openCard(card.dataset.id)));
  els.count.textContent=`${filtered.length.toLocaleString('ko-KR')}장`;
}
function cardMarkup(card) {
  const price=formatPrice(card.priceInfo); const image=cardImage(card);
  return `<article class="trading-card" data-id="${escapeHtml(card.id||'')}" tabindex="0">${image?`<img src="${escapeHtml(image)}" alt="${escapeHtml(card.name||'카드 이미지')}" loading="lazy" onerror="this.style.visibility='hidden'">`:'<div class="card-image-placeholder">✦</div>'}<div class="trading-card-body"><h3>${escapeHtml(card.name||card.id||'이름 정보 없음')}</h3><div class="subline">${escapeHtml(card.setName||'')} · No. ${escapeHtml(card.localId||'—')} · ${escapeHtml(card.rarity||'레어도 미확인')}</div><div class="card-price"><strong>${price?escapeHtml(price):'<span class="unknown-price">가격 정보 없음</span>'}</strong>${Number(card.priceInfo?.priceKrw)>=HIGH_PRICE_KRW?'<span class="high-badge">HIGH VALUE</span>':''}</div></div></article>`;
}

async function openSet(set) {
  state.selectedSet=set; state.view='set'; els.title.textContent=set.name||'카드팩 상세'; els.subtitle.textContent='카드 정보를 불러오는 중입니다.'; loadState(true); hideNotice();
  try {
    const detail=state.details.has(set.id)?state.details.get(set.id):await api(`/api/sets/${encodeURIComponent(set.id)}`);
    state.details.set(set.id,detail); state.updatedAt=detail.updatedAt||state.updatedAt;
    state.view='set'; setNav('cards'); updateStats(); renderSetCards(detail); refreshRarityOptions();
    const total=detail.cards?.length||0; const high=setHighCount(detail); const priceApi=detail.priceConfigured;
    els.subtitle.textContent=`${formatDate(detail.releaseDate)} · ${total}장 · 100,000원 이상 ${high}장 · 국내 판매 여부 미확인`;
    if(detail.priceError) showNotice(`가격 API 오류: ${detail.priceError} 카드 목록은 계속 이용할 수 있고 가격은 미확인으로 표시합니다.`,true);
    else if(!priceApi) showNotice('카드 데이터는 TCGdex에서 확인했습니다. 한국판 카드 가격을 제공하는 API가 연결되지 않아 시세와 가격 변동률은 표시하지 않습니다.');
  } catch(error) { state.view='set'; els.loading.classList.add('hidden'); els.grid.classList.add('hidden'); els.cards.classList.remove('hidden'); els.cards.innerHTML=`<div class="empty-state"><strong>카드팩 데이터를 불러오지 못했습니다</strong><p>${escapeHtml(error.message)}</p><button class="primary-button" id="detail-retry">다시 시도 →</button><button class="back-button" id="detail-back">카드팩 목록</button></div>`; $('#detail-retry').addEventListener('click',()=>openSet(set));$('#detail-back').addEventListener('click',()=>{state.view='home';state.selectedSet=null;setNav('home');render();}); }
}
function renderSetCards(detail) {
  const cards=detail.cards||[];
  const ordered=[...cards].sort((a,b)=>(Number(b.priceInfo?.priceKrw)||-1)-(Number(a.priceInfo?.priceKrw)||-1));
  els.loading.classList.add('hidden'); els.grid.classList.add('hidden'); els.empty.classList.add('hidden'); els.cards.classList.remove('hidden');
  els.cards.innerHTML=`<div class="card-toolbar"><button class="back-button" data-back>← 카드팩 목록</button><strong class="set-detail-title">${escapeHtml(detail.name||detail.id)} <span class="heading-count">${cards.length}장</span></strong><div class="card-filter-row"><button class="quiet-button" data-copy-set>정보 복사</button></div></div>${cards.length?`<p class="price-disclaimer">카드 번호 · 레어도 · 가격 높은 순 · 가격 미확인 카드는 아래쪽에 표시됩니다.</p><div class="card-list">${ordered.map(card=>cardMarkup({...card,setName:detail.name})).join('')}</div>`:`<div class="empty-state"><strong>이 카드팩의 카드 목록을 확인할 수 없습니다</strong><p>카탈로그 출처에서 이 세트의 카드별 정보를 제공하지 않습니다.</p></div>`}`;
  els.cards.querySelector('[data-back]').addEventListener('click',()=>{state.view='home';state.selectedSet=null;setNav('home');render();});
  els.cards.querySelector('[data-copy-set]').addEventListener('click',async()=>{const text=`${detail.name||detail.id} | ${formatDate(detail.releaseDate)} | ${cards.length} cards | TCGdex`;try{await navigator.clipboard.writeText(text);showNotice('카드팩 정보가 클립보드에 복사되었습니다.');}catch{showNotice('클립보드 복사 권한이 없습니다.',true);}});
  els.cards.querySelectorAll('.trading-card').forEach(card=>card.addEventListener('click',()=>openCard(card.dataset.id)));
  els.count.textContent=`${cards.length.toLocaleString('ko-KR')}장`;
}
async function openCard(id) {
  try {
    const card=await api(`/api/cards/${encodeURIComponent(id)}`); const price=formatPrice(card.priceInfo); const image=cardImage(card,true)||cardImage(card);
    if(card.priceError) showNotice(`가격 API 오류: ${card.priceError} 카드 정보는 계속 이용할 수 있습니다.`,true);
    const priceText=price?escapeHtml(price):'가격 정보 없음';
    els.dialogContent.innerHTML=`<div class="dialog-card">${image?`<img src="${escapeHtml(image)}" alt="${escapeHtml(card.name||'카드 이미지')}" onerror="this.style.visibility='hidden'">`:'<div class="dialog-art-empty">이미지 미제공</div>'}<div class="dialog-info"><span class="eyebrow section-eyebrow">POKÉMON CARD</span><h2>${escapeHtml(card.name||'이름 정보 없음')}</h2><p class="dialog-set">${escapeHtml(card.set?.name||card.setName||'카드팩 정보 없음')} · No. ${escapeHtml(card.localId||'—')}</p><div class="dialog-price">${priceText}</div><span class="unknown-price">${Number(card.priceInfo?.priceKrw)>=HIGH_PRICE_KRW?'₩100,000 이상':''}</span><dl><dt>레어도</dt><dd>${escapeHtml(card.rarity||'정보 없음')}</dd><dt>카드 번호</dt><dd>${escapeHtml(card.localId||'정보 없음')}</dd><dt>가격 변동</dt><dd>${card.priceInfo?.changePercent===null||card.priceInfo?.changePercent===undefined?'데이터를 확인할 수 없음':`${card.priceInfo.changePercent>0?'+':''}${card.priceInfo.changePercent}%`}</dd><dt>가격 출처</dt><dd>${escapeHtml(card.priceInfo?.source||'가격 정보 없음')}</dd><dt>최종 확인</dt><dd>${escapeHtml(card.priceInfo?.checkedAt?new Date(card.priceInfo.checkedAt).toLocaleString('ko-KR'):'가격 데이터 미확인')}</dd><dt>판매 여부</dt><dd>한국 내 판매 정보 미확인</dd></dl><div class="dialog-actions"><button id="copy-card">정보 복사</button>${card.priceInfo?.sourceUrl?`<a href="${escapeHtml(card.priceInfo.sourceUrl)}" target="_blank" rel="noopener noreferrer">가격 출처 열기 ↗</a>`:''}${card.set?.id?`<a href="https://www.tcgdex.net/database/${encodeURIComponent(card.set.id)}/${encodeURIComponent(card.id)}" target="_blank" rel="noopener noreferrer">카드 정보 출처 ↗</a>`:''}</div></div></div>`;
    $('#copy-card').addEventListener('click',async()=>{const text=[card.name,card.set?.name||card.setName,`No. ${card.localId||'—'}`,card.rarity||'레어도 미확인',priceText,card.priceInfo?.source||'시세 미확인'].join(' | ');try{await navigator.clipboard.writeText(text);showNotice('카드 정보가 클립보드에 복사되었습니다.');}catch{showNotice('클립보드 복사 권한이 없습니다.',true);}});
    els.dialog.showModal();
  } catch(error) { showNotice(`카드 상세 정보를 불러오지 못했습니다: ${error.message}`,true); }
}
function refreshRarityOptions() {
  const values=[...new Set(allLoadedCards().map(card=>card.rarity).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ko'));
  $('#rarity-filter').innerHTML='<option value="">전체 레어도</option>'+values.map(value=>`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
}
function setNav(view) { document.querySelectorAll('.nav-link').forEach(link=>link.classList.toggle('active',link.dataset.view===view)); }
function render() {
  if(state.view==='cards'||state.view==='ranking') { els.title.textContent=state.view==='ranking'?'가격 랭킹':'카드 탐색';els.subtitle.textContent=state.view==='ranking'?'확인된 가격 기준으로 상위 20장을 표시합니다.':'카드팩을 선택해 해당 카드 목록을 불러오세요.';renderCardView();return; }
  if(state.view==='set'&&state.selectedSet){renderSetCards(state.details.get(state.selectedSet.id)||{...state.selectedSet,cards:[]});return;}
  els.title.textContent='카드팩 둘러보기';els.subtitle.textContent='카탈로그에 등록된 카드팩과 발매 정보를 확인해 보세요.';renderSets();
}

document.querySelectorAll('.nav-link').forEach(link=>link.addEventListener('click',()=>{const view=link.dataset.view;if(!view)return;state.view=view;state.selectedSet=null;setNav(view);render();document.querySelector('#catalog').scrollIntoView({behavior:'smooth',block:'start'});}));
document.querySelectorAll('.filter-chip').forEach(button=>button.addEventListener('click',()=>{state.filter=button.dataset.filter;document.querySelectorAll('.filter-chip').forEach(item=>item.classList.toggle('active',item===button));render();}));
$('#search-input').addEventListener('input',event=>{state.query=event.target.value;render();});
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
