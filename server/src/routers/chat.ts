// routers/chat.ts
import express, { type RequestHandler } from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import { randomUUID } from "node:crypto";

// dotenv.config();
dotenv.config({ path: ".env.local" }); // load from .env.local first

export interface ChatRequestBody {
  message: string;
  destination?: string;
  coords?: { lat: number; lng: number };
  radiusMeters?: number;
  preferences?: Record<string, unknown>;
}
export interface Suggestion {
  name: string; category: string; why: string;
  address?: string; distanceMeters?: number; estSpend?: string; hours?: string;
  website?: string; mapHint?: string; tags?: string[]; [k: string]: unknown;
}
export interface PlanItem { title: string; short_desc: string; est_cost?: string }
export type PlanDays = PlanItem[][];

export interface ChatResponse {
  replyText: string;
  suggestions: Suggestion[];
  note?: string;
  plan?: Array<{ title: string; short_desc: string; est_cost?: string }>; // legacy, single flat plan
  planDays?: PlanDays; // NEW: index = day-1, each has 3–7 items
}

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// ------------------------------------
// Speed knobs / model choices
// ------------------------------------
const FAST_MODEL = process.env.OPENAI_FAST_MODEL || "gpt-4o-mini"; // low TTFT / fast streaming
const JSON_MODEL = process.env.OPENAI_JSON_MODEL || FAST_MODEL;    // use same fast model by default

// ---------- Logging helpers ----------
const MAX_LOG_LEN = 1200;
const DELTA_LOG_EVERY = Number(process.env.DELTA_LOG_EVERY || 12); // throttle delta logs

function truncate(v: unknown, max = MAX_LOG_LEN) {
  return typeof v === "string" && v.length > max
    ? v.slice(0, max) + `… [${v.length - max} more chars]`
    : v;
}
function safeStringify(obj: any) {
  try { return JSON.stringify(obj); } catch { return "[Unserializable]"; }
}
function nowMs() { return Date.now(); }
function log(rid: string, stage: string, info: Record<string, any>) {
  const ts = new Date().toISOString();
  const payload: Record<string, any> = { ts, rid, stage, ...info };
  for (const k of Object.keys(payload)) {
    const v = payload[k];
    if (typeof v === "string") payload[k] = truncate(v);
  }
  // eslint-disable-next-line no-console
  console.log(`[chat] ${stage}`, payload);
}

// ---------- JSON schema (extended to include planDays) ----------
const planItemSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    short_desc: { type: "string" },
    est_cost: { type: "string" }
  },
  required: ["title", "short_desc"],
  additionalProperties: true
} as const;

const schema = {
  type: "object",
  properties: {
    replyText: { type: "string" },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          category: { type: "string" },
          address: { type: "string" },
          distanceMeters: { type: "number" },
          why: { type: "string" },
          estSpend: { type: "string" },
          hours: { type: "string" },
          website: { type: "string" },
          mapHint: { type: "string" },
          tags: { type: "array", items: { type: "string" } }
        },
        required: ["name", "category", "why"],
        additionalProperties: true
      }
    },
    // NEW: planDays — array (days) of arrays (3–7 items each)
    planDays: {
      type: "array",
      items: {
        type: "array",
        items: planItemSchema,
        minItems: 3,
        maxItems: 7
      }
    }
  },
  required: ["replyText", "suggestions"],
  additionalProperties: false
} as const;

// ---------- Core helpers ----------
// Short system prompt for faster TTFT; instruct minimal reasoning in text.
const system = [
  "You are a hyper-local trip concierge.",
  "Provide concrete nearby suggestions and short micro-itineraries.",
  "Keep internal reasoning minimal; do not explain your steps.",
  "Prefer walkable clusters and logical sequencing; minimize backtracking.",
  "Stay within the requested radius when possible.",
  "Use coords as the origin for rough distance estimates."
].join(" ");

function toPlan(suggestions: Suggestion[]): PlanItem[] {
  return suggestions.map(s => ({
    title: s.name,
    short_desc: s.why || s.category || "",
    est_cost: s.estSpend
  }));
}

// Build **planDays** with 3–7 items per day, filling every day
function toPlanDays(suggestions: Suggestion[], nights?: number): PlanDays {
  const days = Math.max(1, nights ?? 1);
  const base: PlanItem[] = toPlan(suggestions);

  // Target items per day between 3 and 7
  let perDay = Math.ceil(base.length / days);
  perDay = Math.min(7, Math.max(3, perDay));

  const needed = days * perDay;

  // If we don't have enough, repeat cyclically (acceptable for scaffolding)
  const pool: PlanItem[] = [];
  for (let i = 0; i < needed; i++) {
    pool.push(base[i % Math.max(1, base.length)]);
  }

  // Distribute sequentially into day buckets
  const out: PlanDays = [];
  for (let d = 0; d < days; d++) {
    const start = d * perDay;
    out.push(pool.slice(start, start + perDay));
  }
  return out;
}

// ---------- SSE helpers ----------
function sseHeaders(res: express.Response) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
}
function sseEvent(res: express.Response, event: string, data: any) {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  res.write(`event: ${event}\n`);
  res.write(`data: ${payload}\n\n`);
}
function sseClose(res: express.Response) {
  try { res.write(`event: end\ndata: ok\n\n`); } catch {}
  res.end();
}

// ====================================================================
// Non-stream JSON endpoint (debug/tools)
// ====================================================================
const postChat: RequestHandler<
  Record<string, never>,
  ChatResponse | { error: string; note?: string },
  ChatRequestBody
> = async (req, res) => {
  const rid = randomUUID();
  const t0 = nowMs();
  log(rid, "request_received", {
    method: "POST",
    path: "/api/chat",
    body: truncate(safeStringify(req.body))
  });

  try {
    const { message, destination, coords, radiusMeters = 2000, preferences = {} } = req.body ?? {};
    log(rid, "input_parsed", {
      message, destination, coords: safeStringify(coords),
      radiusMeters, preferences: truncate(safeStringify(preferences))
    });

    if (!message || (!destination && !coords)) {
      log(rid, "input_validation_failed", { reason: "missing message or destination/coords" });
      res.status(400).json({ error: "Provide 'message' and either 'destination' or 'coords'." });
      return;
    }

    const nights =
      typeof (preferences as any)?.duration?.nights === "number"
        ? (preferences as any).duration.nights
        : undefined;
    log(rid, "nights_computed", { nights });

    // Minified payload → faster TTFT
    const minimalPayload = {
      message,
      destination: destination ?? null,
      coords: coords ?? null,
      radiusMeters,
      groupSize: (preferences as any)?.groupSize ?? null,
      nights: nights ?? null,
      nowIso: new Date().toISOString(),
    };
    log(rid, "openai_build_payload", { minimalPayload: truncate(safeStringify(minimalPayload)) });

    const tCall = nowMs();
    const completion = await openai.chat.completions.create({
      model: JSON_MODEL,
      temperature: 0.5,
      max_tokens: 800,
      presence_penalty: 0,
      frequency_penalty: 0,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content:
            "Return STRICT JSON with keys: replyText, suggestions, and planDays (array where each index is a day, each with 3-7 activities). " +
            "Every day must be filled with 3-7 concrete activities/places to visit. " +
            "Input:\n" + JSON.stringify(minimalPayload)
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "ChatRecSchema", schema }
      } as any
    });
    const tCallEnd = nowMs();
    const content = completion.choices?.[0]?.message?.content || "{}";
    log(rid, "openai_response", {
      ms: tCallEnd - tCall,
      content_len: content.length,
      preview: truncate(content, 300)
    });

    try {
      const parsed = JSON.parse(content) as ChatResponse;
      const planDays = parsed.planDays && parsed.planDays.length
        ? parsed.planDays
        : toPlanDays(parsed.suggestions || [], nights);
      const out: ChatResponse = { ...parsed, planDays };
      log(rid, "response_parsed", {
        suggestions_count: parsed.suggestions?.length ?? 0,
        days: planDays.length,
        first_day_items: planDays[0]?.length ?? 0
      });
      res.status(200).json(out);
    } catch (e: any) {
      log(rid, "response_parse_failed", { error: e?.message, fallback_text_len: content.length });
      res.status(200).json({
        replyText: content,
        suggestions: [],
        planDays: [[]],
        note: "Model did not return valid JSON; delivered raw text."
      } as any);
    }
  } catch (e: any) {
    log(rid, "server_error", { error: e?.message, stack: e?.stack && truncate(String(e.stack), 1500) });
    res.status(500).json({ error: e?.message || "server error" });
  } finally {
    log(rid, "request_complete", { ms: nowMs() - t0 });
  }
};

// ====================================================================
// Streaming endpoint — faster start, JSON stream; emits planDays
// ====================================================================
const postChatStream: RequestHandler<
  Record<string, never>,
  any,
  ChatRequestBody
> = async (req, res) => {
  const rid = randomUUID();
  const t0 = nowMs();
  log(rid, "request_received", {
    method: "POST",
    path: "/api/chat/stream",
    body: truncate(safeStringify(req.body))
  });

  try {
    const { message, destination, coords, radiusMeters = 2000, preferences = {} } = req.body ?? {};
    log(rid, "input_parsed", {
      message, destination, coords: safeStringify(coords),
      radiusMeters, preferences: truncate(safeStringify(preferences))
    });

    if (!message || (!destination && !coords)) {
      log(rid, "input_validation_failed", { reason: "missing message or destination/coords" });
      res.status(400).json({ error: "Provide 'message' and either 'destination' or 'coords'." });
      return;
    }

    const nights =
      typeof (preferences as any)?.duration?.nights === "number"
        ? (preferences as any).duration.nights
        : undefined;
    log(rid, "nights_computed", { nights });

    sseHeaders(res);
    log(rid, "sse_headers_sent", {});

    // Immediate heartbeat + keepalive
    sseEvent(res, "open", { ok: true });
    const ping = setInterval(() => sseEvent(res, "ping", { t: Date.now() }), 15000);
    res.on("close", () => clearInterval(ping));
    res.on("finish", () => clearInterval(ping));

    // Minified payload for the **first** (NL) call
    const minimalPayload = {
      message,
      destination: destination ?? null,
      coords: coords ?? null,
      radiusMeters,
      groupSize: (preferences as any)?.groupSize ?? null,
      nights: nights ?? null,
      nowIso: new Date().toISOString(),
    };
    log(rid, "openai_build_payload_min", { minimalPayload: truncate(safeStringify(minimalPayload)) });

    // Optional prefill so users see something instantly
    sseEvent(res, "replyDelta", "Thinking through nearby options…\n");

    // 1) Stream NL reply (FAST model; concise output; capped tokens)
    const tStreamCall = nowMs();
    const stream = await openai.chat.completions.create({
      model: FAST_MODEL,
      stream: true,
      temperature: 0.5,
      max_tokens: 650,
      presence_penalty: 0,
      frequency_penalty: 0,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content:
            "Write a concise, vivid plan of things to do nearby. Keep reasoning minimal; do not explain steps. " +
            "Do NOT output JSON here—just natural language. Input:\n" + JSON.stringify(minimalPayload)
        }
      ]
    });
    log(rid, "openai_stream_started", { ms_to_start: nowMs() - tStreamCall });

    let replyText = "";
    let chunks = 0;
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content ?? "";
      if (!delta) continue;
      replyText += delta;
      chunks++;
      if (chunks % DELTA_LOG_EVERY === 0) {
        log(rid, "stream_delta", { chunk_index: chunks, delta_len: delta.length, total_len: replyText.length });
      }
      sseEvent(res, "replyDelta", delta); // client preserves whitespace
    }
    log(rid, "openai_stream_complete", { chunks, total_len: replyText.length });
    sseEvent(res, "replyDone", { length: replyText.length });

    // 2) Structured suggestions + planDays (STREAMED JSON tokens)
    const tSuggest = nowMs();
    const jsonStream = await openai.chat.completions.create({
      model: JSON_MODEL,
      stream: true,
      temperature: 0.4,
      max_tokens: 1000,
      presence_penalty: 0,
      frequency_penalty: 0,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content:
            "Return STRICT JSON with keys: replyText, suggestions, and planDays. " +
            "planDays must be an array where each index corresponds to a day of the trip; each day MUST have 3-7 activities (objects with title, short_desc, optional est_cost). " +
            "Use the nights value to determine number of days (default 1 if missing). " +
            "Input:\n" + JSON.stringify({ ...minimalPayload, draftedReply: replyText })
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "ChatRecSchema", schema }
      } as any
    });
    log(rid, "openai_json_stream_started", { ms_to_start: nowMs() - tSuggest });

    let jsonBuf = "";
    let jsonChunks = 0;
    for await (const part of jsonStream) {
      const delta = part?.choices?.[0]?.delta?.content ?? "";
      if (!delta) continue;
      jsonBuf += delta;
      jsonChunks++;
      if (jsonChunks % DELTA_LOG_EVERY === 0) {
        log(rid, "json_stream_delta", { jsonChunks, delta_len: delta.length, total_len: jsonBuf.length });
      }
      sseEvent(res, "jsonDelta", delta);
    }
    log(rid, "openai_json_stream_complete", { jsonChunks, total_len: jsonBuf.length });

    try {
      const parsed = JSON.parse(jsonBuf) as ChatResponse;
      const planDays = parsed.planDays && parsed.planDays.length
        ? parsed.planDays
        : toPlanDays(parsed.suggestions || [], nights);

      // Back-compat events (old clients)
      sseEvent(res, "suggestions", parsed.suggestions ?? []);
      sseEvent(res, "finalReply", parsed.replyText ?? replyText);

      // NEW: emit planDays (day-indexed)
      sseEvent(res, "planDays", planDays);

      // Final parsed JSON snapshot
      sseEvent(res, "jsonFinal", { ...parsed, planDays });

      log(rid, "json_stream_parsed", {
        suggestions_count: parsed.suggestions?.length ?? 0,
        days: planDays.length,
        first_day_items: planDays[0]?.length ?? 0
      });
    } catch (e: any) {
      log(rid, "json_stream_parse_failed", { error: e?.message, preview: truncate(jsonBuf, 300) });
      sseEvent(res, "suggestions", []);
      sseEvent(res, "planDays", [[]]); // emit empty day for shape
      sseEvent(res, "finalReply", replyText);
      sseEvent(res, "note", "Model did not return valid JSON for suggestions/planDays; sent fallback.");
    }

    sseClose(res);
    log(rid, "sse_connection_closed", {});
  } catch (e: any) {
    log(rid, "server_error", { error: e?.message, stack: e?.stack && truncate(String(e.stack), 1500) });
    try { sseEvent(res, "error", e?.message || "server error"); } catch {}
    sseClose(res);
  } finally {
    log(rid, "request_complete", { ms: nowMs() - t0 });
  }
};

// ---------- Routes ----------
router.post("/", postChat);             // non-stream JSON
router.post("/stream", postChatStream); // SSE stream

export const chat = router;
