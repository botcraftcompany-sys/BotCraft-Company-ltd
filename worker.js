export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // PayPal/API routes will go here
    if (url.pathname === "/api/health") {
      return Response.json({
        status: "ok",
        paypal: "ready"
      });
    }

    // Serve your existing website files
    return env.ASSETS.fetch(request);
  }
};
