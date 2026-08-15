const { configured } = require("../../../lib/redis");
const { listReports } = require("../../../lib/diagnostics");
const { isAdmin } = require("../../../lib/admin");

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
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
    const limit = req.query && req.query.limit ? Number(req.query.limit) : 500;
    const reports = await listReports(limit);

    res.statusCode = 200;
    return res.end(JSON.stringify({
      reports,
      count: reports.length
    }));
  } catch (error) {
    res.statusCode = error.statusCode || 500;
    return res.end(JSON.stringify({ error: error.message || "Unable to load diagnostics" }));
  }
};
