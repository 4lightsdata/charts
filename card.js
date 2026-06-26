const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTyHCIpuggmnT48JhvbjLixeB_-VOEaWNkBUDssKIyM_JFPz52tiN_aUi-4UBOvGo9sPbwdvJ-7XSuZ/pub?gid=1860034981&single=true&output=csv';

async function fetchCard(cardID) {
  const resp = await fetch(CSV_URL);
  const text = await resp.text();
  return parseRow(text, cardID);
}

function parseRow(text, cardID) {
  const lines = text.trim().split('\n').map(l => l.split(','));
  const header = lines[0];

  const col = name => header.findIndex(h => h.trim() === name.trim());
  const idxCardID      = col('CardID');
  const idxLabel       = col('Label');
  const idxUnit        = col('Unit');
  const idxLevel       = col('Level');
  const idxChangeVal   = col('ChangeVal');
  const idxPeriodLabel = col('PeriodLabel');
  const idxHistMin     = col('HistMin');
  const idxHistMax     = col('HistMax');
  const idxPercentile  = col('Percentile');
  const sparkStart     = idxPercentile + 2; // skip blank column

  const row = lines.find(r => r[idxCardID] && r[idxCardID].trim() === cardID);
  if (!row) return null;

  const sparkValues = row.slice(sparkStart)
    .map(v => parseFloat(v.trim()))
    .filter(v => !isNaN(v));

  return {
    cardID,
    label:       row[idxLabel].trim(),
    unit:        row[idxUnit].trim(),
    level:       parseFloat(row[idxLevel]),
    changeVal:   parseFloat(row[idxChangeVal]),
    periodLabel: row[idxPeriodLabel].trim(),
    histMin:     parseFloat(row[idxHistMin]),
    histMax:     parseFloat(row[idxHistMax]),
    percentile:  parseFloat(row[idxPercentile]),
    sparkValues
  };
}

function buildSparklineSVG(values) {
  if (!values.length) return '';
  const w = 200, h = 60, pad = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = (h - pad) - ((v - min) / range) * (h - pad * 2);
    return `${x},${y}`;
  });
  const polyline = pts.join(' ');
  const last = pts[pts.length - 1].split(',');
  const areaClose = `${last[0]},${h} ${pad},${h}`;

  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="sg${Math.random().toString(36).slice(2)}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#2a9d2a" stop-opacity="0.4"/>
        <stop offset="100%" stop-color="#2a9d2a" stop-opacity="0.05"/>
      </linearGradient>
    </defs>
    <polygon points="${polyline} ${areaClose}" fill="url(#sg)"/>
    <polyline points="${polyline}" fill="none" stroke="#2a9d2a" stroke-width="1.5"/>
  </svg>`;
}

function renderCard(card, container) {
  const isDown = card.changeVal <= 0;
  const arrow = isDown ? '↓' : '↑';
  const changeColor = isDown ? '#2a9d2a' : '#cc2222';
  const changeDisplay = `${arrow} ${Math.abs(card.changeVal).toFixed(2)} (${card.periodLabel})`;
  const pct = Math.min(100, Math.max(0, card.percentile));
  const sparkSVG = buildSparklineSVG(card.sparkValues);

  container.innerHTML = `
    <style>
      .sc-card {
        background: #F7F7F7;
        border-radius: 12px;
        padding: 12px 16px 8px 16px;
        display: grid;
        grid-template-columns: 90px 1fr 130px;
        grid-template-rows: auto auto;
        align-items: center;
        box-shadow: 0 2px 8px rgba(0,0,0,0.12);
        width: 520px;
        font-family: Arial, sans-serif;
      }
      .sc-left { display: flex; flex-direction: column; justify-content: center; }
      .sc-level { font-size: 1.4rem; font-weight: 400; line-height: 1; color: #111; }
      .sc-change { font-size: 0.9rem; font-weight: 500; margin-top: 2px; }
      .sc-sparkline { padding: 0 8px; }
      .sc-sparkline svg { display: block; width: 100%; height: 60px; }
      .sc-range { position: relative; height: 60px; display: flex; flex-direction: column; justify-content: center; }
      .sc-range-max { font-size: 0.7rem; color: #555; text-align: right; margin-bottom: 2px; }
      .sc-range-line-wrap { position: relative; display: flex; align-items: center; }
      .sc-range-line { width: 100%; border-top: 2px solid #999; }
      .sc-range-dot {
        position: absolute;
        width: 10px; height: 10px;
        background: #111;
        border-radius: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
      }
      .sc-range-min { font-size: 0.7rem; color: #555; margin-top: 2px; }
      .sc-label {
        grid-column: 1 / 4;
        text-align: center;
        font-size: 0.72rem;
        color: #666;
        font-style: italic;
        padding-top: 5px;
        margin-top: 4px;
      }
    </style>
    <div class="sc-card">
      <div class="sc-left">
        <div class="sc-level">${card.level}</div>
        <div class="sc-change" style="color:${changeColor}">${changeDisplay}</div>
      </div>
      <div class="sc-sparkline">${sparkSVG}</div>
      <div class="sc-range">
        <div class="sc-range-max">${card.histMax}</div>
        <div class="sc-range-line-wrap">
          <div class="sc-range-line"></div>
          <div class="sc-range-dot" style="left:${pct}%"></div>
        </div>
        <div class="sc-range-min">${card.histMin}</div>
      </div>
      <div class="sc-label">${card.label}</div>
    </div>`;
}

// Entry point — read cardID from script tag's data-card attribute
(async () => {
  const script = document.currentScript || document.querySelector('script[data-card]');
  const cardID = script ? script.getAttribute('data-card') : null;
  if (!cardID) { console.error('card.js: no data-card attribute found'); return; }

  const container = document.getElementById(`card-${cardID}`);
  if (!container) { console.error(`card.js: no element with id card-${cardID}`); return; }

  try {
    const card = await fetchCard(cardID);
    if (!card) { container.innerHTML = `<p style="color:red">Card "${cardID}" not found in data.</p>`; return; }
    renderCard(card, container);
  } catch (err) {
    container.innerHTML = `<p style="color:red">Error: ${err.message}</p>`;
  }
})();
