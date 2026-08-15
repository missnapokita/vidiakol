const BASE = String(process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || "");

function configured() {
  return Boolean(BASE && TOKEN);
}

async function command(args) {
  if (!configured()) {
    const error = new Error("Upstash Redis is not configured");
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(args)
  });

  const json = await response.json().catch(() => ({}));

  if (!response.ok || json.error) {
    const error = new Error(json.error || `Redis HTTP ${response.status}`);
    error.statusCode = 503;
    throw error;
  }

  return json.result;
}

async function pipeline(commands) {
  if (!configured()) {
    const error = new Error("Upstash Redis is not configured");
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(`${BASE}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands)
  });

  const json = await response.json().catch(() => []);

  if (!response.ok) {
    const error = new Error(`Redis pipeline HTTP ${response.status}`);
    error.statusCode = 503;
    throw error;
  }

  return json.map(x => x && x.result);
}

module.exports = {
  configured,
  command,
  pipeline
};
