require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const MEDIA_DIR = path.resolve(process.env.MEDIA_STORAGE_DIR || path.join(__dirname, "storage", "media"));
const MAX_LEAD_FILES = 5;
const MAX_LEAD_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LEAD_TOTAL_BYTES = 6 * 1024 * 1024;
if (MEDIA_DIR === PUBLIC_DIR || MEDIA_DIR.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
  throw new Error("MEDIA_STORAGE_DIR must be outside the public web directory");
}

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is missing in .env");
  process.exit(1);
}

if (!process.env.JWT_SECRET) {
  console.error("❌ JWT_SECRET is missing in .env");
  process.exit(1);
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT must be a valid TCP port number");
}

function logOperationalError(label, error) {
  if (process.env.NODE_ENV === "development") {
    console.error(label, error);
    return;
  }
  console.error(label, error?.code || "operation failed");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});
pool.on("error", (error) => logOperationalError("IDLE DATABASE CLIENT ERROR:", error));

app.disable("x-powered-by");
app.set("trust proxy", process.env.NODE_ENV === "production" ? 1 : false);
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  if (process.env.NODE_ENV === "production" && req.secure) {
    res.set("Strict-Transport-Security", "max-age=31536000");
  }
  next();
});

app.use(express.json({ limit: "12mb", verify: (req, res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(PUBLIC_DIR, {
  index: false,
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (/\.(?:css|js|mjs|png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
    }
  },
}));

function isBigIntId(value) {
  return typeof value === "string" && /^\d+$/.test(value);
}

function validDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

function projectReference(id) {
  return `PWA-PRJ-${String(id).padStart(6, "0")}`;
}

const PROJECT_STATUSES = new Set(["pending", "accepted", "in_progress", "delayed", "rejected", "completed", "on_hold", "cancelled"]);
const PROJECT_STAGES = new Set(["request_received", "requirements_confirmed", "design_in_progress", "development_in_progress", "testing_revisions", "customer_review", "completed"]);
const PROJECT_STATUS_TRANSITIONS = {
  pending: new Set(["accepted", "rejected"]),
  accepted: new Set(["in_progress", "delayed", "rejected"]),
  in_progress: new Set(["delayed", "completed"]),
  delayed: new Set(["in_progress", "completed", "rejected"]),
  rejected: new Set(),
  completed: new Set(),
};

function validateProjectMilestones(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 30) throw requestError("milestones must contain up to 30 items");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw requestError(`milestones[${index}] must be an object`);
    const title = boundedString(item.title, `milestones[${index}].title`, 200, { required: true });
    const status = item.status || "pending";
    if (!["pending", "in_progress", "completed", "cancelled"].includes(status)) throw requestError(`milestones[${index}].status is invalid`);
    const targetDate = item.target_date || null;
    if (targetDate && !validDateOnly(targetDate)) throw requestError(`milestones[${index}].target_date must be YYYY-MM-DD`);
    return { title, status, target_date: targetDate, sort_order: index };
  });
}

function saleFields(body, fallback = {}) {
  const enabled = body.sale_enabled === undefined ? Boolean(fallback.sale_enabled) : body.sale_enabled;
  const type = body.discount_type === undefined ? (fallback.discount_type || "percentage") : body.discount_type;
  const rawValue = body.discount_value === undefined ? (fallback.discount_value ?? 0) : body.discount_value;
  const value = Number(rawValue);
  const badge = boundedString(body.offer_badge_text === undefined ? (fallback.offer_badge_text || "") : body.offer_badge_text, "offer_badge_text", 40) || null;
  const start = body.sale_start_date === undefined ? (fallback.sale_start_date || null) : body.sale_start_date;
  const end = body.sale_end_date === undefined ? (fallback.sale_end_date || null) : body.sale_end_date;
  if (typeof enabled !== "boolean") throw requestError("sale_enabled must be boolean");
  if (!["percentage", "fixed"].includes(type)) throw requestError("discount_type must be percentage or fixed");
  if (!Number.isFinite(value) || value < 0) throw requestError("discount_value must be a non-negative amount");
  if (type === "percentage" && value >= 100) throw requestError("Percentage discount must be below 100%");
  if (start && !validDateOnly(start)) throw requestError("sale_start_date must be a valid YYYY-MM-DD date");
  if (end && !validDateOnly(end)) throw requestError("sale_end_date must be a valid YYYY-MM-DD date");
  if (start && end && end < start) throw requestError("sale_end_date must be on or after sale_start_date");
  return { enabled, type, value: Math.round(value * 100) / 100, badge, start, end };
}

function withSalePricing(service) {
  const original = Number(service.price || 0);
  const discount = Number(service.discount_value || 0);
  const today = new Date().toISOString().slice(0, 10);
  const startDate = dateOnly(service.sale_start_date);
  const endDate = dateOnly(service.sale_end_date);
  const active = Boolean(service.sale_enabled) && original > 0 &&
    (!startDate || startDate <= today) &&
    (!endDate || endDate >= today) &&
    discount > 0 && (service.discount_type === "percentage" || discount < original);
  const saving = active ? Math.round((service.discount_type === "percentage" ? original * discount / 100 : discount) * 100) / 100 : 0;
  const effective = Math.max(0, Math.round((original - saving) * 100) / 100);
  return { ...service, sale_start_date: startDate, sale_end_date: endDate, original_price: original, sale_price: effective, effective_price: effective,
    savings: saving, sale_active: active, discount_type: service.discount_type || "percentage",
    discount_value: Number(service.discount_value || 0), offer_badge_text: service.offer_badge_text || "" };
}

function normalizeBrand(brand) {
  if (!brand) return null;
  const raw = brand.settings && typeof brand.settings === "object" ? brand.settings : {};
  const settings = {};
  for (const key of ["short_name", "primary_color", "secondary_color", "description", "hero_title", "hero_description", "about_title", "about_description", "footer_text", "hero_image_url", "seo_title", "seo_description", "seo_image", "social_links", "section_visibility", "section_order", "theme_default", "brand_logos"]) {
    if (raw[key] !== undefined) settings[key] = raw[key];
  }
  return {
    company_name: brand.company_name, logo_url: brand.logo_url, favicon_url: brand.favicon_url,
    tagline: brand.tagline, domain_name: brand.domain_name, website_url: brand.domain_name,
    email: brand.email, phone: brand.phone, whatsapp_number: brand.whatsapp_number,
    whatsapp: brand.whatsapp_number, currency: brand.currency, settings, ...settings,
    short_name: settings.short_name || null, primary_color: settings.primary_color || null,
    secondary_color: settings.secondary_color || null, description: settings.description || null,
    brand_logos: { primary: brand.logo_url || null, website: settings.brand_logos?.website || null, admin: settings.brand_logos?.admin || null, customer: settings.brand_logos?.customer || null, favicon: brand.favicon_url || null, alt_text: settings.brand_logos?.alt_text || null },
    website_logo_url: settings.brand_logos?.website || brand.logo_url || null,
    admin_logo_url: settings.brand_logos?.admin || brand.logo_url || null,
    customer_logo_url: settings.brand_logos?.customer || brand.logo_url || null,
    logo_alt_text: settings.brand_logos?.alt_text || `${brand.company_name || "Company"} logo`,
  };
}

const DEFAULT_PUBLIC_THEME = {
  mode: "dark", primary: "#0B1020", secondary: "#202A3B", accent: "#D6B477",
  background: "#0B1020", backgroundAlt: "#111827", card: "#172033", text: "#F5F3EE",
  muted: "#B5BDCA", heading: "#F5F3EE", button: "#D6B477", buttonText: "#0B1020",
  border: "#344055", header: "#0B1020", footer: "#080D18", link: "#D6B477",
  linkHover: "#E8D4A6", gradientStart: "#0B1020", gradientEnd: "#202A3B",
  radius: "medium", shadow: "medium", animation: "medium", font: "system"
};
const THEME_HEX_FIELDS = ["primary","secondary","accent","background","backgroundAlt","card","text","muted","heading","button","buttonText","border","header","footer","link","linkHover","gradientStart","gradientEnd"];
function validatePublicTheme(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw requestError("Theme settings must be an object");
  const value = { ...DEFAULT_PUBLIC_THEME };
  for (const key of THEME_HEX_FIELDS) {
    const candidate = input[key];
    if (candidate !== undefined) {
      if (typeof candidate !== "string" || !/^#[\da-fA-F]{6}$/.test(candidate)) throw requestError(`${key} must be a six-digit HEX color`);
      value[key] = candidate.toUpperCase();
    }
  }
  const enums = { mode: ["light","dark","system"], radius: ["small","medium","large"], shadow: ["none","soft","medium","strong"], animation: ["none","subtle","medium"], font: ["system","serif","modern"] };
  for (const [key, allowed] of Object.entries(enums)) {
    const candidate = input[key];
    if (candidate !== undefined) {
      if (!allowed.includes(candidate)) throw requestError(`${key} is not a supported theme option`);
      value[key] = candidate;
    }
  }
  return value;
}

const reviewVoteRate = new Map();
function reviewVoter(req, res) {
  const name = "pwa_review_voter";
  const cookies = String(req.headers.cookie || "").split(";").map((part) => part.trim().split("="));
  const existing = cookies.find(([key]) => key === name)?.[1];
  let voterId = null;
  if (existing) {
    const [encoded, signature, extra] = existing.split(".");
    if (encoded && signature && !extra) {
      const expected = crypto.createHmac("sha256", process.env.JWT_SECRET).update(encoded).digest("base64url");
      const left = Buffer.from(signature); const right = Buffer.from(expected);
      if (left.length === right.length && crypto.timingSafeEqual(left, right)) voterId = Buffer.from(encoded, "base64url").toString("utf8");
    }
  }
  if (!voterId) {
    const encoded = crypto.randomBytes(32).toString("base64url");
    const signature = crypto.createHmac("sha256", process.env.JWT_SECRET).update(encoded).digest("base64url");
    voterId = Buffer.from(encoded, "base64url").toString("utf8");
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.append("Set-Cookie", `${name}=${encoded}.${signature}; Path=/api/public; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
  }
  return crypto.createHmac("sha256", process.env.JWT_SECRET).update(`review-voter:${voterId}`).digest("hex");
}
function allowReviewVote(hash) {
  const now = Date.now();
  const state = reviewVoteRate.get(hash) || { start: now, count: 0 };
  if (now - state.start > 60_000) { state.start = now; state.count = 0; }
  state.count += 1; reviewVoteRate.set(hash, state);
  if (reviewVoteRate.size > 5000) for (const [key, value] of reviewVoteRate) if (now - value.start > 60_000) reviewVoteRate.delete(key);
  return state.count <= 30;
}

function requestError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function boundedString(value, field, maxLength, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw requestError(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw requestError(`${field} must be text`);
  const cleaned = value.trim();
  if (required && !cleaned) throw requestError(`${field} is required`);
  if (cleaned.length > maxLength) throw requestError(`${field} must be at most ${maxLength} characters`);
  return cleaned;
}

function parseFeatures(value) {
  if (value === undefined) return [];
  const features = typeof value === "string" ? value.split(/\r?\n/) : value;
  if (!Array.isArray(features) || features.length > 30 || features.some((item) => typeof item !== "string" || item.length > 200)) {
    throw requestError("features must be an array of up to 30 text values");
  }
  return features.map((item) => item.trim()).filter(Boolean);
}

function imageUrl(value, field = "image_url") {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2048) throw requestError(`${field} must be a valid image URL`);
  if (value.startsWith("/media/")) return value;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("invalid protocol");
    return url.toString();
  } catch {
    throw requestError(`${field} must use /media/ or an HTTP(S) URL`);
  }
}

function detectImageMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

const AD_TYPES = new Set(["image", "video", "animated_text", "text_image", "text_video", "animated_image"]);
const AD_PLACEMENTS = new Set(["top_strip", "below_hero", "above_footer", "promo_section"]);
const AD_ANIMATIONS = new Set(["none", "fade", "slide_up", "slide_left", "typewriter", "reveal", "marquee", "pulse", "zoom"]);
function adInput(body, existing = {}) {
  const pick = (key, fallback = "") => body[key] === undefined ? (existing[key] ?? fallback) : body[key];
  const name = boundedString(pick("name"), "name", 180, { required: true });
  const ad_type = pick("ad_type", "animated_text");
  const placement = pick("placement", "promo_section");
  const animation = pick("animation", "fade");
  const status = pick("status", "draft");
  const enabled = pick("is_enabled", false);
  const order = Number(pick("display_order", 0));
  const speed = Number(pick("animation_speed", 1));
  const hex = /^#[0-9a-f]{6}$/i;
  const color = (value, field, fallback) => { const v = pick(value, fallback); if (!hex.test(v)) throw requestError(`${field} must be a six-digit HEX color`); return v; };
  if (!AD_TYPES.has(ad_type) || !AD_PLACEMENTS.has(placement) || !AD_ANIMATIONS.has(animation)) throw requestError("Choose a supported advertisement type, placement, and animation");
  if (!['draft','published'].includes(status) || typeof enabled !== "boolean" || !["left","center","right"].includes(pick("text_align","center"))) throw requestError("Invalid advertisement publishing settings");
  if (!Number.isInteger(order) || order < 0 || order > 100000 || !Number.isFinite(speed) || speed < .25 || speed > 5) throw requestError("Invalid advertisement order or animation speed");
  const start = pick("start_at", null) || null, end = pick("end_at", null) || null;
  if (start && Number.isNaN(Date.parse(start)) || end && Number.isNaN(Date.parse(end)) || start && end && Date.parse(end) <= Date.parse(start)) throw requestError("Enter a valid advertisement schedule");
  const href = pick("cta_url", "");
  if (href && href !== "@whatsapp") { let url; try { url = new URL(href, "https://local.invalid"); } catch { throw requestError("CTA URL is invalid"); } if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw requestError("CTA URL must use HTTP or HTTPS"); }
  return { name, ad_type, headline: boundedString(pick("headline"), "headline", 240) ?? "", description: boundedString(pick("description"), "description", 3000) ?? "", cta_text: boundedString(pick("cta_text"), "cta_text", 80) ?? "", cta_url: href || "", placement, animation, animation_speed: speed, text_color: color("text_color", "text_color", "#ffffff"), background_color: color("background_color", "background_color", "#172554"), text_align: pick("text_align", "center"), status, is_enabled: enabled, display_order: order, start_at: start, end_at: end, media_key: pick("media_key", null), poster_key: pick("poster_key", null) };
}

function normalizePhone(countryCode, localPhone) {
  if (typeof countryCode !== "string" || !/^\+[1-9]\d{0,3}$/.test(countryCode)) throw requestError("Choose a valid country calling code");
  if (typeof localPhone !== "string") throw requestError("Mobile number is required");
  const digits = localPhone.replace(/[\s().-]/g, "");
  if (!/^\d{6,14}$/.test(digits) || `${countryCode.slice(1)}${digits}`.length > 15) throw requestError("Enter a valid mobile number with country code");
  return { countryCode, localPhone: digits, phone: `+${countryCode.slice(1)}${digits}` };
}

function normalizeWhatsAppNumber(value) {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

function safeOriginalFilename(value) {
  const name = String(value || "attachment").replace(/\\/g, "/").split("/").pop().replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180);
  return name || "attachment";
}

function decodeLeadFiles(items) {
  if (!Array.isArray(items)) throw requestError("attachments must be a list of image files");
  if (items.length > MAX_LEAD_FILES) throw requestError(`Upload up to ${MAX_LEAD_FILES} images per request`);
  const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  let totalBytes = 0;
  return items.map((item) => {
    if (!item || typeof item !== "object" || typeof item.data_base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data_base64)) throw requestError("An attachment is not valid base64 image data");
    const bytes = Buffer.from(item.data_base64, "base64");
    if (!bytes.length || bytes.length > MAX_LEAD_FILE_BYTES || bytes.toString("base64") !== item.data_base64) throw requestError("Each image must be no larger than 2 MB");
    totalBytes += bytes.length;
    if (totalBytes > MAX_LEAD_TOTAL_BYTES) throw requestError("Combined image size must be no larger than 6 MB");
    const mimeType = detectImageMime(bytes);
    if (!extensions[mimeType] || item.mime_type !== mimeType) throw requestError("Only valid JPEG, PNG, and WebP images are accepted");
    const extension = extensions[mimeType];
    const originalName = safeOriginalFilename(item.name);
    const nameExtension = originalName.split(".").pop().toLowerCase();
    if (!({ jpg: ["jpg", "jpeg"], png: ["png"], webp: ["webp"] }[extension]).includes(nameExtension)) throw requestError("Image filename extension must match its content type");
    return { bytes, mimeType, extension, originalName };
  });
}

const leadRateBuckets = new Map();
function leadRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const bucket = leadRateBuckets.get(key);
  if (!bucket || now - bucket.startedAt > 10 * 60 * 1000) {
    leadRateBuckets.set(key, { startedAt: now, count: 1 });
    return next();
  }
  if (bucket.count >= 5) return res.status(429).json({ error: "Too many requests. Please try again in a few minutes." });
  bucket.count += 1;
  next();
}

const reviewRateBuckets = new Map();
function publicReviewRateLimit(req,res,next){const now=Date.now(),key=req.ip||req.socket.remoteAddress||"unknown",bucket=reviewRateBuckets.get(key);if(!bucket||now-bucket.startedAt>60*60*1000){reviewRateBuckets.set(key,{startedAt:now,count:1});return next();}if(bucket.count>=3)return res.status(429).json({error:"Too many review submissions. Please try again later."});bucket.count+=1;next();}

function leadReference(id) { return `PWA-${String(id).padStart(8, "0")}`; }

async function sendWhatsAppJson(url, token, payload) {
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(12000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `WhatsApp API returned HTTP ${response.status}`);
  return data;
}

function whatsappCredentials() {
  return {
    token: process.env.WHATSAPP_CLOUD_API_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || "",
    phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_BUSINESS_PHONE_NUMBER_ID || "",
    version: process.env.WHATSAPP_API_VERSION || "",
  };
}

function safeWhatsAppError(value) {
  let message = String(value || "WhatsApp provider request failed").slice(0, 1500);
  const token = whatsappCredentials().token;
  if (token) message = message.split(token).join("[redacted]");
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/access[_ -]?token[=: ]+\S+/gi, "access token [redacted]").slice(0, 1000);
}

function whatsappProviderError(data, status) {
  const error = new Error(safeWhatsAppError(data?.error?.error_user_msg || data?.error?.message || `WhatsApp API returned HTTP ${status}`));
  error.status = status;
  error.providerCode = data?.error?.code || null;
  error.providerSubcode = data?.error?.error_subcode || null;
  return error;
}

async function whatsappRequest(url, token, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(options.timeout || 15000) });
  } catch (error) {
    const networkError = new Error(error.name === "TimeoutError" ? "WhatsApp provider request timed out" : "Unable to reach the WhatsApp provider");
    networkError.retryable = true;
    throw networkError;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw whatsappProviderError(data, response.status);
  return data;
}

async function getWhatsAppSettings(db = pool) {
  const result = await db.query("SELECT * FROM whatsapp_notification_settings WHERE id=1");
  if (!result.rowCount) throw new Error("WhatsApp notification settings are not initialized. Apply migration 004_whatsapp_notification_queue.sql.");
  return result.rows[0];
}

async function getBusinessRecipient(settings, db = pool) {
  const value = settings.recipient_phone || process.env.WHATSAPP_NOTIFY_RECIPIENT || process.env.WHATSAPP_BUSINESS_RECIPIENT || (await db.query("SELECT whatsapp_number FROM brand_settings ORDER BY id LIMIT 1")).rows[0]?.whatsapp_number || "";
  const digits = String(value).replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

function notificationEnabled(settings, type) {
  if (!settings.enabled) return false;
  if (type === "project_request") return Boolean(settings.notify_project_requests);
  if (type === "service_inquiry") return Boolean(settings.notify_new_leads && settings.notify_service_inquiries);
  if (type === "lead") return Boolean(settings.notify_new_leads);
  if (type === "customer_confirmation") return Boolean(settings.customer_confirmation && settings.notify_new_leads);
  if (type === "attachment") return Boolean(settings.notify_attachments && settings.notify_new_leads);
  return false;
}

function scheduleFormatter(timezone) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function localScheduleParts(date, formatter) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const days = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { day: days[parts.weekday], minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

function isWhatsAppScheduleAllowed(date, settings) {
  if (!settings.schedule_enabled) return true;
  const formatter = scheduleFormatter(settings.timezone || "Asia/Kolkata");
  const { day, minute } = localScheduleParts(date, formatter);
  const allowed = new Set((settings.allowed_days || []).map(Number));
  const start = Number(String(settings.start_time).slice(0, 2)) * 60 + Number(String(settings.start_time).slice(3, 5));
  const end = Number(String(settings.end_time).slice(0, 2)) * 60 + Number(String(settings.end_time).slice(3, 5));
  if (start === end) return allowed.has(day);
  if (start < end) return allowed.has(day) && minute >= start && minute < end;
  if (minute >= start) return allowed.has(day);
  const previousDay = day === 1 ? 7 : day - 1;
  return minute < end && allowed.has(previousDay);
}

function nextWhatsAppWindow(settings, from = new Date()) {
  if (!settings.schedule_enabled) return from;
  const first = new Date(from);
  first.setUTCSeconds(0, 0);
  if (first < from) first.setUTCMinutes(first.getUTCMinutes() + 1);
  for (let minute = 0; minute <= 8 * 24 * 60; minute += 1) {
    const candidate = new Date(first.getTime() + minute * 60000);
    if (isWhatsAppScheduleAllowed(candidate, settings)) return candidate;
  }
  return null;
}

function notificationTypeAllowed(settings, type) {
  if (type === "attachment") return Boolean(settings.notify_attachments && settings.notify_new_leads);
  return notificationEnabled(settings, type);
}

async function enqueueWhatsAppJob(db, { leadId = null, projectId = null, attachmentId = null, type, recipient }) {
  const settings = await getWhatsAppSettings(db);
  const creds = whatsappCredentials();
  let recipientDigits = recipient;
  if (!recipientDigits && type !== "customer_confirmation") recipientDigits = await getBusinessRecipient(settings, db);
  const configured = Boolean(creds.token && /^\d+$/.test(creds.phoneId) && /^v\d+\.\d+$/.test(creds.version));
  let status = "pending";
  let scheduledAt = new Date();
  let lastError = null;
  if (!notificationTypeAllowed(settings,type)) { status="scheduled"; scheduledAt=new Date(Date.now()+5*60000); lastError="Notification is queued while its admin toggle is disabled."; }
  else {
    const window=nextWhatsAppWindow(settings);
    if(!window){status="scheduled";scheduledAt=new Date(Date.now()+24*3600000);lastError="No permitted sending day is configured; job remains queued.";}
    else if(window.getTime()>Date.now()+1000){status="scheduled";scheduledAt=window;}
  }
  const configError=!recipientDigits?"Configuration: set a valid business WhatsApp recipient in Notification Settings.":!configured?"Configuration: set the Cloud API token, phone number ID, and API version on the server.":null;
  if(configError){lastError=configError;if(status==="pending")status="failed";}
  const result = await db.query(`INSERT INTO whatsapp_notification_queue (lead_id,project_id,attachment_id,notification_type,recipient,scheduled_at,status,last_error)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id,status`, [leadId,projectId,attachmentId,type,recipientDigits,scheduledAt,status,lastError]);
  if (status === "failed" && lastError) await db.query("UPDATE whatsapp_notification_settings SET last_error=$1,updated_at=NOW() WHERE id=1", [lastError]);
  if (leadId && result.rowCount && type !== "attachment") {
    await db.query("UPDATE leads SET whatsapp_notification_status=$1,whatsapp_error=$2,whatsapp_updated_at=NOW() WHERE id=$3", [status === "failed" ? "not_configured" : (status === "scheduled" ? "pending" : "pending"),lastError,leadId]);
  }
  return result.rows[0] || null;
}

function templatePayload(settings,name,language,values) {
  return { messaging_product: "whatsapp", recipient_type: "individual", type: "template", template: { name, language: { code: language }, components: [{ type: "body", parameters: values.map((text) => ({ type: "text", text: String(text || "-").slice(0, 1024) })) }] } };
}

async function notificationDetails(job, db) {
  if (job.project_id) {
    const result = await db.query(`SELECT p.id,p.title,p.project_type,p.description,p.budget,u.name,u.phone,u.email,s.name AS service_name
      FROM projects p LEFT JOIN users u ON u.id=p.user_id LEFT JOIN services s ON s.id=p.service_id WHERE p.id=$1`, [job.project_id]);
    if (!result.rowCount) throw new Error("Project request no longer exists");
    const p = result.rows[0];
    return { reference: `PROJECT-${p.id}`, name: p.name || "Customer", phone: p.phone || "Not on account", email: p.email || "Not provided", service: p.service_name || p.project_type || p.title, price: p.budget == null ? "Quote requested" : `INR ${p.budget}`, message: p.description || p.title, attachmentCount: 0, leadId: null };
  }
  const result = await db.query(`SELECT l.*,COALESCE(l.service_name_snapshot,s.name) AS selected_service FROM leads l LEFT JOIN services s ON s.id=l.service_id WHERE l.id=$1`, [job.lead_id]);
  if (!result.rowCount) throw new Error("Lead request no longer exists");
  const l = result.rows[0];
  const count = await db.query("SELECT COUNT(*)::int AS count FROM lead_attachments WHERE lead_id=$1", [l.id]);
  return { reference: l.lead_reference || leadReference(l.id), name: l.name, phone: l.phone || "Not provided", email: l.email || "Not provided", service: l.selected_service || "General enquiry", price: l.sale_price_snapshot != null ? `${l.currency_snapshot || "INR"} ${l.sale_price_snapshot} (original ${l.original_price_snapshot})` : "Quote requested", message: l.message || "No message provided", attachmentCount: count.rows[0].count, leadId: l.id, customerPhone: l.phone };
}

function isRetryableWhatsAppError(error) {
  return error.retryable === true || error.status === 429 || error.status >= 500 || [4, 80007].includes(Number(error.providerCode));
}

async function recordLeadQueueStatus(db, job, status, messageId, errorText) {
  if (!job.lead_id || job.notification_type === "attachment" || job.notification_type === "customer_confirmation") return;
  await db.query("UPDATE leads SET whatsapp_notification_status=CASE WHEN whatsapp_notification_status IN ('sent','delivered','read') OR (whatsapp_notification_status='failed' AND $1='accepted') THEN whatsapp_notification_status ELSE $1 END,whatsapp_message_id=COALESCE($2,whatsapp_message_id),whatsapp_error=$3,whatsapp_updated_at=NOW() WHERE id=$4", [status,messageId,errorText,job.lead_id]);
}

let processingWhatsAppQueue = false;
async function processWhatsAppQueue() {
  if (processingWhatsAppQueue) return;
  processingWhatsAppQueue = true;
  try {
    await query("UPDATE whatsapp_notification_queue SET status='failed',last_error='Worker stopped during a provider request; verify delivery before retrying.',updated_at=NOW() WHERE status='sending' AND updated_at < NOW()-INTERVAL '15 minutes'");
    for (let batch = 0; batch < 5; batch += 1) {
      const client = await pool.connect();
      let job;
      let settings;
      try {
        await client.query("BEGIN");
        const selected = await client.query("SELECT * FROM whatsapp_notification_queue WHERE status IN ('pending','scheduled') AND scheduled_at<=NOW() AND attempt_count<max_attempts ORDER BY scheduled_at,id LIMIT 1 FOR UPDATE SKIP LOCKED");
        if (!selected.rowCount) { await client.query("COMMIT"); break; }
        job = selected.rows[0];
        settings = await getWhatsAppSettings(client);
        if (!notificationTypeAllowed(settings, job.notification_type)) {
          await client.query("UPDATE whatsapp_notification_queue SET status='scheduled',scheduled_at=NOW()+INTERVAL '5 minutes',last_error='Notification is queued while its admin toggle is disabled.',updated_at=NOW() WHERE id=$1", [job.id]);
          await client.query("COMMIT");
          continue;
        }
        if (settings.schedule_enabled && !isWhatsAppScheduleAllowed(new Date(), settings)) {
          const next = nextWhatsAppWindow(settings);
          await client.query("UPDATE whatsapp_notification_queue SET status='scheduled',scheduled_at=$1,last_error=$2,updated_at=NOW() WHERE id=$3", [next || new Date(Date.now() + 86400000),next ? "Outside the configured sending schedule." : "No permitted sending day is configured; job remains queued.",job.id]);
          await client.query("COMMIT");
          continue;
        }
        const creds = whatsappCredentials();
        const businessRecipient = job.notification_type === "customer_confirmation" ? job.recipient : await getBusinessRecipient(settings, client);
        if (!creds.token || !/^\d+$/.test(creds.phoneId) || !/^v\d+\.\d+$/.test(creds.version) || !businessRecipient) {
          const reason = !businessRecipient ? "Configuration: a valid WhatsApp recipient is required." : "Configuration: Cloud API token, phone number ID, and API version are required.";
          await client.query("UPDATE whatsapp_notification_queue SET recipient=$1,status='failed',last_error=$2,updated_at=NOW() WHERE id=$3", [businessRecipient,reason,job.id]);
          await recordLeadQueueStatus(client,job,"not_configured",null,reason);
          await client.query("UPDATE whatsapp_notification_settings SET last_error=$1,updated_at=NOW() WHERE id=1", [reason]);
          await client.query("COMMIT");
          continue;
        }
        job.recipient = businessRecipient;
        await client.query("UPDATE whatsapp_notification_queue SET status='sending',recipient=$2,attempt_count=attempt_count+1,last_error=NULL,updated_at=NOW() WHERE id=$1", [job.id,businessRecipient]);
        job.attempt_count += 1;
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }

      const latestSettings = await getWhatsAppSettings();
      settings = latestSettings;
      if (!notificationTypeAllowed(latestSettings,job.notification_type)) { await query("UPDATE whatsapp_notification_queue SET status='scheduled',scheduled_at=NOW()+INTERVAL '5 minutes',last_error='Notification is queued while its admin toggle is disabled.',updated_at=NOW() WHERE id=$1",[job.id]); continue; }
      if (latestSettings.schedule_enabled && !isWhatsAppScheduleAllowed(new Date(),latestSettings)) { const next=nextWhatsAppWindow(latestSettings); await query("UPDATE whatsapp_notification_queue SET status='scheduled',scheduled_at=$1,last_error='Outside the configured sending schedule.',updated_at=NOW() WHERE id=$2",[next||new Date(Date.now()+86400000),job.id]); continue; }
      const latestCredentials=whatsappCredentials();
      const currentRecipient=job.notification_type==="customer_confirmation"?job.recipient:await getBusinessRecipient(latestSettings);
      if(!latestCredentials.token||!/^\d+$/.test(latestCredentials.phoneId)||!/^v\d+\.\d+$/.test(latestCredentials.version)||!currentRecipient){const reason=!currentRecipient?"Configuration: a valid WhatsApp recipient is required.":"Configuration: Cloud API token, phone number ID, and API version are required.";await query("UPDATE whatsapp_notification_queue SET status='failed',last_error=$1,updated_at=NOW() WHERE id=$2",[reason,job.id]);if(job.lead_id&&job.notification_type!=="attachment")await recordLeadQueueStatus(pool,job,"not_configured",null,reason);await query("UPDATE whatsapp_notification_settings SET last_error=$1,updated_at=NOW() WHERE id=1",[reason]);continue;}
      job.recipient=currentRecipient;
      await query("UPDATE whatsapp_notification_queue SET recipient=$1 WHERE id=$2 AND status='sending'",[currentRecipient,job.id]);
      const creds = latestCredentials;
      const apiBase = `https://graph.facebook.com/${creds.version}/${encodeURIComponent(creds.phoneId)}`;
      try {
        if (job.notification_type === "attachment") {
          const fileResult = await query("SELECT * FROM lead_attachments WHERE id=$1 AND lead_id=$2", [job.attachment_id,job.lead_id]);
          if (!fileResult.rowCount) throw new Error("Lead attachment no longer exists");
          const file = fileResult.rows[0];
          const bytes = await fs.readFile(path.join(MEDIA_DIR,file.storage_key));
          const form = new FormData();
          form.append("messaging_product","whatsapp");
          form.append("type",file.mime_type);
          form.append("file",new Blob([bytes],{type:file.mime_type}),file.original_name);
          const media = await whatsappRequest(`${apiBase}/media`,creds.token,{method:"POST",body:form,timeout:20000});
          if (!media.id) throw new Error("WhatsApp media upload returned no media ID");
          const sent = await whatsappRequest(`${apiBase}/messages`,creds.token,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messaging_product:"whatsapp",recipient_type:"individual",to:job.recipient,type:"image",image:{id:media.id,caption:`Attachment for ${job.lead_id ? `lead ${job.lead_id}` : "service request"}`},biz_opaque_callback_data:`pwa-job-${job.id}`})});
          const messageId = sent.messages?.[0]?.id;
          if (!messageId) throw new Error("WhatsApp accepted the media request without returning a message ID");
          await query("UPDATE whatsapp_notification_queue SET status='accepted',provider_message_id=$1,updated_at=NOW() WHERE id=$2 AND status='sending'",[messageId,job.id]);
          await query("UPDATE lead_attachments SET whatsapp_status=CASE WHEN whatsapp_status IN ('sent','delivered','read') THEN whatsapp_status ELSE 'accepted' END,whatsapp_message_id=$1,whatsapp_error=NULL WHERE id=$2",[messageId,job.attachment_id]);
        } else {
          const details = await notificationDetails(job,pool);
          if (job.notification_type === "customer_confirmation") {
            const brandName=(await query("SELECT company_name FROM brand_settings ORDER BY id LIMIT 1")).rows[0]?.company_name||"Prime Web Agency";
            const payload = templatePayload(settings,settings.customer_template_name,settings.customer_template_language,[details.reference,brandName]);
            payload.to = job.recipient;
            payload.biz_opaque_callback_data = `pwa-job-${job.id}`;
            const sent = await whatsappRequest(`${apiBase}/messages`,creds.token,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
            const messageId = sent.messages?.[0]?.id;
            if (!messageId) throw new Error("WhatsApp accepted the confirmation without returning a message ID");
            await query("UPDATE whatsapp_notification_queue SET status='accepted',provider_message_id=$1,updated_at=NOW() WHERE id=$2 AND status='sending'",[messageId,job.id]);
          } else {
            const payload = templatePayload(settings,settings.notification_template_name,settings.notification_template_language,[details.reference,details.name,details.phone,details.service,details.price,`${details.message} (Attachments: ${details.attachmentCount})`]);
            payload.to = job.recipient;
            payload.biz_opaque_callback_data = `pwa-job-${job.id}`;
            const sent = await whatsappRequest(`${apiBase}/messages`,creds.token,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
            const messageId = sent.messages?.[0]?.id;
            if (!messageId) throw new Error("WhatsApp accepted the notification without returning a message ID");
            await query("UPDATE whatsapp_notification_queue SET status='accepted',provider_message_id=$1,updated_at=NOW() WHERE id=$2 AND status='sending'",[messageId,job.id]);
            await recordLeadQueueStatus(pool,job,"accepted",messageId,null);
          }
        }
        await query("UPDATE whatsapp_notification_settings SET last_success_at=NOW(),last_error=NULL,connection_status='connected',connection_checked_at=NOW(),updated_at=NOW() WHERE id=1");
      } catch (error) {
        const message = safeWhatsAppError(error.message);
        const retry = isRetryableWhatsAppError(error) && job.attempt_count < 6;
        const delayMinutes = Math.min(60,2 ** Math.max(0,job.attempt_count - 1));
        const status = retry ? "scheduled" : "failed";
        await query("UPDATE whatsapp_notification_queue SET status=$1,scheduled_at=$2,last_error=$3,updated_at=NOW() WHERE id=$4",[status,new Date(Date.now() + delayMinutes * 60000),message,job.id]);
        if (job.notification_type === "attachment") await query("UPDATE lead_attachments SET whatsapp_status='failed',whatsapp_error=$1 WHERE id=$2",[message,job.attachment_id]);
        else if (job.notification_type !== "customer_confirmation") await recordLeadQueueStatus(pool,job,retry?"pending":"failed",null,message);
        await query("UPDATE whatsapp_notification_settings SET last_error=$1,updated_at=NOW() WHERE id=1",[message]);
      }
    }
  } catch (error) {
    console.error("WHATSAPP QUEUE PROCESSOR ERROR:",error.code || "queue error");
  } finally { processingWhatsAppQueue = false; }
}

function triggerWhatsAppQueue() { setImmediate(() => processWhatsAppQueue().catch(() => {})); }
async function reactivateConfiguredWhatsAppJobs() {
  const cfg=whatsappCredentials();
  if(!cfg.token||!/^\d+$/.test(cfg.phoneId)||!/^v\d+\.\d+$/.test(cfg.version))return;
  await query("UPDATE whatsapp_notification_queue SET status='pending',scheduled_at=NOW(),last_error=NULL,updated_at=NOW() WHERE status='failed' AND last_error LIKE 'Configuration:%'");
  await query("UPDATE leads SET whatsapp_notification_status='pending',whatsapp_error=NULL,whatsapp_updated_at=NOW() WHERE whatsapp_notification_status='not_configured' AND id IN (SELECT lead_id FROM whatsapp_notification_queue WHERE status='pending' AND notification_type IN ('lead','service_inquiry'))");
}/* =========================================================
   DATABASE HELPER
========================================================= */

async function query(text, params = []) {
  return pool.query(text, params);
}

/* =========================================================
   AUTH HELPERS
========================================================= */

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "7d",
    }
  );
}

async function authRequired(req, res, next) {
  let decoded;
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Authentication required",
      });
    }

    const token = header.substring(7);

    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({
      error: "Invalid or expired token",
    });
  }

  if (!isBigIntId(String(decoded.id || ""))) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  try {
    const result = await query(
      `SELECT id, name, email, role, is_active FROM users WHERE id = $1`,
      [decoded.id]
    );
    const user = result.rows[0];

    if (!user) return res.status(401).json({ error: "Account no longer exists" });
    if (!user.is_active) return res.status(403).json({ error: "Your account is disabled" });
    if (!["admin", "customer"].includes(user.role)) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Role and active status come from PostgreSQL on every protected request.
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

function rolesRequired(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        error: "Access denied",
      });
    }

    next();
  };
}

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/api/health", async (req, res) => {
  try {
    await query("SELECT 1");

    res.json({
      success: true,
      message: "Prime Web Agency API is running",
      database: "connected",
      time: new Date().toISOString(),
    });
  } catch (error) {
    logOperationalError("HEALTH CHECK DATABASE ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Database connection failed",
    });
  }
});

/* =========================================================
   AUTH
========================================================= */

app.post("/api/auth/register", async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      phone,
      company_name,
    } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        error: "Name, email and password are required",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "Password must contain at least 6 characters",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const existing = await query(
      "SELECT id FROM users WHERE email = $1",
      [normalizedEmail]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: "An account with this email already exists",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await query(
      `
      INSERT INTO users
      (
        name,
        email,
        password_hash,
        phone,
        company_name,
        role
      )
      VALUES ($1, $2, $3, $4, $5, 'customer')
      RETURNING
        id,
        name,
        email,
        phone,
        company_name,
        role,
        is_active,
        created_at
      `,
      [
        name.trim(),
        normalizedEmail,
        passwordHash,
        phone || null,
        company_name || null,
      ]
    );

    const user = result.rows[0];

    const token = createToken(user);

    res.status(201).json({
      success: true,
      token,
      user,
    });
  } catch (error) {
    logOperationalError("REGISTER ERROR:", error);

    res.status(500).json({
      error: "Registration failed",
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const result = await query(
      `
      SELECT
        id,
        name,
        email,
        password_hash,
        phone,
        company_name,
        role,
        is_active,
        created_at
      FROM users
      WHERE email = $1
      `,
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "Invalid email or password",
      });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: "Your account is disabled" });
    }

    const passwordMatch = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordMatch) {
      return res.status(401).json({
        error: "Invalid email or password",
      });
    }

    delete user.password_hash;

    const token = createToken(user);

    res.json({
      success: true,
      token,
      user,
    });
  } catch (error) {
    logOperationalError("LOGIN ERROR:", error);

    res.status(500).json({
      error: "Login failed",
    });
  }
});

app.get("/api/me", authRequired, async (req, res) => {
  try {
    const result = await query(
      `
      SELECT
        id,
        name,
        email,
        phone,
        company_name,
        role,
        created_at
      FROM users
      WHERE id = $1
      `,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    res.json({
      user: result.rows[0],
    });
  } catch (error) {
    logOperationalError("APPLICATION ERROR:", error);

    res.status(500).json({
      error: "Unable to load profile",
    });
  }
});

/* =========================================================
   PUBLIC BRAND
========================================================= */

app.get("/api/public/brand", async (req, res) => {
  try {
    const result = await query(
      `
      SELECT company_name, logo_url, favicon_url, tagline, domain_name, email, phone,
             whatsapp_number, currency, settings
      FROM brand_settings
      ORDER BY id ASC
      LIMIT 1
      `
    );

    const brand=normalizeBrand(result.rows[0] || null);
    brand.theme_config = validatePublicTheme(result.rows[0]?.settings?.theme_published || DEFAULT_PUBLIC_THEME);
    const whatsappSettings=await getWhatsAppSettings();
    brand.whatsapp_number=await getBusinessRecipient(whatsappSettings)||brand.whatsapp_number;
    res.json({brand});
  } catch (error) {
    logOperationalError("APPLICATION ERROR:", error);

    res.status(500).json({
      error: "Unable to load brand settings",
    });
  }
});

/* =========================================================
   PUBLIC SERVICES
========================================================= */

app.get("/api/public/services", async (req, res) => {
  try {
    const result = await query(
      `
      SELECT id, name, slug, description, category, price, price_label,
             maintenance_price, currency, billing_label, features, image_url,
             sale_enabled, discount_type, discount_value, offer_badge_text,
             sale_start_date, sale_end_date
      FROM services
      WHERE is_active = TRUE
      ORDER BY sort_order ASC, id ASC
      `
    );

    res.json({
      services: result.rows.map((service) => ({ ...withSalePricing(service), price_from: service.price, short_description: service.description })),
    });
  } catch (error) {
    logOperationalError("APPLICATION ERROR:", error);

    res.status(500).json({
      error: "Unable to load services",
    });
  }
});

/* =========================================================
   PUBLIC PORTFOLIO
========================================================= */

app.get("/api/public/portfolio", async (req, res) => {
  try {
    const result = await query(
      `
      SELECT id, title, slug, description, category, image_url, project_url, technologies
      FROM portfolio_projects
      WHERE is_published = TRUE
      ORDER BY sort_order ASC, id DESC
      `
    );

    res.json({
      portfolio: result.rows,
    });
  } catch (error) {
    logOperationalError("APPLICATION ERROR:", error);

    res.status(500).json({
      error: "Unable to load portfolio",
    });
  }
});

app.get("/api/public/gallery", async (req, res) => {
  try {
    const result = await query(`
      SELECT id, title, alt_text, category, caption, '/media/' || storage_key AS image_url, sort_order
      FROM gallery_images WHERE is_published = TRUE ORDER BY sort_order ASC, created_at DESC
    `);
    res.json({ gallery: result.rows });
  } catch (error) {
    logOperationalError("PUBLIC GALLERY ERROR:", error);
    res.status(500).json({ error: "Unable to load gallery" });
  }
});

app.get("/media/:storageKey", async (req, res) => {
  try {
    const storageKey = req.params.storageKey;
    if (!/^[a-f0-9-]{36}\.(jpg|png|webp|gif|mp4|webm)$/.test(storageKey)) {
      return res.status(404).end();
    }
    const isVideo = /\.(mp4|webm)$/.test(storageKey);
    const result = await query(isVideo ? "SELECT storage_key,mime_type FROM advertisement_media WHERE storage_key=$1::varchar AND mime_type LIKE 'video/%'" : "SELECT storage_key,mime_type FROM gallery_images WHERE storage_key=$1::varchar UNION ALL SELECT storage_key,mime_type FROM advertisement_media WHERE storage_key=$1::varchar AND mime_type LIKE 'image/%' LIMIT 1", [storageKey]);
    if (!result.rowCount) return res.status(404).end();
    res.set({ "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=86400", "Content-Disposition": "inline" });
    if (isVideo) res.set("Content-Security-Policy", "default-src 'none'; sandbox");
    res.type(result.rows[0].mime_type);
    return res.sendFile(storageKey, { root: MEDIA_DIR }, (error) => {
      if (error && !res.headersSent) res.status(error.statusCode === 404 ? 404 : 500).end();
    });
  } catch (error) {
    logOperationalError("MEDIA SERVE ERROR:", error);
    res.status(500).end();
  }
});

const adColumns = "id,name,ad_type,headline,description,media_key,media_mime_type,media_size,poster_key,cta_text,cta_url,placement,animation,animation_speed,text_color,background_color,text_align,status,is_enabled,display_order,start_at,end_at,created_at,updated_at";
function logPgDiagnostic(label,error){const detail={code:error.code||null,message:error.message||"",detail:error.detail||"",hint:error.hint||"",position:error.position||null};if(process.env.NODE_ENV==="development")console.error(label,detail);else console.error(label,error.code||"database error");}
async function validateAdMedia(a){let mime=null;if(a.media_key){const found=await query("SELECT mime_type FROM advertisement_media WHERE storage_key=$1",[a.media_key]);if(!found.rowCount)throw requestError("Advertisement media reference is invalid");mime=found.rows[0].mime_type;}if(a.poster_key){const found=await query("SELECT mime_type FROM advertisement_media WHERE storage_key=$1",[a.poster_key]);if(!found.rowCount||!found.rows[0].mime_type.startsWith("image/"))throw requestError("Poster must reference an uploaded image");}if(mime&&["video","text_video"].includes(a.ad_type)!==mime.startsWith("video/"))throw requestError("Uploaded media type does not match the selected advertisement type");if(a.ad_type==="animated_text"&&a.media_key)throw requestError("Animated text advertisements cannot include a media file");}
app.get("/api/public/advertisements", async (req,res) => {
  try { const result = await query(`SELECT id,ad_type,headline,description,media_mime_type,cta_text,cta_url,placement,animation,animation_speed,text_color,background_color,text_align,display_order,CASE WHEN media_key IS NULL THEN NULL ELSE '/media/'||media_key END AS media_url,CASE WHEN poster_key IS NULL THEN NULL ELSE '/media/'||poster_key END AS poster_url FROM advertisements WHERE status='published' AND is_enabled=TRUE AND EXISTS(SELECT 1 FROM advertisement_placements p WHERE p.placement=advertisements.placement AND p.is_enabled=TRUE) AND (start_at IS NULL OR start_at<=NOW()) AND (end_at IS NULL OR end_at>NOW()) ORDER BY placement,display_order,id`);let ads=result.rows;if(ads.some(ad=>ad.cta_url==="@whatsapp")){const settings=await getWhatsAppSettings();const digits=await getBusinessRecipient(settings);ads=ads.map(ad=>ad.cta_url==="@whatsapp"?{...ad,cta_url:digits?`https://wa.me/${digits}`:""}:ad);}res.set("Cache-Control","public, max-age=60, stale-while-revalidate=120").json({ advertisements: ads }); }
  catch(error){ console.error("PUBLIC ADS ERROR:",error.code||"query failed"); res.status(500).json({error:"Unable to load advertisements"}); }
});
app.get("/api/admin/advertisements",authRequired,rolesRequired("admin"),async(req,res)=>{try{const result=await query(`SELECT ${adColumns} FROM advertisements ORDER BY updated_at DESC,id DESC`);res.json({advertisements:result.rows});}catch(error){console.error("ADMIN ADS ERROR:",error.code||"query failed");res.status(500).json({error:"Unable to load advertisements"});}});
app.get("/api/admin/advertisement-placements",authRequired,rolesRequired("admin"),async(req,res)=>{try{const result=await query("SELECT placement,is_enabled FROM advertisement_placements ORDER BY placement");res.json({placements:result.rows});}catch(error){console.error("ADMIN AD PLACEMENTS ERROR:",error.code||"query failed");res.status(500).json({error:"Unable to load advertisement placements"});}});
app.put("/api/admin/advertisement-placements/:placement",authRequired,rolesRequired("admin"),async(req,res)=>{try{if(!AD_PLACEMENTS.has(req.params.placement)||typeof req.body?.is_enabled!=="boolean")return res.status(400).json({error:"Invalid advertisement placement setting"});const result=await query("UPDATE advertisement_placements SET is_enabled=$1,updated_at=NOW() WHERE placement=$2 RETURNING placement,is_enabled",[req.body.is_enabled,req.params.placement]);if(!result.rowCount)return res.status(404).json({error:"Advertisement placement not found"});res.json({placement:result.rows[0]});}catch(error){console.error("UPDATE AD PLACEMENT ERROR:",error.code||"update failed");res.status(500).json({error:"Unable to update advertisement placement"});}});
app.post("/api/admin/advertisements/upload",authRequired,rolesRequired("admin"),async(req,res)=>{
  let key=null;try{const {data_url,kind="media"}=req.body||{};if(!["media","poster"].includes(kind)||typeof data_url!=="string")throw requestError("Select a supported image or video file");const match=data_url.match(/^data:(image\/(?:jpeg|png|webp|gif)|video\/(?:mp4|webm));base64,([A-Za-z0-9+/=]+)$/);if(!match)throw requestError("Unsupported advertisement media type");const mime=match[1],bytes=Buffer.from(match[2],"base64");const max=mime.startsWith("video/")?8*1024*1024:5*1024*1024;if(!bytes.length||bytes.length>max)throw requestError(`File exceeds the ${max/1024/1024} MB limit`);let ext={"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif","video/mp4":"mp4","video/webm":"webm"}[mime];if(mime.startsWith("image/")&&detectImageMime(bytes)!==mime)throw requestError("Image content does not match its file type");if(mime==="video/mp4"&&(bytes.length<12||bytes.subarray(4,8).toString("ascii")!=="ftyp"))throw requestError("Video file is not a valid MP4");if(mime==="video/webm"&&bytes.subarray(0,4).toString("hex")!=="1a45dfa3")throw requestError("Video file is not a valid WebM");key=`${crypto.randomUUID()}.${ext}`;await fs.mkdir(MEDIA_DIR,{recursive:true,mode:0o700});await fs.writeFile(path.join(MEDIA_DIR,key),bytes,{flag:"wx",mode:0o600});await query("INSERT INTO advertisement_media(storage_key,mime_type,file_size) VALUES($1,$2,$3)",[key,mime,bytes.length]);res.status(201).json({storage_key:key,url:`/media/${key}`,mime_type:mime,file_size:bytes.length,kind});}catch(error){if(key)await fs.unlink(path.join(MEDIA_DIR,key)).catch(()=>{});if(error.statusCode===400)return res.status(400).json({error:error.message});console.error("AD UPLOAD ERROR:",error.code||"upload failed");res.status(500).json({error:"Unable to save advertisement media"});}
});
app.post("/api/admin/advertisements",authRequired,rolesRequired("admin"),async(req,res)=>{try{const a=adInput(req.body||{});await validateAdMedia(a);const result=await query(`INSERT INTO advertisements(name,ad_type,headline,description,media_key,poster_key,cta_text,cta_url,placement,animation,animation_speed,text_color,background_color,text_align,status,is_enabled,display_order,start_at,end_at,media_mime_type,media_size) VALUES($1::varchar,$2::varchar,$3::varchar,$4::text,$5::varchar,$6::varchar,$7::varchar,$8::varchar,$9::varchar,$10::varchar,$11::numeric,$12::varchar,$13::varchar,$14::varchar,$15::varchar,$16::boolean,$17::integer,$18::timestamptz,$19::timestamptz,(SELECT mime_type FROM advertisement_media WHERE storage_key=$5::varchar),(SELECT file_size FROM advertisement_media WHERE storage_key=$5::varchar)) RETURNING ${adColumns}`,[a.name,a.ad_type,a.headline,a.description,a.media_key,a.poster_key,a.cta_text,a.cta_url,a.placement,a.animation,a.animation_speed,a.text_color,a.background_color,a.text_align,a.status,a.is_enabled,a.display_order,a.start_at,a.end_at]);res.status(201).json({advertisement:result.rows[0]});}catch(error){if(error.statusCode===400)return res.status(400).json({error:error.message});logPgDiagnostic("CREATE AD ERROR:",error);res.status(500).json({error:"Unable to create advertisement"});}});
app.put("/api/admin/advertisements/:id",authRequired,rolesRequired("admin"),async(req,res)=>{try{if(!isBigIntId(req.params.id))return res.status(400).json({error:"Advertisement ID must be numeric"});const existing=await query(`SELECT * FROM advertisements WHERE id=$1`,[req.params.id]);if(!existing.rowCount)return res.status(404).json({error:"Advertisement not found"});const a=adInput(req.body||{},existing.rows[0]);await validateAdMedia(a);const result=await query(`UPDATE advertisements SET name=$1,ad_type=$2,headline=$3,description=$4,media_key=$5,poster_key=$6,cta_text=$7,cta_url=$8,placement=$9,animation=$10,animation_speed=$11,text_color=$12,background_color=$13,text_align=$14,status=$15,is_enabled=$16,display_order=$17,start_at=$18,end_at=$19,media_mime_type=(SELECT mime_type FROM advertisement_media WHERE storage_key=$5::varchar),media_size=(SELECT file_size FROM advertisement_media WHERE storage_key=$5::varchar),updated_at=NOW() WHERE id=$20 RETURNING ${adColumns}`,[a.name,a.ad_type,a.headline,a.description,a.media_key,a.poster_key,a.cta_text,a.cta_url,a.placement,a.animation,a.animation_speed,a.text_color,a.background_color,a.text_align,a.status,a.is_enabled,a.display_order,a.start_at,a.end_at,req.params.id]);res.json({advertisement:result.rows[0]});}catch(error){if(error.statusCode===400)return res.status(400).json({error:error.message});logPgDiagnostic("UPDATE AD ERROR:",error);res.status(500).json({error:"Unable to update advertisement"});}});
app.delete("/api/admin/advertisements/:id",authRequired,rolesRequired("admin"),async(req,res)=>{try{if(!isBigIntId(req.params.id))return res.status(400).json({error:"Advertisement ID must be numeric"});const result=await query("DELETE FROM advertisements WHERE id=$1 RETURNING id",[req.params.id]);if(!result.rowCount)return res.status(404).json({error:"Advertisement not found"});res.json({success:true});}catch(error){console.error("DELETE AD ERROR:",error.code||"delete failed");res.status(500).json({error:"Unable to delete advertisement"});}});

function validateReview(body,fallback={}){const val=k=>body[k]===undefined?fallback[k]:body[k];const display_name=boundedString(val("display_name"),"display_name",120,{required:true}),company_name=boundedString(val("company_name")||"","company_name",160),quote=boundedString(val("quote"),"quote",2000,{required:true}),rating=Number(val("rating")),sort_order=Number(val("sort_order")??0),attribution_consent=val("attribution_consent")===true,is_approved=val("is_approved")===true,is_visible=val("is_visible")!==false,is_published=val("is_published")!==false,is_featured=val("is_featured")===true,reviewer_photo_url=imageUrl(val("reviewer_photo_url"),"reviewer_photo_url");if(!Number.isInteger(rating)||rating<1||rating>5||!Number.isInteger(sort_order)||sort_order<0||sort_order>100000)throw requestError("Review rating or order is invalid");if(is_approved&&!attribution_consent)throw requestError("Record attribution consent before approving a review");return{display_name,company_name,quote,rating,sort_order,attribution_consent,is_approved,is_visible,is_published,is_featured,reviewer_photo_url};}
const reviewColumns="id,display_name,company_name,quote,rating,attribution_consent,is_approved,is_visible,is_published,is_featured,reviewer_photo_url,sort_order,created_at";
app.get("/api/public/reviews",async(req,res)=>{try{const voterHash=reviewVoter(req,res);const result=await query("SELECT r.id,r.display_name,r.company_name,r.quote,r.rating,r.is_featured,r.reviewer_photo_url,r.created_at,(SELECT ROUND(AVG(rating)::numeric,1) FROM approved_reviews WHERE is_approved AND attribution_consent AND is_published AND is_visible) AS public_average,(SELECT COUNT(*)::int FROM approved_reviews WHERE is_approved AND attribution_consent AND is_published AND is_visible) AS review_count,COUNT(v.id) FILTER (WHERE v.is_helpful)::int AS helpful_count,COUNT(v.id) FILTER (WHERE v.is_helpful=FALSE)::int AS not_helpful_count,MAX(CASE WHEN v.voter_hash=$1 THEN CASE WHEN v.is_helpful THEN 'helpful' ELSE 'not_helpful' END END) AS viewer_vote FROM approved_reviews r LEFT JOIN review_helpful_votes v ON v.review_id=r.id WHERE r.is_approved AND r.attribution_consent AND r.is_published AND r.is_visible GROUP BY r.id ORDER BY r.is_featured DESC,r.sort_order,r.id",[voterHash]);res.set("Cache-Control","private,no-store").json({reviews:result.rows,average:result.rows[0]?.public_average||0,count:result.rows[0]?.review_count||0});}catch(error){console.error("PUBLIC REVIEWS ERROR:",error.code||"query failed");res.status(500).json({error:"Unable to load reviews"});}});
app.post("/api/public/reviews/:id/vote",async(req,res)=>{try{if(!isBigIntId(req.params.id))return res.status(400).json({error:"Review ID must be numeric"});if(typeof req.body?.helpful!=="boolean")return res.status(400).json({error:"Vote must be true or false"});const voterHash=reviewVoter(req,res);if(!allowReviewVote(voterHash))return res.status(429).json({error:"Please wait before voting again"});const id=req.params.id;const inserted=await query("INSERT INTO review_helpful_votes(review_id,voter_hash,is_helpful) SELECT $1::bigint,$2::char(64),$3::boolean WHERE EXISTS(SELECT 1 FROM approved_reviews WHERE id=$1::bigint AND is_approved AND attribution_consent AND is_published AND is_visible) ON CONFLICT(review_id,voter_hash) DO NOTHING RETURNING is_helpful",[id,voterHash,req.body.helpful]);const current=await query("SELECT v.is_helpful,COUNT(*) FILTER (WHERE all_votes.is_helpful)::int AS helpful_count,COUNT(*) FILTER (WHERE all_votes.is_helpful=FALSE)::int AS not_helpful_count FROM review_helpful_votes v JOIN approved_reviews r ON r.id=v.review_id LEFT JOIN review_helpful_votes all_votes ON all_votes.review_id=r.id WHERE v.review_id=$1::bigint AND v.voter_hash=$2::char(64) AND r.is_approved AND r.attribution_consent AND r.is_published AND r.is_visible GROUP BY v.is_helpful",[id,voterHash]);if(!current.rowCount)return res.status(404).json({error:"This review is not available for voting"});const vote=current.rows[0];const counts=await query("SELECT COUNT(*) FILTER (WHERE is_helpful)::int AS helpful_count,COUNT(*) FILTER (WHERE is_helpful=FALSE)::int AS not_helpful_count FROM review_helpful_votes WHERE review_id=$1::bigint",[id]);const result={success:true,viewer_vote:vote.is_helpful?"helpful":"not_helpful",helpful_count:counts.rows[0].helpful_count,not_helpful_count:counts.rows[0].not_helpful_count,recorded:Boolean(inserted.rowCount)};if(vote.is_helpful!==req.body.helpful)return res.status(409).json({...result,error:"You have already voted on this review"});res.set("Cache-Control","no-store").json(result);}catch(error){console.error("PUBLIC REVIEW VOTE ERROR:",error.code||"vote failed");res.status(500).json({error:"Unable to record your vote"});}});
app.post("/api/public/reviews",publicReviewRateLimit,async(req,res)=>{try{const b=req.body&&typeof req.body==="object"&&!Array.isArray(req.body)?req.body:{};if(b.website_url)return res.status(400).json({error:"Unable to submit this review"});const displayName=boundedString(b.display_name,"display_name",120,{required:true}),quote=boundedString(b.quote,"quote",2000,{required:true}),rating=Number(b.rating);if(!Number.isInteger(rating)||rating<1||rating>5)throw requestError("Choose a rating from 1 to 5");if(b.attribution_consent!==true)throw requestError("Please confirm permission to publish your name and review if approved");await query("INSERT INTO approved_reviews(display_name,company_name,quote,rating,attribution_consent,is_approved,is_visible,is_published,is_featured,sort_order) VALUES($1::varchar,'',$2::text,$3::smallint,TRUE,FALSE,FALSE,FALSE,FALSE,0)",[displayName,quote,rating]);res.status(201).json({success:true,message:"Thank you. Your review was received and will be visible only after admin approval."});}catch(error){if(error.statusCode===400)return res.status(400).json({error:error.message});console.error("PUBLIC REVIEW SUBMIT ERROR:",error.code||"submit failed");res.status(500).json({error:"Unable to submit your review"});}});
app.get("/api/admin/reviews",authRequired,rolesRequired("admin"),async(req,res)=>{try{const result=await query("SELECT "+reviewColumns+",(is_approved AND attribution_consent AND is_published AND is_visible) AS public_eligible FROM approved_reviews ORDER BY updated_at DESC,id DESC");res.json({reviews:result.rows});}catch(error){console.error("ADMIN REVIEWS ERROR:",error.code||"query failed");res.status(500).json({error:"Unable to load reviews"});}});
app.post("/api/admin/reviews",authRequired,rolesRequired("admin"),async(req,res)=>{try{const r=validateReview(req.body||{});const result=await query("INSERT INTO approved_reviews(display_name,company_name,quote,rating,attribution_consent,is_approved,is_visible,is_published,is_featured,reviewer_photo_url,sort_order) VALUES($1::varchar,$2::varchar,$3::text,$4::smallint,$5::boolean,$6::boolean,$7::boolean,$8::boolean,$9::boolean,$10::varchar,$11::integer) RETURNING "+reviewColumns,[r.display_name,r.company_name||"",r.quote,r.rating,r.attribution_consent,r.is_approved,r.is_visible,r.is_published,r.is_featured,r.reviewer_photo_url,r.sort_order]);res.status(201).json({review:result.rows[0]});}catch(error){if(error.statusCode===400)return res.status(400).json({error:error.message});console.error("CREATE REVIEW ERROR:",error.code||"create failed");res.status(500).json({error:"Unable to create review"});}});
app.put("/api/admin/reviews/:id",authRequired,rolesRequired("admin"),async(req,res)=>{try{if(!isBigIntId(req.params.id))return res.status(400).json({error:"Review ID must be numeric"});const old=await query("SELECT * FROM approved_reviews WHERE id=$1",[req.params.id]);if(!old.rowCount)return res.status(404).json({error:"Review not found"});const r=validateReview(req.body||{},old.rows[0]);const result=await query("UPDATE approved_reviews SET display_name=$1::varchar,company_name=$2::varchar,quote=$3::text,rating=$4::smallint,attribution_consent=$5::boolean,is_approved=$6::boolean,is_visible=$7::boolean,is_published=$8::boolean,is_featured=$9::boolean,reviewer_photo_url=$10::varchar,sort_order=$11::integer,updated_at=NOW() WHERE id=$12 RETURNING "+reviewColumns,[r.display_name,r.company_name||"",r.quote,r.rating,r.attribution_consent,r.is_approved,r.is_visible,r.is_published,r.is_featured,r.reviewer_photo_url,r.sort_order,req.params.id]);res.json({review:result.rows[0]});}catch(error){if(error.statusCode===400)return res.status(400).json({error:error.message});console.error("UPDATE REVIEW ERROR:",error.code||"update failed");res.status(500).json({error:"Unable to update review"});}});
app.delete("/api/admin/reviews/:id",authRequired,rolesRequired("admin"),async(req,res)=>{try{if(!isBigIntId(req.params.id))return res.status(400).json({error:"Review ID must be numeric"});const result=await query("DELETE FROM approved_reviews WHERE id=$1 RETURNING id",[req.params.id]);if(!result.rowCount)return res.status(404).json({error:"Review not found"});res.json({success:true});}catch(error){console.error("DELETE REVIEW ERROR:",error.code||"delete failed");res.status(500).json({error:"Unable to delete review"});}});
function safeExternalUrl(value,field){if(value===undefined||value===null||value==="")return null;if(typeof value!=="string"||value.length>2048)throw requestError(field+" must be a valid HTTP(S) URL");try{const u=new URL(value);if(!["http:","https:"].includes(u.protocol)||u.username||u.password)throw Error();return u.toString();}catch{throw requestError(field+" must be a valid HTTP(S) URL");}}
function validateDemo(body,f={}){const val=k=>body[k]===undefined?f[k]:body[k];const title=boundedString(val("title"),"title",200,{required:true}),category=boundedString(val("category"),"category",100,{required:true}),description=boundedString(val("description")||"","description",3000)||"",website_url=safeExternalUrl(val("website_url"),"website_url"),media_key=boundedString(val("media_key"),"media_key",100),thumbnail_key=boundedString(val("thumbnail_key"),"thumbnail_key",100),price_label=boundedString(val("price_label"),"price_label",160),cta_label=boundedString(val("cta_label")||"Build a Website Like This","cta_label",80,{required:true}),display_order=Number(val("display_order")??0),is_featured=val("is_featured")===true,is_enabled=val("is_enabled")!==false,is_published=val("is_published")===true,demo_label=boundedString(val("demo_label"),"demo_label",120),demo_login_url=safeExternalUrl(val("demo_login_url"),"demo_login_url"),demo_username=boundedString(val("demo_username"),"demo_username",160),demo_instructions=boundedString(val("demo_instructions"),"demo_instructions",1000),demo_credentials_public=val("demo_credentials_public")===true,demo_account_is_sandbox=val("demo_account_is_sandbox")===true,available_until=val("available_until")?new Date(val("available_until")):null;if(!Number.isInteger(display_order)||display_order<0||display_order>1000000)throw requestError("Display order must be a non-negative integer");if(available_until&&Number.isNaN(available_until.getTime()))throw requestError("Availability date is invalid");if(demo_credentials_public&&(!demo_account_is_sandbox||!demo_label||!demo_username))throw requestError("Public demo account details require a dedicated sandbox account, label, and username");if(demo_login_url&&!demo_label)throw requestError("Demo login URL requires a demo label");return{title,category,description,website_url,media_key,thumbnail_key,price_label,cta_label,display_order,is_featured,is_enabled,is_published,demo_label,demo_login_url,demo_username,demo_instructions,demo_credentials_public,demo_account_is_sandbox,available_until};}
const demoColumns="id,title,category,description,website_url,media_key,media_mime_type,thumbnail_key,price_label,cta_label,is_featured,is_enabled,is_published,display_order,demo_label,demo_login_url,demo_username,demo_instructions,demo_credentials_public,demo_account_is_sandbox,available_until,created_at,updated_at";
app.get("/api/public/demos",async(req,res)=>{try{const result=await query("SELECT id,title,category,description,website_url,CASE WHEN media_key IS NULL THEN NULL ELSE '/media/'||media_key END AS media_url,media_mime_type,CASE WHEN thumbnail_key IS NULL THEN NULL ELSE '/media/'||thumbnail_key END AS thumbnail_url,price_label,cta_label,is_featured,demo_label,(demo_credentials_public AND demo_account_is_sandbox) AS demo_credentials_public,CASE WHEN demo_credentials_public AND demo_account_is_sandbox THEN demo_login_url END AS demo_login_url,CASE WHEN demo_credentials_public AND demo_account_is_sandbox THEN demo_username END AS demo_username,CASE WHEN demo_credentials_public AND demo_account_is_sandbox THEN demo_instructions END AS demo_instructions FROM website_demos WHERE is_published=TRUE AND is_enabled=TRUE AND (available_until IS NULL OR available_until>NOW()) ORDER BY is_featured DESC,display_order,id");res.set("Cache-Control","no-store").json({demos:result.rows});}catch(error){console.error("PUBLIC DEMOS ERROR:",error.code||"query failed");res.status(500).json({error:"Unable to load demos"});}});
app.get("/api/admin/demos",authRequired,rolesRequired("admin"),async(req,res)=>{try{const result=await query("SELECT "+demoColumns+" FROM website_demos ORDER BY updated_at DESC,id DESC");res.json({demos:result.rows});}catch(error){console.error("ADMIN DEMOS ERROR:",error.code||"query failed");res.status(500).json({error:"Unable to load demos"});}});
async function validateDemoMedia(key,imagesOnly=false){if(!key)return null;if(!/^[a-f0-9-]{36}\.(jpg|png|webp|gif|mp4|webm)$/.test(key))throw requestError("Media reference is invalid");const x=await query("SELECT mime_type FROM advertisement_media WHERE storage_key=$1::varchar UNION ALL SELECT mime_type FROM gallery_images WHERE storage_key=$1::varchar LIMIT 1",[key]);if(!x.rowCount||(imagesOnly&&x.rows[0].mime_type.startsWith("video/")))throw requestError("Select supported uploaded media");return x.rows[0].mime_type;}
async function saveDemo(req,res,updating){try{if(updating&&!isBigIntId(req.params.id))return res.status(400).json({error:"Demo ID must be numeric"});const old=updating?await query("SELECT * FROM website_demos WHERE id=$1",[req.params.id]):null;if(updating&&!old.rowCount)return res.status(404).json({error:"Demo not found"});const d=validateDemo(req.body||{},old?.rows[0]||{}),mime=await validateDemoMedia(d.media_key);await validateDemoMedia(d.thumbnail_key,true);const v=[d.title,d.category,d.description,d.website_url,d.media_key,mime,d.thumbnail_key,d.price_label,d.cta_label,d.is_featured,d.is_enabled,d.is_published,d.display_order,d.demo_label,d.demo_login_url,d.demo_username,d.demo_instructions,d.demo_credentials_public,d.demo_account_is_sandbox,d.available_until];const sql=updating?"UPDATE website_demos SET title=$1::varchar,category=$2::varchar,description=$3::text,website_url=$4::varchar,media_key=$5::varchar,media_mime_type=$6::varchar,thumbnail_key=$7::varchar,price_label=$8::varchar,cta_label=$9::varchar,is_featured=$10::boolean,is_enabled=$11::boolean,is_published=$12::boolean,display_order=$13::integer,demo_label=$14::varchar,demo_login_url=$15::varchar,demo_username=$16::varchar,demo_instructions=$17::text,demo_credentials_public=$18::boolean,demo_account_is_sandbox=$19::boolean,available_until=$20::timestamptz,updated_at=NOW() WHERE id=$21 RETURNING "+demoColumns:"INSERT INTO website_demos(title,category,description,website_url,media_key,media_mime_type,thumbnail_key,price_label,cta_label,is_featured,is_enabled,is_published,display_order,demo_label,demo_login_url,demo_username,demo_instructions,demo_credentials_public,demo_account_is_sandbox,available_until) VALUES($1::varchar,$2::varchar,$3::text,$4::varchar,$5::varchar,$6::varchar,$7::varchar,$8::varchar,$9::varchar,$10::boolean,$11::boolean,$12::boolean,$13::integer,$14::varchar,$15::varchar,$16::varchar,$17::text,$18::boolean,$19::boolean,$20::timestamptz) RETURNING "+demoColumns;const result=await query(sql,updating?v.concat(req.params.id):v);res.status(updating?200:201).json({demo:result.rows[0]});}catch(error){if(error.statusCode===400)return res.status(400).json({error:error.message});console.error("SAVE DEMO ERROR:",error.code||"save failed");res.status(500).json({error:"Unable to save demo"});}}
app.post("/api/admin/demos",authRequired,rolesRequired("admin"),(req,res)=>saveDemo(req,res,false));app.put("/api/admin/demos/:id",authRequired,rolesRequired("admin"),(req,res)=>saveDemo(req,res,true));
app.delete("/api/admin/demos/:id",authRequired,rolesRequired("admin"),async(req,res)=>{try{if(!isBigIntId(req.params.id))return res.status(400).json({error:"Demo ID must be numeric"});const x=await query("DELETE FROM website_demos WHERE id=$1 RETURNING id",[req.params.id]);if(!x.rowCount)return res.status(404).json({error:"Demo not found"});res.json({success:true});}catch(error){console.error("DELETE DEMO ERROR:",error.code||"delete failed");res.status(500).json({error:"Unable to delete demo"});}});/* =========================================================
   PUBLIC AI SETTINGS
========================================================= */

app.get("/api/public/ai", async (req, res) => {
  try {
    const result = await query(
      `
      SELECT
        is_enabled AS enabled
      FROM ai_settings
      ORDER BY id ASC
      LIMIT 1
      `
    );

    res.json({
      // Do not expose administrator-authored prompts, business context, or welcome text.
      ai: result.rows[0]?.enabled ? { enabled: true } : null,
    });
  } catch (error) {
    logOperationalError("APPLICATION ERROR:", error);

    res.status(500).json({
      error: "Unable to load AI settings",
    });
  }
});

/* =========================================================
   ANALYTICS EVENT
========================================================= */

app.post("/api/analytics/event", async (req, res) => {
  try {
    const { event_name, page_url, session_id, visitor_id, metadata } = req.body || {};
    const allowedEvents = new Set(["page_view", "whatsapp_click", "lead_submit", "contact_click", "navigation_click", "portfolio_view", "service_view", "cta_click", "portfolio_interaction", "enquiry_start"]);
    if (typeof event_name !== "string" || !allowedEvents.has(event_name)) {
      return res.status(400).json({ error: "event_name is invalid" });
    }
    if (session_id !== undefined && (typeof session_id !== "string" || session_id.length > 255)) {
      return res.status(400).json({ error: "session_id must be a string of at most 255 characters" });
    }
    if (visitor_id !== undefined && (typeof visitor_id !== "string" || visitor_id.length > 255)) {
      return res.status(400).json({ error: "visitor_id must be a string of at most 255 characters" });
    }
    if (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata))) {
      return res.status(400).json({ error: "metadata must be an object" });
    }
    const page = page_url || req.body.page || null;
    if (page !== null && (typeof page !== "string" || page.length > 2048)) {
      return res.status(400).json({ error: "page must be a string of at most 2048 characters" });
    }

    await query(
      `
      INSERT INTO analytics_events
      (
        event_type,
        page_url,
        session_id,
        metadata,
        referrer
      )
      VALUES ($1, $2, $3, $4, $5)
      `,
      [
        event_name,
        page_url || req.body.page || null,
        session_id || visitor_id || null,
        JSON.stringify(metadata || {}),
        req.get("referer") || null,
      ]
    );

    res.json({
      success: true,
    });
  } catch (error) {
    logOperationalError("ANALYTICS ERROR:", error);

    res.status(500).json({
      error: "Unable to record analytics",
    });
  }
});

/* =========================================================
   LEADS
========================================================= */

app.post("/api/leads", leadRateLimit, async (req, res) => {
  const createdFiles = [];
  const client = await pool.connect();
  let committed = false;
  let savedReference = null;
  try {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    if (body.website_url) return res.status(400).json({ error: "Unable to submit this request" });
    const requestKey = body.request_key || null;
    if (requestKey && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey)) throw requestError("request_key must be a valid request identifier");
    let existingRequest = null;
    if (requestKey) {
      const existing = await query("SELECT id,service_id,lead_reference,whatsapp_notification_status FROM leads WHERE request_key=$1", [requestKey]);
      existingRequest = existing.rows[0] || null;
    }
    const { service_id } = body;
    const name = boundedString(body.name, "name", 150, { required: true });
    const email = boundedString(body.email, "email", 255);
    const legacyPhone = boundedString(body.phone, "phone", 30);
    const extended = body.country_code !== undefined || body.local_phone !== undefined || body.consent !== undefined || body.attachments !== undefined;
    const phoneInfo = extended ? normalizePhone(body.country_code, boundedString(body.local_phone, "mobile number", 20, { required: true })) : null;
    const phone = phoneInfo?.phone || legacyPhone;
    const companyName = boundedString(body.company_name ?? body.company, "company_name", 200);
    const service = boundedString(body.service, "service", 220);
    const message = boundedString(body.message, "message", 5000);
    const source = boundedString(body.source, "source", 100) || "website";
    if (extended && body.consent !== true) throw requestError("Please agree to the privacy and contact consent before submitting");
    if (!email && !phone) return res.status(400).json({ error: "Email or phone is required" });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "email must be valid" });
    if (phone && !/^[+()\d .-]{7,30}$/.test(phone)) return res.status(400).json({ error: "phone must be valid" });
    const attachments = decodeLeadFiles(body.attachments || []);

    let resolvedServiceId = null;
    let serviceRow = null;
    const serviceFields = "id,name,price,currency,sale_enabled,discount_type,discount_value,offer_badge_text,sale_start_date,sale_end_date";
    if (service_id !== undefined && service_id !== null && service_id !== "") {
      if (!((typeof service_id === "string" && isBigIntId(service_id)) || (typeof service_id === "number" && Number.isSafeInteger(service_id) && service_id > 0))) throw requestError("service_id must identify exactly one service");
      resolvedServiceId = String(service_id);
      const result = await query(`SELECT ${serviceFields} FROM services WHERE id=$1 AND is_active=TRUE`, [resolvedServiceId]);
      serviceRow = result.rows[0] || null;
      if (!serviceRow) throw requestError("The selected service is unavailable. Please choose another service.");
    } else if (service) {
      let result = null;
      if (/^\d+$/.test(service)) result = await query(`SELECT ${serviceFields} FROM services WHERE id=$1 AND is_active=TRUE`, [service]);
      if (!result?.rowCount) result = await query(`SELECT ${serviceFields} FROM services WHERE slug=$1 AND is_active=TRUE LIMIT 1`, [service]);
      if (!result.rowCount) result = await query(`SELECT ${serviceFields} FROM services WHERE name=$1 AND is_active=TRUE ORDER BY id LIMIT 2`, [service]);
      if (result.rowCount > 1) throw requestError("That service name is ambiguous. Please select the service from the list.");
      serviceRow = result.rows[0] || null;
      if (!serviceRow) throw requestError("The selected service is unavailable. Please choose another service.");
      resolvedServiceId = String(serviceRow.id);
    }
    if (existingRequest) {
      if (String(existingRequest.service_id ?? "") !== String(resolvedServiceId ?? "")) return res.status(409).json({error:"This request key was already used for a different service. Please resubmit your selection."});
      return res.status(200).json({success:true,duplicate:true,lead_reference:existingRequest.lead_reference,whatsapp:{status:existingRequest.whatsapp_notification_status}});
    }
    const pricing = serviceRow ? withSalePricing(serviceRow) : null;
    const pendingReference = `TMP-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await client.query("BEGIN");
    const inserted = await client.query(`
      INSERT INTO leads (name,email,phone,company_name,service_id,message,source,status,lead_reference,request_key,country_code,local_phone,service_name_snapshot,original_price_snapshot,sale_price_snapshot,currency_snapshot,consent_at,whatsapp_notification_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'new',$8,$9,$10,$11,$12,$13,$14,$15,NOW(),'pending')
      ON CONFLICT (request_key) WHERE request_key IS NOT NULL DO NOTHING
      RETURNING id
    `, [name,email,phone,companyName,resolvedServiceId,message,source,pendingReference,requestKey,phoneInfo?.countryCode || null,phoneInfo?.localPhone || null,serviceRow?.name || service || null,pricing?.original_price ?? null,pricing?.sale_price ?? null,serviceRow?.currency || null]);
    if (!inserted.rowCount) {
      await client.query("ROLLBACK");
      const duplicate = await query("SELECT service_id,lead_reference,whatsapp_notification_status FROM leads WHERE request_key=$1", [requestKey]);
      if (String(duplicate.rows[0]?.service_id ?? "") !== String(resolvedServiceId ?? "")) return res.status(409).json({error:"This request key was already used for a different service. Please resubmit your selection."});
      return res.status(200).json({ success: true, duplicate: true, lead_reference: duplicate.rows[0]?.lead_reference, whatsapp: { status: duplicate.rows[0]?.whatsapp_notification_status } });
    }
    const leadId = inserted.rows[0].id;
    const reference = leadReference(leadId);
    savedReference = reference;
    await client.query("UPDATE leads SET lead_reference=$1 WHERE id=$2", [reference, leadId]);
    await client.query("INSERT INTO admin_lead_notifications(lead_id) VALUES($1) ON CONFLICT (lead_id) DO NOTHING", [leadId]);
    for (const file of attachments) {
      const storageKey = `${crypto.randomUUID()}.${file.extension}`;
      await fs.mkdir(MEDIA_DIR, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(MEDIA_DIR, storageKey), file.bytes, { flag: "wx", mode: 0o600 });
      createdFiles.push(storageKey);
      await client.query("INSERT INTO lead_attachments (lead_id,storage_key,original_name,mime_type,file_size) VALUES ($1,$2,$3,$4,$5)", [leadId,storageKey,file.originalName,file.mimeType,file.bytes.length]);
    }
    let notificationJob = null;
    const businessSettings = await getWhatsAppSettings(client);
    const notificationType = resolvedServiceId ? "service_inquiry" : "lead";
    const businessRecipient = await getBusinessRecipient(businessSettings, client);
    notificationJob = await enqueueWhatsAppJob(client, { leadId, type: notificationType, recipient: businessRecipient });
    if (businessSettings.notify_attachments) {
      const savedAttachments = await client.query("SELECT id FROM lead_attachments WHERE lead_id=$1 ORDER BY id", [leadId]);
      for (const attachment of savedAttachments.rows) await enqueueWhatsAppJob(client, { leadId, attachmentId: attachment.id, type: "attachment", recipient: businessRecipient });
    }
    if (businessSettings.customer_confirmation && phoneInfo?.phone) {
      await enqueueWhatsAppJob(client, { leadId, type: "customer_confirmation", recipient: phoneInfo.phone.replace(/\D/g, "") });
    }
    await client.query("COMMIT");
    committed = true;

    triggerWhatsAppQueue();
    const manualRecipient = businessRecipient;
    const manualText = `New Prime Web Agency enquiry ${reference}\nName: ${name}\nService: ${serviceRow?.name || "General enquiry"}\nMessage: ${message.slice(0,1200)}`;
    const manualUrl = manualRecipient ? `https://wa.me/${manualRecipient}?text=${encodeURIComponent(manualText)}` : null;
    const queueStatus = notificationJob?.status || "scheduled";
    return res.status(201).json({ success: true, lead_reference: reference, save_status: "saved", whatsapp: { status: queueStatus, message: queueStatus === "pending" ? "Request saved. WhatsApp notification is queued." : queueStatus === "scheduled" ? "Request saved. WhatsApp notification is scheduled." : "Request saved. Check Admin Panel WhatsApp configuration.", manual_url: manualUrl, recipient_configured: Boolean(manualRecipient) } });
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK").catch(() => {});
      await Promise.all(createdFiles.map((key) => fs.unlink(path.join(MEDIA_DIR, key)).catch(() => {})));
    }
    if (committed) {
      console.error("POST-COMMIT LEAD PROCESSING ERROR:", error.code || "request failed");
      return res.status(201).json({ success: true, lead_reference: savedReference, whatsapp: { status: "failed", message: "Request saved, but post-submission processing failed." } });
    }
    if (error.statusCode === 400) return res.status(400).json({ error: error.message });
    console.error("LEAD ERROR:", error.code || "request failed");
    res.status(500).json({ error: "Unable to submit lead" });
  } finally {
    client.release();
  }
});

/* =========================================================
   CUSTOMER PROJECTS
========================================================= */

app.get(
  "/api/customer/projects",
  authRequired,
  rolesRequired("customer", "admin"),
  async (req, res) => {
    try {
      const result = await query(`
        SELECT p.*,s.name AS service_name,
          'PWA-PRJ-'||LPAD(p.id::text,6,'0') AS project_reference,
          (SELECT COUNT(*)::int FROM project_notifications n WHERE n.project_id=p.id AND n.user_id=$1 AND n.read_at IS NULL) AS unread_updates,
          (SELECT a.title FROM project_activity a WHERE a.project_id=p.id ORDER BY a.created_at DESC,a.id DESC LIMIT 1) AS latest_update,
          (SELECT a.created_at FROM project_activity a WHERE a.project_id=p.id ORDER BY a.created_at DESC,a.id DESC LIMIT 1) AS latest_update_at
        FROM projects p LEFT JOIN services s ON s.id=p.service_id
        WHERE ($2='admin' OR p.user_id=$1)
        ORDER BY p.created_at DESC`, [req.user.id, req.user.role]);
      res.json({
        projects: result.rows,
        unread_count: result.rows.reduce((count,project)=>count+Number(project.unread_updates||0),0),
      });
    } catch (error) {
      console.error("LOAD PROJECTS ERROR:", error.code || "query failed");
      res.status(500).json({ error: "Unable to load projects" });
    }
  }
);

app.post(
  "/api/customer/projects",
  authRequired,
  rolesRequired("customer", "admin"),
  async (req, res) => {
    try {
      const { name,business_name,project_type,service_id,budget,deadline,description,requirements } = req.body || {};

      if (typeof name !== "string" || !name.trim() || name.trim().length > 200) {
        return res.status(400).json({
          error: "Project name is required and must be at most 200 characters",
        });
      }

      for (const [field, value, max] of [["business_name", business_name, 200], ["project_type", project_type, 120], ["description", description, 10000]]) {
        if (value !== undefined && value !== null && (typeof value !== "string" || value.length > max)) {
          return res.status(400).json({ error: `${field} must be text up to ${max} characters` });
        }
      }
      if (requirements !== undefined && requirements !== null && typeof requirements !== "string" && (typeof requirements !== "object" || Array.isArray(requirements))) return res.status(400).json({ error: "requirements must be text or an object" });
      if (typeof requirements === "string" && requirements.length > 10000) return res.status(400).json({ error: "requirements must be at most 10000 characters" });
      if (budget !== undefined && budget !== null && budget !== "" && (!Number.isFinite(Number(budget)) || Number(budget) < 0)) {
        return res.status(400).json({ error: "budget must be a non-negative number" });
      }
      if (req.body.priority !== undefined && !["normal", "high", "urgent"].includes(req.body.priority)) {
        return res.status(400).json({ error: "priority must be normal, high, or urgent" });
      }
      if (deadline !== undefined && deadline !== null && deadline !== "" && !validDateOnly(deadline)) {
        return res.status(400).json({ error: "deadline must be a valid YYYY-MM-DD date" });
      }

      const requestedCustomer = req.body.customer_id;
      if (requestedCustomer && !isBigIntId(String(requestedCustomer))) {
        return res.status(400).json({ error: "customer_id must be a numeric users.id" });
      }
      const customerId = req.user.role === "customer"
        ? req.user.id
        : (isBigIntId(String(requestedCustomer || "")) ? requestedCustomer : req.user.id);
      if (req.user.role === "admin" && requestedCustomer) {
        const customer = await query("SELECT id FROM users WHERE id = $1 AND role = 'customer' AND is_active = TRUE", [customerId]);
        if (!customer.rowCount) return res.status(400).json({ error: "customer_id must identify an active customer account" });
      }
      if (req.user.role === "customer" && requestedCustomer && String(requestedCustomer) !== String(req.user.id)) return res.status(403).json({ error: "Customers can only create projects for their own account" });
      if (service_id !== undefined && service_id !== null && service_id !== "" && !isBigIntId(String(service_id))) return res.status(400).json({ error: "service_id must be a numeric database ID" });
      if (service_id) { const service=await query("SELECT id,name FROM services WHERE id=$1 AND is_active=TRUE",[service_id]); if(!service.rowCount)return res.status(400).json({error:"The selected service is unavailable"}); }
      const requestKey=req.body.request_key||null;
      if(requestKey&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey))return res.status(400).json({error:"request_key must be a valid request identifier"});
      const userInfo=await query("SELECT phone,role FROM users WHERE id=$1 AND is_active=TRUE",[customerId]);
      if(!userInfo.rowCount)return res.status(400).json({error:"An active customer account is required"});
      if(req.user.role==="customer"&&userInfo.rows[0].role!=="customer")return res.status(403).json({error:"An active customer account is required"});
      const contactPhone=boundedString(req.body.phone||userInfo.rows[0].phone||"","phone",30,{required:req.user.role==="customer"});
      if(contactPhone&&!/^[+()\d .-]{7,30}$/.test(contactPhone))return res.status(400).json({error:"A valid contact phone number is required"});
      if(requestKey){const previous=await query("SELECT id,user_id,service_id FROM projects WHERE request_key=$1",[requestKey]);if(previous.rowCount){if(String(previous.rows[0].user_id)!==String(customerId)||String(previous.rows[0].service_id||"")!==String(service_id||""))return res.status(409).json({error:"This request key was already used for a different project"});return res.status(200).json({success:true,duplicate:true,project:previous.rows[0],project_reference:projectReference(previous.rows[0].id)});}}

      const projectClient = await pool.connect();
      let result;
      let projectJob;
      try {
        await projectClient.query("BEGIN");
        result = await projectClient.query("INSERT INTO projects (user_id,title,project_type,service_id,budget,deadline,description,requirements,request_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::uuid) ON CONFLICT (request_key) WHERE request_key IS NOT NULL DO NOTHING RETURNING *",[customerId,name.trim(),project_type || null,service_id||null,budget === "" || budget === undefined ? null : budget,deadline === "" || deadline === undefined ? null : deadline,description?.trim() || null,JSON.stringify({ ...(typeof requirements === "string" && requirements.trim() ? { summary: requirements.trim() } : (requirements && typeof requirements === "object" ? requirements : {})), ...(business_name ? { business_name } : {}), ...(contactPhone ? { contact_phone: contactPhone } : {}), ...(req.body.priority ? { priority: req.body.priority } : {}) }),requestKey]);
        if(!result.rowCount){const duplicate=await projectClient.query("SELECT * FROM projects WHERE request_key=$1",[requestKey]);if(!duplicate.rowCount)throw new Error("Project request conflict could not be resolved");await projectClient.query("COMMIT");return res.status(200).json({success:true,duplicate:true,project:duplicate.rows[0],project_reference:projectReference(duplicate.rows[0].id)});}
        const created=result.rows[0];
        const activity=await projectClient.query("INSERT INTO project_activity(project_id,actor_id,event_type,title,note,new_status,new_progress,idempotency_key) VALUES($1,$2,'request_received','Project request received',$3,'pending',0,$4::uuid) RETURNING id",[created.id,req.user.id,"Your request has been received and is awaiting review.",requestKey]);
        await projectClient.query("INSERT INTO project_notifications(project_id,activity_id,user_id) SELECT $1,$2,id FROM users WHERE role='admin' AND is_active=TRUE ON CONFLICT(activity_id,user_id) DO NOTHING",[created.id,activity.rows[0].id]);
        const projectSettings = await getWhatsAppSettings(projectClient);
        projectJob = await enqueueWhatsAppJob(projectClient,{projectId:created.id,type:"project_request",recipient:await getBusinessRecipient(projectSettings,projectClient)});
        await projectClient.query("COMMIT");
      } catch (projectError) { await projectClient.query("ROLLBACK").catch(()=>{}); throw projectError; } finally { projectClient.release(); }
      triggerWhatsAppQueue();
      res.status(201).json({ success:true, project:result.rows[0], project_reference:projectReference(result.rows[0].id), notification_status:projectJob?.status||"scheduled" });
    } catch (error) {
      if(error.statusCode===400)return res.status(400).json({error:error.message});
      console.error("CREATE PROJECT ERROR:", error.code || "request failed");
      res.status(500).json({ error: "Unable to create project" });
    }
  }
);

app.get(
  "/api/customer/projects/:id",
  authRequired,
  rolesRequired("customer", "admin"),
  async (req, res) => {
    try {
      const projectId = req.params.id;
      if (!isBigIntId(projectId)) return res.status(400).json({ error: "Project ID must be numeric" });

      const result = await query(
        `
        SELECT
          p.*,
          'PWA-PRJ-'||LPAD(p.id::text,6,'0') AS project_reference,
          s.name AS service_name
        FROM projects p
        LEFT JOIN services s
          ON s.id = p.service_id
        WHERE p.id = $1
          AND ($2 = 'admin' OR p.user_id = $3)
        `,
        [projectId, req.user.role, req.user.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Project not found",
        });
      }

      const project = result.rows[0];

      const messages = await query(
        `
        SELECT
          pm.*,
          u.name AS sender_name
        FROM project_messages pm
        LEFT JOIN users u
          ON u.id = pm.sender_id
        WHERE pm.project_id = $1
        ORDER BY pm.created_at ASC
        `,
        [projectId]
      );

      const [activity,milestones,files]=await Promise.all([
        query("SELECT id,event_type,title,note,old_status,new_status,old_progress,new_progress,created_at FROM project_activity WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100",[projectId]),
        query("SELECT id,title,status,target_date,completed_at,sort_order FROM project_milestones WHERE project_id=$1 ORDER BY sort_order,id",[projectId]),
        query("SELECT id,original_name,mime_type,file_size,is_customer_visible,created_at FROM project_files WHERE project_id=$1 AND ($2='admin' OR is_customer_visible=TRUE) ORDER BY created_at DESC,id DESC",[projectId,req.user.role]),
      ]);

      res.json({
        project,
        messages: messages.rows,
        activity: activity.rows,
        milestones: milestones.rows,
        files: files.rows,
      });
    } catch (error) {
      logOperationalError("APPLICATION ERROR:", error);

      res.status(500).json({
        error: "Unable to load project",
      });
    }
  }
);

app.post("/api/customer/projects/:id/read",authRequired,rolesRequired("customer"),async(req,res)=>{
  try{if(!isBigIntId(req.params.id))return res.status(400).json({error:"Project ID must be numeric"});const result=await query("UPDATE project_notifications n SET read_at=COALESCE(n.read_at,NOW()) WHERE n.project_id=$1 AND n.user_id=$2 AND n.read_at IS NULL AND EXISTS(SELECT 1 FROM projects p WHERE p.id=n.project_id AND p.user_id=$2) RETURNING n.id",[req.params.id,req.user.id]);res.json({success:true,marked_read:result.rowCount});}
  catch(error){console.error("READ CUSTOMER PROJECT UPDATES ERROR:",error.code||"update failed");res.status(500).json({error:"Unable to update project notifications"});}
});

app.post("/api/admin/projects/:id/read",authRequired,rolesRequired("admin"),async(req,res)=>{
  try{if(!isBigIntId(req.params.id))return res.status(400).json({error:"Project ID must be numeric"});const result=await query("UPDATE project_notifications SET read_at=COALESCE(read_at,NOW()) WHERE project_id=$1 AND user_id=$2 AND read_at IS NULL RETURNING id",[req.params.id,req.user.id]);res.json({success:true,marked_read:result.rowCount});}
  catch(error){console.error("READ ADMIN PROJECT UPDATES ERROR:",error.code||"update failed");res.status(500).json({error:"Unable to update project notifications"});}
});

app.post("/api/admin/projects/:id/files",authRequired,rolesRequired("admin"),async(req,res)=>{
  let storageKey=null;
  try{
    if(!isBigIntId(req.params.id))return res.status(400).json({error:"Project ID must be numeric"});
    const project=await query("SELECT id FROM projects WHERE id=$1",[req.params.id]);if(!project.rowCount)return res.status(404).json({error:"Project not found"});
    const dataUrl=req.body?.data_url,name=safeOriginalFilename(req.body?.name||"project-file");
    if(typeof dataUrl!=="string")return res.status(400).json({error:"Choose a project image or PDF file"});
    const match=dataUrl.match(/^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/);if(!match)return res.status(400).json({error:"Only JPG, PNG, WebP, and PDF files are supported"});
    const mime=match[1],bytes=Buffer.from(match[2],"base64");if(!bytes.length||bytes.length>8*1024*1024)return res.status(400).json({error:"Project files must be no larger than 8 MiB"});
    if(mime.startsWith("image/")&&detectImageMime(bytes)!==mime)return res.status(400).json({error:"File content does not match its image type"});
    if(mime==="application/pdf"&&bytes.subarray(0,5).toString("ascii")!=="%PDF-")return res.status(400).json({error:"File is not a valid PDF"});
    const extension={"image/jpeg":"jpg","image/png":"png","image/webp":"webp","application/pdf":"pdf"}[mime];storageKey=`${crypto.randomUUID()}.${extension}`;
    await fs.mkdir(MEDIA_DIR,{recursive:true,mode:0o700});await fs.writeFile(path.join(MEDIA_DIR,storageKey),bytes,{flag:"wx",mode:0o600});
     const client=await pool.connect();
     try{
       await client.query("BEGIN");
       const saved=await client.query("INSERT INTO project_files(project_id,uploaded_by,original_name,storage_key,mime_type,file_size,is_customer_visible) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,original_name,mime_type,file_size,is_customer_visible,created_at",[req.params.id,req.user.id,name,storageKey,mime,bytes.length,req.body.is_customer_visible===true]);
       if(req.body.is_customer_visible===true){
         const activity=await client.query("INSERT INTO project_activity(project_id,actor_id,event_type,title,note) VALUES($1,$2,'file_shared','Project file shared',$3) RETURNING id",[req.params.id,req.user.id,`A project file was shared: ${name}`]);
         await client.query("INSERT INTO project_notifications(project_id,activity_id,user_id) SELECT $1,$2,user_id FROM projects WHERE id=$1 AND user_id IS NOT NULL ON CONFLICT(activity_id,user_id) DO NOTHING",[req.params.id,activity.rows[0].id]);
       }
       await client.query("COMMIT");
       res.status(201).json({file:saved.rows[0]});
     }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}
  }catch(error){if(storageKey)await fs.unlink(path.join(MEDIA_DIR,storageKey)).catch(()=>{});if(error.statusCode===400)return res.status(400).json({error:error.message});console.error("PROJECT FILE UPLOAD ERROR:",error.code||"upload failed");res.status(500).json({error:"Unable to upload the project file"});}
});

app.get("/api/customer/projects/:id/files/:fileId",authRequired,rolesRequired("customer","admin"),async(req,res)=>{
  try{
    if(!isBigIntId(req.params.id)||!isBigIntId(req.params.fileId))return res.status(400).end();
    const found=await query("SELECT f.storage_key,f.mime_type,f.original_name FROM project_files f JOIN projects p ON p.id=f.project_id WHERE f.id=$1 AND f.project_id=$2 AND ($3='admin' OR (p.user_id=$4 AND f.is_customer_visible=TRUE))",[req.params.fileId,req.params.id,req.user.role,req.user.id]);
    if(!found.rowCount)return res.status(404).end();const file=found.rows[0];if(!/^[a-f0-9-]{36}\.(jpg|png|webp|pdf)$/.test(file.storage_key))return res.status(404).end();
    const bytes=await fs.readFile(path.join(MEDIA_DIR,file.storage_key));if(file.mime_type.startsWith("image/")&&detectImageMime(bytes)!==file.mime_type)return res.status(404).end();if(file.mime_type==="application/pdf"&&bytes.subarray(0,5).toString("ascii")!=="%PDF-")return res.status(404).end();
    res.set({"X-Content-Type-Options":"nosniff","Cache-Control":"private,no-store","Content-Disposition":`inline; filename="${safeOriginalFilename(file.original_name).replace(/["\\]/g,"_")}"`});res.type(file.mime_type).send(bytes);
  }catch(error){if(error.code!=="ENOENT")console.error("PROJECT FILE ACCESS ERROR:",error.code||"read failed");res.status(error.code==="ENOENT"?404:500).end();}
});

/* =========================================================
   ADMIN DASHBOARD
========================================================= */

app.get(
  "/api/admin/dashboard",
  authRequired,
  rolesRequired("admin"),
  async (req, res) => {
    try {
      const [
        visitors,
        todayVisitors,
        pageViews,
        leads,
        whatsappClicks,
        customers,
        projects,
        services,
        gallery,
        recentProjects,
        recentLeads,
        analytics,
      ] = await Promise.all([
        query(`
          SELECT COUNT(DISTINCT COALESCE(NULLIF(session_id, ''), NULLIF(visitor_id, '')))::int AS count
          FROM analytics_events
          WHERE NULLIF(session_id, '') IS NOT NULL OR NULLIF(visitor_id, '') IS NOT NULL
        `),

        query(`
          SELECT COUNT(DISTINCT COALESCE(NULLIF(session_id, ''), NULLIF(visitor_id, '')))::int AS count
          FROM analytics_events
          WHERE (NULLIF(session_id, '') IS NOT NULL OR NULLIF(visitor_id, '') IS NOT NULL)
          AND created_at >= CURRENT_DATE
        `),

        query(`
          SELECT COUNT(*)::int AS count
          FROM analytics_events
          WHERE event_type = 'page_view'
        `),

        query(`
          SELECT COUNT(*)::int AS count
          FROM leads
        `),

        query(`
          SELECT COUNT(*)::int AS count
          FROM analytics_events
          WHERE event_type = 'whatsapp_click'
        `),

        query(`
          SELECT COUNT(*)::int AS count
          FROM users
          WHERE role = 'customer'
        `),

        query(`
          SELECT COUNT(*)::int AS count
          FROM projects
        `),
        query(`SELECT COUNT(*)::int AS count FROM services`),
        query(`SELECT COUNT(*)::int AS count FROM gallery_images`),
        query(`
          SELECT p.id, p.title, p.status, p.created_at, u.name AS customer_name, s.name AS service_name
          FROM projects p
          LEFT JOIN users u ON u.id = p.user_id
          LEFT JOIN services s ON s.id = p.service_id
          ORDER BY p.created_at DESC LIMIT 6
        `),
        query(`
          SELECT l.id, l.name, l.email, l.status, l.created_at, s.name AS service_name
          FROM leads l LEFT JOIN services s ON s.id = l.service_id
          ORDER BY l.created_at DESC LIMIT 6
        `),
        query(`
          SELECT created_at::date AS date, COUNT(*)::int AS events,
            COUNT(DISTINCT COALESCE(NULLIF(session_id, ''), NULLIF(visitor_id, '')))::int AS visitors
          FROM analytics_events
          WHERE created_at >= CURRENT_DATE - INTERVAL '13 days'
          GROUP BY created_at::date ORDER BY date ASC
        `),
      ]);

      res.json({
        visitors: visitors.rows[0].count,
        today_visitors: todayVisitors.rows[0].count,
        page_views: pageViews.rows[0].count,
        leads: leads.rows[0].count,
        whatsapp_clicks: whatsappClicks.rows[0].count,
        customers: customers.rows[0].count,
        projects: projects.rows[0].count,
        services: services.rows[0].count,
        gallery_images: gallery.rows[0].count,
        recent_projects: recentProjects.rows,
        recent_leads: recentLeads.rows,
        analytics: analytics.rows,
      });
    } catch (error) {
      logOperationalError("DASHBOARD ERROR:", error);

      res.status(500).json({
        error: "Unable to load dashboard",
      });
    }
  }
);

/* =========================================================
   ADMIN ANALYTICS
========================================================= */

app.get(
  "/api/admin/analytics",
  authRequired,
  rolesRequired("admin"),
  async (req, res) => {
    try {
      const daily = await query(`
        SELECT
          created_at::date AS date,
          COUNT(*)::int AS events,
          COUNT(DISTINCT COALESCE(NULLIF(session_id, ''), NULLIF(visitor_id, '')))::int AS visitors
        FROM analytics_events
        WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY created_at::date
        ORDER BY date ASC
      `);

      const events = await query(`
        SELECT
          event_type AS event_name,
          COUNT(*)::int AS count
        FROM analytics_events
        GROUP BY event_type
        ORDER BY count DESC
      `);

      res.json({
        daily: daily.rows,
        events: events.rows,
      });
    } catch (error) {
      logOperationalError("APPLICATION ERROR:", error);

      res.status(500).json({
        error: "Unable to load analytics",
      });
    }
  }
);

/* =========================================================
   ADMIN BRAND
========================================================= */

app.get(
  "/api/admin/brand",
  authRequired,
  rolesRequired("admin"),
  async (req, res) => {
    try {
      const result = await query(
        `
        SELECT *
        FROM brand_settings
        ORDER BY id ASC
        LIMIT 1
        `
      );

      res.json({
        brand: normalizeBrand(result.rows[0] || null),
      });
    } catch (error) {
      logOperationalError("APPLICATION ERROR:", error);

      res.status(500).json({
        error: "Unable to load brand",
      });
    }
  }
);

app.put(
  "/api/admin/brand",
  authRequired,
  rolesRequired("admin"),
  async (req, res) => {
    try {
      const body = req.body || {};
      const found = await query("SELECT * FROM brand_settings ORDER BY id ASC LIMIT 1");
      const current = found.rows[0] || {};
      const old = current.settings || {};
      const companyName = boundedString(body.company_name ?? current.company_name ?? "Prime Web Agency", "company_name", 200, { required: true });
      const tagline = boundedString(body.tagline ?? current.tagline ?? "", "tagline", 500);
      const domain = boundedString(body.website_url ?? body.domain_name ?? current.domain_name ?? "", "domain_name", 255);
      const email = boundedString(body.email ?? current.email ?? "", "email", 255);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw requestError("email must be a valid email address");
      const phone = boundedString(body.phone ?? current.phone ?? "", "phone", 30);
      const whatsapp = boundedString(body.whatsapp ?? current.whatsapp_number ?? "", "whatsapp", 30);
      const logo = body.logo_url === undefined ? current.logo_url : imageUrl(body.logo_url, "logo_url");
      const favicon = body.favicon_url === undefined ? current.favicon_url : imageUrl(body.favicon_url, "favicon_url");
      const address = boundedString(body.address ?? current.address ?? "", "address", 2000);
      const currency = boundedString(body.currency ?? current.currency ?? "INR", "currency", 10, { required: true }).toUpperCase();
      const settingTextFields = ["short_name", "primary_color", "secondary_color", "description", "hero_title", "hero_description", "hero_image_url", "about_title", "about_description", "footer_text", "seo_title", "seo_description", "seo_image"];
      const settingsPatch = {};
      for (const key of settingTextFields) {
        if (body[key] !== undefined) {
          const max = ["hero_description", "about_description", "footer_text", "seo_description", "description"].includes(key) ? 5000 : 1000;
          settingsPatch[key] = boundedString(body[key], key, max);
        }
      }
      if (body.brand_logos !== undefined) {
        if (!body.brand_logos || typeof body.brand_logos !== "object" || Array.isArray(body.brand_logos)) throw requestError("brand_logos must be an object");
        const logos = {};
        for (const key of ["website", "admin", "customer"]) logos[key] = imageUrl(body.brand_logos[key], `brand_logos.${key}`);
        logos.alt_text = boundedString(body.brand_logos.alt_text, "logo_alt_text", 300);
        settingsPatch.brand_logos = { ...(old.brand_logos || {}), ...logos };
      }
      for (const key of ["primary_color", "secondary_color"]) {
        if (settingsPatch[key] !== undefined && settingsPatch[key] !== null && !/^#[\da-fA-F]{6}$/.test(settingsPatch[key])) {
          throw requestError(`${key} must be a six-digit HEX color`);
        }
      }
      if (body.hero_image_url !== undefined) settingsPatch.hero_image_url = imageUrl(body.hero_image_url, "hero_image_url");
      if (body.seo_image !== undefined) settingsPatch.seo_image = imageUrl(body.seo_image, "seo_image");
      if (body.social_links !== undefined) {
        if (!body.social_links || typeof body.social_links !== "object" || Array.isArray(body.social_links)) throw requestError("social_links must be an object");
        const links = {};
        for (const key of ["instagram", "facebook", "linkedin", "youtube"]) {
          const value = body.social_links[key];
          if (value) {
            try { const parsed = new URL(value); if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(); links[key] = parsed.toString(); }
            catch { throw requestError(`${key} must be an HTTP(S) URL`); }
          }
        }
        settingsPatch.social_links = links;
      }
      if (body.section_visibility !== undefined) {
        if (!body.section_visibility || typeof body.section_visibility !== "object" || Array.isArray(body.section_visibility) || Object.values(body.section_visibility).some((value) => typeof value !== "boolean")) throw requestError("section_visibility must map section names to booleans");
        settingsPatch.section_visibility = body.section_visibility;
      }
      if (body.section_order !== undefined) {
        const sections = ["services", "automation", "about", "portfolio", "gallery", "process", "contact"];
        if (!Array.isArray(body.section_order) || body.section_order.some((section) => !sections.includes(section))) throw requestError("section_order contains an unsupported section");
        settingsPatch.section_order = body.section_order;
      }
      if (body.theme_default !== undefined) {
        if (!["system", "light", "dark"].includes(body.theme_default)) throw requestError("theme_default must be system, light, or dark");
        settingsPatch.theme_default = body.theme_default;
      }
      const settings = { ...old, ...settingsPatch };
      const values = [companyName, tagline || null, domain || null, phone || null, whatsapp || null, email || null, logo, favicon, address || null, currency, JSON.stringify(settings)];
      const result = current.id
        ? await query(`UPDATE brand_settings SET company_name=$1,tagline=$2,domain_name=$3,phone=$4,whatsapp_number=$5,email=$6,logo_url=$7,favicon_url=$8,address=$9,currency=$10,settings=$11::jsonb,updated_at=NOW() WHERE id=$12 RETURNING *`, [...values, current.id])
        : await query(`INSERT INTO brand_settings (company_name,tagline,domain_name,phone,whatsapp_number,email,logo_url,favicon_url,address,currency,settings) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING *`, values);

      res.json({
        success: true,
        brand: normalizeBrand(result.rows[0]),
      });
    } catch (error) {
      logOperationalError("BRAND UPDATE ERROR:", error);

      res.status(error.statusCode || 500).json({
        error: error.statusCode ? error.message : "Unable to update brand",
      });
    }
  }
);

app.get("/api/admin/theme", authRequired, rolesRequired("admin"), async (req, res) => {
  try {
    const found = await query("SELECT settings FROM brand_settings ORDER BY id LIMIT 1");
    const settings = found.rows[0]?.settings || {};
    res.json({ draft: validatePublicTheme(settings.theme_draft || settings.theme_published || DEFAULT_PUBLIC_THEME), published: validatePublicTheme(settings.theme_published || DEFAULT_PUBLIC_THEME) });
  } catch (error) {
    console.error("ADMIN THEME LOAD ERROR:", error.code || "query failed");
    res.status(500).json({ error: "Unable to load website theme" });
  }
});
app.put("/api/admin/theme/draft", authRequired, rolesRequired("admin"), async (req, res) => {
  try {
    const theme = validatePublicTheme(req.body?.theme);
    const found = await query("SELECT id,settings FROM brand_settings ORDER BY id LIMIT 1");
    if (!found.rowCount) return res.status(409).json({ error: "Save website brand settings before configuring the theme" });
    const result = await query("UPDATE brand_settings SET settings=settings || $1::jsonb,updated_at=NOW() WHERE id=$2 RETURNING settings", [JSON.stringify({ theme_draft: theme }), found.rows[0].id]);
    res.json({ success: true, draft: result.rows[0].settings.theme_draft });
  } catch (error) {
    if (error.statusCode === 400) return res.status(400).json({ error: error.message });
    console.error("ADMIN THEME DRAFT ERROR:", error.code || "update failed"); res.status(500).json({ error: "Unable to save theme draft" });
  }
});
app.post("/api/admin/theme/publish", authRequired, rolesRequired("admin"), async (req, res) => {
  try {
    const found = await query("SELECT id,settings FROM brand_settings ORDER BY id LIMIT 1");
    if (!found.rowCount) return res.status(409).json({ error: "Save website brand settings before publishing the theme" });
    const draft = validatePublicTheme(found.rows[0].settings?.theme_draft || DEFAULT_PUBLIC_THEME);
    await query("UPDATE brand_settings SET settings=settings || $1::jsonb,updated_at=NOW() WHERE id=$2", [JSON.stringify({ theme_published: draft }), found.rows[0].id]);
    res.json({ success: true, published: draft });
  } catch (error) {
    if (error.statusCode === 400) return res.status(400).json({ error: error.message });
    console.error("ADMIN THEME PUBLISH ERROR:", error.code || "update failed"); res.status(500).json({ error: "Unable to publish theme" });
  }
});
app.post("/api/admin/theme/reset", authRequired, rolesRequired("admin"), async (req, res) => {
  try {
    const found = await query("SELECT id FROM brand_settings ORDER BY id LIMIT 1");
    if (!found.rowCount) return res.status(409).json({ error: "Save website brand settings before resetting the theme" });
    await query("UPDATE brand_settings SET settings=settings || $1::jsonb,updated_at=NOW() WHERE id=$2", [JSON.stringify({ theme_draft: DEFAULT_PUBLIC_THEME }), found.rows[0].id]);
    res.json({ success: true, draft: DEFAULT_PUBLIC_THEME });
  } catch (error) { console.error("ADMIN THEME RESET ERROR:", error.code || "update failed"); res.status(500).json({ error: "Unable to reset theme draft" }); }
});

app.post("/api/admin/brand/logo", authRequired, rolesRequired("admin"), async (req, res) => {
  let storageKey;
  let client;
  let committed = false;
  try {
    const logoSlot = req.body?.slot || "primary";
    if (!["primary", "website", "admin", "customer", "favicon"].includes(logoSlot)) throw requestError("Choose a supported logo placement");
    const match = typeof req.body?.data_url === "string" && req.body.data_url.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || match[2].length > 6990508) throw requestError("Choose a valid PNG, JPG, or WebP logo no larger than 5 MB");
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > 5 * 1024 * 1024 || bytes.toString("base64") !== match[2]) throw requestError("Logo must be no larger than 5 MB");
    const actualMime = detectImageMime(bytes);
    if (actualMime !== match[1] || actualMime === "image/gif") throw requestError("Logo image content does not match its PNG, JPG, or WebP type");
    const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[actualMime];
    storageKey = `${crypto.randomUUID()}.${extension}`;
    await fs.mkdir(MEDIA_DIR, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(MEDIA_DIR, storageKey), bytes, { flag: "wx", mode: 0o600 });
    client = await pool.connect();
    await client.query("BEGIN");
    const brand = (await client.query("SELECT id FROM brand_settings ORDER BY id LIMIT 1 FOR UPDATE")).rows[0];
    if (!brand) throw new Error("Brand settings have not been initialized");
    await client.query("INSERT INTO gallery_images (title,alt_text,category,storage_key,mime_type,file_size,is_published) VALUES ('Website logo','Prime Web Agency logo','Brand identity',$1,$2,$3,FALSE)", [storageKey,actualMime,bytes.length]);
    const imageUrl = `/media/${storageKey}`;
    if (logoSlot === "primary") await client.query("UPDATE brand_settings SET logo_url=$1,updated_at=NOW() WHERE id=$2", [imageUrl,brand.id]);
    else if (logoSlot === "favicon") await client.query("UPDATE brand_settings SET favicon_url=$1,updated_at=NOW() WHERE id=$2", [imageUrl,brand.id]);
    else await client.query("UPDATE brand_settings SET settings=settings || $1::jsonb,updated_at=NOW() WHERE id=$2", [JSON.stringify({ brand_logos: { ...(brand.settings?.brand_logos || {}), [logoSlot]: imageUrl } }),brand.id]);
    await client.query("COMMIT");
    committed = true;
    res.status(201).json({ success: true, logo_url: imageUrl, slot: logoSlot });
  } catch (error) {
    if (client && !committed) await client.query("ROLLBACK").catch(() => {});
    if (storageKey && !committed) await fs.unlink(path.join(MEDIA_DIR, storageKey)).catch(() => {});
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Unable to upload logo" });
  } finally {
    client?.release();
  }
});

const whatsappTestSendBuckets = new Map();
function takeWhatsAppTestLimit(req,res,next) {
  const key=String(req.user?.id||req.ip||"unknown"); const until=whatsappTestSendBuckets.get(key)||0;
  if(until>Date.now()) return res.status(429).json({error:"Wait before sending another WhatsApp test message."});
  whatsappTestSendBuckets.set(key,Date.now()+60000); next();
}
function serializeWhatsAppSettings(s,recipient,credentials) {
  return {enabled:s.enabled,notify_new_leads:s.notify_new_leads,notify_service_inquiries:s.notify_service_inquiries,notify_project_requests:s.notify_project_requests,notify_attachments:s.notify_attachments,customer_confirmation:s.customer_confirmation,schedule_enabled:s.schedule_enabled,allowed_days:s.allowed_days.map(Number),start_time:String(s.start_time).slice(0,5),end_time:String(s.end_time).slice(0,5),timezone:s.timezone,recipient_phone:s.recipient_phone,effective_recipient:recipient,notification_template_name:s.notification_template_name,notification_template_language:s.notification_template_language,customer_template_name:s.customer_template_name,customer_template_language:s.customer_template_language,connection_status:s.connection_status,connection_checked_at:s.connection_checked_at,last_success_at:s.last_success_at,last_error:s.last_error,credentials_configured:Boolean(credentials.token&&/^\d+$/.test(credentials.phoneId)&&/^v\d+\.\d+$/.test(credentials.version)),api_version:credentials.version||null};
}
app.get("/api/admin/whatsapp/status",authRequired,rolesRequired("admin"),async(req,res)=>{
  try {const settings=await getWhatsAppSettings();const recipient=await getBusinessRecipient(settings);const creds=whatsappCredentials();const saved=serializeWhatsAppSettings(settings,recipient,creds);const queue=await query("SELECT status,COUNT(*)::int AS count FROM whatsapp_notification_queue GROUP BY status");const configured=saved.credentials_configured&&Boolean(recipient);res.json({...saved,configured,recipient_configured:Boolean(recipient),message:!configured?(!recipient?"Configure a valid business WhatsApp recipient.":"Configure the Cloud API token, phone number ID, and API version on the server."):settings.connection_status==="connected"?"WhatsApp provider connection was verified.":"Credentials are present; run Test Connection to verify them with WhatsApp.",queue:Object.fromEntries(queue.rows.map(row=>[row.status,row.count]))});}
  catch(error){console.error("WHATSAPP SETTINGS LOAD ERROR:",error.code||"load failed");res.status(500).json({error:"Unable to load WhatsApp settings. Apply migration 004 if it has not been applied."});}
});
app.put("/api/admin/whatsapp/settings",authRequired,rolesRequired("admin"),async(req,res)=>{
  try {
    const b=req.body||{};const bools=["enabled","notify_new_leads","notify_service_inquiries","notify_project_requests","notify_attachments","customer_confirmation","schedule_enabled"];
    for(const field of bools)if(typeof b[field]!=="boolean")throw requestError(field+" must be true or false");
    if(!Array.isArray(b.allowed_days)||b.allowed_days.some(day=>!Number.isInteger(day)||day<1||day>7))throw requestError("allowed_days must contain ISO weekdays from 1 (Monday) through 7 (Sunday)");
    if(b.schedule_enabled&&!b.allowed_days.length)throw requestError("Select at least one allowed sending day");
    const timePattern=/^(?:[01]\d|2[0-3]):[0-5]\d$/;if(!timePattern.test(b.start_time)||!timePattern.test(b.end_time))throw requestError("Enter schedule times in HH:MM format");
    const timezone=boundedString(b.timezone,"timezone",100,{required:true});try{new Intl.DateTimeFormat("en-US",{timeZone:timezone});}catch{throw requestError("Choose a valid IANA timezone");}
    const country=boundedString(b.recipient_country_code,"recipient_country_code",5,{required:true});const local=boundedString(b.recipient_local_phone||"","recipient_local_phone",20);
    if(!/^\+[1-9]\d{0,3}$/.test(country))throw requestError("Choose a valid WhatsApp country calling code");
    const localDigits=(local||"").replace(/[\s().-]/g,"");if(localDigits&&!/^\d{6,14}$/.test(localDigits))throw requestError("Enter a valid business WhatsApp phone number");
    const recipient=localDigits?country+localDigits:null;if(recipient&&recipient.replace(/\D/g,"").length>15)throw requestError("WhatsApp recipient cannot exceed 15 digits");
    const template=boundedString(b.notification_template_name,"notification_template_name",120,{required:true});const language=boundedString(b.notification_template_language,"notification_template_language",20,{required:true});
    const customerTemplate=boundedString(b.customer_template_name,"customer_template_name",120,{required:true});const customerLanguage=boundedString(b.customer_template_language,"customer_template_language",20,{required:true});
    if(!/^[a-z0-9_]{1,120}$/.test(template)||!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)||!/^[a-z0-9_]{1,120}$/.test(customerTemplate)||!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(customerLanguage))throw requestError("Template names or language codes are invalid");
    const result=await query("UPDATE whatsapp_notification_settings SET enabled=$1,notify_new_leads=$2,notify_service_inquiries=$3,notify_project_requests=$4,notify_attachments=$5,customer_confirmation=$6,schedule_enabled=$7,allowed_days=$8::smallint[],start_time=$9::time,end_time=$10::time,timezone=$11,recipient_phone=$12,notification_template_name=$13,notification_template_language=$14,customer_template_name=$15,customer_template_language=$16,connection_status='not_tested',updated_at=NOW() WHERE id=1 RETURNING *",[b.enabled,b.notify_new_leads,b.notify_service_inquiries,b.notify_project_requests,b.notify_attachments,b.customer_confirmation,b.schedule_enabled,[...new Set(b.allowed_days)],b.start_time,b.end_time,timezone,recipient,template,language,customerTemplate,customerLanguage]);
    await query("UPDATE whatsapp_notification_queue SET status='pending',scheduled_at=NOW(),last_error=NULL,updated_at=NOW() WHERE status='failed' AND last_error LIKE 'Configuration:%'");
    await query("UPDATE leads SET whatsapp_notification_status='pending',whatsapp_error=NULL,whatsapp_updated_at=NOW() WHERE id IN (SELECT lead_id FROM whatsapp_notification_queue WHERE status='pending' AND notification_type IN ('lead','service_inquiry')) AND whatsapp_notification_status='not_configured'");
    triggerWhatsAppQueue();const effective=await getBusinessRecipient(result.rows[0]);res.json({success:true,settings:serializeWhatsAppSettings(result.rows[0],effective,whatsappCredentials())});
  } catch(error){console.error("WHATSAPP SETTINGS SAVE ERROR:",error.code||error.statusCode||"settings error",safeWhatsAppError(error.message));res.status(error.statusCode||500).json({error:error.statusCode?error.message:"Unable to save WhatsApp notification settings"});}
});
app.post("/api/admin/whatsapp/test-connection",authRequired,rolesRequired("admin"),async(req,res)=>{
  try{const cfg=whatsappCredentials();if(!cfg.token)return res.status(400).json({error:"Missing WhatsApp Cloud API access token. Set WHATSAPP_CLOUD_API_TOKEN on the server."});if(!/^\d+$/.test(cfg.phoneId))return res.status(400).json({error:"Missing or invalid WhatsApp Business Phone Number ID."});if(!/^v\d+\.\d+$/.test(cfg.version))return res.status(400).json({error:"Set WHATSAPP_API_VERSION (for example vXX.X) on the server."});
    const result=await whatsappRequest("https://graph.facebook.com/"+cfg.version+"/"+encodeURIComponent(cfg.phoneId)+"?fields=display_phone_number,verified_name",cfg.token);await query("UPDATE whatsapp_notification_settings SET connection_status='connected',connection_checked_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=1");return res.json({success:true,status:"connected",verified_name:result.verified_name||null,display_phone_number:result.display_phone_number||null,message:"WhatsApp provider accepted the credential and phone-number lookup."});
  }catch(error){const message=safeWhatsAppError(error.message);await query("UPDATE whatsapp_notification_settings SET connection_status='error',connection_checked_at=NOW(),last_error=$1,updated_at=NOW() WHERE id=1",[message]).catch(()=>{});const status=error.status||502;return res.status(status>=400&&status<500?400:502).json({success:false,status:"error",error:message});}
});
app.post("/api/admin/whatsapp/test-message",authRequired,rolesRequired("admin"),takeWhatsAppTestLimit,async(req,res)=>{
  try{const settings=await getWhatsAppSettings();const recipient=await getBusinessRecipient(settings);const cfg=whatsappCredentials();if(!cfg.token||!/^\d+$/.test(cfg.phoneId)||!/^v\d+\.\d+$/.test(cfg.version))return res.status(400).json({error:"Configure a valid access token, Business Phone Number ID, and API version before sending a test."});if(!recipient)return res.status(400).json({error:"Configure a valid business recipient phone number first."});
    const payload=templatePayload(settings,settings.notification_template_name,settings.notification_template_language,["PWA-TEST","Admin Test","Test contact","WhatsApp connection test","INR 0","This is a test notification."]);payload.to=recipient;payload.biz_opaque_callback_data="pwa-test-"+Date.now();const result=await whatsappRequest("https://graph.facebook.com/"+cfg.version+"/"+encodeURIComponent(cfg.phoneId)+"/messages",cfg.token,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});const messageId=result.messages?.[0]?.id;if(!messageId)throw new Error("Provider response did not include a WhatsApp message ID");await query("UPDATE whatsapp_notification_settings SET last_success_at=NOW(),last_error=NULL,connection_status='connected',connection_checked_at=NOW(),updated_at=NOW() WHERE id=1");res.json({success:true,status:"accepted",provider_message_id:messageId,message:"WhatsApp accepted the test message. This does not confirm delivery; wait for a signed status webhook."});
  }catch(error){const message=safeWhatsAppError(error.message);await query("UPDATE whatsapp_notification_settings SET last_error=$1,updated_at=NOW() WHERE id=1",[message]).catch(()=>{});const status=error.status||502;res.status(status>=400&&status<500?400:502).json({success:false,status:"failed",error:message});}
});

/* =========================================================
   ADMIN SERVICES
========================================================= */

app.get(
  "/api/admin/services",
  authRequired,
  rolesRequired("admin"),
  async (req, res) => {
    try {
      const result = await query(
        `
        SELECT services.*, price AS price_from, description AS short_description
        FROM services
        ORDER BY sort_order ASC, id ASC
        `
      );

      res.json({
      services: result.rows.map((service) => ({ ...withSalePricing(service), price_from: service.price, short_description: service.description })),
      });
    } catch (error) {
      logOperationalError("APPLICATION ERROR:", error);

      res.status(500).json({
        error: "Unable to load services",
      });
    }
  }
);

app.post(
  "/api/admin/services",
  authRequired,
  rolesRequired("admin"),
  async (req, res) => {
    try {
      const body = req.body || {};
      const name = boundedString(body.name, "name", 200, { required: true });
      const slug = boundedString(body.slug, "slug", 220, { required: true }).toLowerCase();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw requestError("slug may contain lowercase letters, numbers, and hyphens");
      const category = boundedString(body.category || "Web Development", "category", 100, { required: true });
      const description = boundedString(body.description ?? body.short_description ?? "", "description", 10000);
      const price = Number(body.price ?? body.price_from ?? 0);
      const maintenancePrice = Number(body.maintenance_price ?? 0);
      const sortOrder = Number(body.sort_order ?? 0);
      const currency = boundedString(body.currency || "INR", "currency", 10, { required: true }).toUpperCase();
      const priceLabel = boundedString(body.price_label || "Starting at", "price_label", 100);
      const billingLabel = boundedString(body.billing_label || body.billing_type || "one-time", "billing_label", 100);
      const features = parseFeatures(body.features);
      const serviceImage = imageUrl(body.image_url);
      const sale = saleFields(body);
      if (!Number.isFinite(price) || price <= 0 || price > 9999999999.99) throw requestError("Original price must be greater than zero");
      if (sale.type === "fixed" && sale.value >= price) throw requestError("Fixed discount must be less than the original price");
      if (!Number.isFinite(maintenancePrice) || maintenancePrice < 0 || maintenancePrice > 9999999999.99) throw requestError("maintenance_price must be a non-negative amount");
      if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1000000) throw requestError("sort_order must be a non-negative integer");
      if (!Array.isArray(body.features) && body.features !== undefined && typeof body.features !== "string") throw requestError("features must be text or an array");
      const isActive = body.is_active !== false;

      const result = await query(
        `
        INSERT INTO services
        (
          name,
          slug,
          category,
          description,
          price,
          maintenance_price,
          currency,
          price_label,
          billing_label,
          features,
          image_url,
          sort_order,
          is_active, sale_enabled, discount_type, discount_value, offer_badge_text,
          sale_start_date, sale_end_date
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        RETURNING *
        `,
        [
          name,
          slug,
          category,
          description || null,
          price,
          maintenancePrice,
          currency,
          priceLabel,
          billingLabel,
          JSON.stringify(features),
          serviceImage,
          sortOrder,
          isActive,
          sale.enabled, sale.type, sale.value, sale.badge, sale.start, sale.end,
        ]
      );

      res.status(201).json({
        success: true,
        service: withSalePricing(result.rows[0]),
      });
    } catch (error) {
      logOperationalError("SERVICE CREATE ERROR:", error);

      res.status(error.statusCode || (error.code === "23505" ? 409 : 500)).json({
        error: "Unable to create service",
        ...(error.statusCode ? { details: error.message } : {}),
        ...(error.code === "23505" ? { details: "A service with this slug already exists" } : {}),
      });
    }
  }
);

app.put(
  "/api/admin/services/:id",
  authRequired,
  rolesRequired("admin"),
  async (req, res) => {
    try {
      if (!isBigIntId(req.params.id)) return res.status(400).json({ error: "Service ID must be numeric" });
      const existing = await query("SELECT * FROM services WHERE id = $1", [req.params.id]);
      if (!existing.rows.length) return res.status(404).json({ error: "Service not found" });
      const current = existing.rows[0];
      const body = req.body || {};
      const name = boundedString(body.name ?? current.name, "name", 200, { required: true });
      const slug = boundedString(body.slug ?? current.slug, "slug", 220, { required: true }).toLowerCase();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw requestError("slug may contain lowercase letters, numbers, and hyphens");
      const category = boundedString(body.category ?? current.category, "category", 100, { required: true });
      const description = boundedString(body.description ?? body.short_description ?? current.description ?? "", "description", 10000);
      const price = Number(body.price ?? body.price_from ?? current.price);
      const maintenancePrice = Number(body.maintenance_price ?? current.maintenance_price);
      const sortOrder = Number(body.sort_order ?? current.sort_order);
      const currency = boundedString(body.currency ?? current.currency, "currency", 10, { required: true }).toUpperCase();
      const priceLabel = boundedString(body.price_label ?? current.price_label ?? "Starting at", "price_label", 100);
      const billingLabel = boundedString(body.billing_label ?? body.billing_type ?? current.billing_label ?? "one-time", "billing_label", 100);
      const features = body.features === undefined ? current.features : parseFeatures(body.features);
      const serviceImage = body.image_url === undefined ? current.image_url : imageUrl(body.image_url);
      const sale = saleFields(body, current);
      const isActive = body.is_active === undefined ? current.is_active : body.is_active;
      if (!Number.isFinite(price) || price <= 0 || price > 9999999999.99) throw requestError("Original price must be greater than zero");
      if (sale.type === "fixed" && sale.value >= price) throw requestError("Fixed discount must be less than the original price");
      if (!Number.isFinite(maintenancePrice) || maintenancePrice < 0 || maintenancePrice > 9999999999.99) throw requestError("maintenance_price must be a non-negative amount");
      if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1000000) throw requestError("sort_order must be a non-negative integer");
      if (typeof isActive !== "boolean") throw requestError("is_active must be boolean");

      const result = await query(
        `
        UPDATE services
        SET
          name = $1,
          slug = $2,
          category = $3,
          description = $4,
          price = $5,
          maintenance_price = $6,
          currency = $7,
          price_label = $8,
          billing_label = $9,
          features = $10::jsonb,
          image_url = $11,
          sort_order = $12,
          is_active = $13,
          sale_enabled = $14,
          discount_type = $15,
          discount_value = $16,
          offer_badge_text = $17,
          sale_start_date = $18,
          sale_end_date = $19
        WHERE id = $20
        RETURNING *
        `,
        [
          name,
          slug,
          category || "Web Development",
          description || null,
          price,
          maintenancePrice,
          currency,
          priceLabel,
          billingLabel,
          JSON.stringify(features),
          serviceImage,
          sortOrder,
          isActive,
          sale.enabled, sale.type, sale.value, sale.badge, sale.start, sale.end,
          req.params.id,
        ]
      );

      res.json({
        success: true,
        service: withSalePricing(result.rows[0]),
      });
    } catch (error) {
      logOperationalError("APPLICATION ERROR:", error);

      res.status(error.statusCode || (error.code === "23505" ? 409 : 500)).json({
        error: "Unable to update service",
        ...(error.statusCode ? { details: error.message } : {}),
        ...(error.code === "23505" ? { details: "A service with this slug already exists" } : {}),
      });
    }
  }
);

app.delete(
  "/api/admin/services/:id",
  authRequired,
  rolesRequired("admin"),
  async (req, res) => {
    try {
      if (!isBigIntId(req.params.id)) return res.status(400).json({ error: "Service ID must be numeric" });
      const usage = await query(`
        SELECT
          EXISTS (SELECT 1 FROM projects WHERE service_id = $1) AS used_by_projects,
          EXISTS (SELECT 1 FROM leads WHERE service_id = $1) AS used_by_leads
      `, [req.params.id]);
      if (usage.rows[0].used_by_projects || usage.rows[0].used_by_leads) {
        return res.status(409).json({ error: "This service is linked to projects or leads. Deactivate it instead." });
      }
      const deleted = await query("DELETE FROM services WHERE id = $1 RETURNING id", [req.params.id]);
      if (!deleted.rowCount) return res.status(404).json({ error: "Service not found" });

      res.json({
        success: true,
      });
    } catch (error) {
      logOperationalError("APPLICATION ERROR:", error);

      res.status(500).json({
        error: "Unable to delete service",
      });
    }
  }
);

app.get("/api/admin/media", authRequired, rolesRequired("admin"), async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(60, Math.max(1, Number.parseInt(req.query.limit, 10) || 24));
    const offset = (page - 1) * limit;
    const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 150) : "";
    const category = typeof req.query.category === "string" ? req.query.category.trim().slice(0, 100) : "";
    const where = `WHERE ($1 = '' OR title ILIKE '%' || $1 || '%' OR alt_text ILIKE '%' || $1 || '%' OR caption ILIKE '%' || $1 || '%' OR category ILIKE '%' || $1 || '%') AND ($2 = '' OR category = $2)`;
    const [items, total] = await Promise.all([
      query(`SELECT id,title,alt_text,category,caption,storage_key,'/media/' || storage_key AS image_url,mime_type,file_size,is_published,sort_order,created_at FROM gallery_images ${where} ORDER BY sort_order ASC,created_at DESC LIMIT $3 OFFSET $4`, [search, category, limit, offset]),
      query(`SELECT COUNT(*)::int AS count FROM gallery_images ${where}`, [search, category]),
    ]);
    res.json({ media: items.rows, total: total.rows[0].count, page, limit });
  } catch (error) {
    logOperationalError("MEDIA LIST ERROR:", error);
    res.status(500).json({ error: "Unable to load media" });
  }
});

app.post("/api/admin/media", authRequired, rolesRequired("admin"), async (req, res) => {
  let storageKey;
  try {
    const body = req.body || {};
    const title = boundedString(body.title, "title", 180, { required: true });
    const altText = boundedString(body.alt_text || "", "alt_text", 300);
    const category = boundedString(body.category || "General", "category", 100, { required: true });
    const caption = boundedString(body.caption || "", "caption", 5000);
    const isPublished = body.is_published === true;
    const sortOrder = Number(body.sort_order ?? 0);
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1000000) throw requestError("sort_order must be a non-negative integer");
    let encoded = body.data_base64;
    let declaredMime = body.mime_type;
    if (typeof body.data_url === "string") {
      const match = body.data_url.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) throw requestError("Upload must be a supported base64 image data URL");
      declaredMime = match[1];
      encoded = match[2];
    }
    if (typeof encoded !== "string" || encoded.length > 6990508 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw requestError("Image data is missing or exceeds the 5 MB upload limit");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.length || bytes.length > 5 * 1024 * 1024 || bytes.toString("base64") !== encoded) {
      throw requestError("Image data is invalid or exceeds the 5 MB upload limit");
    }
    const actualMime = detectImageMime(bytes);
    if (!actualMime || declaredMime !== actualMime) throw requestError("Image content does not match a supported image format");
    const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[actualMime];
    storageKey = `${crypto.randomUUID()}.${extension}`;
    await fs.mkdir(MEDIA_DIR, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(MEDIA_DIR, storageKey), bytes, { flag: "wx", mode: 0o600 });
    const result = await query(`
      INSERT INTO gallery_images (title,alt_text,category,caption,storage_key,mime_type,file_size,is_published,sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id,title,alt_text,category,caption,storage_key,'/media/' || storage_key AS image_url,mime_type,file_size,is_published,sort_order,created_at
    `, [title, altText || "", category, caption || null, storageKey, actualMime, bytes.length, isPublished, sortOrder]);
    res.status(201).json({ media: result.rows[0] });
  } catch (error) {
    if (storageKey) await fs.unlink(path.join(MEDIA_DIR, storageKey)).catch(() => {});
    logOperationalError("MEDIA UPLOAD ERROR:", error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Unable to upload media" });
  }
});

app.put("/api/admin/media/:id", authRequired, rolesRequired("admin"), async (req, res) => {
  try {
    if (!isBigIntId(req.params.id)) throw requestError("Media ID must be numeric");
    const body = req.body || {};
    const fields = {
      title: body.title === undefined ? undefined : boundedString(body.title, "title", 180, { required: true }),
      alt_text: body.alt_text === undefined ? undefined : boundedString(body.alt_text, "alt_text", 300),
      category: body.category === undefined ? undefined : boundedString(body.category, "category", 100, { required: true }),
      caption: body.caption === undefined ? undefined : boundedString(body.caption, "caption", 5000),
      is_published: body.is_published,
      sort_order: body.sort_order,
    };
    const columns = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!columns.length) throw requestError("No media fields were provided");
    for (const [key, value] of columns) {
      if (key === "is_published" && typeof value !== "boolean") throw requestError("is_published must be boolean");
      if (key === "sort_order" && (!Number.isInteger(value) || value < 0 || value > 1000000)) throw requestError("sort_order must be a non-negative integer");
    }
    const assignments = columns.map(([key], index) => `${key} = $${index + 1}`).join(", ");
    const values = columns.map(([, value]) => value);
    values.push(req.params.id);
    const result = await query(`UPDATE gallery_images SET ${assignments},updated_at=NOW() WHERE id=$${values.length} RETURNING id,title,alt_text,category,caption,'/media/' || storage_key AS image_url,mime_type,file_size,is_published,sort_order,created_at`, values);
    if (!result.rowCount) return res.status(404).json({ error: "Media item not found" });
    res.json({ media: result.rows[0] });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Unable to update media" });
  }
});

app.delete("/api/admin/media/:id", authRequired, rolesRequired("admin"), async (req, res) => {
  if (!isBigIntId(req.params.id)) return res.status(400).json({ error: "Media ID must be numeric" });
  const client = await pool.connect();
  let storageKey;
  try {
    await client.query("BEGIN");
    const media = await client.query("SELECT id,storage_key FROM gallery_images WHERE id=$1 FOR UPDATE", [req.params.id]);
    if (!media.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Media item not found" });
    }
    storageKey = media.rows[0].storage_key;
    const url = `/media/${storageKey}`;
    const usage = await client.query(`
      SELECT
        EXISTS (SELECT 1 FROM services WHERE image_url=$1) OR
        EXISTS (SELECT 1 FROM portfolio_projects WHERE image_url=$1) OR
        EXISTS (SELECT 1 FROM website_demos WHERE media_key=$2 OR thumbnail_key=$2) OR
        EXISTS (SELECT 1 FROM brand_settings WHERE logo_url=$1 OR favicon_url=$1 OR position($1 in settings::text)>0)
        AS in_use
    `, [url, storageKey]);
    if (usage.rows[0].in_use) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This image is in use. Replace its references before deleting it." });
    }
    await client.query("DELETE FROM gallery_images WHERE id=$1", [req.params.id]);
    await client.query("COMMIT");
    await fs.unlink(path.join(MEDIA_DIR, storageKey)).catch((error) => {
      if (error.code !== "ENOENT") console.error("Unused media file cleanup failed:", error.message);
    });
    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    logOperationalError("MEDIA DELETE ERROR:", error);
    res.status(500).json({ error: "Unable to delete media" });
  } finally {
    client.release();
  }
});

app.get("/api/admin/portfolio", authRequired, rolesRequired("admin"), async (req, res) => {
  try {
    const result = await query("SELECT * FROM portfolio_projects ORDER BY sort_order ASC,created_at DESC");
    res.json({ portfolio: result.rows });
  } catch (error) {
    logOperationalError("PORTFOLIO LIST ERROR:", error);
    res.status(500).json({ error: "Unable to load portfolio" });
  }
});

app.post("/api/admin/portfolio", authRequired, rolesRequired("admin"), async (req, res) => {
  try {
    const body = req.body || {};
    const title = boundedString(body.title, "title", 200, { required: true });
    const slug = boundedString(body.slug || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), "slug", 220);
    const category = boundedString(body.category || "", "category", 100);
    const description = boundedString(body.description || "", "description", 10000);
    const projectUrl = body.project_url ? imageUrl(body.project_url, "project_url") : null;
    const projectImage = imageUrl(body.image_url);
    const technologies = parseFeatures(body.technologies || []);
    const sortOrder = Number(body.sort_order ?? 0);
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1000000) throw requestError("sort_order must be a non-negative integer");
    if (body.is_published !== undefined && typeof body.is_published !== "boolean") throw requestError("is_published must be boolean");
    const result = await query(`
      INSERT INTO portfolio_projects (title,slug,description,category,image_url,project_url,technologies,is_published,sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *
    `, [title, slug || null, description || null, category || null, projectImage, projectUrl, JSON.stringify(technologies), body.is_published === true, sortOrder]);
    res.status(201).json({ project: result.rows[0] });
  } catch (error) {
    logOperationalError("PORTFOLIO CREATE ERROR:", error);
    res.status(error.statusCode || (error.code === "23505" ? 409 : 500)).json({ error: error.statusCode ? error.message : error.code === "23505" ? "A portfolio project with this slug already exists" : "Unable to create portfolio project" });
  }
});

app.put("/api/admin/portfolio/:id", authRequired, rolesRequired("admin"), async (req, res) => {
  try {
    if (!isBigIntId(req.params.id)) throw requestError("Portfolio ID must be numeric");
    const currentResult = await query("SELECT * FROM portfolio_projects WHERE id=$1", [req.params.id]);
    if (!currentResult.rowCount) return res.status(404).json({ error: "Portfolio project not found" });
    const current = currentResult.rows[0];
    const body = req.body || {};
    const title = boundedString(body.title ?? current.title, "title", 200, { required: true });
    const slug = boundedString(body.slug ?? current.slug ?? "", "slug", 220);
    const category = boundedString(body.category ?? current.category ?? "", "category", 100);
    const description = boundedString(body.description ?? current.description ?? "", "description", 10000);
    const projectUrl = body.project_url === undefined ? current.project_url : body.project_url ? imageUrl(body.project_url, "project_url") : null;
    const projectImage = body.image_url === undefined ? current.image_url : imageUrl(body.image_url);
    const technologies = body.technologies === undefined ? current.technologies : parseFeatures(body.technologies);
    const sortOrder = Number(body.sort_order ?? current.sort_order);
    const published = body.is_published ?? current.is_published;
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1000000) throw requestError("sort_order must be a non-negative integer");
    if (typeof published !== "boolean") throw requestError("is_published must be boolean");
    const result = await query(`
      UPDATE portfolio_projects SET title=$1,slug=$2,description=$3,category=$4,image_url=$5,project_url=$6,technologies=$7::jsonb,is_published=$8,sort_order=$9 WHERE id=$10 RETURNING *
    `, [title, slug || null, description || null, category || null, projectImage, projectUrl, JSON.stringify(technologies), published, sortOrder, req.params.id]);
    res.json({ project: result.rows[0] });
  } catch (error) {
    logOperationalError("PORTFOLIO UPDATE ERROR:", error);
    res.status(error.statusCode || (error.code === "23505" ? 409 : 500)).json({ error: error.statusCode ? error.message : error.code === "23505" ? "A portfolio project with this slug already exists" : "Unable to update portfolio project" });
  }
});

app.delete("/api/admin/portfolio/:id", authRequired, rolesRequired("admin"), async (req, res) => {
  try {
    if (!isBigIntId(req.params.id)) return res.status(400).json({ error: "Portfolio ID must be numeric" });
    const result = await query("DELETE FROM portfolio_projects WHERE id=$1 RETURNING id", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Portfolio project not found" });
    res.json({ success: true });
  } catch (error) {
    logOperationalError("PORTFOLIO DELETE ERROR:", error);
    res.status(500).json({ error: "Unable to delete portfolio project" });
  }
});

/* =========================================================
   ADMIN PROJECTS
========================================================= */

app.get(
  "/api/admin/projects",
  authRequired,
  rolesRequired("admin"),
  async (req, res) => {
    try {
      const result = await query(`
        SELECT
          p.*,
          'PWA-PRJ-'||LPAD(p.id::text,6,'0') AS project_reference,
          u.name AS customer_name,
          u.email AS customer_email,
          s.name AS service_name,
          w.status AS whatsapp_status,
          w.last_error AS whatsapp_error,
          (SELECT COUNT(*)::int FROM project_notifications n WHERE n.project_id=p.id AND n.user_id=$1 AND n.read_at IS NULL) AS unread_updates
        FROM projects p
        LEFT JOIN whatsapp_notification_queue w ON w.project_id=p.id AND w.notification_type='project_request'
        LEFT JOIN users u
          ON u.id = p.user_id
        LEFT JOIN services s
          ON s.id = p.service_id
        ORDER BY p.created_at DESC
      `,[req.user.id]);

      res.json({
        projects: result.rows,
        unread_count: result.rows.reduce((count,project)=>count+Number(project.unread_updates||0),0),
      });
    } catch (error) {
      logOperationalError("APPLICATION ERROR:", error);

      res.status(500).json({
        error: "Unable to load projects",
      });
    }
  }
);

app.post("/api/admin/projects/:id/whatsapp/retry",authRequired,rolesRequired("admin"),async(req,res)=>{
  try{if(!isBigIntId(req.params.id))return res.status(400).json({error:"Project ID must be numeric"});const project=await query("SELECT id FROM projects WHERE id=$1",[req.params.id]);if(!project.rowCount)return res.status(404).json({error:"Project not found"});const client=await pool.connect();try{await client.query("BEGIN");const existing=await client.query("SELECT id,status,last_error FROM whatsapp_notification_queue WHERE project_id=$1 AND notification_type='project_request' FOR UPDATE",[req.params.id]);if(existing.rowCount&&["accepted","sent","delivered","read"].includes(existing.rows[0].status)){await client.query("COMMIT");return res.json({success:true,status:existing.rows[0].status,message:"The project notification was already accepted and was not resent."});}if(existing.rowCount&&existing.rows[0].status==="sending"){await client.query("ROLLBACK");return res.status(409).json({error:"The project notification is already in progress."});}if(existing.rowCount&&String(existing.rows[0].last_error||"").startsWith("Worker stopped during a provider request")){await client.query("ROLLBACK");return res.status(409).json({error:"The previous provider request has an unknown outcome. Verify WhatsApp delivery before retrying."});}if(existing.rowCount)await client.query("UPDATE whatsapp_notification_queue SET status='pending',scheduled_at=NOW(),attempt_count=0,last_error=NULL,updated_at=NOW() WHERE id=$1",[existing.rows[0].id]);else await enqueueWhatsAppJob(client,{projectId:req.params.id,type:"project_request",recipient:null});await client.query("COMMIT");}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}triggerWhatsAppQueue();res.status(202).json({success:true,status:"pending",message:"Project notification retry queued."});}catch(error){console.error("PROJECT WHATSAPP RETRY ERROR:",error.code||"retry failed");res.status(500).json({error:"Unable to retry the project WhatsApp notification"});}
});

app.put(
  "/api/admin/projects/:id",
  authRequired,
  rolesRequired("admin"),
  async (req, res) => {
    const projectClient = await pool.connect();
    try {
      const body=req.body&&typeof req.body==="object"&&!Array.isArray(req.body)?req.body:{};
      const {status,progress_percent:submittedProgress,progress,stage,estimated_start_date,deadline,delay_reason,decision_reason,update_note,request_key,budget,assigned_to,admin_notes}=body;
      if(!isBigIntId(req.params.id))return res.status(400).json({error:"Project ID must be numeric"});
      if(status!==undefined&&!PROJECT_STATUSES.has(status))return res.status(400).json({error:"Unsupported project status"});
      const progress_percent=submittedProgress===undefined?progress:submittedProgress;
      if(progress_percent!==undefined&&(!Number.isInteger(Number(progress_percent))||Number(progress_percent)<0||Number(progress_percent)>100))return res.status(400).json({error:"progress_percent must be a whole number from 0 to 100"});
      if(budget!==undefined&&budget!==null&&budget!==""&&(!Number.isFinite(Number(budget))||Number(budget)<0))return res.status(400).json({error:"budget must be a non-negative number"});
      if(assigned_to!==undefined&&assigned_to!==null&&(typeof assigned_to!=="string"||assigned_to.length>200))return res.status(400).json({error:"assigned_to must be text up to 200 characters or null"});
      if(admin_notes!==undefined&&(typeof admin_notes!=="string"||admin_notes.length>10000))return res.status(400).json({error:"admin_notes must be text up to 10000 characters"});
      if(stage!==undefined&&!PROJECT_STAGES.has(stage))return res.status(400).json({error:"Unsupported project stage"});
      for(const [field,value] of [["deadline",deadline],["estimated_start_date",estimated_start_date]])if(value!==undefined&&value!==null&&value!==""&&!validDateOnly(value))return res.status(400).json({error:`${field} must be a valid YYYY-MM-DD date`});
      if(delay_reason!==undefined&&(typeof delay_reason!=="string"||delay_reason.length>3000))return res.status(400).json({error:"delay_reason must be text up to 3000 characters"});
      if(decision_reason!==undefined&&(typeof decision_reason!=="string"||decision_reason.length>3000))return res.status(400).json({error:"decision_reason must be text up to 3000 characters"});
      if(update_note!==undefined&&(typeof update_note!=="string"||update_note.length>5000))return res.status(400).json({error:"update_note must be text up to 5000 characters"});
      if(request_key&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request_key))return res.status(400).json({error:"request_key must be a valid request identifier"});
      const milestones=validateProjectMilestones(body.milestones);
      await projectClient.query("BEGIN");
      if(request_key){const replay=await projectClient.query("SELECT id FROM project_activity WHERE idempotency_key=$1::uuid",[request_key]);if(replay.rowCount){const current=await projectClient.query("SELECT * FROM projects WHERE id=$1",[req.params.id]);await projectClient.query("COMMIT");if(!current.rowCount)return res.status(404).json({error:"Project not found"});return res.json({success:true,duplicate:true,project:current.rows[0]});}}
      const found=await projectClient.query("SELECT * FROM projects WHERE id=$1 FOR UPDATE",[req.params.id]);
      if(!found.rowCount){await projectClient.query("ROLLBACK");return res.status(404).json({error:"Project not found"});}
      const old=found.rows[0],nextStatus=status===undefined?old.status:status;
      if(status!==undefined&&status!==old.status&&PROJECT_STATUS_TRANSITIONS[old.status]&&!PROJECT_STATUS_TRANSITIONS[old.status].has(status)){await projectClient.query("ROLLBACK");return res.status(409).json({error:`Project cannot move from ${old.status} to ${status}`});}
      if(status==="delayed"&&!String(delay_reason||old.delay_reason||"").trim()){await projectClient.query("ROLLBACK");return res.status(400).json({error:"A reason is required when delaying a project"});}
      if(status==="rejected"&&!String(decision_reason||"").trim()){await projectClient.query("ROLLBACK");return res.status(400).json({error:"A reason is required when rejecting a project"});}
      const nextProgress=status==="completed"&&progress_percent===undefined?100:progress_percent===undefined?old.progress_percent:Number(progress_percent);
      const nextStage=stage===undefined?(status==="completed"?"completed":old.stage):stage;
      const nextStart=estimated_start_date===undefined?old.estimated_start_date:(estimated_start_date||null);
      const nextDeadline=deadline===undefined?old.deadline:(deadline||null);
      if(nextStart&&nextDeadline&&dateOnly(nextDeadline)<dateOnly(nextStart)){await projectClient.query("ROLLBACK");return res.status(400).json({error:"Estimated completion must be on or after the estimated start date"});}
      const requirementsPatch={...(assigned_to!==undefined?{assigned_to}:{}),...(admin_notes!==undefined?{admin_notes}:{})};
      const result=await projectClient.query("UPDATE projects SET status=$1,progress_percent=$2,stage=$3,estimated_start_date=$4,deadline=$5,delay_reason=$6,decision_reason=$7,budget=CASE WHEN $8::boolean THEN $9::numeric ELSE budget END,requirements=requirements||$10::jsonb,updated_at=NOW() WHERE id=$11 RETURNING *",[nextStatus,nextProgress,nextStage,nextStart,nextDeadline,status==="delayed"?(delay_reason||old.delay_reason):delay_reason===undefined?old.delay_reason:(delay_reason||null),status==="rejected"?(decision_reason||null):decision_reason===undefined?old.decision_reason:(decision_reason||null),budget!==undefined,budget===""?null:(budget??null),JSON.stringify(requirementsPatch),req.params.id]);
      if(milestones){for(const item of milestones)await projectClient.query("INSERT INTO project_milestones(project_id,title,status,target_date,completed_at,sort_order) VALUES($1,$2,$3,$4,CASE WHEN $3='completed' THEN NOW() END,$5) ON CONFLICT(project_id,title) DO UPDATE SET status=EXCLUDED.status,target_date=EXCLUDED.target_date,completed_at=CASE WHEN EXCLUDED.status='completed' THEN COALESCE(project_milestones.completed_at,NOW()) ELSE NULL END,sort_order=EXCLUDED.sort_order,updated_at=NOW()",[req.params.id,item.title,item.status,item.target_date,item.sort_order]);}
      const changed=old.status!==nextStatus||Number(old.progress_percent)!==nextProgress||old.stage!==nextStage||dateOnly(old.estimated_start_date)!==dateOnly(nextStart)||dateOnly(old.deadline)!==dateOnly(nextDeadline)||Boolean(update_note&&update_note.trim())||Boolean(milestones?.length)||budget!==undefined||assigned_to!==undefined||admin_notes!==undefined;
      let activity=null;
      if(changed){const title=status!==undefined&&status!==old.status?`Project ${status.replaceAll("_"," ")}`:stage!==undefined&&stage!==old.stage?`Project stage updated: ${stage.replaceAll("_"," ")}`:"Project progress updated";const note=boundedString(update_note||delay_reason||decision_reason||"","update_note",5000)||null;activity=await projectClient.query("INSERT INTO project_activity(project_id,actor_id,event_type,title,note,old_status,new_status,old_progress,new_progress,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::uuid) RETURNING id,created_at",[req.params.id,req.user.id,status!==undefined&&status!==old.status?"status_change":"progress_update",title,note,old.status,nextStatus,old.progress_percent,nextProgress,request_key||null]);if(old.user_id)await projectClient.query("INSERT INTO project_notifications(project_id,activity_id,user_id) VALUES($1,$2,$3) ON CONFLICT(activity_id,user_id) DO NOTHING",[req.params.id,activity.rows[0].id,old.user_id]);}
      const finalMilestones=await projectClient.query("SELECT id,title,status,target_date,completed_at,sort_order FROM project_milestones WHERE project_id=$1 ORDER BY sort_order,id",[req.params.id]);
      await projectClient.query("COMMIT");
      res.json({success:true,project:result.rows[0],project_reference:projectReference(result.rows[0].id),activity:activity?.rows[0]||null,milestones:finalMilestones.rows,notification_status:old.user_id?"in_app":"customer_account_not_linked"});
    } catch (error) {
      await projectClient.query("ROLLBACK").catch(()=>{});
      if(error.statusCode===400)return res.status(400).json({error:error.message});
      console.error("UPDATE PROJECT ERROR:",error.code||"update failed");
      res.status(500).json({error:"Unable to update project"});
    } finally { projectClient.release(); }
  }
);

/* =========================================================
   ADMIN LEADS
========================================================= */

app.get(
  "/api/admin/leads",
  authRequired,
  rolesRequired("admin"),
  async (req, res) => {
    try {
      const result = await query(`
        SELECT
          l.*,
          COALESCE(l.service_name_snapshot,s.name) AS service_name,
          COALESCE(a.attachments,'[]'::jsonb) AS attachments
        FROM leads l
        LEFT JOIN services s
          ON s.id = l.service_id
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object('id',la.id,'original_name',la.original_name,'mime_type',la.mime_type,'file_size',la.file_size,'created_at',la.created_at,'whatsapp_status',la.whatsapp_status) ORDER BY la.id) AS attachments
          FROM lead_attachments la WHERE la.lead_id=l.id
        ) a ON TRUE
        ORDER BY l.created_at DESC
      `);

      res.json({
        leads: result.rows,
      });
    } catch (error) {
      logOperationalError("APPLICATION ERROR:", error);

      res.status(500).json({
        error: "Unable to load leads",
      });
    }
  }
);

app.get("/api/admin/lead-notifications",authRequired,rolesRequired("admin"),async(req,res)=>{
  try {
    const result=await query(`SELECT n.id,n.lead_id,n.created_at,n.read_at,l.lead_reference,l.name,l.phone,l.email,l.service_name_snapshot AS service_name,l.message,l.source,l.status FROM admin_lead_notifications n JOIN leads l ON l.id=n.lead_id ORDER BY n.read_at NULLS FIRST,n.created_at DESC LIMIT 100`);
    const unread=await query("SELECT COUNT(*)::int AS count FROM admin_lead_notifications WHERE read_at IS NULL");
    res.json({notifications:result.rows,unread_count:unread.rows[0]?.count||0});
  } catch(error) { console.error("ADMIN LEAD NOTIFICATIONS ERROR:",error.code||"query failed"); res.status(500).json({error:"Unable to load lead notifications"}); }
});

app.post("/api/admin/lead-notifications/:id/read",authRequired,rolesRequired("admin"),async(req,res)=>{
  try {
    if(!isBigIntId(req.params.id))return res.status(400).json({error:"Notification ID must be numeric"});
    const result=await query("UPDATE admin_lead_notifications SET read_at=COALESCE(read_at,NOW()) WHERE id=$1 RETURNING id,lead_id,read_at",[req.params.id]);
    if(!result.rowCount)return res.status(404).json({error:"Lead notification not found"});
    res.json({notification:result.rows[0]});
  } catch(error) { console.error("MARK LEAD NOTIFICATION READ ERROR:",error.code||"update failed"); res.status(500).json({error:"Unable to update lead notification"}); }
});

app.get("/api/admin/leads/:id/attachments/:attachmentId", authRequired, rolesRequired("admin"), async (req, res) => {
  try {
    if (!isBigIntId(req.params.id) || !isBigIntId(req.params.attachmentId)) return res.status(400).json({ error: "Lead and attachment IDs must be numeric" });
    const result = await query("SELECT storage_key,mime_type,original_name FROM lead_attachments WHERE id=$1 AND lead_id=$2", [req.params.attachmentId,req.params.id]);
    if (!result.rowCount) return res.status(404).end();
    const { storage_key: storageKey, mime_type: mimeType, original_name: originalName } = result.rows[0];
    if (!/^[a-f0-9-]{36}\.(jpg|png|webp)$/.test(storageKey)) return res.status(404).end();
    const bytes = await fs.readFile(path.join(MEDIA_DIR, storageKey));
    if (detectImageMime(bytes) !== mimeType) return res.status(404).end();
    res.set({ "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Content-Disposition": `inline; filename="${safeOriginalFilename(originalName).replace(/["\\]/g, "_")}"` });
    return res.type(mimeType).send(bytes);
  } catch (error) {
    if (error.code !== "ENOENT") console.error("LEAD ATTACHMENT ACCESS ERROR:", error.code || "read failed");
    res.status(error.code === "ENOENT" ? 404 : 500).end();
  }
});

app.post("/api/admin/leads/:id/whatsapp/retry",authRequired,rolesRequired("admin"),async(req,res)=>{
  try {
    if(!isBigIntId(req.params.id))return res.status(400).json({error:"Lead ID must be numeric"});
    const lead=await query("SELECT id,service_id,phone FROM leads WHERE id=$1",[req.params.id]);if(!lead.rowCount)return res.status(404).json({error:"Lead not found"});
    const uncertain=await query("SELECT id FROM whatsapp_notification_queue WHERE lead_id=$1 AND status='failed' AND last_error LIKE 'Worker stopped during a provider request%'",[req.params.id]);if(uncertain.rowCount)return res.status(409).json({error:"The previous provider request has an unknown outcome. Check the WhatsApp recipient or delivery webhook before retrying to avoid a duplicate."});
    const client=await pool.connect();let mainJob;try{await client.query("BEGIN");const type=lead.rows[0].service_id?"service_inquiry":"lead";const existing=await client.query("SELECT id,status FROM whatsapp_notification_queue WHERE lead_id=$1 AND notification_type=$2 AND attachment_id IS NULL FOR UPDATE",[req.params.id,type]);if(existing.rowCount&&existing.rows[0].status==="sending"){await client.query("ROLLBACK");return res.status(409).json({error:"A WhatsApp notification is already in progress."});}if(existing.rowCount&&["accepted","sent","delivered","read"].includes(existing.rows[0].status)){const failedFiles=await client.query("SELECT id FROM whatsapp_notification_queue WHERE lead_id=$1 AND notification_type='attachment' AND status='failed'",[req.params.id]);if(failedFiles.rowCount){await client.query("UPDATE whatsapp_notification_queue SET status='pending',scheduled_at=NOW(),attempt_count=0,last_error=NULL,updated_at=NOW() WHERE lead_id=$1 AND notification_type='attachment' AND status='failed'",[req.params.id]);await client.query("UPDATE lead_attachments SET whatsapp_status='pending',whatsapp_error=NULL WHERE lead_id=$1 AND whatsapp_status='failed'",[req.params.id]);await client.query("COMMIT");triggerWhatsAppQueue();return res.status(202).json({success:true,status:"pending",message:"Failed attachment notifications were queued for retry. The original lead message was not resent."});}await client.query("COMMIT");return res.json({success:true,status:existing.rows[0].status,message:"The notification was already accepted; it was not sent again."});}
      if(existing.rowCount)await client.query("UPDATE whatsapp_notification_queue SET status='pending',scheduled_at=NOW(),attempt_count=0,last_error=NULL,updated_at=NOW() WHERE id=$1",[existing.rows[0].id]);else mainJob=await enqueueWhatsAppJob(client,{leadId:req.params.id,type,recipient:null});
      await client.query("UPDATE whatsapp_notification_queue SET status='pending',scheduled_at=NOW(),attempt_count=0,last_error=NULL,updated_at=NOW() WHERE lead_id=$1 AND status='failed'",[req.params.id]);
      await client.query("UPDATE lead_attachments SET whatsapp_status='pending',whatsapp_error=NULL WHERE lead_id=$1 AND whatsapp_status IN ('failed','manual_only')",[req.params.id]);await client.query("UPDATE leads SET whatsapp_notification_status='pending',whatsapp_error=NULL,whatsapp_updated_at=NOW() WHERE id=$1",[req.params.id]);await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}
    triggerWhatsAppQueue();res.status(202).json({success:true,status:"pending",message:"Retry queued. Check the lead status for the provider result."});
  }catch(error){console.error("WHATSAPP RETRY ERROR:",error.code||"retry failed");res.status(error.statusCode||500).json({error:error.statusCode?error.message:"Unable to queue WhatsApp retry"});}
});

app.put(
  "/api/admin/leads/:id",
  authRequired,
  rolesRequired("admin"),
  async (req, res) => {
    try {
      const {
        status,
      } = req.body;

      if (!isBigIntId(req.params.id)) return res.status(400).json({ error: "Lead ID must be numeric" });
      if (status !== undefined && !["new", "contacted", "qualified", "converted", "closed"].includes(status)) {
        return res.status(400).json({ error: "Unsupported lead status" });
      }

      const result = await query(
        `
        UPDATE leads
        SET
          status = COALESCE($1, status)
        WHERE id = $2
        RETURNING *
        `,
        [
          status ?? null,
          req.params.id,
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Lead not found",
        });
      }

      res.json({
        success: true,
        lead: result.rows[0],
      });
    } catch (error) {
      logOperationalError("APPLICATION ERROR:", error);

      res.status(500).json({
        error: "Unable to update lead",
      });
    }
  }
);

/* =========================================================
   ADMIN AI SETTINGS
========================================================= */

app.get(
  "/api/admin/ai",
  authRequired,
  rolesRequired("admin"),
  async (req, res) => {
    try {
      const result = await query(
        `
        SELECT *
        FROM ai_settings
        ORDER BY id ASC
        LIMIT 1
        `
      );

      res.json({
        ai: result.rows[0] || null,
      });
    } catch (error) {
      logOperationalError("APPLICATION ERROR:", error);

      res.status(500).json({
        error: "Unable to load AI settings",
      });
    }
  }
);

app.put(
  "/api/admin/ai",
  authRequired,
  rolesRequired("admin"),
  async (req, res) => {
    try {
      const {
        enabled,
        assistant_name,
        welcome_message,
        system_prompt,
        business_context,
        fallback_message,
        human_handoff_enabled,
      } = req.body;

      const existing = await query(
        `
        SELECT id
        FROM ai_settings
        ORDER BY id ASC
        LIMIT 1
        `
      );

      let result;

      if (existing.rows.length === 0) {
        result = await query(
          `
          INSERT INTO ai_settings
          (
            is_enabled,
            business_name,
            system_prompt,
            settings
          )
          VALUES ($1,$2,$3,$4::jsonb)
          RETURNING *
          `,
          [
            enabled !== false,
            assistant_name || null,
            system_prompt,
            JSON.stringify({ welcome_message, business_context, fallback_message, human_handoff_enabled: human_handoff_enabled !== false }),
          ]
        );
      } else {
        result = await query(
          `
          UPDATE ai_settings
          SET
            is_enabled = $1,
            business_name = $2,
            system_prompt = $3,
            settings = COALESCE(settings, '{}'::jsonb) || $4::jsonb
          WHERE id = $5
          RETURNING *
          `,
          [
            enabled !== false,
            assistant_name || null,
            system_prompt,
            JSON.stringify({ welcome_message, business_context, fallback_message, human_handoff_enabled: human_handoff_enabled !== false }),
            existing.rows[0].id,
          ]
        );
      }

      res.json({
        success: true,
        ai: result.rows[0],
      });
    } catch (error) {
      logOperationalError("APPLICATION ERROR:", error);

      res.status(500).json({
        error: "Unable to update AI settings",
      });
    }
  }
);

/* =========================================================
   AI DEMO
========================================================= */

const CONFIDENTIAL_METRICS_REPLY = "यह जानकारी हमारी आंतरिक और गोपनीय व्यावसायिक जानकारी है। मैं इसके बजाय हमारी उपलब्ध सेवाओं, कीमतों और संपर्क की जानकारी दे सकता हूँ।";
const PRIVATE_DATA_REPLY = "मैं निजी ग्राहक, आंतरिक या सिस्टम जानकारी साझा नहीं कर सकता। मैं उपलब्ध सेवाओं, प्रकाशित कीमतों और सार्वजनिक संपर्क जानकारी में मदद कर सकता हूँ।";

function isConfidentialChatRequest(text) {
  return /\b(visitor|visitors|traffic|analytics|lead|leads|customer|customers|client|clients|sales|revenue|conversion|conversions|approved|approval|paying|profit|dashboard|report|phone numbers?|emails?|contact details|conversation|messages?|api.?key|password|credentials?|environment variables?|database|sql|system prompt|secret|token|admin|internal|customer list)\b|गोपनीय|आंतरिक|लीड|ग्राहक|विज़िटर|विजिटर|बिक्री|मंज़ूर|अनुमोदित/u.test(text);
}

function isPublicPhone(value) {
  if (typeof value !== "string") return false;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15;
}

app.post("/api/ai/demo", async (req, res) => {
  try {
    const message = req.body?.message;
    if (typeof message !== "string" || !message.trim() || message.length > 2000) {
      return res.status(400).json({ error: "Message must be text between 1 and 2000 characters" });
    }
    const text = message.trim().toLowerCase();
    if (isConfidentialChatRequest(text)) {
      const metricRequest = /\b(how many|count|number of|total|sales|revenue|visitors?|leads?|customers?|approved|approval|conversions?)\b|कितने|कितनी|संख्या|कुल|बिक्री|ग्राहक|लीड|विज़िटर|विजिटर/u.test(text);
      return res.json({ success: true, reply: metricRequest ? CONFIDENTIAL_METRICS_REPLY : PRIVATE_DATA_REPLY });
    }

    // The public chatbot can retrieve only published business fields.
    const [brandResult, servicesResult] = await Promise.all([
      query(`SELECT company_name, tagline, domain_name, email, phone, whatsapp_number, currency, settings FROM brand_settings ORDER BY id ASC LIMIT 1`),
      query(`SELECT name, description, category, price, price_label, maintenance_price, currency, billing_label, features FROM services WHERE is_active = TRUE ORDER BY sort_order ASC, id ASC LIMIT 30`),
    ]);
    const brand = normalizeBrand(brandResult.rows[0] || null);
    const services = servicesResult.rows;
    let reply = `Namaste! Main ${brand?.company_name || "Prime Web Agency"} ka assistant hoon. Main hamari published services, pricing aur public contact details ke baare mein madad kar sakta hoon.`;

    if (/\b(whatsapp|phone|telephone|mobile|contact|call|number)\b|नंबर|फोन|व्हाट्सऐप|संपर्क/u.test(text)) {
      const parts = [];
      if (isPublicPhone(brand?.phone)) parts.push(`Phone: ${brand.phone}`);
      if (isPublicPhone(brand?.whatsapp_number)) parts.push(`WhatsApp: ${brand.whatsapp_number} (https://wa.me/${brand.whatsapp_number.replace(/\D/g, "")})`);
      if (brand?.email) parts.push(`Email: ${brand.email}`);
      reply = parts.length ? `Public contact details: ${parts.join(" | ")}` : "Hamare public contact details ki pushti abhi zaroori hai. Kripya website par diye gaye contact form ka istemal karein.";
    } else if (/\b(price|pricing|cost|charges|rate|maintenance)\b|कीमत|मूल्य|चार्ज/u.test(text)) {
      reply = services.length
        ? `Published services and prices: ${services.map(x => `${x.name}: ${x.price_label || "Starting at"} ${x.currency || brand?.currency || "INR"} ${x.price}${Number(x.maintenance_price) > 0 ? `; maintenance ${x.currency || brand?.currency || "INR"} ${x.maintenance_price} (${x.billing_label || "one-time"})` : ""}.${x.description ? ` ${x.description}` : ""}${Array.isArray(x.features) && x.features.length ? ` Includes: ${x.features.join(", ")}.` : ""}`).join(" | ")}. Final pricing depends on project requirements.`
        : "Published pricing is not currently available. Please contact us for confirmation.";
    } else if (/\b(service|services|website|web development|automation|chatbot)\b|सेवा/u.test(text)) {
      reply = services.length
        ? `Our published services: ${services.map(x => `${x.name} — ${x.description || x.category}`).join(" | ")}`
        : "Please check our website for currently available services.";
    }
    res.json({ success: true, reply, mode: "public-data-rule-based" });
  } catch (error) {
    console.error("AI DEMO ERROR:", error.code || "request failed");
    res.status(500).json({ error: "AI demo failed" });
  }
});

/* =========================================================
   WHATSAPP WEBHOOK FOUNDATION
========================================================= */

app.get("/api/webhooks/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (mode === "subscribe" && token === verifyToken) {
    return res.status(200).send(challenge);
  }

  return res.status(403).send("Verification failed");
});

app.post("/api/webhooks/whatsapp", async (req, res) => {
  try {
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    const signature = req.get("x-hub-signature-256") || "";
    if (!appSecret || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return res.sendStatus(401);
    const expected = `sha256=${crypto.createHmac("sha256", appSecret).update(req.rawBody || Buffer.alloc(0)).digest("hex")}`;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return res.sendStatus(401);
    const statuses = (req.body?.entry || []).flatMap((entry) => entry.changes || []).flatMap((change) => change.value?.statuses || []);
    for (const status of statuses) {
      if (!status.id || !["sent", "delivered", "read", "failed"].includes(status.status)) continue;
      const details = status.errors?.length ? JSON.stringify(status.errors).slice(0, 1000) : null;
      const opaqueMatch = /^pwa-job-(\d+)$/.exec(status.biz_opaque_callback_data || "");
      const queueJobId = opaqueMatch?.[1] || null;
      await query("UPDATE leads SET whatsapp_notification_status=$1,whatsapp_error=$2,whatsapp_updated_at=NOW() WHERE whatsapp_message_id=$3", [status.status, details, status.id]);
      await query("UPDATE lead_attachments SET whatsapp_status=$1,whatsapp_error=$2 WHERE whatsapp_message_id=$3", [status.status, details, status.id]);
      await query("UPDATE whatsapp_notification_queue SET status=$1,provider_message_id=COALESCE(provider_message_id,$2),last_error=$3,updated_at=NOW() WHERE provider_message_id=$2 OR id=$4", [status.status === "failed" ? "failed" : status.status,status.id,details,queueJobId]);
      if (status.status === "failed") await query("UPDATE whatsapp_notification_settings SET last_error=$1,updated_at=NOW() WHERE id=1", [details || "WhatsApp reported delivery failure."]);
    }
    return res.sendStatus(200);

    console.log(
      "📩 WhatsApp webhook received:",
      JSON.stringify(req.body, null, 2)
    );

    /*
      IMPORTANT:

      This endpoint is the foundation for a real Meta WhatsApp
      Cloud API integration.

      Real production integration should additionally verify:
      - Meta webhook signature
      - WhatsApp Business Account
      - phone_number_id
      - access token
      - message/contact mapping
      - conversation creation
      - AI processing
      - outbound WhatsApp API calls
    */

    res.sendStatus(200);
  } catch (error) {
    logOperationalError("WHATSAPP WEBHOOK ERROR:", error);

    res.sendStatus(500);
  }
});

/* =========================================================
   PUBLIC HOME (theme default from brand settings)
========================================================= */

app.get("/", async (req, res) => {
  try {
    const result = await query("SELECT settings->>'theme_default' AS theme_default FROM brand_settings ORDER BY id ASC LIMIT 1");
    const theme = ["light", "dark", "system"].includes(result.rows[0]?.theme_default) ? result.rows[0].theme_default : "system";
    const html = await fs.readFile(path.join(__dirname, "public", "index.html"), "utf8");
    res.type("html").send(html.replace('<html lang="en">', `<html lang="en" data-default-theme="${theme}">`));
  } catch (error) {
    logOperationalError("HOMEPAGE ERROR:", error);
    res.sendFile(path.join(__dirname, "public", "index.html"));
  }
});

/* =========================================================
   ADMIN PAGE
========================================================= */

app.get(["/admin", "/admin/", "/admin.html"], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

/* =========================================================
   404 API HANDLER
========================================================= */

app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API endpoint not found",
  });
});

/* =========================================================
   FRONTEND FALLBACK
========================================================= */

app.get("/{*splat}", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  const databaseStatuses = {
    "22P02": 400,
    "22001": 400,
    "22007": 400,
    "22008": 400,
    "23505": 409,
    "23503": 409,
    "23514": 400,
  };
  const parserStatuses = {
    "entity.parse.failed": 400,
    "entity.too.large": 413,
    "request.size.invalid": 400,
  };
  const candidateStatus = Number(error.statusCode || error.status || databaseStatuses[error.code] || parserStatuses[error.type]);
  const status = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599
    ? candidateStatus
    : 500;

  if (status >= 500) logOperationalError("GLOBAL ERROR:", error);

  const safeMessages = {
    400: "Invalid request",
    401: "Authentication required",
    403: "Access denied",
    404: "Resource not found",
    409: "Request conflicts with existing data",
    413: "Request body is too large",
  };
  const message = status >= 500
    ? "Internal server error"
    : (error.statusCode && typeof error.message === "string" ? error.message : safeMessages[status] || "Request could not be completed");

  res.status(status).json({ error: message });
});

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {
  try {
    await query("SELECT 1");

    console.log("✅ PostgreSQL connected");

    setInterval(() => processWhatsAppQueue(), 5000).unref();
    processWhatsAppQueue();
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log("");
      console.log("==============================================");
      console.log("🚀 PRIME WEB AGENCY SERVER");
      console.log("==============================================");
      console.log(`Listening on 0.0.0.0:${PORT}`);
      console.log("Health check: /api/health");
      console.log("==============================================");
      console.log("");
    });
    server.on("error", (error) => {
      logOperationalError("HTTP SERVER START ERROR:", error);
      process.exit(1);
    });
    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`Received ${signal}; shutting down`);
      server.close(() => {
        pool.end().then(() => process.exit(0)).catch((error) => {
          logOperationalError("DATABASE SHUTDOWN ERROR:", error);
          process.exit(1);
        });
      });
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  } catch (error) {
    logOperationalError("DATABASE STARTUP FAILED:", error);
    process.exit(1);
  }
}

startServer();
