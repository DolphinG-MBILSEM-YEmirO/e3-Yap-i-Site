"use strict";

const WINDOW_MS = 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const HOURLY_LIMIT = 5;
const MAX_BODY_BYTES = 16 * 1024;
const SEND_URL = "https://api.resend.com/emails";

// Best-effort rate limiting for warm function instances. The form also has a
// client-side cooldown; use a shared store if stronger limits are needed.
const requestsByIp = new Map();

function reply(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(body);
}

function field(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseBody(req) {
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    return req.body;
  }
  if (typeof req.body === "string") {
    return JSON.parse(req.body);
  }
  return {};
}

function emailIsValid(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getClientIp(req) {
  const realIp = req.headers["x-real-ip"];
  const forwarded = req.headers["x-forwarded-for"];
  const candidate = Array.isArray(realIp)
    ? realIp[0]
    : realIp || (Array.isArray(forwarded) ? forwarded[0] : forwarded || "");
  return String(candidate).split(",")[0].trim() || "unknown";
}

function rateLimited(ip, now) {
  const recent = (requestsByIp.get(ip) || []).filter((time) => now - time < WINDOW_MS);
  if (recent.length > 0 && now - recent[recent.length - 1] < MIN_INTERVAL_MS) {
    requestsByIp.set(ip, recent);
    return true;
  }
  if (recent.length >= HOURLY_LIMIT) {
    requestsByIp.set(ip, recent);
    return true;
  }
  recent.push(now);
  requestsByIp.set(ip, recent);

  if (requestsByIp.size > 5000) {
    for (const [key, times] of requestsByIp) {
      if (times.length === 0 || now - times[times.length - 1] >= WINDOW_MS) {
        requestsByIp.delete(key);
      }
    }
  }
  return false;
}

module.exports = async function contact(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return reply(res, 405, { ok: false, error: "method_not_allowed" });
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return reply(res, 413, { ok: false, error: "too_long" });
  }

  let data;
  try {
    data = parseBody(req);
  } catch {
    return reply(res, 400, { ok: false, error: "invalid" });
  }

  const name = field(data.name);
  const company = field(data.company);
  const email = field(data.email).toLowerCase();
  const phone = field(data.phone);
  const message = field(data.message);
  const website = field(data.website);

  // Honeypot: bots receive a success response, but no email is sent.
  if (website) {
    return reply(res, 200, { ok: true });
  }

  if (name.length < 3 || name.length > 120) {
    return reply(res, 400, { ok: false, error: "name" });
  }
  if (company.length > 160) {
    return reply(res, 400, { ok: false, error: "company" });
  }
  if (!emailIsValid(email)) {
    return reply(res, 400, { ok: false, error: "email" });
  }
  if (phone && !/^[0-9+()\s.\-]{7,32}$/.test(phone)) {
    return reply(res, 400, { ok: false, error: "phone" });
  }
  if (message.length < 20) {
    return reply(res, 400, { ok: false, error: "message" });
  }
  if (message.length > 4000) {
    return reply(res, 400, { ok: false, error: "too_long" });
  }
  if (/[\r\n]/.test(name + email + company + phone)) {
    return reply(res, 400, { ok: false, error: "invalid" });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const sender = process.env.CONTACT_EMAIL_FROM;
  const recipients = (process.env.CONTACT_EMAIL_TO || "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);

  if (!apiKey || !sender || !recipients.length || recipients.some((address) => !emailIsValid(address))) {
    console.error("[contact] Email service is not configured.");
    return reply(res, 500, { ok: false, error: "mail_failed" });
  }
  if (/[\r\n]/.test(sender)) {
    return reply(res, 500, { ok: false, error: "mail_failed" });
  }

  const ip = getClientIp(req);
  if (rateLimited(ip, Date.now())) {
    return reply(res, 429, { ok: false, error: "throttle" });
  }

  const companyLine = company ? "Şirket: " + company + "\n" : "";
  const phoneLine = phone ? "Telefon: " + phone + "\n" : "";
  const text = [
    "Web sitesinden yeni iletişim formu mesajı",
    "",
    "Ad Soyad: " + name,
    companyLine.trimEnd(),
    "E-posta: " + email,
    phoneLine.trimEnd(),
    "",
    "Mesaj:",
    message
  ].filter((line) => line !== "").join("\n");

  let response;
  try {
    response = await fetch(SEND_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: sender,
        to: recipients,
        reply_to: email,
        subject: "E3 Yapı - " + name + (company ? " (" + company + ")" : "") + " form mesajı",
        text
      })
    });
  } catch (error) {
    console.error("[contact] Email provider request failed.");
    return reply(res, 502, { ok: false, error: "mail_failed" });
  }

  if (!response.ok) {
    console.error("[contact] Email provider returned status " + response.status + ".");
    return reply(res, 502, { ok: false, error: "mail_failed" });
  }

  return reply(res, 200, { ok: true });
};
