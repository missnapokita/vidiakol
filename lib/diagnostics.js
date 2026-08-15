const crypto = require("crypto");
const { command, pipeline } = require("./redis");

const REPORT_LIST_KEY = "btk:diagnostics:reports";
const REPORT_KEY_PREFIX = "btk:diagnostics:report:";
const DEDUPE_KEY_PREFIX = "btk:diagnostics:dedupe:";
const STATS_KEY = "btk:diagnostics:stats";

const MAX_REPORTS = 5000;
const REPORT_TTL_SECONDS = 60 * 24 * 60 * 60; // 60 days
const DEDUPE_WINDOW_SECONDS = 10 * 60;         // 10 minutes

function cleanText(value, max = 500) {
  return String(value == null ? "" : value)
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, max);
}

function safeInt(value, min = 0, max = 999999) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function allowedBackend(value) {
  const v = cleanText(value, 30).toUpperCase();
  return ["SAF", "SHIZUKU", "LEGACY", "UNKNOWN"].includes(v) ? v : "UNKNOWN";
}

function allowedCategory(value) {
  const v = cleanText(value, 30).toUpperCase();
  const allowed = [
    "PERMISSION", "DOWNLOAD", "ZIP", "UNZIP",
    "CREATE_FOLDER", "WRITE", "REPLACE", "VERIFY",
    "SHIZUKU", "SAF", "LEGACY", "UNKNOWN"
  ];
  return allowed.includes(v) ? v : "UNKNOWN";
}

function normalizeStage(value) {
  const v = cleanText(value, 50).toUpperCase();
  return v || "UNKNOWN";
}

function reportId() {
  return `DIA-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function dedupeFingerprint(report) {
  const parts = [
    report.code,
    report.backend,
    report.category,
    report.stage,
    report.reason,
    report.exception_type,
    report.target_entry,
    report.android_version,
    report.sdk,
    report.manufacturer,
    report.model
  ].join("|");

  return crypto.createHash("sha256").update(parts).digest("hex").slice(0, 24);
}

function sanitizeReport(body) {
  const now = Date.now();

  return {
    report_id: reportId(),
    code: cleanText(body.code || "BTK-UNKNOWN", 80),
    category: allowedCategory(body.category),
    backend: allowedBackend(body.backend),
    stage: normalizeStage(body.stage),

    reason: cleanText(body.reason || body.error || "Unknown failure", 1000),
    error: cleanText(body.error, 1000),
    exception_type: cleanText(body.exception_type, 160),
    exception: cleanText(body.exception, 1800),

    android_version: cleanText(body.android_version, 40),
    sdk: safeInt(body.sdk, 0, 100),
    manufacturer: cleanText(body.manufacturer, 80),
    model: cleanText(body.model, 120),
    app_version: cleanText(body.app_version, 80),

    task_category: cleanText(body.task_category, 80),
    target_entry: cleanText(body.target_entry, 500),
    target_path: cleanText(body.target_path, 700),
    progress: safeInt(body.progress, 0, 100),

    shizuku_state: cleanText(body.shizuku_state, 120),
    permission_state: cleanText(body.permission_state, 160),

    created_at: now
  };
}

async function incrementStats(report) {
  const fields = [
    ["total", 1],
    [`backend:${report.backend}`, 1],
    [`category:${report.category}`, 1],
    [`stage:${report.stage}`, 1],
    [`code:${report.code}`, 1]
  ];

  const commands = fields.map(([field, amount]) => ["HINCRBY", STATS_KEY, field, amount]);
  await pipeline(commands);
}

async function saveReport(body) {
  const report = sanitizeReport(body);
  const fingerprint = dedupeFingerprint(report);
  const dedupeKey = DEDUPE_KEY_PREFIX + fingerprint;

  // NX + EX means an identical failure from the same device/context
  // will be stored at most once per 10-minute window.
  const dedupe = await command([
    "SET",
    dedupeKey,
    report.report_id,
    "NX",
    "EX",
    DEDUPE_WINDOW_SECONDS
  ]);

  if (dedupe !== "OK") {
    return {
      stored: false,
      duplicate: true,
      report_id: null
    };
  }

  const reportKey = REPORT_KEY_PREFIX + report.report_id;

  await pipeline([
    ["SET", reportKey, JSON.stringify(report), "EX", REPORT_TTL_SECONDS],
    ["LPUSH", REPORT_LIST_KEY, report.report_id],
    ["LTRIM", REPORT_LIST_KEY, 0, MAX_REPORTS - 1]
  ]);

  await incrementStats(report);

  // Remove stale IDs whose report payloads already expired.
  // Also guarantees the list never exceeds MAX_REPORTS.
  await cleanupList();

  return {
    stored: true,
    duplicate: false,
    report_id: report.report_id
  };
}

async function cleanupList() {
  const ids = await command(["LRANGE", REPORT_LIST_KEY, 0, MAX_REPORTS - 1]) || [];
  if (!ids.length) return;

  const checks = await pipeline(
    ids.map(id => ["EXISTS", REPORT_KEY_PREFIX + id])
  );

  const stale = [];
  for (let i = 0; i < ids.length; i++) {
    if (Number(checks[i] || 0) === 0) stale.push(ids[i]);
  }

  if (stale.length) {
    await pipeline(
      stale.map(id => ["LREM", REPORT_LIST_KEY, 0, id])
    );
  }
}

async function listReports(limit = 500) {
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 500));
  const ids = await command(["LRANGE", REPORT_LIST_KEY, 0, safeLimit - 1]) || [];

  if (!ids.length) return [];

  const raw = await pipeline(
    ids.map(id => ["GET", REPORT_KEY_PREFIX + id])
  );

  const reports = [];
  const stale = [];

  for (let i = 0; i < ids.length; i++) {
    const value = raw[i];

    if (!value) {
      stale.push(ids[i]);
      continue;
    }

    try {
      reports.push(JSON.parse(value));
    } catch (_) {
      stale.push(ids[i]);
    }
  }

  if (stale.length) {
    await pipeline(stale.map(id => ["LREM", REPORT_LIST_KEY, 0, id]));
  }

  return reports;
}

async function deleteReport(id) {
  const cleanId = cleanText(id, 120);
  if (!cleanId) return false;

  const exists = Number(await command(["EXISTS", REPORT_KEY_PREFIX + cleanId]) || 0);

  await pipeline([
    ["DEL", REPORT_KEY_PREFIX + cleanId],
    ["LREM", REPORT_LIST_KEY, 0, cleanId]
  ]);

  return exists > 0;
}

async function getStats() {
  const reports = await listReports(1000);

  // Current-window stats are calculated from retained reports so the admin
  // dashboard reflects active diagnostics, not reports already expired by TTL.
  const stats = {
    total: reports.length,
    saf: 0,
    shizuku: 0,
    legacy: 0,
    permission: 0,
    download: 0,
    zip: 0,
    write: 0,
    replace: 0,
    verify: 0
  };

  for (const r of reports) {
    const backend = String(r.backend || "").toUpperCase();
    const category = String(r.category || "").toUpperCase();
    const stage = String(r.stage || "").toUpperCase();

    if (backend === "SAF") stats.saf++;
    if (backend === "SHIZUKU") stats.shizuku++;
    if (backend === "LEGACY") stats.legacy++;

    if (category === "PERMISSION" || stage.includes("PERMISSION")) stats.permission++;
    if (category === "DOWNLOAD" || stage.includes("DOWNLOAD")) stats.download++;
    if (category === "ZIP" || stage.includes("ZIP")) stats.zip++;
    if (category === "WRITE" || stage.includes("WRITE")) stats.write++;
    if (category === "REPLACE" || stage.includes("REPLACE")) stats.replace++;
    if (category === "VERIFY" || stage.includes("VERIFY")) stats.verify++;
  }

  return stats;
}

module.exports = {
  MAX_REPORTS,
  REPORT_TTL_SECONDS,
  DEDUPE_WINDOW_SECONDS,
  saveReport,
  listReports,
  deleteReport,
  getStats
};
