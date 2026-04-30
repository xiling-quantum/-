import fs from "node:fs/promises";
import path from "node:path";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatSignedPercent(value) {
  const number = Number(value ?? 0);
  const sign = number > 0 ? "+" : "";
  return `${sign}${number.toFixed(2)}%`;
}

function formatCompact(value) {
  const number = Number(value ?? 0);
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 2
  }).format(number);
}

function formatPrice(value) {
  const number = Number(value ?? 0);
  if (number >= 1000) return number.toFixed(2);
  if (number >= 1) return number.toFixed(4);
  if (number >= 0.01) return number.toFixed(5);
  return number.toFixed(8);
}

function buildRow(row, side) {
  const isGainer = side === "gainer";
  const repeatBadge = row.isRepeated
    ? `<span class="streak-badge">${escapeHtml(row.repeatLabel ?? `连续出现 ${row.repeatDays} 天`)}</span>`
    : "";

  return `
    <tr class="market-row">
      <td>
        <div class="symbol-cell">
          <span class="rank-dot">${escapeHtml(row.rank)}</span>
          <div>
            <div class="symbol-main">${escapeHtml(row.baseAsset)}</div>
            <div class="symbol-sub">${escapeHtml(row.symbol)}</div>
          </div>
        </div>
      </td>
      <td>${escapeHtml(formatPrice(row.lastPrice))}</td>
      <td class="${isGainer ? "up" : "down"}">${escapeHtml(formatSignedPercent(row.priceChangePercent))}</td>
      <td>${escapeHtml(formatCompact(row.quoteVolume))}</td>
      <td>${escapeHtml(formatPrice(row.lowPrice))} - ${escapeHtml(formatPrice(row.highPrice))}</td>
      <td>${repeatBadge}</td>
    </tr>
  `;
}

function buildCard(row, side) {
  const isGainer = side === "gainer";

  return `
    <article class="hero-card ${isGainer ? "hero-up" : "hero-down"}">
      <div class="hero-card-top">
        <span class="hero-eyebrow">${isGainer ? "涨幅榜第一" : "跌幅榜第一"}</span>
        ${row.isRepeated ? `<span class="hero-streak">${escapeHtml(row.repeatLabel ?? `连续出现 ${row.repeatDays} 天`)}</span>` : ""}
      </div>
      <h2>${escapeHtml(row.baseAsset)}<small>${escapeHtml(row.symbol)}</small></h2>
      <div class="hero-move ${isGainer ? "up" : "down"}">${escapeHtml(formatSignedPercent(row.priceChangePercent))}</div>
      <div class="hero-stats">
        <span>最新价 ${escapeHtml(formatPrice(row.lastPrice))}</span>
        <span>24h 成交额 ${escapeHtml(formatCompact(row.quoteVolume))}</span>
      </div>
    </article>
  `;
}

function buildSparklineBars(rows, side) {
  const absoluteMax = Math.max(...rows.map((item) => Math.abs(Number(item.priceChangePercent ?? 0))), 1);

  return rows
    .map((row) => {
      const width = Math.max(8, Math.round((Math.abs(Number(row.priceChangePercent ?? 0)) / absoluteMax) * 100));
      return `
        <div class="flow-row">
          <div class="flow-label">
            <span>${escapeHtml(row.baseAsset)}</span>
            <small>${escapeHtml(row.symbol)}</small>
          </div>
          <div class="flow-bar-shell">
            <div class="flow-bar ${side}" style="width:${width}%"></div>
          </div>
          <strong class="${side}">${escapeHtml(formatSignedPercent(row.priceChangePercent))}</strong>
        </div>
      `;
    })
    .join("");
}

function buildHtml(summary) {
  const gainers = summary.gainers ?? [];
  const losers = summary.losers ?? [];
  const topGainer = gainers[0];
  const topLoser = losers[0];
  const repeatCount = gainers.filter((item) => item.isRepeated).length;
  const totalTrackedVolume = [...gainers, ...losers].reduce(
    (sum, item) => sum + Number(item.quoteVolume ?? 0),
    0
  );
  const dataScript = JSON.stringify(summary);

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>币安涨跌榜看板</title>
    <style>
      :root {
        --bg: #0b0e11;
        --panel: #161a1e;
        --panel-2: #1e2329;
        --panel-3: #2b3139;
        --text: #f0f4f8;
        --muted: #848e9c;
        --yellow: #f0b90b;
        --yellow-soft: rgba(240, 185, 11, 0.14);
        --green: #0ecb81;
        --red: #f6465d;
        --line: rgba(255,255,255,0.06);
        --shadow: 0 24px 80px rgba(0,0,0,0.35);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Segoe UI", "PingFang SC", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top right, rgba(240,185,11,0.16), transparent 24%),
          radial-gradient(circle at top left, rgba(246,70,93,0.08), transparent 22%),
          linear-gradient(180deg, #0b0e11 0%, #0f1317 100%);
        min-height: 100vh;
      }
      .shell {
        width: min(1400px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 28px 0 40px;
      }
      .topbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        padding: 14px 18px;
        border: 1px solid var(--line);
        border-radius: 18px;
        background: rgba(22, 26, 30, 0.72);
        backdrop-filter: blur(16px);
        box-shadow: var(--shadow);
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .brand-mark {
        width: 42px;
        height: 42px;
        border-radius: 14px;
        background:
          linear-gradient(135deg, rgba(240,185,11,0.28), rgba(240,185,11,0.08)),
          #101418;
        border: 1px solid rgba(240,185,11,0.28);
        position: relative;
      }
      .brand-mark::before,
      .brand-mark::after {
        content: "";
        position: absolute;
        inset: 9px;
        border: 2px solid var(--yellow);
        transform: rotate(45deg);
      }
      .brand-mark::after {
        inset: 15px;
      }
      .brand h1 {
        margin: 0;
        font-size: 22px;
        letter-spacing: 0.02em;
      }
      .brand p,
      .topbar-meta span {
        margin: 0;
        color: var(--muted);
      }
      .topbar-meta {
        display: flex;
        gap: 18px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .topbar-meta strong {
        display: block;
        color: var(--text);
        font-size: 14px;
      }
      .topbar-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 10px;
        flex-wrap: wrap;
      }
      .run-button {
        border: 0;
        border-radius: 999px;
        padding: 11px 16px;
        color: #181a20;
        background: var(--yellow);
        font-weight: 800;
        cursor: pointer;
        box-shadow: 0 10px 26px rgba(240,185,11,0.18);
      }
      .run-button:disabled {
        cursor: wait;
        opacity: 0.62;
      }
      .run-status {
        min-width: 160px;
        color: var(--muted);
        font-size: 12px;
        text-align: right;
      }
      .calendar-panel {
        margin-top: 18px;
        padding: 16px 18px;
        border: 1px solid var(--line);
        border-radius: 20px;
        background: rgba(22, 26, 30, 0.72);
        box-shadow: var(--shadow);
      }
      .calendar-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-bottom: 12px;
      }
      .calendar-head h3 {
        margin: 0;
        font-size: 16px;
      }
      .calendar-head span {
        color: var(--muted);
        font-size: 12px;
      }
      .date-picker {
        display: flex;
        gap: 10px;
        overflow-x: auto;
        padding-bottom: 2px;
      }
      .date-button {
        flex: 0 0 auto;
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 10px 12px;
        color: var(--text);
        background: rgba(255,255,255,0.03);
        cursor: pointer;
        font-weight: 700;
      }
      .date-button.active {
        color: #181a20;
        border-color: var(--yellow);
        background: var(--yellow);
      }
      .hero {
        display: grid;
        grid-template-columns: 1.2fr 0.8fr;
        gap: 18px;
        margin-top: 18px;
      }
      .hero-panel,
      .board-panel,
      .flow-panel {
        border: 1px solid var(--line);
        border-radius: 24px;
        background: linear-gradient(180deg, rgba(30,35,41,0.94), rgba(18,22,27,0.94));
        box-shadow: var(--shadow);
      }
      .hero-panel {
        padding: 22px;
      }
      .hero-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
        margin-top: 18px;
      }
      .hero-card {
        padding: 20px;
        border-radius: 20px;
        border: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(43,49,57,0.88), rgba(22,26,30,0.88));
      }
      .hero-up { box-shadow: inset 0 0 0 1px rgba(14,203,129,0.12); }
      .hero-down { box-shadow: inset 0 0 0 1px rgba(246,70,93,0.12); }
      .hero-card-top {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
      }
      .hero-eyebrow,
      .hero-streak,
      .summary-chip,
      .streak-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
      }
      .hero-eyebrow {
        color: #181a20;
        background: var(--yellow);
      }
      .hero-streak,
      .streak-badge {
        color: var(--green);
        background: rgba(14,203,129,0.12);
        border: 1px solid rgba(14,203,129,0.18);
      }
      .hero-card h2 {
        margin: 16px 0 6px;
        font-size: 34px;
        line-height: 1;
      }
      .hero-card h2 small {
        display: block;
        margin-top: 8px;
        color: var(--muted);
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.04em;
      }
      .hero-move {
        font-size: 42px;
        font-weight: 800;
        letter-spacing: -0.03em;
      }
      .up { color: var(--green); }
      .down { color: var(--red); }
      .hero-stats,
      .summary-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }
      .hero-stats span,
      .summary-box {
        padding: 12px 14px;
        border-radius: 16px;
        background: rgba(255,255,255,0.03);
        border: 1px solid var(--line);
      }
      .summary-side {
        padding: 22px;
      }
      .section-head {
        display: flex;
        justify-content: space-between;
        align-items: end;
        gap: 12px;
      }
      .section-head h3 {
        margin: 0;
        font-size: 18px;
      }
      .section-head p {
        margin: 6px 0 0;
        color: var(--muted);
      }
      .summary-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        margin-top: 18px;
      }
      .summary-box strong {
        display: block;
        margin-top: 8px;
        font-size: 22px;
      }
      .summary-chip {
        color: #181a20;
        background: rgba(240,185,11,0.92);
      }
      .boards {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
        margin-top: 18px;
      }
      .board-panel {
        overflow: hidden;
      }
      .board-panel header,
      .flow-panel header {
        padding: 18px 20px 14px;
        border-bottom: 1px solid var(--line);
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th,
      td {
        padding: 14px 20px;
        text-align: left;
        border-bottom: 1px solid var(--line);
        font-size: 14px;
      }
      th {
        color: var(--muted);
        font-weight: 600;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .market-row:hover {
        background: rgba(255,255,255,0.025);
      }
      .symbol-cell {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .rank-dot {
        width: 28px;
        height: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        background: rgba(240,185,11,0.12);
        color: var(--yellow);
        font-size: 12px;
        font-weight: 800;
      }
      .symbol-main {
        font-size: 16px;
        font-weight: 700;
      }
      .symbol-sub {
        color: var(--muted);
        font-size: 12px;
      }
      .flow-panel {
        margin-top: 18px;
        overflow: hidden;
      }
      .flow-wrap {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0;
      }
      .flow-col {
        padding: 18px 20px 20px;
      }
      .flow-col + .flow-col {
        border-left: 1px solid var(--line);
      }
      .flow-row {
        display: grid;
        grid-template-columns: 112px 1fr 72px;
        align-items: center;
        gap: 12px;
        margin-top: 12px;
      }
      .flow-label span {
        display: block;
        font-weight: 700;
      }
      .flow-label small {
        color: var(--muted);
      }
      .flow-bar-shell {
        height: 10px;
        border-radius: 999px;
        background: rgba(255,255,255,0.05);
        overflow: hidden;
      }
      .flow-bar {
        height: 100%;
        border-radius: 999px;
      }
      .flow-bar.gainer {
        background: linear-gradient(90deg, rgba(14,203,129,0.4), rgba(14,203,129,1));
      }
      .flow-bar.loser {
        background: linear-gradient(90deg, rgba(246,70,93,0.35), rgba(246,70,93,1));
      }
      .footer {
        margin-top: 18px;
        color: var(--muted);
        font-size: 13px;
        text-align: right;
      }
      @media (max-width: 1100px) {
        .hero,
        .boards,
        .flow-wrap {
          grid-template-columns: 1fr;
        }
        .flow-col + .flow-col {
          border-left: 0;
          border-top: 1px solid var(--line);
        }
      }
      @media (max-width: 760px) {
        .shell {
          width: min(100vw - 20px, 1400px);
          padding-top: 14px;
        }
        .topbar,
        .hero-panel,
        .summary-side,
        .flow-col {
          padding: 16px;
        }
        .topbar-actions,
        .run-status {
          justify-content: flex-start;
          text-align: left;
        }
        .hero-grid,
        .summary-grid {
          grid-template-columns: 1fr;
        }
        th:nth-child(4),
        td:nth-child(4),
        th:nth-child(5),
        td:nth-child(5) {
          display: none;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="topbar">
        <div class="brand">
          <div class="brand-mark"></div>
          <div>
            <h1>币安涨跌榜看板</h1>
            <p>现货市场日内涨跌榜，自动标注连续上涨币种</p>
          </div>
        </div>
        <div class="topbar-meta">
          <span>交易日<strong id="currentDateLabel">${escapeHtml(summary.dateLabel)}</strong></span>
          <span>计价币种<strong>${escapeHtml(summary.quoteAsset)}</strong></span>
          <span>跟踪交易对<strong id="trackedUniverse">${escapeHtml(summary.universe?.symbolsWithTradingDayData ?? 0)}</strong></span>
        </div>
        <div class="topbar-actions">
          <button id="runBinanceButton" class="run-button" type="button">立即抓取</button>
          <span id="runBinanceStatus" class="run-status">通过本地服务打开后可自动抓取。</span>
        </div>
      </div>

      <section class="calendar-panel">
        <div class="calendar-head">
          <div>
            <h3>历史日历</h3>
            <span>每天抓取一次，点击日期查看当天涨跌榜；重复出现会自动标注。</span>
          </div>
        </div>
        <div id="datePicker" class="date-picker"></div>
      </section>

      <section class="hero">
        <div class="hero-panel">
          <div class="section-head">
            <div>
              <h3>市场脉搏</h3>
              <p>基于今日公开行情生成的本地币安风格看板。</p>
            </div>
            <span class="summary-chip">前 ${escapeHtml(summary.top)} 名</span>
          </div>
          <div id="heroGrid" class="hero-grid">
            ${topGainer ? buildCard(topGainer, "gainer") : ""}
            ${topLoser ? buildCard(topLoser, "loser") : ""}
          </div>
        </div>

        <aside class="summary-side hero-panel">
          <div class="section-head">
            <div>
              <h3>快速概览</h3>
              <p>快速查看本次生成榜单的关键信息。</p>
            </div>
          </div>
          <div class="summary-grid">
            <div class="summary-box">
              重复出现数
              <strong id="repeatCount">${escapeHtml(repeatCount)}</strong>
            </div>
            <div class="summary-box">
              榜单合计 24h 成交额
              <strong id="totalTrackedVolume">${escapeHtml(formatCompact(totalTrackedVolume))}</strong>
            </div>
            <div class="summary-box">
              最大涨幅
              <strong id="bestMove" class="up">${escapeHtml(topGainer ? formatSignedPercent(topGainer.priceChangePercent) : "--")}</strong>
            </div>
            <div class="summary-box">
              最大跌幅
              <strong id="worstMove" class="down">${escapeHtml(topLoser ? formatSignedPercent(topLoser.priceChangePercent) : "--")}</strong>
            </div>
          </div>
        </aside>
      </section>

      <section class="boards">
        <div class="board-panel">
          <header class="section-head">
            <div>
              <h3>涨幅榜</h3>
              <p>按当日涨跌幅从高到低排序。</p>
            </div>
          </header>
          <table>
            <thead>
              <tr>
                <th>币种</th>
                <th>最新价</th>
                <th>24h%</th>
                <th>成交额</th>
                <th>区间</th>
                <th>标记</th>
              </tr>
            </thead>
            <tbody id="gainersBody">${gainers.map((row) => buildRow(row, "gainer")).join("")}</tbody>
          </table>
        </div>

        <div class="board-panel">
          <header class="section-head">
            <div>
              <h3>跌幅榜</h3>
              <p>按当日涨跌幅从低到高排序。</p>
            </div>
          </header>
          <table>
            <thead>
              <tr>
                <th>币种</th>
                <th>最新价</th>
                <th>24h%</th>
                <th>成交额</th>
                <th>区间</th>
                <th>标记</th>
              </tr>
            </thead>
            <tbody id="losersBody">${losers.map((row) => buildRow(row, "loser")).join("")}</tbody>
          </table>
        </div>
      </section>

      <section class="flow-panel">
        <header class="section-head">
          <div>
            <h3>动量分布</h3>
            <p>对比涨跌两侧榜单的相对波动强度。</p>
          </div>
        </header>
        <div class="flow-wrap">
          <div class="flow-col">
            <div class="section-head">
              <div>
                <h3>涨幅动量</h3>
              </div>
            </div>
            <div id="gainersFlow">${buildSparklineBars(gainers, "gainer")}</div>
          </div>
          <div class="flow-col">
            <div class="section-head">
              <div>
                <h3>跌幅动量</h3>
              </div>
            </div>
            <div id="losersFlow">${buildSparklineBars(losers, "loser")}</div>
          </div>
        </div>
      </section>

      <div class="footer">
        生成时间 ${escapeHtml(summary.generatedAt)} | 时区偏移 ${escapeHtml(summary.timezoneOffset)}
      </div>
    </div>
    <script>
      window.__BINANCE_MOVERS__ = ${dataScript};
      const snapshots = window.__BINANCE_MOVERS__.history?.length
        ? window.__BINANCE_MOVERS__.history
        : [window.__BINANCE_MOVERS__];
      const datePicker = document.getElementById("datePicker");
      const heroGrid = document.getElementById("heroGrid");
      const gainersBody = document.getElementById("gainersBody");
      const losersBody = document.getElementById("losersBody");
      const gainersFlow = document.getElementById("gainersFlow");
      const losersFlow = document.getElementById("losersFlow");
      const currentDateLabel = document.getElementById("currentDateLabel");
      const trackedUniverse = document.getElementById("trackedUniverse");
      const repeatCountNode = document.getElementById("repeatCount");
      const totalTrackedVolumeNode = document.getElementById("totalTrackedVolume");
      const bestMoveNode = document.getElementById("bestMove");
      const worstMoveNode = document.getElementById("worstMove");

      function escapeClientHtml(value) {
        return String(value ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }

      function formatClientPercent(value) {
        const number = Number(value ?? 0);
        return (number > 0 ? "+" : "") + number.toFixed(2) + "%";
      }

      function formatClientCompact(value) {
        return new Intl.NumberFormat("en", {
          notation: "compact",
          maximumFractionDigits: 2
        }).format(Number(value ?? 0));
      }

      function formatClientPrice(value) {
        const number = Number(value ?? 0);
        if (number >= 1000) return number.toFixed(2);
        if (number >= 1) return number.toFixed(4);
        if (number >= 0.01) return number.toFixed(5);
        return number.toFixed(8);
      }

      function clientRow(row, side) {
        const repeatBadge = row.isRepeated
          ? '<span class="streak-badge">' + escapeClientHtml(row.repeatLabel || ("连续出现 " + row.repeatDays + " 天")) + "</span>"
          : "";
        return '<tr class="market-row">' +
          '<td><div class="symbol-cell"><span class="rank-dot">' + escapeClientHtml(row.rank) + '</span><div>' +
          '<div class="symbol-main">' + escapeClientHtml(row.baseAsset) + '</div>' +
          '<div class="symbol-sub">' + escapeClientHtml(row.symbol) + '</div>' +
          '</div></div></td>' +
          '<td>' + escapeClientHtml(formatClientPrice(row.lastPrice)) + '</td>' +
          '<td class="' + (side === "gainer" ? "up" : "down") + '">' + escapeClientHtml(formatClientPercent(row.priceChangePercent)) + '</td>' +
          '<td>' + escapeClientHtml(formatClientCompact(row.quoteVolume)) + '</td>' +
          '<td>' + escapeClientHtml(formatClientPrice(row.lowPrice)) + ' - ' + escapeClientHtml(formatClientPrice(row.highPrice)) + '</td>' +
          '<td>' + repeatBadge + '</td>' +
          '</tr>';
      }

      function clientCard(row, side) {
        if (!row) return "";
        const isGainer = side === "gainer";
        const badge = row.isRepeated
          ? '<span class="hero-streak">' + escapeClientHtml(row.repeatLabel || ("连续出现 " + row.repeatDays + " 天")) + "</span>"
          : "";
        return '<article class="hero-card ' + (isGainer ? "hero-up" : "hero-down") + '">' +
          '<div class="hero-card-top"><span class="hero-eyebrow">' + (isGainer ? "涨幅榜第一" : "跌幅榜第一") + '</span>' + badge + '</div>' +
          '<h2>' + escapeClientHtml(row.baseAsset) + '<small>' + escapeClientHtml(row.symbol) + '</small></h2>' +
          '<div class="hero-move ' + (isGainer ? "up" : "down") + '">' + escapeClientHtml(formatClientPercent(row.priceChangePercent)) + '</div>' +
          '<div class="hero-stats"><span>最新价 ' + escapeClientHtml(formatClientPrice(row.lastPrice)) + '</span>' +
          '<span>24h 成交额 ' + escapeClientHtml(formatClientCompact(row.quoteVolume)) + '</span></div>' +
          '</article>';
      }

      function clientFlow(rows, side) {
        const absoluteMax = Math.max(...rows.map((item) => Math.abs(Number(item.priceChangePercent ?? 0))), 1);
        return rows.map((row) => {
          const width = Math.max(8, Math.round((Math.abs(Number(row.priceChangePercent ?? 0)) / absoluteMax) * 100));
          return '<div class="flow-row"><div class="flow-label">' +
            '<span>' + escapeClientHtml(row.baseAsset) + '</span><small>' + escapeClientHtml(row.symbol) + '</small></div>' +
            '<div class="flow-bar-shell"><div class="flow-bar ' + side + '" style="width:' + width + '%"></div></div>' +
            '<strong class="' + side + '">' + escapeClientHtml(formatClientPercent(row.priceChangePercent)) + '</strong></div>';
        }).join("");
      }

      function renderSnapshot(snapshot) {
        const gainers = snapshot.gainers || [];
        const losers = snapshot.losers || [];
        const topGainer = gainers[0];
        const topLoser = losers[0];
        const repeated = gainers.filter((item) => item.isRepeated).length + losers.filter((item) => item.isRepeated).length;
        const totalVolume = [...gainers, ...losers].reduce((sum, item) => sum + Number(item.quoteVolume || 0), 0);

        currentDateLabel.textContent = snapshot.dateLabel || "--";
        trackedUniverse.textContent = snapshot.universe?.symbolsWithTradingDayData ?? "--";
        repeatCountNode.textContent = repeated;
        totalTrackedVolumeNode.textContent = formatClientCompact(totalVolume);
        bestMoveNode.textContent = topGainer ? formatClientPercent(topGainer.priceChangePercent) : "--";
        worstMoveNode.textContent = topLoser ? formatClientPercent(topLoser.priceChangePercent) : "--";
        heroGrid.innerHTML = clientCard(topGainer, "gainer") + clientCard(topLoser, "loser");
        gainersBody.innerHTML = gainers.map((row) => clientRow(row, "gainer")).join("");
        losersBody.innerHTML = losers.map((row) => clientRow(row, "loser")).join("");
        gainersFlow.innerHTML = clientFlow(gainers, "gainer");
        losersFlow.innerHTML = clientFlow(losers, "loser");

        document.querySelectorAll(".date-button").forEach((button) => {
          button.classList.toggle("active", button.dataset.date === snapshot.dateLabel);
        });
      }

      function renderCalendar() {
        datePicker.innerHTML = snapshots.map((snapshot) =>
          '<button class="date-button" type="button" data-date="' + escapeClientHtml(snapshot.dateLabel) + '">' +
          escapeClientHtml(snapshot.dateLabel) + '</button>'
        ).join("");

        datePicker.querySelectorAll(".date-button").forEach((button) => {
          button.addEventListener("click", () => {
            const snapshot = snapshots.find((item) => item.dateLabel === button.dataset.date);
            if (snapshot) renderSnapshot(snapshot);
          });
        });
      }

      renderCalendar();
      renderSnapshot(snapshots[snapshots.length - 1]);
      const runButton = document.getElementById("runBinanceButton");
      const runStatus = document.getElementById("runBinanceStatus");
      let lastFinishedAt = null;
      let reloadAfterRun = false;

      function setRunState(status) {
        if (!runStatus || !runButton) return;

        if (!status || status.localFile) {
          runButton.disabled = true;
          runStatus.textContent = "请通过本地常驻服务打开页面";
          return;
        }

        runButton.disabled = Boolean(status.running);

        if (status.running) {
          runStatus.textContent = "正在抓取行情...";
          return;
        }

        if (status.status === "completed") {
          runStatus.textContent = "已更新：" + new Date(status.finishedAt).toLocaleString();
          if (reloadAfterRun && lastFinishedAt && status.finishedAt !== lastFinishedAt) {
            window.location.reload();
          }
          lastFinishedAt = status.finishedAt;
          reloadAfterRun = false;
          return;
        }

        if (status.status === "failed") {
          runStatus.textContent = "抓取失败，请查看后台日志";
          reloadAfterRun = false;
          return;
        }

        runStatus.textContent = "可手动抓取；后台每日自动更新";
      }

      async function refreshRunStatus() {
        if (window.location.protocol === "file:") {
          setRunState({ localFile: true });
          return;
        }

        try {
          const response = await fetch("/api/status", { cache: "no-store" });
          if (!response.ok) throw new Error("status failed");
          setRunState(await response.json());
        } catch {
          setRunState({ localFile: true });
        }
      }

      runButton?.addEventListener("click", async () => {
        runButton.disabled = true;
        runStatus.textContent = "正在启动抓取...";
        reloadAfterRun = true;
        try {
          const response = await fetch("/api/run", { method: "POST" });
          const status = await response.json();
          setRunState(status);
        } catch {
          runStatus.textContent = "启动失败：请确认本地服务正在运行";
          runButton.disabled = false;
          reloadAfterRun = false;
        }
      });

      refreshRunStatus();
      setInterval(refreshRunStatus, 5000);
    </script>
  </body>
</html>`;
}

export async function buildBinanceSite({ outputDir, summary }) {
  const siteDir = path.join(outputDir, "site");
  const entryFile = path.join(siteDir, "index.html");
  await fs.mkdir(siteDir, { recursive: true });
  await fs.writeFile(entryFile, buildHtml(summary), "utf8");
  return {
    siteDir,
    entryFile
  };
}
