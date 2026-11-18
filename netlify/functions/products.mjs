import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";

export const config = { path: "/api/products" };

const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });
const sha = t => createHash("sha256").update(String(t)).digest();
const keyOk = k => {
  const real = process.env.ADMIN_KEY || "";
  return !!real && typeof k === "string" && timingSafeEqual(sha(k), sha(real));
};

const S = (v, n) => String(v ?? "").slice(0, n);
const IMG = /^data:image\/(webp|png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/;
const clean = p => ({
  id: S(p.id, 60) || "p-" + randomBytes(4).toString("hex"),
  nombre: S(p.nombre, 80),
  juegos: Math.min(999, Math.max(0, Math.round(Number(p.juegos) || 0))),
  nota: S(p.nota, 120),
  precio: Math.max(0, Math.round((Number(p.precio) || 0) * 100) / 100),
  imagen: typeof p.imagen === "string" && p.imagen.length <= 600000 && IMG.test(p.imagen) ? p.imagen : "",
  disponible: p.disponible !== false,
  promo: p.promo !== false, // false = este paquete no participa en el Hot Sale
});

// Textos de la tienda, número de WhatsApp y Hot Sale. Se guardan junto al catálogo.
function cleanAjustes(a) {
  if (!a || typeof a !== "object") return null;
  const textos = {};
  const src = a.textos && typeof a.textos === "object" ? a.textos : {};
  for (const [k, v] of Object.entries(src).slice(0, 100)) if (/^[a-zA-Z0-9]{1,30}$/.test(k)) textos[k] = S(v, 400);
  const h = a.hotsale && typeof a.hotsale === "object" ? a.hotsale : {};
  return {
    textos,
    whatsapp: String(a.whatsapp ?? "").replace(/\D/g, "").slice(0, 15),
    hotsale: {
      activo: h.activo === true,
      titulo: S(h.titulo, 40),
      texto: S(h.texto, 160),
      descuento: Math.min(90, Math.max(1, Math.round(Number(h.descuento) || 10))),
      fin: Math.max(0, Math.min(Number(h.fin) || 0, 8.64e15)),
    },
  };
}

export default async (req) => {
  const store = getStore({ name: "zoriwi", consistency: "strong" });
  const url = new URL(req.url);
  const cur = (await store.get("catalog", { type: "json" })) || null;
  const updated = cur?.updated || "0";

  if (req.method === "GET") {
    if (url.searchParams.has("auth")) {
      if (!process.env.ADMIN_KEY) return json({ error: "Falta configurar la variable ADMIN_KEY en Netlify." }, 500);
      return keyOk(req.headers.get("x-admin-key")) ? json({ ok: true }) : json({ error: "No autorizado" }, 401);
    }
    if (url.searchParams.has("ver")) return json({ updated });
    return json({ updated, products: cur ? cur.products : null, ajustes: cur?.ajustes || null });
  }

  if (req.method === "POST") {
    if (!keyOk(req.headers.get("x-admin-key"))) return json({ error: "No autorizado" }, 401);
    const raw = await req.text();
    if (raw.length > 5.5 * 1024 * 1024) return json({ error: "El catálogo es demasiado grande. Usa fotos más ligeras." }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: "JSON inválido" }, 400); }
    if (!Array.isArray(body.products)) return json({ error: "Falta la lista de productos" }, 400);
    if (String(body.base ?? "0") !== updated) return json({ error: "Conflicto", updated }, 409);
    const next = new Date().toISOString();
    // Si el panel no manda ajustes (pestaña vieja), se conservan los que ya estaban guardados.
    const ajustes = cleanAjustes(body.ajustes) || cur?.ajustes || null;
    await store.setJSON("catalog", { updated: next, products: body.products.slice(0, 200).map(clean), ...(ajustes ? { ajustes } : {}) });
    return json({ ok: true, updated: next });
  }

  return json({ error: "Método no permitido" }, 405);
};
