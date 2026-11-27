// Pago con tarjeta — Mercado Pago Checkout Pro (Netlify Function)
//
// POST /api/checkout   body { items:[{id,q}] }  -> { url, ref, total }
// GET  /api/checkout?payment_id=123              -> { status, total, ref }
//
// Variable de entorno en Netlify: MP_ACCESS_TOKEN = Access Token de PRODUCCIÓN (APP_USR-...)
// Los precios se calculan aquí con el catálogo guardado (Netlify Blobs, mismo que products.mjs),
// incluido el Hot Sale. Nunca se usa el precio que mande el navegador.
import { getStore } from "@netlify/blobs";

export const config = { path: "/api/checkout" };

const MP = "https://api.mercadopago.com";
const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });
const r2 = n => Math.round(n * 100) / 100;

// misma regla de precio que la tienda (index.html -> price())
function unitPrice(p, hot) {
  const precio = +p.precio || 0;
  const on = hot && hot.activo && +hot.fin > Date.now();
  if (on && p.promo !== false && precio > 0) return r2(precio * (1 - (+hot.descuento || 0) / 100));
  return precio;
}

export default async (req) => {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) return json({ error: "El pago con tarjeta aún no está activado" }, 503);
  const auth = { Authorization: `Bearer ${token}` };
  const url = new URL(req.url);
  const site = (process.env.URL || url.origin).replace(/\/+$/, ""); // Netlify define URL = dominio principal

  try {
    /* ---- consultar estado real de un pago ---- */
    if (req.method === "GET") {
      const id = String(url.searchParams.get("payment_id") || "").replace(/\D/g, "");
      if (!id) return json({ error: "Falta payment_id" }, 400);
      const r = await fetch(`${MP}/v1/payments/${id}`, { headers: auth });
      if (!r.ok) return json({ error: "Pago no encontrado" }, 404);
      const p = await r.json();
      return json({ status: p.status, total: p.transaction_amount, ref: p.external_reference || "" });
    }

    if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

    /* ---- crear cobro ---- */
    const raw = await req.text();
    if (raw.length > 20000) return json({ error: "Pedido demasiado grande" }, 413);
    let body;
    try { body = JSON.parse(raw || "{}"); } catch { return json({ error: "Pedido inválido" }, 400); }
    const wanted = Array.isArray(body.items) ? body.items.slice(0, 20) : [];
    if (!wanted.length) return json({ error: "Tu carrito está vacío" }, 400);

    const store = getStore({ name: "zoriwi", consistency: "strong" });
    const cat = (await store.get("catalog", { type: "json" })) || {};
    const products = Array.isArray(cat.products) ? cat.products : [];
    const hot = cat.ajustes?.hotsale || null;

    const items = [];
    for (const w of wanted) {
      const p = products.find(x => String(x.id) === String(w?.id));
      const q = Math.floor(Number(w?.q));
      if (!p || p.disponible === false) return json({ error: "Un paquete de tu carrito ya no está disponible" }, 409);
      if (!(q >= 1 && q <= 50)) return json({ error: "Cantidad no válida" }, 400);
      const unit = unitPrice(p, hot);
      if (!(unit > 0)) return json({ error: "Un paquete de tu carrito no tiene precio para pago con tarjeta" }, 409);
      items.push({
        id: String(p.id),
        title: String(p.nombre || "Paquete de juegos").slice(0, 250),
        description: `${+p.juegos || 0} juego(s)`,
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
        // solo tarjetas de crédito y débito (borra esta línea para aceptar también OXXO / SPEI)
        payment_methods: { excluded_payment_types: [{ id: "ticket" }, { id: "atm" }, { id: "bank_transfer" }], installments: 12 },
        expires: true,
        expiration_date_to: new Date(Date.now() + 2 * 3600e3).toISOString(),
      }),
    });
    const pref = await pr.json();
    if (!pr.ok || !pref.init_point) {
      console.error("Mercado Pago:", pr.status, JSON.stringify(pref));
      return json({ error: "No pudimos abrir el pago con tarjeta" }, 502);
    }
    return json({ url: pref.init_point, ref, total });
  } catch (e) {
    console.error("checkout:", e?.message);
    return json({ error: "No pudimos abrir el pago con tarjeta" }, 500);
  }
};
