const MAX_MESSAGE_LENGTH = 3900;

function notifyTarget() {
  return String(process.env.TELEGRAM_NOTIFY_TARGET || "").trim();
}

function notificationsEnabled() {
  const flag = String(process.env.TELEGRAM_NOTIFY_ENABLED || "true").trim().toLowerCase();
  return Boolean(notifyTarget()) && !["0", "false", "no", "off"].includes(flag);
}

function compactText(value, maxLength = 900) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function postSender(post) {
  if (post.senderUsername) return `@${post.senderUsername}`;
  if (post.senderName) return post.senderName;
  if (post.senderId) return post.senderId;
  return post.authorHandle || post.group || "telegram";
}

export function telegramNotifyConfigured() {
  return notificationsEnabled();
}

export function formatTelegramPostNotification(post) {
  const lines = [
    "[Meme Monitor]",
    `Source: ${post.group || post.authorHandle || "telegram"}`,
    `Sender: ${postSender(post)}`,
    `Score: ${post.memeScore ?? "-"}`,
    `Time: ${post.publishedAt || post.scrapedAt || "-"}`,
    "",
    compactText(post.text),
    "",
    post.url || ""
  ].filter((line) => line !== "");
  return lines.join("\n").slice(0, MAX_MESSAGE_LENGTH);
}

export function formatTelegramBatchNotification(payload) {
  const posts = Array.isArray(payload?.posts) ? payload.posts : [];
  const topPosts = posts.slice(0, 5);
  const lines = [
    "[Meme Monitor] Manual scrape finished",
    `Matched: ${posts.length}`,
    `Targets: ${(payload?.targets || []).join(", ") || "-"}`,
    `Time: ${payload?.generatedAt || new Date().toISOString()}`,
    ""
  ];
  for (const post of topPosts) {
    lines.push(`- ${post.group || "telegram"} / ${postSender(post)} / score ${post.memeScore ?? "-"}`);
    lines.push(`  ${compactText(post.text, 180)}`);
    if (post.url) lines.push(`  ${post.url}`);
  }
  if (posts.length > topPosts.length) {
    lines.push(`... ${posts.length - topPosts.length} more matched messages saved locally.`);
  }
  return lines.join("\n").slice(0, MAX_MESSAGE_LENGTH);
}

export async function sendTelegramNotification(client, text) {
  if (!notificationsEnabled()) return false;
  await client.sendMessage(notifyTarget(), {
    message: String(text || "").slice(0, MAX_MESSAGE_LENGTH),
    linkPreview: false
  });
  return true;
}
