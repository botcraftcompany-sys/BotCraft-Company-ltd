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
              error: "Database is not connected."
            },
            {
              status: 500,
              headers: corsHeaders
            }
          );
        }

        const productID =
          url.searchParams.get("id");

        // Get one product
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
              {
                error: "Product not found."
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

        // Pagination
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

        // Search/filter
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

        if (conditions.length > 0) {
          whereClause =
            " WHERE " +
            conditions.join(" AND ");
        }

        // Products query
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

        // Count products
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
                Math.ceil(total / limit)
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
