import fs from "node:fs/promises";
import path from "node:path";
import nodemailer from "nodemailer";

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
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 2
  }).format(Number(value ?? 0));
}

function formatPrice(value) {
  const number = Number(value ?? 0);
  if (number >= 1000) return number.toFixed(2);
  if (number >= 1) return number.toFixed(4);
  if (number >= 0.01) return number.toFixed(5);
  return number.toFixed(8);
}

function tableCell(content, options = {}) {
  const color = options.color ?? "#111827";
  const align = options.align ?? "left";
  const weight = options.weight ?? "500";
  return `<td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;color:${color};text-align:${align};font-weight:${weight};white-space:nowrap;">${content}</td>`;
}

function tableHeader(content, align = "left") {
  return `<th style="padding:10px 8px;border-bottom:1px solid #d1d5db;color:#4b5563;text-align:${align};font-size:13px;font-weight:700;white-space:nowrap;">${escapeHtml(content)}</th>`;
}

function buildRows(rows, side) {
  const percentColor = side === "gainer" ? "#059669" : "#dc2626";

  return rows
    .map((row) => {
      const repeatLabel = row.isRepeated ? row.repeatLabel : "-";
      return `<tr>
        ${tableCell(escapeHtml(row.rank), { color: "#6b7280", align: "center" })}
        ${tableCell(`<strong style="color:#111827;">${escapeHtml(row.symbol)}</strong>`, { weight: "700" })}
        ${tableCell(escapeHtml(formatPrice(row.lastPrice)), { align: "right" })}
        ${tableCell(escapeHtml(formatSignedPercent(row.priceChangePercent)), { color: percentColor, align: "right", weight: "800" })}
        ${tableCell(escapeHtml(formatCompact(row.quoteVolume)), { align: "right" })}
        ${tableCell(escapeHtml(repeatLabel || "-"), { color: row.isRepeated ? "#b45309" : "#9ca3af" })}
      </tr>`;
    })
    .join("");
}

function buildTable(title, rows, side) {
  const titleColor = side === "gainer" ? "#059669" : "#dc2626";
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    <thead>
      <tr>
        <th colspan="6" style="padding:14px 12px;background:#f9fafb;color:${titleColor};text-align:left;font-size:18px;font-weight:800;border-bottom:1px solid #e5e7eb;">${escapeHtml(title)}</th>
      </tr>
      <tr>
        ${tableHeader("名次", "center")}
        ${tableHeader("币种")}
        ${tableHeader("最新价", "right")}
        ${tableHeader("涨跌幅", "right")}
        ${tableHeader("成交额", "right")}
        ${tableHeader("标记")}
      </tr>
    </thead>
    <tbody>${buildRows(rows, side)}</tbody>
  </table>`;
}

export function buildBinanceEmailContent(summary) {
  const gainers = summary?.gainers ?? [];
  const losers = summary?.losers ?? [];
  const subject = `币安涨跌榜日报 ${summary?.dateLabel ?? ""}`.trim();
  const textSections = [
    `币安涨跌榜日报 ${summary?.dateLabel ?? ""}`,
    "",
    "涨幅榜：",
    ...gainers.map(
      (row) =>
        `${row.rank}. ${row.symbol} ${formatSignedPercent(row.priceChangePercent)} 最新价 ${formatPrice(row.lastPrice)}${row.isRepeated ? ` ${row.repeatLabel}` : ""}`
    ),
    "",
    "跌幅榜：",
    ...losers.map(
      (row) =>
        `${row.rank}. ${row.symbol} ${formatSignedPercent(row.priceChangePercent)} 最新价 ${formatPrice(row.lastPrice)}${row.isRepeated ? ` ${row.repeatLabel}` : ""}`
    ),
    "",
    `跟踪交易对：${summary?.universe?.symbolsWithTradingDayData ?? "-"}`,
    `生成时间：${summary?.generatedAt ?? "-"}`
  ];

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f3f4f6;color:#111827;font-family:'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background:#f3f4f6;">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="960" style="width:960px;max-width:100%;border-collapse:collapse;">
            <tr>
              <td style="padding:22px 24px;background:#111827;border-radius:8px;color:#ffffff;">
                <div style="font-size:28px;font-weight:900;line-height:1.3;color:#f0b90b;">币安涨跌榜日报</div>
                <div style="margin-top:10px;font-size:15px;color:#d1d5db;">日期：${escapeHtml(summary?.dateLabel ?? "-")} | 跟踪交易对：${escapeHtml(summary?.universe?.symbolsWithTradingDayData ?? "-")} | 计价币种：${escapeHtml(summary?.quoteAsset ?? "-")}</div>
              </td>
            </tr>
            <tr>
              <td style="padding-top:16px;">
                ${buildTable("涨幅榜", gainers, "gainer")}
              </td>
            </tr>
            <tr>
              <td style="padding-top:16px;">
                ${buildTable("跌幅榜", losers, "loser")}
              </td>
            </tr>
            <tr>
              <td style="padding:14px 4px 0;color:#6b7280;font-size:13px;">
                生成时间：${escapeHtml(summary?.generatedAt ?? "-")}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return {
    subject,
    text: textSections.join("\n"),
    html
  };
}

export async function loadEmailConfig(configPath) {
  const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
  return {
    smtp: {
      host: raw?.smtp?.host ?? "smtp.qq.com",
      port: raw?.smtp?.port ?? 465,
      secure: raw?.smtp?.secure ?? true,
      user: raw?.smtp?.user ?? process.env.BINANCE_SMTP_USER ?? "",
      pass: raw?.smtp?.pass ?? process.env.BINANCE_SMTP_PASS ?? ""
    },
    mail: {
      from: raw?.mail?.from ?? raw?.smtp?.user ?? process.env.BINANCE_SMTP_USER ?? "",
      to: Array.isArray(raw?.mail?.to)
        ? raw.mail.to
        : [raw?.mail?.to ?? process.env.BINANCE_MAIL_TO ?? ""].filter(Boolean),
      subjectPrefix: raw?.mail?.subjectPrefix ?? "币安涨跌榜日报"
    }
  };
}

export async function readLatestBinanceSummary(projectRoot) {
  const summaryPath = path.join(projectRoot, "data", "binance", "latest", "summary.json");
  return JSON.parse(await fs.readFile(summaryPath, "utf8"));
}

export async function sendBinanceEmail({ config, summary }) {
  const { subject, text, html } = buildBinanceEmailContent(summary);
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass
    }
  });

  const result = await transporter.sendMail({
    from: config.mail.from,
    to: config.mail.to.join(", "),
    subject: `${config.mail.subjectPrefix} ${summary.dateLabel}`.trim() || subject,
    text,
    html
  });

  return result;
}
