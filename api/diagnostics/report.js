const { configured } = require("../../lib/redis");
const { saveReport } = require("../../lib/diagnostics");

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  if (!configured()) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: "Diagnostics storage is not configured" }));
  }

  try {
    const body = typeof req.body === "object"
      ? req.body
      : JSON.parse(req.body || "{}");

    // Reject obviously empty reports.
    if (!body || (!body.reason && !body.error && !body.exception && !body.code)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Missing diagnostic data" }));
    }

    const result = await saveReport(body);

    res.statusCode = 201;
    return res.end(JSON.stringify({
      ok: true,
      stored: result.stored,
      duplicate: result.duplicate,
      report_id: result.report_id
    }));

  } catch (error) {
    res.statusCode = error.statusCode || 500;
    return res.end(JSON.stringify({
      error: error.message || "Unable to save diagnostic report"
    }));
  }
};
