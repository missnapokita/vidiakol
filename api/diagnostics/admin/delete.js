const { configured } = require("../../../lib/redis");
const { deleteReport } = require("../../../lib/diagnostics");
const { isAdmin } = require("../../../lib/admin");

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  if (!isAdmin(req)) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  if (!configured()) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: "Diagnostics storage is not configured" }));
  }

  try {
    const body = typeof req.body === "object"
      ? req.body
      : JSON.parse(req.body || "{}");

    const ok = await deleteReport(body.report_id);

    if (!ok) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "Report not found" }));
    }

    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true }));
  } catch (error) {
    res.statusCode = error.statusCode || 500;
    return res.end(JSON.stringify({ error: error.message || "Unable to delete report" }));
  }
};
