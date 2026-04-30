import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORM_LABELS = {
  tiktok: "抖音国际版",
  instagram: "Instagram",
  amazon: "亚马逊",
  fastmoss: "榜单数据源"
};

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

async function loadEnvFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw) {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    if (process.env[key] === undefined) {
      process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  }
}

async function loadLocalEnv(projectRoot) {
  await loadEnvFile(path.join(projectRoot, ".env.local"));
  await loadEnvFile(path.join(projectRoot, ".env"));
}

function truncateText(value, maxLength = 58) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text || "未命名商品";
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function formatCount(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return String(value);
  }
  if (number >= 10000) {
    return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)}万`;
  }
  return number.toLocaleString("zh-CN");
}

function formatScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "-";
  }
  return formatCount(Math.round(number));
}

function buildFeishuSignature(secret) {
  if (!secret) {
    return {};
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac("sha256", stringToSign).update("").digest("base64");
  return { timestamp, sign };
}

function line(...items) {
  return items.filter(Boolean);
}

function text(value) {
  return { tag: "text", text: value };
}

function link(label, href) {
  if (!href) {
    return null;
  }
  return { tag: "a", text: label, href };
}

function sourceUrl(record) {
  return (
    record.postUrl ||
    record.productUrl ||
    record.fastmossInfluencerUrl ||
    record.tiktokCreatorUrl ||
    record.rawMeta?.sourceUrl ||
    null
  );
}

function buildPlatformRows(records, limit) {
  const grouped = new Map();
  for (const record of records) {
    const platform = record.displayPlatform || record.platform || "unknown";
    if (!grouped.has(platform)) {
      grouped.set(platform, []);
    }
    grouped.get(platform).push(record);
  }

  const preferredOrder = ["tiktok", "instagram", "amazon", "fastmoss"];
  const orderedPlatforms = [
    ...preferredOrder.filter((platform) => grouped.has(platform)),
    ...[...grouped.keys()].filter((platform) => !preferredOrder.includes(platform))
  ];

  const rows = [];
  for (const platform of orderedPlatforms) {
    const platformRecords = grouped
      .get(platform)
      .slice()
      .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
      .slice(0, limit);

    rows.push(line(text(`\n【${PLATFORM_LABELS[platform] || platform}】共 ${platformRecords.length} 条\n`)));
    for (const [index, record] of platformRecords.entries()) {
      const title = truncateText(record.displayName || record.productHint || record.caption);
      const salesText = record.salesCount ? `｜销量 ${formatCount(record.salesCount)}` : "";
      const amountText = record.salesAmount ? `｜销售额 ${formatCount(record.salesAmount)}` : "";
      const commentsText = record.commentCount ? `｜评论 ${formatCount(record.commentCount)}` : "";
      const scoreText = `｜热度 ${formatScore(record.score || record.hotScore)}`;
      rows.push(
        line(
          text(`${index + 1}. ${title}${scoreText}${salesText}${amountText}${commentsText}  `),
          link("查看来源", sourceUrl(record))
        )
      );
    }
  }
  return rows;
}

function chunkRows(rows, maxRows) {
  const chunks = [];
  for (let index = 0; index < rows.length; index += maxRows) {
    chunks.push(rows.slice(index, index + maxRows));
  }
  return chunks;
}

async function postToFeishu(webhookUrl, secret, title, rows) {
  const payload = {
    ...buildFeishuSignature(secret),
    msg_type: "post",
    content: {
      post: {
        zh_cn: {
          title,
          content: rows
        }
      }
    }
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Feishu webhook failed: ${response.status} ${body}`);
  }

  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }

  if (parsed.StatusCode && parsed.StatusCode !== 0) {
    throw new Error(`Feishu webhook failed: ${body}`);
  }
  if (parsed.code && parsed.code !== 0) {
    throw new Error(`Feishu webhook failed: ${body}`);
  }
  return parsed;
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await loadLocalEnv(projectRoot);

  const args = parseArgs(process.argv.slice(2));
  const latestDir = path.resolve(projectRoot, args.latest || "data/latest");
  const webhookUrl = args.webhook || process.env.FEISHU_WEBHOOK_URL;
  const secret = args.secret || process.env.FEISHU_BOT_SECRET;
  const dashboardUrl =
    args.dashboardUrl || process.env.DASHBOARD_PUBLIC_URL || "http://127.0.0.1:47831/";
  const perPlatformLimit = Number(args.limit || process.env.FEISHU_TOP_PER_PLATFORM || 10);
  const maxRowsPerMessage = Number(args.maxRowsPerMessage || 22);
  const dryRun = Boolean(args["dry-run"] || process.env.FEISHU_DRY_RUN === "1");

  const [leaderboardsRaw, summaryRaw] = await Promise.all([
    fs.readFile(path.join(latestDir, "leaderboards.json"), "utf8"),
    fs.readFile(path.join(latestDir, "run-summary.json"), "utf8").catch(() => "{}")
  ]);
  const leaderboards = JSON.parse(leaderboardsRaw);
  const summary = JSON.parse(summaryRaw);
  const records = leaderboards.boards?.overall || [];
  const generatedAt = leaderboards.generatedAt || summary.finishedAt || new Date().toISOString();
  const dateText = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(generatedAt));

  const introRows = [
    line(text(`更新时间：${dateText}\n`)),
    line(text(`最新结果：${records.length} 条；每个平台最多推送 ${perPlatformLimit} 条。\n`)),
    line(text("本机结果页："), link(dashboardUrl, dashboardUrl), text("\n"))
  ];
  const contentRows = buildPlatformRows(records, perPlatformLimit);
  const chunks = chunkRows([...introRows, ...contentRows], maxRowsPerMessage);

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: true,
          messages: chunks.length,
          records: records.length,
          title: "社媒热推榜",
          preview: chunks[0]
        },
        null,
        2
      )
    );
    return;
  }

  if (!webhookUrl) {
    throw new Error(
      "Missing FEISHU_WEBHOOK_URL. Put it in .env.local or pass --webhook <url>."
    );
  }

  for (const [index, chunk] of chunks.entries()) {
    const suffix = chunks.length > 1 ? `（${index + 1}/${chunks.length}）` : "";
    await postToFeishu(webhookUrl, secret, `社媒热推榜${suffix}`, chunk);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        messages: chunks.length,
        records: records.length,
        latestDir,
        dashboardUrl
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
