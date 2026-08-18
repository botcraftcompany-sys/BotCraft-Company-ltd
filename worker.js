export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    // HEALTH CHECK
    if (url.pathname === "/api/health") {
      return Response.json(
        {
          status: "ok",
          paypal: "sandbox-ready",
          database: env.DB ? "connected" : "not-connected",
          products_api: env.DB ? "ready" : "not-ready"
        },
        { headers: corsHeaders }
      );
    }

    // PRODUCTS API
    if (
      url.pathname === "/api/products" &&
      request.method === "GET"
    ) {
      try {
        if (!env.DB) {
          return Response.json(
            { error: "Database is not connected." },
            {
              status: 500,
              headers: corsHeaders
            }
          );
        }

        const productID =
          url.searchParams.get("id");

        if (productID) {
          const product =
            await env.DB.prepare(`
              SELECT
                id,
                sku,
                name,
                category,
                description,
                price,
                currency,
                image_url,
                supplier,
                supplier_url,
                affiliate_url,
                stock_status,
                brand,
                created_at
              FROM products
              WHERE id = ?
              LIMIT 1
            `)
              .bind(productID)
              .first();

          if (!product) {
            return Response.json(
              { error: "Product not found." },
              {
                status: 404,
                headers: corsHeaders
              }
            );
          }

          return Response.json(
            { product },
            { headers: corsHeaders }
          );
        }

        let page =
          Number(
            url.searchParams.get("page") || 1
          );

        let limit =
          Number(
            url.searchParams.get("limit") || 20
          );

        if (!Number.isFinite(page) || page < 1) {
          page = 1;
        }

        if (!Number.isFinite(limit) || limit < 1) {
          limit = 20;
        }

        if (limit > 100) {
          limit = 100;
        }

        page = Math.floor(page);
        limit = Math.floor(limit);

        const offset =
          (page - 1) * limit;

        const search =
          url.searchParams.get("search");

        const category =
          url.searchParams.get("category");

        const conditions = [];
        const bindings = [];

        if (search) {
          conditions.push(`
            (
              name LIKE ?
              OR sku LIKE ?
              OR description LIKE ?
              OR brand LIKE ?
              OR supplier LIKE ?
            )
          `);

          const term = `%${search}%`;

          bindings.push(
            term,
            term,
            term,
            term,
            term
          );
        }

        if (category) {
          conditions.push(
            "category = ?"
          );

          bindings.push(category);
        }

        let whereClause = "";

        if (conditions.length) {
          whereClause =
            " WHERE " +
            conditions.join(" AND ");
        }

        const productQuery = `
          SELECT
            id,
            sku,
            name,
            category,
            description,
            price,
            currency,
            image_url,
            supplier,
            supplier_url,
            affiliate_url,
            stock_status,
            brand,
            created_at
          FROM products
          ${whereClause}
          ORDER BY id DESC
          LIMIT ? OFFSET ?
        `;

        const result =
          await env.DB
            .prepare(productQuery)
            .bind(
              ...bindings,
              limit,
              offset
            )
            .all();

        const countQuery = `
          SELECT COUNT(*) AS total
          FROM products
          ${whereClause}
        `;

        const countResult =
          await env.DB
            .prepare(countQuery)
            .bind(...bindings)
            .first();

        const total =
          Number(
            countResult?.total || 0
          );

        return Response.json(
          {
            products:
              result.results || [],

            pagination: {
              page,
              limit,
              total,
              total_pages:
                Math.ceil(
                  total / limit
                )
            }
          },
          {
            headers: corsHeaders
          }
        );

      } catch (error) {
        console.error(
          "Products API error:",
          error
        );

        return Response.json(
          {
            error:
              error.message ||
              "Unable to load products."
          },
          {
            status: 500,
            headers: corsHeaders
          }
        );
      }
    }

    // CATEGORIES API
    if (
      url.pathname === "/api/categories" &&
      request.method === "GET"
    ) {
      try {
        if (!env.DB) {
          return Response.json(
            {
              error:
                "Database is not connected."
            },
            {
              status: 500,
              headers: corsHeaders
            }
          );
        }

        const result =
          await env.DB.prepare(`
            SELECT DISTINCT category
            FROM products
            WHERE category IS NOT NULL
              AND category != ''
            ORDER BY category ASC
          `).all();

        return Response.json(
          {
            categories:
              (result.results || [])
                .map(
                  item => item.category
                )
          },
          {
            headers: corsHeaders
          }
        );

      } catch (error) {
        console.error(
          "Categories API error:",
          error
        );

        return Response.json(
          {
            error:
              error.message ||
              "Unable to load categories."
          },
          {
            status: 500,
            headers: corsHeaders
          }
        );
      }
    }
        // =========================================================
    // PAYPAL ACCESS TOKEN
    // =========================================================

    async function getPayPalAccessToken() {
      if (
        !env.PAYPAL_CLIENT_ID ||
        !env.PAYPAL_CLIENT_SECRET
      ) {
        throw new Error(
          "PayPal credentials are missing."
        );
      }

      const credentials = btoa(
        `${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`
      );

      const response = await fetch(
        "https://api-m.sandbox.paypal.com/v1/oauth2/token",
        {
          method: "POST",
          headers: {
            "Authorization":
              `Basic ${credentials}`,
            "Content-Type":
              "application/x-www-form-urlencoded",
            "Accept":
              "application/json"
          },
          body:
            "grant_type=client_credentials"
        }
      );

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error_description ||
          data.error ||
          "PayPal authentication failed."
        );
      }

      if (!data.access_token) {
        throw new Error(
          "PayPal did not return an access token."
        );
      }

      return data.access_token;
    }


    // =========================================================
    // SAVE SUCCESSFUL ORDER TO D1
    // =========================================================

    async function saveOrderToDatabase(
      paypalData,
      orderID
    ) {
      if (!env.DB) {
        console.error(
          "D1 database binding DB is missing."
        );
        return;
      }

      try {
        const purchaseUnit =
          paypalData.purchase_units?.[0];

        const amount =
          purchaseUnit?.amount
            ? Number(
                purchaseUnit.amount.value
              )
            : 0;

        const currency =
          purchaseUnit?.amount?.currency_code ||
          "USD";

        const payer =
          paypalData.payer || {};

        const customerName =
          payer.name
            ? `${payer.name.given_name || ""} ${payer.name.surname || ""}`.trim()
            : null;

        const customerEmail =
          payer.email_address || null;

        const items =
          JSON.stringify(
            purchaseUnit || {}
          );

        await env.DB.prepare(`
          INSERT OR IGNORE INTO orders
          (
            paypal_order_id,
            customer_name,
            customer_email,
            items,
            amount,
            currency,
            status
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
          .bind(
            orderID,
            customerName,
            customerEmail,
            items,
            amount,
            currency,
            paypalData.status ||
              "COMPLETED"
          )
          .run();

        console.log(
          "Order saved to D1:",
          orderID
        );

      } catch (error) {
        console.error(
          "D1 order save error:",
          error
        );
      }
    }


    // =========================================================
    // CREATE PAYPAL ORDER
    // =========================================================

    if (
      url.pathname ===
        "/api/paypal/create-order" &&
      request.method === "POST"
    ) {
      try {
        const body =
          await request.json();

        const amount =
          Number(body.amount);

        if (
          !Number.isFinite(amount) ||
          amount <= 0
        ) {
          return Response.json(
            {
              error:
                "Invalid payment amount."
            },
            {
              status: 400,
              headers: corsHeaders
            }
          );
        }

        const accessToken =
          await getPayPalAccessToken();

        const paypalResponse =
          await fetch(
            "https://api-m.sandbox.paypal.com/v2/checkout/orders",
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json",

                "Authorization":
                  `Bearer ${accessToken}`,

                "Accept":
                  "application/json"
              },

              body:
                JSON.stringify({
                  intent: "CAPTURE",

                  purchase_units: [
                    {
                      amount: {
                        currency_code:
                          "USD",

                        value:
                          amount.toFixed(2)
                      }
                    }
                  ],

                  application_context: {
                    brand_name:
                      "BotCraft",

                    landing_page:
                      "LOGIN",

                    user_action:
                      "PAY_NOW",

                    return_url:
                      `${url.origin}/api/paypal/payment-success`,

                    cancel_url:
                      `${url.origin}/api/paypal/payment-cancel`
                  }
                })
            }
          );

        const data =
          await paypalResponse.json();

        return Response.json(
          data,
          {
            status:
              paypalResponse.status,

            headers:
              corsHeaders
          }
        );

      } catch (error) {
        console.error(
          "Create order error:",
          error
        );

        return Response.json(
          {
            error:
              error.message ||
              "Unable to create PayPal order."
          },
          {
            status: 500,
            headers: corsHeaders
          }
        );
      }
    }


    // =========================================================
    // CAPTURE PAYPAL ORDER
    // =========================================================

    if (
      url.pathname.startsWith(
        "/api/paypal/capture-order/"
      ) &&
      request.method === "POST"
    ) {
      try {
        const orderID =
          url.pathname
            .split("/")
            .pop();

        if (!orderID) {
          return Response.json(
            {
              error:
                "Missing PayPal order ID."
            },
            {
              status: 400,
              headers: corsHeaders
            }
          );
        }

        const accessToken =
          await getPayPalAccessToken();

        const paypalResponse =
          await fetch(
            `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderID}/capture`,
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json",

                "Authorization":
                  `Bearer ${accessToken}`,

                "Accept":
                  "application/json",

                "Prefer":
                  "return=representation"
              }
            }
          );

        const data =
          await paypalResponse.json();

        if (
          paypalResponse.ok &&
          data.status ===
            "COMPLETED"
        ) {
          await saveOrderToDatabase(
            data,
            orderID
          );
        }

        return Response.json(
          data,
          {
            status:
              paypalResponse.status,

            headers:
              corsHeaders
          }
        );

      } catch (error) {
        console.error(
          "Capture error:",
          error
        );

        return Response.json(
          {
            error:
              error.message ||
              "Unable to capture PayPal payment."
          },
          {
            status: 500,
            headers: corsHeaders
          }
        );
      }
    }
        // =========================================================
    // PAYPAL PAYMENT SUCCESS RETURN
    // =========================================================

    if (
      url.pathname ===
      "/api/paypal/payment-success"
    ) {
      const orderID =
        url.searchParams.get("token");

      if (!orderID) {
        return new Response(
          "PayPal returned without an order ID.",
          {
            status: 400,
            headers: {
              ...corsHeaders,
              "Content-Type":
                "text/plain;charset=UTF-8"
            }
          }
        );
      }

      try {
        const accessToken =
          await getPayPalAccessToken();

        const paypalResponse =
          await fetch(
            `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderID}/capture`,
            {
              method: "POST",
              headers: {
                "Content-Type":
                  "application/json",
                "Authorization":
                  `Bearer ${accessToken}`,
                "Accept":
                  "application/json",
                "Prefer":
                  "return=representation"
              }
            }
          );

        const data =
          await paypalResponse.json();

        if (!paypalResponse.ok) {
          return Response.json(
            {
              error:
                "PayPal payment could not be captured.",
              paypal: data
            },
            {
              status:
                paypalResponse.status,
              headers:
                corsHeaders
            }
          );
        }

        if (
          data.status ===
          "COMPLETED"
        ) {
          await saveOrderToDatabase(
            data,
            orderID
          );
        }

        return new Response(
          `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BotCraft Payment Successful</title>

<style>
body{
  font-family:Arial,sans-serif;
  background:#07111f;
  color:white;
  text-align:center;
  padding:60px 20px;
}

.box{
  max-width:600px;
  margin:auto;
  background:#0d1b2e;
  padding:40px;
  border-radius:18px;
  border:1px solid #20324a;
}

h1{
  color:#42e8a4;
}

.order{
  color:#9db0c7;
  word-break:break-all;
}

a{
  display:inline-block;
  margin-top:25px;
  padding:13px 20px;
  background:#42e8a4;
  color:#03100a;
  text-decoration:none;
  border-radius:8px;
  font-weight:bold;
}
</style>

</head>

<body>

<div class="box">

<h1>Payment Successful! 🎉</h1>

<p>
Thank you for your BotCraft order.
</p>

<p class="order">
PayPal Order ID:<br>
${orderID}
</p>

<a href="/">
Return to BotCraft
</a>

</div>

</body>
</html>`,
          {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type":
                "text/html;charset=UTF-8"
            }
          }
        );

      } catch (error) {
        console.error(
          "Payment success error:",
          error
        );

        return new Response(
          "Payment capture error: " +
          error.message,
          {
            status: 500,
            headers: {
              ...corsHeaders,
              "Content-Type":
                "text/plain;charset=UTF-8"
            }
          }
        );
      }
    }


    // =========================================================
    // PAYPAL PAYMENT CANCEL
    // =========================================================

    if (
      url.pathname ===
      "/api/paypal/payment-cancel"
    ) {
      return new Response(
        `<!DOCTYPE html>
<html>

<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payment Cancelled</title>

<style>
body{
  font-family:Arial,sans-serif;
  background:#07111f;
  color:white;
  text-align:center;
  padding:60px 20px;
}

h1{
  color:#42e8a4;
}

a{
  display:inline-block;
  margin-top:25px;
  padding:13px 20px;
  background:#42e8a4;
  color:#03100a;
  text-decoration:none;
  border-radius:8px;
  font-weight:bold;
}
</style>

</head>

<body>

<h1>Payment Cancelled</h1>

<p>
Your PayPal payment was cancelled.
</p>

<a href="/">
Return to BotCraft
</a>

</body>
</html>`,
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type":
              "text/html;charset=UTF-8"
          }
        }
      );
    }


    // =========================================================
    // ASSETS
    // =========================================================

    if (
      env.ASSETS &&
      typeof env.ASSETS.fetch ===
        "function"
    ) {
      return env.ASSETS.fetch(
        request
      );
    }


    // =========================================================
    // FALLBACK
    // =========================================================

    return Response.json(
      {
        status: "ok",
        message:
          "BotCraft PayPal Worker is running."
      },
      {
        status: 200,
        headers:
          corsHeaders
      }
    );
  }
};
