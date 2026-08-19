export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    // HEALTH CHECK
    if (
      url.pathname === "/api/health" &&
      request.method === "GET"
    ) {
      return Response.json(
        {
          status: "ok",
          paypal: "sandbox-ready",
          database: env.DB ? "connected" : "not-connected",
          products_api: env.DB ? "ready" : "not-ready"
        },
        {
          headers: corsHeaders
        }
      );
    }

    // TEMPORARY FALLBACK
    return Response.json(
      {
        status: "ok",
        message: "BotCraft Worker is running."
      },
      {
        status: 200,
        headers: corsHeaders
      }
    );
  }
};
