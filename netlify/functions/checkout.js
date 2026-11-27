/**
 * /api/checkout — Pago con tarjeta para Zoriwi Shop (Mercado Pago Checkout Pro)
 *
 * POST /api/checkout            body: { items: [{ id: "p4", q: 1 }, ...] }
 *   → { url, ref, total }       url = página de pago segura de Mercado Pago
 * GET  /api/checkout?payment_id=123
 *   → { status, total, ref }    consulta el estado real del pago
 *
 * Variables de entorno:
 *   MP_ACCESS_TOKEN  (obligatoria)  Access Token de producción de Mercado Pago
 *   SITE_URL         (opcional)     ej. https://zoriwi.shop  — si no, usa el dominio de la petición
 *   PRODUCTS_URL     (opcional)     URL del catálogo; por defecto SITE_URL + /api/products
 *
 * Los precios SIEMPRE se calculan aquí con el catálogo real (incluido el Hot Sale),
 * nunca con lo que mande el navegador.
 * Formato compatible con Vercel / Netlify (función Node) y con Express:
 *   app.all("/api/checkout", express.json(), require("./api/checkout"))
 */
const MP = "https://api.mercadopago.com";
const r2 = n => Math.round(n * 100) / 100;

function send(res, code, data) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) throw new Error("too big"); }
  return JSON.parse(raw || "{}");
}

// misma regla de precio que la página (index.html → price())
function unitPrice(p, hot) {
  const precio = +p.precio || 0;
  const on = hot && hot.activo && +hot.fin > Date.now();
  if (on && p.promo !== false && precio > 0) return r2(precio * (1 - (+hot.descuento || 0) / 100));
  return precio;
}

module.exports = async function handler(req, res) {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) return send(res, 503, { error: "El pago con tarjeta aún no está activado" });

  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const site = (process.env.SITE_URL || `${proto}://${host}`).replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${token}` };

  try {
    /* ---- consultar estado de un pago ---- */
    if (req.method === "GET") {
      const url = new URL(req.url, site);
      const id = String(url.searchParams.get("payment_id") || "").replace(/\D/g, "");
      if (!id) return send(res, 400, { error: "Falta payment_id" });
      const r = await fetch(`${MP}/v1/payments/${id}`, { headers: auth });
      if (!r.ok) return send(res, 404, { error: "Pago no encontrado" });
      const p = await r.json();
      return send(res, 200, { status: p.status, total: p.transaction_amount, ref: p.external_reference || "" });
    }

    if (req.method !== "POST") return send(res, 405, { error: "Método no permitido" });

    /* ---- crear cobro ---- */
    const body = await readBody(req);
    const wanted = Array.isArray(body.items) ? body.items.slice(0, 20) : [];
    if (!wanted.length) return send(res, 400, { error: "Tu carrito está vacío" });

    const cr = await fetch(process.env.PRODUCTS_URL || `${site}/api/products`, { cache: "no-store" });
    if (!cr.ok) throw new Error("catálogo no disponible");
    const cat = await cr.json();
    const products = Array.isArray(cat.products) ? cat.products : [];
    const hot = (cat.ajustes && cat.ajustes.hotsale) || null;

    const items = [];
    for (const w of wanted) {
      const p = products.find(x => String(x.id) === String(w && w.id));
      const q = Math.floor(+(w && w.q));
      if (!p || p.disponible === false) return send(res, 409, { error: "Un paquete de tu carrito ya no está disponible" });
      if (!(q >= 1 && q <= 50)) return send(res, 400, { error: "Cantidad no válida" });
      const unit = unitPrice(p, hot);
      if (!(unit > 0)) return send(res, 409, { error: "Un paquete de tu carrito no tiene precio para pago con tarjeta" });
      items.push({
        id: String(p.id),
        title: String(p.nombre || "Paquete de juegos").slice(0, 250),
        description: `${+p.juegos || 0} juego(s) de Steam`,
        category_id: "games",
        quantity: q,
        unit_price: unit,
        currency_id: "MXN",
      });
    }
    const total = r2(items.reduce((s, i) => s + i.unit_price * i.quantity, 0));
    const ref = "ZW-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();

    const pr = await fetch(`${MP}/checkout/preferences`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "X-Idempotency-Key": ref },
      body: JSON.stringify({
        items,
        external_reference: ref,
        statement_descriptor: "ZORIWI SHOP",
        back_urls: {
          success: `${site}/?pago=ok`,
          pending: `${site}/?pago=pendiente`,
          failure: `${site}/?pago=error`,
        },
        auto_return: "approved",
        // solo tarjetas de crédito y débito (quita esta línea para aceptar también OXXO / SPEI)
        payment_methods: { excluded_payment_types: [{ id: "ticket" }, { id: "atm" }, { id: "bank_transfer" }], installments: 12 },
        expires: true,
        expiration_date_to: new Date(Date.now() + 2 * 3600e3).toISOString(),
      }),
    });
    const pref = await pr.json();
    if (!pr.ok || !pref.init_point) {
      console.error("Mercado Pago:", pr.status, JSON.stringify(pref));
      throw new Error("preferencia rechazada");
    }
    return send(res, 200, { url: pref.init_point, ref, total });
  } catch (e) {
    console.error("checkout:", e && e.message);
    return send(res, 500, { error: "No pudimos abrir el pago con tarjeta" });
  }
};
