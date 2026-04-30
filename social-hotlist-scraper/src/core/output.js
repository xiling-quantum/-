import fs from "node:fs/promises";
import path from "node:path";
import { STANDARD_FIELDS } from "./constants.js";
import { slugifyTimestamp } from "./utils.js";

function csvEscape(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const raw =
    typeof value === "string"
      ? value
      : Array.isArray(value) || typeof value === "object"
        ? JSON.stringify(value)
        : String(value);

  return `"${raw.replace(/"/g, "\"\"")}"`;
}

export async function createRunDirectory(baseOutputDir, runDate = new Date()) {
  const runId = slugifyTimestamp(runDate);
  const runDir = path.join(baseOutputDir, runId);
  await fs.mkdir(runDir, { recursive: true });
  return {
    runId,
    runDir
  };
}

export async function writeJsonl(filePath, records) {
  const content = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await fs.writeFile(filePath, content, "utf8");
}

export async function writeCsv(filePath, records) {
  const lines = [
    STANDARD_FIELDS.join(","),
    ...records.map((record) =>
      STANDARD_FIELDS.map((field) => csvEscape(record[field])).join(",")
    )
  ];
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

export async function writeRunSummary(filePath, summary) {
  await fs.writeFile(filePath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

export async function writeObjectsCsv(filePath, rows) {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((field) => csvEscape(row[field])).join(","))
  ];
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

export async function syncLatestOutput(runDir, latestDir) {
  await fs.rm(latestDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(latestDir), { recursive: true });
  await fs.cp(runDir, latestDir, { recursive: true });
}
