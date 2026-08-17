export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Allow browser requests from your website
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    // Handle browser preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders
      });
    }

    // Health check
    if (url.pathname === "/api/health") {
      return Response.json(
        {
          status: "ok",
          paypal: "ready"
        },
        {
          headers: corsHeaders
        }
      );
    }
    

    // Get PayPal OAuth access token
    async function getPayPalAccessToken() {
      const credentials = btoa(
        `${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`
      );

      const response = await fetch(
        "https://api-m.sandbox.paypal.com/v1/oauth2/token",
        {
          method: "POST",
          headers: {
            "Authorization": `Basic ${credentials}`,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: "grant_type=client_credentials"
        }
      );

      if (!response.ok) {
        throw new Error("PayPal authentication failed");
      }

      const data = await response.json();
      return data.access_token;
    }

    // Create PayPal order
    if (url.pathname === "/api/paypal/create-order" && request.method === "POST") {
      try {
        const body = await request.json();
        const amount = Number(body.amount);

        if (!Number.isFinite(amount) || amount <= 0) {
          return Response.json(
            { error: "Invalid amount" },
            { status: 400, headers: corsHeaders }
          );
        }

        const accessToken = await getPayPalAccessToken();

        const paypalResponse = await fetch(
          "https://api-m.sandbox.paypal.com/v2/checkout/orders",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${accessToken}`
            },
            body: JSON.stringify({
              intent: "CAPTURE",
              purchase_units: [
                {
                  amount: {
                    currency_code: "USD",
                    value: amount.toFixed(2)
                  }
                }
              ]
            })
          }
        );

        const data = await paypalResponse.json();

        return Response.json(data, {
          status: paypalResponse.status,
          headers: corsHeaders
        });
      } catch (error) {
        return Response.json(
          { error: error.message },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // Capture PayPal order
    if (url.pathname.startsWith("/api/paypal/capture-order/") && request.method === "POST") {
      try {
        const orderID = url.pathname.split("/").pop();

        if (!orderID) {
          return Response.json(
            { error: "Missing order ID" },
            { status: 400, headers: corsHeaders }
          );
        }

        const accessToken = await getPayPalAccessToken();

        const paypalResponse = await fetch(
          `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderID}/capture`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${accessToken}`
            }
          }
        );

        const data = await paypalResponse.json();

        return Response.json(data, {
          status: paypalResponse.status,
          headers: corsHeaders
        });
      } catch (error) {
        return Response.json(
          { error: error.message },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // Serve the existing website
    return env.ASSETS.fetch(request);
  }
};
