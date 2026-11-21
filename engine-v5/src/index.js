const SERVICE = "Crypto Pump Hunter Engine V5";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: SERVICE,
        stage: env.ENGINE_STAGE || "foundation-only",
        mode: env.ENGINE_MODE || "paper",
        storage: {
          d1Configured: Boolean(env.ENGINE_DB),
          r2Configured: Boolean(env.ENGINE_ARCHIVE),
          kvDependency: false
        },
        marketScanning: false,
        liveTrading: false
      });
    }

    return json({ ok: false, error: "Not Found" }, 404);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
