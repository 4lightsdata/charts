(function () {
  const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTyHCIpuggmnT48JhvbjLixeB_-VOEaWNkBUDssKIyM_JFPz52tiN_aUi-4UBOvGo9sPbwdvJ-7XSuZ/pub?gid=1860034981&single=true&output=csv';
  const CACHE_KEY = 'stressCards_csv_v2';
  const CACHE_TTL_MS = 45000;
  const FETCH_TIMEOUT_MS = 8000;

  const RED = '#f23645';
  const GREEN = '#089981';
  const INK = '#111318';
  const MUTED = '#6b7280';
  const CARD_BG = '#f7f8fa'; // subtle light grey card background

  // ---------- styles (injected once per page) ----------
  function injectStyles() {
    if (document.getElementById('stress-card-styles')) return;
    const style = document.createElement('style');
    style.id = 'stress-card-styles';
    style.textContent = `
      html, body { max-width: 100%; overflow-x: hidden; }
      .sc-card {
        background: ${CARD_BG};
        border-radius: 32px;
        padding: 20px 22px 16px 22px;
        width: 100%;
        max-width: 560px;
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        display: flex;
        flex-direction: column;
        gap: 12px;
        overflow: hidden;
      }
      .sc-title {
        text-align: left;
        text-transform: uppercase;
        font-size: 0.8rem;
        font-weight: normal;
        letter-spacing: 0.02em;
        color: ${INK};
        overflow-wrap: break-word;
      }
      .sc-row {
        display: grid;
        grid-template-columns: 25% 35% 40%;
        column-gap: 14px;
        align-items: start;
        min-width: 0;
      }
      .sc-col { min-width: 0; box-sizing: border-box; max-width: 100%; }

      /* left: level / change */
      .sc-col-left { display: flex; align-items: flex-start; }
      .sc-text { display: flex; flex-direction: column; min-width: 0; }
      .sc-level { font-size: 1.05rem; font-weight: normal; color: ${INK}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sc-change { font-size: 0.85rem; font-weight: normal; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sc-change.up   { color: ${RED}; }
      .sc-change.down { color: ${GREEN}; }
      .sc-change.flat { color: ${INK}; }
      .sc-period { font-size: 0.7rem; color: ${MUTED}; margin-top: 2px; }

      /* middle: sparkline */
      .sc-col-graph { display: flex; flex-direction: column; }
      .sc-sparkline svg { display: block; width: 100%; height: 56px; }
      .sc-trend-label { font-size: 0.68rem; color: ${MUTED}; text-align: center; margin-top: 4px; overflow-wrap: break-word; }

      /* right: range slider */
      .sc-col-range { display: flex; flex-direction: column; align-items: center; }
      .sc-range-max { width: 100%; text-align: right; font-size: 0.68rem; color: ${MUTED}; overflow-wrap: break-word; }
      .sc-range-min { width: 100%; text-align: left; font-size: 0.68rem; color: ${MUTED}; margin-top: 2px; overflow-wrap: break-word; }
      .sc-range-line-wrap { position: relative; width: 100%; display: flex; align-items: center; height: 14px; margin: 6px 0; }
      .sc-range-line { width: 100%; height: 0; border-top: 1px solid #000; }
      .sc-range-dot {
        position: absolute; width: 11px; height: 11px; border-radius: 50%;
        top: 50%; transform: translate(-50%, -50%); background: #000;
        box-shadow: 0 0 0 3px rgba(17,19,24,0.08);
      }
      .sc-slider-label { font-size: 0.68rem; color: ${MUTED}; text-align: center; margin-top: 4px; overflow-wrap: break-word; }

      .sc-note { text-align: center; font-size: 0.8rem; color: ${MUTED}; padding: 16px 4px; }
      .sc-cards-wrap { display: flex; flex-direction: column; gap: 14px; max-width: 100%; }

      @media (max-width: 480px) {
        .sc-row { column-gap: 8px; }
        .sc-level { font-size: 0.9rem; }
        .sc-card { padding: 16px 14px 12px 14px; }
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

  // ---------- rows -> card models (new schema) ----------
  function rowsToCards(rows) {
    if (!rows.length) return [];
    const header = rows[0];
    const col = name => header.findIndex(h => h.trim().toLowerCase() === name.trim().toLowerCase());
    const idx = {
      cardID:          col('CardID'),
      label:           col('Label'),
      levelDisplay:    col('LevelDisplay'),
      levelVal:        col('LevelVal'),
      changeDisplay:   col('ChangeDisplay'),
      changeVal:       col('ChangeVal'),
      periodLabel:     col('PeriodLabel'),
      trendColor:      col('TrendColor'),
      trendLabel:      col('TrendLabel'),
      histMinDisplay:  col('HistMinDisplay'),
      histMaxDisplay:  col('HistMaxDisplay'),
      histMin:         col('HistMin'),
      histMax:         col('HistMax'),
      relativePosition:col('RelativePosition'),
      sliderLabel:     col('SliderLabel')
    };
    // Sparkline values start one column after the last recognized metadata
    // column (there's a blank spacer column, then dated values).
    const knownIdxs = Object.values(idx).filter(i => i >= 0);
    const sparkStart = (knownIdxs.length ? Math.max(...knownIdxs) : 0) + 2;

    const cards = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (idx.cardID < 0 || !row[idx.cardID] || !row[idx.cardID].trim()) continue;

      const get = key => (idx[key] >= 0 && row[idx[key]] !== undefined) ? row[idx[key]].trim() : '';
      const getNum = key => parseFloat(get(key));

      const sparkValues = row.slice(sparkStart)
        .map(v => parseFloat(v))
        .filter(v => Number.isFinite(v));

      cards.push({
        cardID:           get('cardID'),
        label:            get('label'),
        levelDisplay:     get('levelDisplay'),
        levelVal:         getNum('levelVal'),
        changeDisplay:    get('changeDisplay'),
        changeVal:        getNum('changeVal'),
        periodLabel:      get('periodLabel'),
        trendColor:       getNum('trendColor'),
        trendLabel:       get('trendLabel'),
        histMinDisplay:   get('histMinDisplay'),
        histMaxDisplay:   get('histMaxDisplay'),
        histMin:          getNum('histMin'),
        histMax:          getNum('histMax'),
        relativePosition: get('relativePosition'),
        sliderLabel:      get('sliderLabel'),
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
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // Find the marker position within a string like "---o------" and return
  // its position as a 0-100 percentage along the string.
  function relativePositionPercent(posStr) {
    if (!posStr) return 50;
    const chars = Array.from(posStr);
    if (chars.length < 2) return 50;
    const idx = chars.findIndex(ch => ch !== '-' && ch.trim() !== '');
    if (idx === -1) return 50;
    return Math.min(100, Math.max(0, (idx / (chars.length - 1)) * 100));
  }

  function buildSparklineSVG(values, colorClass, invertArea) {
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
    const closeY = invertArea ? pad : h; // shading above the line for negative levels
    const areaClose = `${pts[pts.length - 1].split(',')[0]},${closeY} ${pad},${closeY}`;
    const color = colorClass === 'red' ? RED : (colorClass === 'green' ? GREEN : MUTED);
    const gid = 'sg' + Math.random().toString(36).slice(2);
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.03"/>
      </linearGradient></defs>
      <polygon points="${polyline} ${areaClose}" fill="url(#${gid})"/>
      <polyline points="${polyline}" fill="none" stroke="${color}" stroke-width="1.5"/>
    </svg>`;
  }

  function buildCardHTML(card) {
    const changeVal = card.changeVal;
    const changeState = !Number.isFinite(changeVal) ? 'flat' : (changeVal > 0 ? 'up' : (changeVal < 0 ? 'down' : 'flat'));

    const trendColor = card.trendColor;
    const sparkColorClass = !Number.isFinite(trendColor) ? 'neutral' : (trendColor > 0 ? 'red' : 'green');
    const invertArea = Number.isFinite(card.levelVal) && card.levelVal < 0;
    const sparkSVG = buildSparklineSVG(card.sparkValues, sparkColorClass, invertArea);

    const pct = relativePositionPercent(card.relativePosition);

    return `
    <div class="sc-card">
      <div class="sc-title">${esc(card.label || card.cardID)}</div>
      <div class="sc-row">
        <div class="sc-col sc-col-left">
          <div class="sc-text">
            <div class="sc-level">${esc(card.levelDisplay)}</div>
            <div class="sc-change ${changeState}">${esc(card.changeDisplay)}</div>
            <div class="sc-period">${esc(card.periodLabel)}</div>
          </div>
        </div>
        <div class="sc-col sc-col-graph">
          <div class="sc-sparkline">${sparkSVG}</div>
          <div class="sc-trend-label">${esc(card.trendLabel)}</div>
        </div>
        <div class="sc-col sc-col-range">
          <div class="sc-range-max">${esc(card.histMaxDisplay)}</div>
          <div class="sc-range-line-wrap">
            <div class="sc-range-line"></div>
            <div class="sc-range-dot ${changeState}" style="left:${pct}%"></div>
          </div>
          <div class="sc-range-min">${esc(card.histMinDisplay)}</div>
          <div class="sc-slider-label">${esc(card.sliderLabel)}</div>
        </div>
      </div>
    </div>`;
  }

  function buildNoDataHTML(label) {
    return `<div class="sc-card"><div class="sc-note">"${esc(label)}" data unavailable right now</div></div>`;
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

  const exportsObj = { renderSingleCard, renderAllCards, getCards, parseCSV, rowsToCards, buildCardHTML, buildNoDataHTML, relativePositionPercent };
  if (typeof window !== 'undefined') window.StressCards = exportsObj;
  if (typeof module !== 'undefined' && module.exports) module.exports = exportsObj;
})();
