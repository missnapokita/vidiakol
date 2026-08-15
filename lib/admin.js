function isAdmin(req) {
  const expected = String(process.env.DIAGNOSTICS_ADMIN_KEY || "");
  const supplied = String(
    (req.headers && (
      req.headers["x-admin-key"] ||
      req.headers["X-Admin-Key"]
    )) || ""
  );

  return Boolean(expected) && supplied === expected;
}

module.exports = { isAdmin };
