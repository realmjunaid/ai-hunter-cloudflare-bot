import {
  InteractionResponseType,
  InteractionType,
  verifyKey,
} from "discord-interactions";

// ====== SETTINGS: this is the only section you normally need to edit ======
// X handles without "@". From free-ai-model-x-accounts.txt (SKIP/NOISE excluded).
const ACCOUNTS = [
  "OpenRouter", "InfronAI", "aimlapi", "cerebras", "opencode",
  "testingcatalog", "rayycfu", "DeRonin_", "sairahul1", "StudentOffersHQ",
  "cline", "JulianGoldieSEO", "RequestyAI", "kilocode", "GroqInc",
  "CerebrasSystems", "togethercompute", "NVIDIAAIDev", "chutes_ai", "SambaNovaAI",
  "FireworksAI_HQ", "poolsideai", "inclusionAI", "Alibaba_Qwen", "deepseek_ai",
  "NousResearch", "UnslothAI", "huggingface", "zefirium", "0xbobaaa",
  "yohakujpn", "alannnfx", "artificialanlys", "calbuldelis69", "0x_kaize",
  "Forhanvv", "maruf_ix",
];
// Post filter: alert only when the SAME post has BOTH a free-access signal
// AND an AI/model signal. Release/campaign words alone are not enough.
const FREE_SIG = /free|gratis|\$0|zero[ -]?cost|credits?|trial|promo|giveaway|quota/i;
const MODEL_SIG = /model|api\b|llm|endpoint|inference|playground|token|tier|chatbot|\bai\b|gpt|claude|gemini|grok|deepseek|qwen|llama|mistral|kimi|glm|minimax|nemotron|ling|flux|whisper|dall|diffusion|openai|anthropic|openrouter|infron|groq|cerebras|together|fireworks|huggingface|nvidia|Muse|requesty|kilocode|chutes|sambanova|nous|hermes|unsloth/i;
const NOISE_SIG = /hiring|webinar|podcast|meetup|birthday|airdrop|presale|congrat|pizza|swag|merch|t-shirt/i;
const INSTANCES = [
  "https://nitter.jaydenha.uk",
  "https://nitter.meowing.monster",
  "https://xcancel.com",
]; // Nitter instances, tried in order. These change often, update when they die.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
// ==========================================================================

const FETCH_TIMEOUT_MS = 15_000;
const SOURCE_DOWN_THROTTLE_MS = 24 * 60 * 60 * 1000; // one "source down" alert per day
const MAX_SEEN_POSTS = 500;
const POST_MAX_AGE_MS = 24 * 60 * 60 * 1000; // only posts from the last 24h

export default {
  async scheduled(event, env, ctx) {
    // Await directly so cron failures are visible in logs/traces.
    // runAll never throws (it settles internally), but keep a guard anyway.
    try {
      // "5 * * * *" (hourly, :05) → X posts; everything else → model sites.
      if (event.cron === "5 * * * *") {
        await runXOnly(env);
      } else {
        await runSites(env);
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "scheduled run failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  },

  // Manual trigger: https://YOUR-WORKER.workers.dev/run?key=RUN_KEY
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Discord slash commands: set this URL as the Interactions Endpoint URL
    // in the Discord Developer Portal.
    if (url.pathname === "/interactions" && request.method === "POST") {
      return handleInteraction(request, env, ctx);
    }
    if (url.pathname !== "/run") {
      return new Response("not found", { status: 404 });
    }
    if (!env.RUN_KEY) {
      console.error(JSON.stringify({ message: "RUN_KEY secret not configured" }));
      return new Response("server misconfigured", { status: 500 });
    }
    const ok = await isValidKey(url.searchParams.get("key") || "", env.RUN_KEY);
    if (!ok) {
      return new Response("unauthorized", { status: 401 });
    }
    // Run inline so errors surface in the HTTP response logs, not dropped.
    try {
      await runAll(env);
      return new Response("done");
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "manual run failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return new Response("run failed", { status: 500 });
    }
  },
};

// Constant-time comparison to avoid leaking the key via timing.
// Hashes both sides first so equal-length is guaranteed (no length leak).
async function isValidKey(provided, expected) {
  try {
    const encoder = new TextEncoder();
    const [a, b] = await Promise.all([
      crypto.subtle.digest("SHA-256", encoder.encode(provided)),
      crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    ]);
    return crypto.subtle.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Exported for local testing (node import), used by checkX below.
export function isRelevantPost(title) {
  if (typeof title !== "string" || !title) return false;
  if (NOISE_SIG.test(title)) return false;
  return FREE_SIG.test(title) && MODEL_SIG.test(title);
}

// ---------- Discord slash commands (/interactions) ----------
async function handleInteraction(request, env, ctx) {
  if (!env.DISCORD_PUBLIC_KEY) {
    console.error(JSON.stringify({ message: "DISCORD_PUBLIC_KEY not configured" }));
    return new Response("interactions not configured", { status: 500 });
  }
  const signature = request.headers.get("X-Signature-Ed25519") || "";
  const timestamp = request.headers.get("X-Signature-Timestamp") || "";
  // Must verify the RAW body — parsing first would break the signature.
  const rawBody = await request.text();
  let valid = false;
  try {
    valid = await verifyKey(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY);
  } catch {
    valid = false;
  }
  if (!valid) return new Response("bad signature", { status: 401 });

  const interaction = safeJsonParse(rawBody, null);
  if (!interaction) return new Response("bad body", { status: 400 });

  // Required for endpoint verification in the Developer Portal.
  if (interaction.type === InteractionType.PING) {
    return Response.json({ type: InteractionResponseType.PONG });
  }
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const data = await routeCommand(env, ctx, interaction);
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { ...data, flags: 64 }, // ephemeral: only you see it
    });
  }
  return Response.json({ type: InteractionResponseType.PONG });
}

async function routeCommand(env, ctx, interaction) {
  const cmd = interaction.data?.name;
  if (cmd === "free") return cmdFree(env);
  if (cmd === "run") {
    ctx.waitUntil(runAll(env));
    return { content: "⏳ Check started — notun kichu pele channel-e post hobe." };
  }
  if (cmd === "watch") return { content: await cmdWatch(env, interaction.data?.options || []) };
  return { content: "Unknown command." };
}

async function cmdFree(env) {
  const specs = [
    ["OpenRouter Free Models", "free_models"],
    ["Infron Free Models", "infron_free_models"],
    ["OpenCode Zen Free Models", "zen_free_models"],
  ];
  const embeds = [];
  for (const [title, key] of specs) {
    const raw = await env.KV.get(key);
    if (!raw) {
      embeds.push({ title: `${title} (?)`, description: "No baseline yet — /run chalao.", color: 0x5865f2 });
      continue;
    }
    const list = normEntries(raw);
    if (!list) {
      embeds.push({ title: `${title} (?)`, description: "Data error.", color: 0x5865f2 });
      continue;
    }
    const names = list.map((e) => e.n);
    for (const [ci, chunk] of chunkNumbered(names).entries()) {
      embeds.push({
        title: ci === 0 ? `${title} (${list.length})` : `${title} (cont.)`,
        description: chunk,
        color: 0x5865f2,
      });
    }
  }
  return { embeds: embeds.slice(0, 10) };
}

async function getWatchAccounts(env) {
  const extraRaw = await env.KV.get("extra_accounts");
  const extra = extraRaw ? safeJsonParse(extraRaw, null) : [];
  const clean = Array.isArray(extra) ? extra.filter((x) => typeof x === "string") : [];
  return { builtIn: ACCOUNTS, extra: clean, all: [...ACCOUNTS, ...clean] };
}

async function cmdWatch(env, options) {
  const sub = options[0]?.name;
  if (sub === "list") {
    const { builtIn, extra } = await getWatchAccounts(env);
    let msg = `**Watching ${builtIn.length + extra.length} X accounts** (${builtIn.length} built-in`;
    msg += extra.length ? `, ${extra.length} added):\n` : "):\n";
    msg += builtIn.map((x) => `@${x}`).join(", ");
    if (extra.length) msg += `\n\nAdded: ${extra.map((x) => `@${x}`).join(", ")}`;
    return msg;
  }
  if (sub === "add") {
    const raw = (options[0]?.options?.[0]?.value || "").trim().replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{1,15}$/.test(raw)) {
      return "❌ Invalid handle — X username (letters, numbers, _ , max 15) dao.";
    }
    const { all, extra } = await getWatchAccounts(env);
    if (all.some((x) => x.toLowerCase() === raw.toLowerCase())) {
      return `⚠️ @${raw} already watched.`;
    }
    extra.push(raw);
    await env.KV.put("extra_accounts", JSON.stringify(extra.slice(-100)));
    return `✅ @${raw} added — porer check theke alerts asbe.`;
  }
  return "Usage: /watch list · /watch add @handle";
}

function hasBindings(env) {
  if (!env.KV) {
    console.error(JSON.stringify({ message: "KV binding missing" }));
    return false;
  }
  return true;
}

async function runAll(env) {
  if (!hasBindings(env)) return;
  await runSites(env);
  await runXOnly(env);
}

async function runSites(env) {
  if (!hasBindings(env)) return;
  logSettled(await Promise.allSettled([checkOpenRouter(env), checkInfron(env), checkZen(env)]));
}

async function runXOnly(env) {
  if (!hasBindings(env)) return;
  logSettled(await Promise.allSettled([checkX(env)]));
}

function logSettled(results) {
  for (const r of results) {
    if (r.status === "rejected") {
      console.error(
        JSON.stringify({
          message: "watcher failed",
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        }),
      );
    }
  }
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// ---------- Discord ----------
const EMBED_GREEN = 0x57f287;
const EMBED_RED = 0xed4245;
const EMBED_BLUE = 0x5865f2;
const EMBED_X = 0x1d9bf0;

function getWebhook(env, specificKey) {
  // Two channels: X alerts vs model alerts. Each falls back to the legacy
  // single DISCORD_WEBHOOK_URL so old setups keep working.
  const raw = (specificKey && env[specificKey]) || env.DISCORD_WEBHOOK_URL;
  if (!raw) {
    console.error(
      JSON.stringify({ message: "Discord webhook secret not configured", key: specificKey }),
    );
    return null;
  }
  try {
    const webhook = new URL(raw);
    if (webhook.protocol !== "https:") throw new Error("non-https webhook");
    return webhook.toString();
  } catch {
    console.error(JSON.stringify({ message: "Discord webhook URL invalid", key: specificKey }));
    return null;
  }
}

const WEBHOOK_X = "DISCORD_X_WEBHOOK_URL";
const WEBHOOK_MODELS = "DISCORD_MODELS_WEBHOOK_URL";

async function postJson(webhook, payload) {
  try {
    const r = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) {
      console.error(
        JSON.stringify({ message: "Discord send failed", status: r.status, body: await r.text() }),
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "Discord send error",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
}

// Numbered list ("1. name") chunked to fit embed descriptions (4096 max).
function chunkNumbered(names, budget = 3900) {
  const chunks = [];
  let cur = "";
  names.forEach((n, i) => {
    const line = `${i + 1}. ${n}\n`;
    if ((cur + line).length > budget) {
      chunks.push(cur);
      cur = "";
    }
    cur += line;
  });
  if (cur) chunks.push(cur);
  return chunks;
}

// Rich embeds, 10 per message (Discord limit), max 5 messages.
async function sendDiscordEmbeds(env, embeds, webhookKey) {
  const webhook = getWebhook(env, webhookKey);
  if (!webhook) return false;
  let ok = true;
  for (const slice of chunkArray(embeds, 10).slice(0, 5)) {
    if (!(await postJson(webhook, { embeds: slice }))) ok = false;
  }
  return ok;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function sendDiscord(env, text, webhookKey) {
  const webhook = getWebhook(env, webhookKey);
  if (!webhook) return false;
  const chunks = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if ((cur + line + "\n").length > 1900) {
      chunks.push(cur);
      cur = "";
    }
    cur += line + "\n";
  }
  if (cur) chunks.push(cur);

  let ok = true;
  for (const c of chunks.slice(0, 5)) {
    if (!(await postJson(webhook, { content: c }))) ok = false;
  }
  return ok;
}

// KV model entries are [{i: id, n: displayName}]; old id-only arrays migrate.
function normEntries(raw) {
  const arr = safeJsonParse(raw, null);
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const e of arr) {
    if (typeof e === "string") out.push({ i: e, n: e });
    else if (e && typeof e.i === "string") {
      out.push({ i: e.i, n: typeof e.n === "string" ? e.n : e.i });
    }
  }
  return out;
}

// ---------- Free-model watchers (OpenRouter / Infron / OpenCode Zen) ----------
// Generic add/remove diffing: each source only needs a URL, KV key and picker.
// Picker returns {i: id, n: displayName} for free models, else null.
function pickOpenRouterFree(m) {
  if (typeof m?.id !== "string") return null;
  const isZero = (v) => v === "0" || v === 0;
  const free = m.id.endsWith(":free") || (isZero(m.pricing?.prompt) && isZero(m.pricing?.completion));
  return free ? { i: m.id, n: typeof m.name === "string" && m.name ? m.name : m.id } : null;
}

function pickInfronFree(m) {
  if (typeof m?.id !== "string") return null;
  // Infron docs: "Free variants carry the :free suffix and are billed at $0.00".
  // Zero min_*_price alone over-matches (trial/search/video endpoints the site
  // does NOT list under ?free=true), so match the suffix only.
  if (!m.id.endsWith(":free")) return null;
  return { i: m.id, n: typeof m.display_name === "string" && m.display_name ? m.display_name : m.id };
}

function pickZenFree(m) {
  if (typeof m?.id !== "string") return null;
  // Zen /v1/models has no pricing field; free models use the "-free" suffix
  // (see opencode.ai/v2/docs/console/models/#free-models). "big-pickle" is the
  // one documented free model without the suffix.
  const free = m.id.endsWith("-free") || m.id === "big-pickle";
  return free ? { i: m.id, n: m.id } : null;
}

async function watchModelList(env, { name, provider, url, kvKey, pick }) {
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        message: `${name} fetch failed`,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return;
  }
  if (!res.ok) {
    console.error(JSON.stringify({ message: `${name} bad status`, status: res.status }));
    return;
  }
  let data;
  try {
    ({ data } = await res.json());
  } catch {
    console.error(JSON.stringify({ message: `${name} invalid JSON` }));
    return;
  }
  if (!Array.isArray(data)) {
    console.error(JSON.stringify({ message: `${name} unexpected shape` }));
    return;
  }

  const current = data.map(pick).filter(Boolean).sort((a, b) => (a.i < b.i ? -1 : a.i > b.i ? 1 : 0));

  const prevRaw = await env.KV.get(kvKey);
  if (!prevRaw) {
    await env.KV.put(kvKey, JSON.stringify(current)); // baseline, no alert
    console.log(JSON.stringify({ message: `${name} baseline saved`, count: current.length }));
    return;
  }

  const prev = normEntries(prevRaw);
  if (!prev) {
    console.error(JSON.stringify({ message: `${kvKey} KV corrupt, resetting baseline` }));
    await env.KV.put(kvKey, JSON.stringify(current));
    return;
  }

  const prevIds = new Set(prev.map((e) => e.i));
  const curIds = new Set(current.map((e) => e.i));
  const added = current.filter((e) => !prevIds.has(e.i));
  const removed = prev.filter((e) => !curIds.has(e.i));
  if (!added.length && !removed.length) return;

  const ts = new Date().toISOString();
  const embeds = [];
  if (added.length) {
    const s = added.length === 1 ? "" : "s";
    for (const [ci, chunk] of chunkNumbered(added.map((e) => e.n)).entries()) {
      embeds.push({
        title: ci === 0 ? `${added.length} New Free Model${s} Added` : "Added (cont.)",
        color: EMBED_GREEN,
        fields: ci === 0 ? [{ name: "Provider", value: provider }] : [],
        description: chunk,
        timestamp: ts,
      });
    }
  }
  if (removed.length) {
    const s = removed.length === 1 ? "" : "s";
    for (const [ci, chunk] of chunkNumbered(removed.map((e) => e.n)).entries()) {
      embeds.push({
        title: ci === 0 ? `${removed.length} Free Model${s} Removed` : "Removed (cont.)",
        color: EMBED_RED,
        fields: ci === 0 ? [{ name: "Provider", value: provider }] : [],
        description: chunk,
        timestamp: ts,
      });
    }
  }

  // Only save the new list if the alert was delivered, otherwise retry next hour
  if (await sendDiscordEmbeds(env, embeds, WEBHOOK_MODELS)) {
    await env.KV.put(kvKey, JSON.stringify(current));
  }
}

function checkOpenRouter(env) {
  return watchModelList(env, {
    name: "OpenRouter",
    provider: "OpenRouter",
    url: "https://openrouter.ai/api/v1/models",
    kvKey: "free_models",
    pick: pickOpenRouterFree,
  });
}

function checkInfron(env) {
  return watchModelList(env, {
    name: "Infron",
    provider: "Infron",
    url: "https://api.infron.ai/v1/models",
    kvKey: "infron_free_models",
    pick: pickInfronFree,
  });
}

function checkZen(env) {
  return watchModelList(env, {
    name: "Zen",
    provider: "OpenCode Zen",
    url: "https://opencode.ai/zen/v1/models",
    kvKey: "zen_free_models",
    pick: pickZenFree,
  });
}

// ---------- X watcher (via Nitter RSS) ----------
async function fetchRss(user) {
  for (const base of INSTANCES) {
    try {
      const r = await fetch(`${base}/${user}/rss`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) continue;
      const xml = await r.text();
      if (xml.includes("<item>")) return xml;
    } catch (err) {
      console.log(
        JSON.stringify({
          message: "Nitter instance failed, trying next",
          instance: base,
          user,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return null; // every instance failed
}

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export function parseItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const b = m[1];
    const title = decodeEntities(b.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "");
    const link = (b.match(/<link>(.*?)<\/link>/)?.[1] || "").trim();
    const path = link.match(/\/([^/]+\/status\/\d+)/)?.[1];
    const dateStr = (b.match(/<(pubDate|published|updated)>(.*?)<\/\1>/)?.[2] || "").trim();
    const ts = dateStr ? Date.parse(dateStr) : NaN;
    return {
      title,
      url: path ? `https://x.com/${path}` : link,
      ts: Number.isNaN(ts) ? 0 : ts, // 0 = unknown date → fail-open (seen-set still dedupes)
    };
  });
}

async function checkX(env) {
  const seenRaw = await env.KV.get("seen_posts");
  const first = !seenRaw;
  const parsed = seenRaw ? safeJsonParse(seenRaw, null) : [];
  const seen = new Set(Array.isArray(parsed) ? parsed : []);
  if (seenRaw && !Array.isArray(parsed)) {
    console.error(JSON.stringify({ message: "seen_posts KV corrupt, resetting" }));
  }
  const fresh = [];
  let failed = 0;
  const cutoff = Date.now() - POST_MAX_AGE_MS;
  const { all: ACCOUNTS_LIVE } = await getWatchAccounts(env);

  // Fetch in parallel batches: 37 sequential RSS fetches against flaky
  // Nitter instances would take minutes (client timeouts, slow cron runs).
  // Total subrequests stay the same, wall-clock drops ~10x.
  const BATCH = 10;
  for (let i = 0; i < ACCOUNTS_LIVE.length; i += BATCH) {
    const batch = ACCOUNTS_LIVE.slice(i, i + BATCH);
    const xmls = await Promise.all(batch.map((user) => fetchRss(user)));
    batch.forEach((user, bi) => {
      const xml = xmls[bi];
      if (!xml) {
        failed++;
        return;
      }
      for (const it of parseItems(xml)) {
        if (!it.url) continue;
        if (it.ts && it.ts < cutoff) continue; // older than 24h — skip, don't even track
        if (!seen.has(it.url) && isRelevantPost(it.title)) fresh.push({ user, ...it });
        seen.add(it.url);
      }
    });
  }

  if (failed === ACCOUNTS_LIVE.length) {
    await notifySourceDown(env);
    return;
  }

  if (first) {
    // First run only builds the baseline, never alerts.
    await env.KV.put("seen_posts", JSON.stringify([...seen].slice(-MAX_SEEN_POSTS)));
    return;
  }
  if (!fresh.length) {
    await env.KV.put("seen_posts", JSON.stringify([...seen].slice(-MAX_SEEN_POSTS)));
    return;
  }

  const ts = new Date().toISOString();
  const embeds = fresh.slice(0, 30).map((p) => ({
    color: EMBED_X,
    author: { name: `@${p.user}` },
    title: p.title.slice(0, 256) || "(no title)",
    url: p.url,
    timestamp: ts,
  }));
  // Persist seen list only if Discord delivered, so failures retry next run.
  if (await sendDiscordEmbeds(env, embeds, WEBHOOK_X)) {
    await env.KV.put("seen_posts", JSON.stringify([...seen].slice(-MAX_SEEN_POSTS)));
  }
}

async function notifySourceDown(env) {
  // Throttle: don't spam Discord every hour while instances are dead.
  const lastRaw = await env.KV.get("x_source_down_at");
  const last = lastRaw ? Number(lastRaw) : 0;
  if (Date.now() - last < SOURCE_DOWN_THROTTLE_MS) return;
  const sent = await sendDiscord(
    env,
    "⚠️ X source down: all Nitter instances failed. Update INSTANCES in src/index.js.",
    WEBHOOK_X,
  );
  if (sent) {
    await env.KV.put("x_source_down_at", String(Date.now()));
  }
}
