export default {

  async fetch(request, env) {

    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };


    // CORS
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
          database:
            env.DB
              ? "connected"
              : "not-connected",
          products_api:
            env.DB
              ? "ready"
              : "not-ready"
        },
        {
          headers: corsHeaders
        }
      );

    }


    // =========================================================
    // PRODUCTS API
    // =========================================================

    if (
      url.pathname === "/api/products" &&
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


        const productID =
          url.searchParams.get("id");


        if (productID) {

          const product =
            await env.DB
              .prepare(`
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
              {
                error:
                  "Product not found."
              },
              {
                status: 404,
                headers: corsHeaders
              }
            );

          }


          return Response.json(
            {
              product
            },
            {
              headers: corsHeaders
            }
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


        if (
          !Number.isFinite(page) ||
          page < 1
        ) {

          page = 1;

        }


        if (
          !Number.isFinite(limit) ||
          limit < 1
        ) {

          limit = 20;

        }


        if (limit > 100) {

          limit = 100;

        }


        page =
          Math.floor(page);

        limit =
          Math.floor(limit);


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


          const term =
            `%${search}%`;


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


        if (conditions.length > 0) {

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
      // =========================================================
    // PAYPAL ACCESS TOKEN
    // =========================================================

    async function getPayPalAccessToken() {

      if (
        !env.PAYPAL_CLIENT_ID ||
        !env.PAYPAL_CLIENT_SECRET
      ) {

        throw new Error(
          "PayPal credentials are not configured."
        );

      }

      const credentials =
        btoa(
          env.PAYPAL_CLIENT_ID +
          ":" +
          env.PAYPAL_CLIENT_SECRET
        );

      const response =
        await fetch(
          "https://api-m.sandbox.paypal.com/v1/oauth2/token",
          {
            method: "POST",

            headers: {
              "Authorization":
                "Basic " + credentials,

              "Content-Type":
                "application/x-www-form-urlencoded"
            },

            body:
              "grant_type=client_credentials"
          }
        );

      const data =
        await response.json();

      if (!response.ok) {

        console.error(
          "PayPal OAuth error:",
          data
        );

        throw new Error(
          data.error_description ||
          "Unable to authenticate with PayPal."
        );

      }

      return data.access_token;
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

        const customerName =
          String(
            body.customerName || ""
          ).trim();

        const customerEmail =
          String(
            body.customerEmail || ""
          ).trim();

        const customerPhone =
          String(
            body.customerPhone || ""
          ).trim();

        const customerAddress =
          String(
            body.customerAddress || ""
          ).trim();

        const amount =
          Number(body.amount);

        const items =
          Array.isArray(body.items)
            ? body.items
            : [];


        if (
          !customerName ||
          !customerEmail ||
          !customerAddress
        ) {

          return Response.json(
            {
              error:
                "Customer name, email and address are required."
            },
            {
              status: 400,
              headers: corsHeaders
            }
          );

        }


        if (
          !Number.isFinite(amount) ||
          amount <= 0
        ) {

          return Response.json(
            {
              error:
                "Invalid order amount."
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

                "Authorization":
                  "Bearer " + accessToken,

                "Content-Type":
                  "application/json",

                "Prefer":
                  "return=representation"

              },

              body:
                JSON.stringify({

                  intent:
                    "CAPTURE",

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

                    user_action:
                      "PAY_NOW",

                    return_url:
                      url.origin +
                      "/api/paypal/payment-success",

                    cancel_url:
                      url.origin +
                      "/api/paypal/payment-cancel"

                  }

                })

            }
          );


        const paypalData =
          await paypalResponse.json();


        console.log(
          "PayPal create order response:",
          paypalData
        );


        if (!paypalResponse.ok) {

          return Response.json(
            {
              error:
                paypalData?.message ||
                paypalData?.name ||
                "PayPal order creation failed.",

              paypal:
                paypalData
            },
            {
              status: 502,
              headers: corsHeaders
            }
          );

        }


        let approvalUrl =
          null;


        if (
          Array.isArray(
            paypalData.links
          )
        ) {

          const approvalLink =
            paypalData.links.find(
              function(link) {

                return (
                  link &&
                  (
                    link.rel ===
                      "approve" ||
                    link.rel ===
                      "payer-action"
                  ) &&
                  link.href
                );

              }
            );


          if (approvalLink) {

            approvalUrl =
              approvalLink.href;

          }

        }


        if (!approvalUrl) {

          console.error(
            "PayPal approval URL missing:",
            paypalData
          );

          return Response.json(
            {
              error:
                "PayPal approval link was not returned.",

              paypal_order_id:
                paypalData.id || null,

              paypal:
                paypalData

            },
            {
              status: 502,
              headers: corsHeaders
            }
          );

        }


        // SAVE ORDER TO D1

        if (env.DB) {

          try {

            await env.DB
              .prepare(`
                INSERT INTO orders (
                  paypal_order_id,
                  customer_name,
                  customer_email,
                  customer_phone,
                  customer_address,
                  amount,
                  currency,
                  status,
                  items
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              `)
              .bind(

                paypalData.id,

                customerName,

                customerEmail,

                customerPhone,

                customerAddress,

                amount,

                "USD",

                "CREATED",

                JSON.stringify(items)

              )
              .run();


          } catch (dbError) {

            console.error(
              "Order database error:",
              dbError
            );

          }

        }


        // RETURN APPROVAL LINK

        return Response.json(
          {

            id:
              paypalData.id,

            status:
              paypalData.status,

            approvalUrl:
              approvalUrl,

            links:
              paypalData.links || []

          },
          {
            headers: corsHeaders
          }
        );


      } catch (error) {

        console.error(
          "Create PayPal order error:",
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
          url.pathname.split("/").pop();


        if (!orderID) {

          return Response.json(
            {
              error:
                "PayPal order ID is required."
            },
            {
              status: 400,
              headers: corsHeaders
            }
          );

        }


        const accessToken =
          await getPayPalAccessToken();


        const captureResponse =
          await fetch(
            "https://api-m.sandbox.paypal.com/v2/checkout/orders/" +
            encodeURIComponent(orderID) +
            "/capture",
            {

              method: "POST",

              headers: {

                "Authorization":
                  "Bearer " + accessToken,

                "Content-Type":
                  "application/json",

                "Prefer":
                  "return=representation"

              }

            }
          );


        const captureData =
          await captureResponse.json();


        console.log(
          "PayPal capture response:",
          captureData
        );


        if (!captureResponse.ok) {

          return Response.json(
            {
              error:
                captureData?.message ||
                "PayPal capture failed.",

              paypal:
                captureData

            },
            {
              status: 502,
              headers: corsHeaders
            }
          );

        }


        const payerName =
          [
            captureData?.payer?.name?.given_name,
            captureData?.payer?.name?.surname
          ]
            .filter(Boolean)
            .join(" ") || null;


        const payerEmail =
          captureData?.payer?.email_address ||
          null;


        if (env.DB) {

          await env.DB
            .prepare(`
              UPDATE orders
              SET
                status = ?,
                payer_name = ?,
                payer_email = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE paypal_order_id = ?
            `)
            .bind(

              captureData.status ||
                "COMPLETED",

              payerName,

              payerEmail,

              orderID

            )
            .run();

        }


        return Response.json(
          {

            success:
              true,

            orderID:
              orderID,

            status:
              captureData.status,

            payerName:
              payerName,

            payerEmail:
              payerEmail,

            paypal:
              captureData

          },
          {
            headers: corsHeaders
          }
        );


      } catch (error) {

        console.error(
          "Capture PayPal order error:",
          error
        );

        return Response.json(
          {
            error:
              error.message ||
              "Unable to capture PayPal order."
          },
          {
            status: 500,
            headers: corsHeaders
          }
        );

      }

          }  
        // =========================================================
    // PAYPAL PAYMENT SUCCESS
    // =========================================================

    if (
      url.pathname ===
        "/api/paypal/payment-success" &&
      request.method === "GET"
    ) {

      const orderID =
        url.searchParams.get("token");


      if (!orderID) {

        return new Response(
          "Missing PayPal order ID.",
          {
            status: 400,

            headers: {
              ...corsHeaders,
              "Content-Type":
                "text/plain"
            }
          }
        );

      }


      try {

        const accessToken =
          await getPayPalAccessToken();


        const captureResponse =
          await fetch(
            "https://api-m.sandbox.paypal.com/v2/checkout/orders/" +
            encodeURIComponent(orderID) +
            "/capture",
            {

              method: "POST",

              headers: {

                "Authorization":
                  "Bearer " + accessToken,

                "Content-Type":
                  "application/json"

              }

            }
          );


        const captureData =
          await captureResponse.json();


        console.log(
          "PayPal payment success capture:",
          captureData
        );


        if (
          env.DB &&
          captureResponse.ok
        ) {

          const payerName =
            [
              captureData?.payer?.name?.given_name,
              captureData?.payer?.name?.surname
            ]
              .filter(Boolean)
              .join(" ") || null;


          const payerEmail =
            captureData?.payer?.email_address ||
            null;


          await env.DB
            .prepare(`
              UPDATE orders
              SET
                status = ?,
                payer_name = ?,
                payer_email = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE paypal_order_id = ?
            `)
            .bind(

              captureData.status ||
                "COMPLETED",

              payerName,

              payerEmail,

              orderID

            )
            .run();

        }


        return new Response(

          `<!DOCTYPE html>

          <html>

          <head>

          <meta charset="UTF-8">

          <meta
            name="viewport"
            content="width=device-width,initial-scale=1.0"
          >

          <title>BotCraft Payment</title>

          <style>

          body{
            margin:0;
            padding:40px 20px;
            background:#07111f;
            color:white;
            font-family:Arial,sans-serif;
            text-align:center;
          }

          .box{
            max-width:600px;
            margin:auto;
            padding:30px;
            background:#0d1b2e;
            border-radius:15px;
          }

          h1{
            color:#42e8a4;
          }

          a{
            color:#42e8a4;
            font-weight:bold;
          }

          </style>

          </head>

          <body>

          <div class="box">

          <h1>
          ${
            captureResponse.ok
              ? "Payment Successful! 🎉"
              : "Payment Processing Error"
          }
          </h1>

          <p>
          ${
            captureResponse.ok
              ? "Thank you for your BotCraft order."
              : "We could not complete your PayPal payment."
          }
          </p>

          <p>
          PayPal Order ID:
          </p>

          <strong>
          ${escapeHtml(orderID)}
          </strong>

          <br><br>

          <a href="/">
          Return to BotCraft
          </a>

          </div>

          </body>

          </html>`,

          {
            status:
              captureResponse.ok
                ? 200
                : 502,

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
          "Payment processing error: " +
          error.message,
          {
            status: 500,

            headers: {
              ...corsHeaders,
              "Content-Type":
                "text/plain"
            }
          }
        );

      }

    }


    // =========================================================
    // PAYPAL CANCEL
    // =========================================================

    if (
      url.pathname ===
        "/api/paypal/payment-cancel" &&
      request.method === "GET"
    ) {

      return new Response(

        `<!DOCTYPE html>

        <html>

        <head>

        <meta charset="UTF-8">

        <meta
          name="viewport"
          content="width=device-width,initial-scale=1.0"
        >

        <title>BotCraft Payment Cancelled</title>

        <style>

        body{
          margin:0;
          padding:40px 20px;
          background:#07111f;
          color:white;
          font-family:Arial,sans-serif;
          text-align:center;
        }

        .box{
          max-width:600px;
          margin:auto;
          padding:30px;
          background:#0d1b2e;
          border-radius:15px;
        }

        h1{
          color:#42e8a4;
        }

        a{
          color:#42e8a4;
          font-weight:bold;
        }

        </style>

        </head>

        <body>

        <div class="box">

        <h1>
        Payment Cancelled
        </h1>

        <p>
        Your BotCraft payment was cancelled.
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

    }


    // =========================================================
    // DEFAULT RESPONSE
    // =========================================================

    return Response.json(
      {
        status: "ok",
        message:
          "BotCraft Worker is running."
      },
      {
        status: 200,
        headers: corsHeaders
      }
    );

  }

};


/* =========================================================
   HTML ESCAPE HELPER
========================================================= */

function escapeHtml(value){

  return String(value)

    .replace(/&/g,"&amp;")

    .replace(/</g,"&lt;")

    .replace(/>/g,"&gt;")

    .replace(/"/g,"&quot;")

    .replace(/'/g,"&#039;");

                }

        
