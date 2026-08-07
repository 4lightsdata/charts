(function () {
  const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTyHCIpuggmnT48JhvbjLixeB_-VOEaWNkBUDssKIyM_JFPz52tiN_aUi-4UBOvGo9sPbwdvJ-7XSuZ/pub?gid=1860034981&single=true&output=csv';
  const CACHE_KEY = 'stressCards_csv_v1';
  const CACHE_TTL_MS = 45000;
  const FETCH_TIMEOUT_MS = 8000;

  const GREEN = '#089981';
  const RED = '#f23645';
  const INK = '#111318';
  const MUTED = '#6b7280';
  const PILL_BG = '#f0f1f3';

  // ---------- styles (injected once per page) ----------
  function injectStyles() {
    if (document.getElementById('stress-card-styles')) return;
    const style = document.createElement('style');
    style.id = 'stress-card-styles';
    style.textContent = `
      .sc-card {
        background: #fff;
        border-radius: 999px;
        padding: 18px 32px 14px 32px;
        display: grid;
        grid-template-columns: minmax(100px, 130px) 1fr minmax(84px, 120px);
        grid-template-rows: auto auto;
        align-items: center;
        width: 100%;
        max-width: 520px;
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        position: relative;
      }
      .sc-left { display:flex; align-items:center; gap:8px; min-width:0; }
      .sc-dot { width:14px; height:14px; border-radius:50%; background:${INK}; flex-shrink:0; }
      .sc-dot.down { background:${GREEN}; }
      .sc-dot.up { background:${RED}; }
      .sc-text { display:flex; flex-direction:column; line-height:1.15; min-width:0; }
      .sc-level { font-size:1.05rem; font-weight:700; color:${INK}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .sc-change { font-size:0.85rem; font-weight:600; white-space:nowrap; }
      .sc-change.down { color:${GREEN}; }
      .sc-change.up { color:${RED}; }
      .sc-change.flat { color:${MUTED}; }
      .sc-sparkline { padding:0 8px; min-width:0; }
      .sc-sparkline svg { display:block; width:100%; height:60px; }
      .sc-range { display:flex; flex-direction:column; align-items:center; position:relative; height:60px; justify-content:center; }
      .sc-range-line-wrap { position:relative; width:100%; display:flex; align-items:center; }
      .sc-range-line { width:100%; height:0; border-top:2px dashed #d8dade; }
      .sc-range-dot { position:absolute; width:11px; height:11px; background:${INK}; border-radius:50%; top:50%; transform:translate(-50%,-50%); box-shadow:0 0 0 3px rgba(17,19,24,0.08); }
      .sc-range-dot.down { background:${GREEN}; box-shadow:0 0 0 3px rgba(8,153,129,0.15); }
      .sc-range-dot.up { background:${RED}; box-shadow:0 0 0 3px rgba(242,54,69,0.15); }
      .sc-range-labels { width:100%; display:flex; justify-content:space-between; font-size:0.7rem; color:${MUTED}; margin-top:4px; }
      .sc-range-max-label { position:absolute; top:2px; right:4px; font-size:0.7rem; color:${MUTED}; }
      .sc-label { grid-column:1/4; text-align:center; font-size:0.7rem; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; color:${MUTED}; padding-top:8px; border-top:1px solid #f0f1f3; margin-top:6px; }
      .sc-note { grid-column:1/4; text-align:center; font-size:0.8rem; color:${MUTED}; padding:16px 4px; font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
      .sc-cards-wrap { display:flex; flex-direction:column; gap:14px; }
      @media (max-width: 480px) {
        .sc-card { grid-template-columns: 92px 1fr 80px; padding:14px 22px 10px 22px; }
        .sc-level { font-size:0.95rem; }
      }
    `;
    document.head.appendChild(style);
  }

  // ---------- RFC4180-ish CSV parser: handles quoted fields, embedded commas/quotes ----------
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { inQuotes = false; }
        } else {
          field += c;
        }
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\r') { /* skip, handled by \n */ }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(f => f.trim() !== ''));
  }

  // ---------- fetch with timeout + one retry + cross-page cache (localStorage) ----------
  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
      return parsed.text;
    } catch (e) { return null; }
  }
  function writeCache(text) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), text })); } catch (e) { /* ignore quota/denied */ }
  }

  async function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const resp = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } finally {
      clearTimeout(timer);
    }
  }

  let inFlight = null;
  async function fetchCSVText() {
    const cached = readCache();
    if (cached) return cached;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let lastErr;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const text = await fetchWithTimeout(CSV_URL, FETCH_TIMEOUT_MS);
          writeCache(text);
          return text;
        } catch (e) { lastErr = e; }
      }
      throw lastErr;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  // ---------- rows -> card models ----------
  function rowsToCards(rows) {
    if (!rows.length) return [];
    const header = rows[0];
    const col = name => header.findIndex(h => h.trim() === name.trim());
    const idx = {
      cardID: col('CardID'), label: col('Label'), unit: col('Unit'),
      level: col('Level'), changeVal: col('ChangeVal'), periodLabel: col('PeriodLabel'),
      histMin: col('HistMin'), histMax: col('HistMax'), percentile: col('Percentile')
    };
    const sparkStart = idx.percentile + 2; // skip the blank column after Percentile

    const cards = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[idx.cardID] || !row[idx.cardID].trim()) continue;

      const sparkValues = row.slice(sparkStart)
        .map(v => parseFloat(v))
        .filter(v => Number.isFinite(v));

      cards.push({
        cardID:      row[idx.cardID].trim(),
        label:       (row[idx.label] || '').trim(),
        unit:        (row[idx.unit] || '').trim(),
        level:       parseFloat(row[idx.level]),
        changeVal:   parseFloat(row[idx.changeVal]),
        periodLabel: (row[idx.periodLabel] || '').trim(),
        histMin:     parseFloat(row[idx.histMin]),
        histMax:     parseFloat(row[idx.histMax]),
        percentile:  parseFloat(row[idx.percentile]),
        sparkValues
      });
    }
    return cards;
  }

  async function getCards() {
    const text = await fetchCSVText();
    return rowsToCards(parseCSV(text));
  }

  // ---------- rendering helpers ----------
  function fmt(n, digits = 2) { return Number.isFinite(n) ? n.toFixed(digits) : '—'; }
  function fmtPlain(n) { return Number.isFinite(n) ? n : '—'; }

  function buildSparklineSVG(values, colorClass) {
    if (!values || values.length < 2) return '';
    const w = 200, h = 60, pad = 4;
    const min = Math.min(...values), max = Math.max(...values);
    const range = max - min || 1;
    const pts = values.map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (w - pad * 2);
      const y = (h - pad) - ((v - min) / range) * (h - pad * 2);
      return `${x},${y}`;
    });
    const polyline = pts.join(' ');
    const areaClose = `${pts[pts.length - 1].split(',')[0]},${h} ${pad},${h}`;
    const color = colorClass === 'up' ? RED : GREEN;
    const gid = 'sg' + Math.random().toString(36).slice(2);
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.03"/>
      </linearGradient></defs>
      <polygon points="${polyline} ${areaClose}" fill="url(#${gid})"/>
      <polyline points="${polyline}" fill="none" stroke="${color}" stroke-width="1.5"/>
    </svg>`;
  }

  function buildCardHTML(card) {
    const hasChange = Number.isFinite(card.changeVal);
    const isDown = hasChange ? card.changeVal <= 0 : null;
    const changeClass = !hasChange ? 'flat' : (isDown ? 'down' : 'up');
    const arrow = !hasChange ? '' : (isDown ? '↓ ' : '↑ ');
    const changeDisplay = hasChange
      ? `${arrow}${fmt(Math.abs(card.changeVal))}${card.periodLabel ? ` (${card.periodLabel})` : ''}`
      : 'change unavailable';
    const pct = Number.isFinite(card.percentile) ? Math.min(100, Math.max(0, card.percentile)) : 50;
    const sparkSVG = buildSparklineSVG(card.sparkValues, changeClass);

    return `
    <div class="sc-card">
      <div class="sc-left">
        <div class="sc-dot ${changeClass}"></div>
        <div class="sc-text">
          <div class="sc-level">${fmtPlain(card.level)}</div>
          <div class="sc-change ${changeClass}">${changeDisplay}</div>
        </div>
      </div>
      <div class="sc-sparkline">${sparkSVG}</div>
      <div class="sc-range">
        <div class="sc-range-max-label">${fmtPlain(card.histMax)}</div>
        <div class="sc-range-line-wrap">
          <div class="sc-range-line"></div>
          <div class="sc-range-dot ${changeClass}" style="left:${pct}%"></div>
        </div>
        <div class="sc-range-labels"><span>${fmtPlain(card.histMin)}</span></div>
      </div>
      <div class="sc-label">${card.label || card.cardID}</div>
    </div>`;
  }

  function buildNoDataHTML(label) {
    return `<div class="sc-card"><div class="sc-note">"${label}" data unavailable right now</div></div>`;
  }

  // ---------- entry points ----------
  async function renderSingleCard(cardID, container) {
    injectStyles();
    container.innerHTML = `<div class="sc-note">Loading…</div>`;
    try {
      const cards = await getCards();
      const card = cards.find(c => c.cardID.toLowerCase() === cardID.toLowerCase());
      container.innerHTML = card ? buildCardHTML(card) : buildNoDataHTML(cardID);
    } catch (err) {
      container.innerHTML = buildNoDataHTML(cardID);
    }
  }

  async function renderAllCards(container) {
    injectStyles();
    container.innerHTML = `<div class="sc-note">Loading…</div>`;
    try {
      const cards = await getCards();
      container.innerHTML = `<div class="sc-cards-wrap">${cards.map(buildCardHTML).join('')}</div>`;
    } catch (err) {
      container.innerHTML = `<div class="sc-note">Unable to load stress index data right now.</div>`;
    }
  }

  // ---------- bootstrap from the including <script> tag ----------
  (function bootstrap() {
    if (typeof document === 'undefined') return; // allow safe require() in non-browser contexts (e.g. tests)
    const script = document.currentScript || document.querySelector('script[data-card], script[data-cards-container]');
    if (!script) return;
    const singleID = script.getAttribute('data-card');
    const allContainerId = script.getAttribute('data-cards-container');
    if (singleID) {
      const el = document.getElementById(`card-${singleID}`);
      if (el) renderSingleCard(singleID, el);
    } else if (allContainerId) {
      const el = document.getElementById(allContainerId);
      if (el) renderAllCards(el);
    }
  })();

  const exportsObj = { renderSingleCard, renderAllCards, getCards, parseCSV, rowsToCards, buildCardHTML, buildNoDataHTML };
  if (typeof window !== 'undefined') window.StressCards = exportsObj;
  if (typeof module !== 'undefined' && module.exports) module.exports = exportsObj;
})();
