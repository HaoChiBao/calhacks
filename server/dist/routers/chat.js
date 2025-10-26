// routers/chat.ts
import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import { randomUUID } from "node:crypto";
dotenv.config({ path: ".env.local" }); // load local env if present
// -------------------------------------------------------------------
const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const JSON_MODEL = process.env.OPENAI_JSON_MODEL || "gpt-4o-mini";
const PLACES_API_KEY = process.env.PLACES_API_KEY || "";
// ---------- Logging helpers ----------
const MAX_LOG_LEN = 1200;
const DELTA_LOG_EVERY = Number(process.env.DELTA_LOG_EVERY || 12);
function truncate(v, max = MAX_LOG_LEN) {
    return typeof v === "string" && v.length > max
        ? v.slice(0, max) + `… [${v.length - max} more chars]`
        : v;
}
function safeStringify(obj) {
    try {
        return JSON.stringify(obj);
    }
    catch {
        return "[Unserializable]";
    }
}
function nowMs() { return Date.now(); }
function log(rid, stage, info) {
    const ts = new Date().toISOString();
    const payload = { ts, rid, stage, ...info };
    for (const k of Object.keys(payload)) {
        const v = payload[k];
        if (typeof v === "string")
            payload[k] = truncate(v);
    }
    // eslint-disable-next-line no-console
    console.log(`[chat] ${stage}`, payload);
}
// ---------- Cost normalization (strict formats only) ----------
/**
 * Normalize any input string to one of:
 *   - "free"
 *   - "$N"           (integer)
 *   - "$N–$M"        (integer range, en dash)
 * If it can't be normalized, return undefined (omit from JSON).
 */
function coerceCost(input) {
    if (!input)
        return undefined;
    const raw = String(input).trim().toLowerCase();
    // 1) Free keywords
    if (/\bfree\b/.test(raw) || /\$0\b/.test(raw))
        return "free";
    // Normalize separators like "~", "to", "-", "–" to a single hyphen for parsing
    const sepNormalized = raw
        .replace(/[–—]/g, "-")
        .replace(/\bto\b/g, "-")
        .replace(/~|\s+/g, " ")
        .trim();
    // Pull out all integers (ignore decimals)
    const nums = (sepNormalized.match(/\d{1,6}/g) || []).map(n => parseInt(n, 10)).filter(n => Number.isFinite(n));
    if (nums.length === 1) {
        const n = Math.max(0, nums[0] | 0);
        return `$${n}`;
    }
    if (nums.length >= 2) {
        let [a, b] = nums;
        if (a > b)
            [a, b] = [b, a];
        if (a === b)
            return `$${a}`;
        return `$${a}–$${b}`;
    }
    // "$$", "$$$" style — rough mapping
    if (/^\${2}$/.test(raw))
        return "$10–$25";
    if (/^\${3}$/.test(raw))
        return "$25–$50";
    if (/^\${4,}$/.test(raw))
        return "$50–$100";
    return undefined;
}
// ---------- STRICT JSON schema (3–5 activities / day) ----------
const strictPlanItemSchema = {
    type: "object",
    properties: {
        title: { type: "string" },
        short_description: { type: "string" },
        /**
         * Must be either "free", "$N", or "$N–$M".
         */
        estimated_cost: { type: "string" }
    },
    required: ["title", "short_description"],
    additionalProperties: false
};
/**
 * planDays:
 * - array of days
 * - each day is an array of **3–5** activities
 * - each activity strictly: { title, short_description, estimated_cost? }
 * - activities within a day must be mutually feasible in one day
 *   (clustered by distance, ordered morning→evening, reasonable durations)
 */
const strictSchema = {
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
        planDays: {
            description: "Array of days; each inner array is a single day's plan with **3–5** activities that are mutually feasible within that day (clustered, walkable/short transit, ordered morning→evening).",
            type: "array",
            items: {
                type: "array",
                items: strictPlanItemSchema,
                minItems: 3,
                maxItems: 5
            }
        }
    },
    required: ["replyText", "suggestions", "planDays"],
    additionalProperties: false
};
// ---------- Helpers to enforce strict shape ----------
function suggestionsToStrictDays(suggestions, nights) {
    const days = Math.max(1, nights ?? 1);
    const items = suggestions.map((s) => {
        const normalized = coerceCost(s.estSpend);
        return {
            title: s.name,
            short_description: s.why || s.category || "",
            ...(normalized ? { estimated_cost: normalized } : {}),
        };
    });
    let perDay = Math.ceil(items.length / days);
    perDay = Math.min(5, Math.max(3, perDay));
    const needed = days * perDay;
    const pool = [];
    const denom = Math.max(1, items.length);
    for (let i = 0; i < needed; i++)
        pool.push(items[i % denom]);
    const out = [];
    for (let d = 0; d < days; d++) {
        const start = d * perDay;
        out.push(pool.slice(start, start + perDay));
    }
    return out;
}
function normalizeStrictDays(input) {
    if (!Array.isArray(input))
        return null;
    const out = [];
    for (const day of input) {
        if (!Array.isArray(day))
            return null;
        if (day.length < 3 || day.length > 5)
            return null;
        const strictDay = [];
        for (const it of day) {
            const title = it?.title;
            const shortDesc = it?.short_description ??
                it?.short_desc;
            const estRaw = it?.estimated_cost ??
                it?.est_cost ??
                it?.estSpend;
            if (typeof title !== "string" || typeof shortDesc !== "string")
                return null;
            const normalized = coerceCost(typeof estRaw === "string" ? estRaw : undefined);
            const one = {
                title,
                short_description: shortDesc,
                ...(normalized ? { estimated_cost: normalized } : {}),
            };
            strictDay.push(one);
        }
        out.push(strictDay);
    }
    return out;
}
async function textSearch(query, center, radiusMeters, maxResults = 4) {
    if (!PLACES_API_KEY)
        return [];
    const params = new URLSearchParams({
        query,
        key: PLACES_API_KEY,
    });
    if (center && radiusMeters) {
        params.set("location", `${center.lat},${center.lng}`);
        params.set("radius", String(Math.max(200, Math.min(radiusMeters, 50000))));
    }
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?${params.toString()}`;
    const resp = await fetch(url);
    if (!resp.ok)
        return [];
    const data = await resp.json().catch(() => null);
    if (!data?.results)
        return [];
    const out = [];
    for (const r of data.results.slice(0, maxResults)) {
        if (!r.place_id || !r.geometry?.location)
            continue;
        out.push({
            place_id: r.place_id,
            name: r.name || query,
            lat: r.geometry.location.lat,
            lng: r.geometry.location.lng,
        });
    }
    return out;
}
// A very light category guess to widen alternates when a duplicate is detected
function guessCategoryKeywords(title, shortDesc) {
    const s = `${title} ${shortDesc ?? ""}`.toLowerCase();
    if (/\b(museum|gallery|exhibit)\b/.test(s))
        return "museum";
    if (/\b(park|garden|zoo|aquarium)\b/.test(s))
        return "park";
    if (/\b(shrine|temple|church|cathedral)\b/.test(s))
        return "shrine";
    if (/\b(market|shopping|mall|boutique)\b/.test(s))
        return "shopping";
    if (/\b(lookout|tower|observatory|view)\b/.test(s))
        return "view";
    if (/\b(nightlife|bar|club|izakaya|pub)\b/.test(s))
        return "bar";
    if (/\b(cafe|coffee|tea)\b/.test(s))
        return "cafe";
    return "tourist attraction";
}
// De-duplicate planDays using Places Text Search; maintain 3–5 activities/day
async function dedupeAndEnrichPlanDays(planDays, center, radiusMeters) {
    if (!Array.isArray(planDays) || planDays.length === 0)
        return planDays;
    // Track global uniqueness by place_id and normalized name
    const seenPlaceIds = new Set();
    const seenNames = new Set(); // lowercase, trimmed
    const out = [];
    for (let d = 0; d < planDays.length; d++) {
        const day = planDays[d] ?? [];
        const unique = [];
        // First pass: try to map each activity to a canonical place_id
        for (const act of day) {
            const q = act.title;
            let hits = [];
            try {
                hits = await textSearch(q, center, radiusMeters, 4);
                // If 0 hits, try a light category search near center
                if (hits.length === 0) {
                    const cat = guessCategoryKeywords(act.title, act.short_description);
                    hits = await textSearch(cat, center, radiusMeters, 4);
                }
            }
            catch {
                // ignore
            }
            // Pick first unused hit
            let chosen = null;
            for (const h of hits) {
                const nameKey = h.name?.toLowerCase().trim();
                if (h.place_id && !seenPlaceIds.has(h.place_id) && nameKey && !seenNames.has(nameKey)) {
                    chosen = h;
                    break;
                }
            }
            if (chosen) {
                seenPlaceIds.add(chosen.place_id);
                if (chosen.name)
                    seenNames.add(chosen.name.toLowerCase().trim());
                // Use the canonical name as title (prevents subtle dupes like “Shibuya Crossing” vs “Shibuya Scramble”)
                unique.push({
                    title: chosen.name || act.title,
                    short_description: act.short_description,
                    ...(act.estimated_cost ? { estimated_cost: act.estimated_cost } : {}),
                });
            }
            else {
                // No hit or all hit duplicates — try to at least de-dupe by text name
                const nameKey = act.title.toLowerCase().trim();
                if (!seenNames.has(nameKey)) {
                    seenNames.add(nameKey);
                    unique.push(act);
                }
                // else drop it; we’ll fill below to keep 3–5 items
            }
        }
        // Ensure 3–5 items per day; if we lost items to de-dupe, fill alternates
        const needMin = 3;
        const needMax = 5;
        const want = Math.min(needMax, Math.max(needMin, unique.length));
        while (unique.length < want) {
            // Pull a general alternate nearby (tourist attraction)
            let altHits = [];
            try {
                altHits = await textSearch("tourist attraction", center, radiusMeters, 6);
            }
            catch { /* ignore */ }
            let chosen = null;
            for (const h of altHits) {
                const nameKey = h.name?.toLowerCase().trim();
                if (h.place_id && !seenPlaceIds.has(h.place_id) && nameKey && !seenNames.has(nameKey)) {
                    chosen = h;
                    break;
                }
            }
            if (!chosen)
                break; // cannot fill more
            seenPlaceIds.add(chosen.place_id);
            if (chosen.name)
                seenNames.add(chosen.name.toLowerCase().trim());
            unique.push({
                title: chosen.name,
                short_description: "Notable nearby attraction.",
                // do not invent a cost; leave undefined if we don’t know
            });
        }
        // If we somehow ended > 5 because original day had many unique, trim to 5
        out.push(unique.slice(0, needMax));
    }
    return out;
}
// ---------- Title normalization + de-dupe helpers ----------
function normalizeTitleKey(t) {
    return t
        .toLowerCase()
        .replace(/^[\s]*(visit|explore|walk|tour|see|go to|discover)\s+/g, "") // drop generic prefixes
        .replace(/&/g, "and")
        .replace(/[^a-z0-9\s]/g, "") // remove punctuation
        .replace(/\s+/g, " ")
        .trim();
}
function dedupeWithinDayByTitle(day) {
    const seen = new Set();
    const out = [];
    for (const item of day) {
        const key = normalizeTitleKey(item.title);
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}
// ---------- FINAL CLAMP: Guarantee 3–5 items per day + de-dupe ----------
/**
 * Ensures every day has 3–5 items, removes *within-day* duplicates by normalized title,
 * and truncates anything over 5 automatically. If <3 after de-dup, we fill from suggestions.
 */
function enforceDayCount3to5(planDays, suggestions, nights) {
    const daysCount = Math.max(planDays.length, 1);
    const fallback = suggestionsToStrictDays(suggestions || [], nights ?? daysCount);
    const out = [];
    for (let i = 0; i < daysCount; i++) {
        // 1) de-dupe by title within the day
        let day = dedupeWithinDayByTitle(planDays[i] || []);
        // 2) hard truncate anything over 5 RIGHT AWAY (automatic truncation)
        day = day.slice(0, 5);
        const titles = new Set(day.map(a => normalizeTitleKey(a.title)));
        // 3) ensure min 3 by pulling distinct fillers
        const needMin = 3;
        if (day.length < needMin) {
            const tryPools = [];
            if (fallback[i])
                tryPools.push(fallback[i]);
            if (fallback.length)
                tryPools.push(fallback.flat());
            for (const pool of tryPools) {
                for (const cand of pool) {
                    const key = normalizeTitleKey(cand.title);
                    if (!titles.has(key)) {
                        day.push(cand);
                        titles.add(key);
                        if (day.length >= needMin)
                            break;
                    }
                }
                if (day.length >= needMin)
                    break;
            }
        }
        // 4) final truncate to 5 (in case we overfilled to reach 3–5)
        out.push(day.slice(0, 5));
    }
    return out;
}
// ---------- SSE helpers ----------
function sseHeaders(res) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
}
function sseEvent(res, event, data) {
    const payload = typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data);
    res.write(`event: ${event}\n`);
    res.write(`data: ${payload}\n\n`);
}
function sseClose(res) {
    try {
        res.write(`event: end\ndata: ok\n\n`);
    }
    catch { }
    res.end();
}
// ====================================================================
// PROMPT BUILDERS (anti-duplicate + max 5 hard rule in instructions)
// ====================================================================
const SYSTEM_RULES = [
    "You MUST answer in STRICT JSON only. No preface, no explanations.",
    "Return exactly these keys: replyText (string), suggestions (array), planDays (array of arrays).",
    "planDays details:",
    "- Each inner array is ONE DAY's plan, ordered morning→evening.",
    "- Include **3–5** activities per day (NEVER more than 5). If you draft >5 candidates, PICK THE BEST 5 and STOP.",
    "- Absolutely NO duplicate or near-duplicate titles in the same day (e.g., 'Balboa Park' vs 'Visit Balboa Park' counts as a duplicate; keep only one).",
    "- Avoid repeating essentially the same venue under different names (e.g., 'Gaslamp Quarter Exploration' and 'Gaslamp Quarter'). Keep the most informative phrasing once.",
    "- Activities in the same day must be mutually feasible: clustered (walkable/short transit, <= ~2–3km apart unless transit is obvious), reasonable durations (~60–120m typical), consider opening hours if relevant.",
    "- Each activity strictly has fields: { title, short_description, estimated_cost? }.",
    "- IMPORTANT: estimated_cost must be ONLY one of: 'free', '$N' (integer), or '$N–$M' (integer range with an en dash). No other formats.",
    "- DO NOT include day labels like 'Day 1' outside the JSON. JSON ONLY."
].join(" ");
function userPrompt(minimalPayload) {
    return [
        "Return STRICT JSON with keys: replyText, suggestions, and planDays (strict).",
        "Each day must contain **3–5** activities feasible within the same day (clustered, ordered morning→evening, reasonable duration).",
        "Within a day, DO NOT include duplicate or near-duplicate titles. If two names refer to the same place, keep only ONE.",
        "Each activity object must be exactly { title, short_description, (optional) estimated_cost }.",
        "For estimated_cost use ONLY: 'free', '$N', or '$N–$M' (en dash).",
        "Use 'nights' (default 1) to set the number of days.",
        "Never output more than FIVE items for any day; if you have more than five, select the top five and STOP.",
        "Input:\n" + JSON.stringify(minimalPayload)
    ].join(" ");
}
// ====================================================================
// Non-stream JSON endpoint (strict JSON)
// ====================================================================
const postChat = async (req, res) => {
    const rid = randomUUID();
    const t0 = nowMs();
    log(rid, "request_received", {
        method: "POST",
        path: "/api/chat",
        body: truncate(safeStringify(req.body))
    });
    try {
        const { message, destination, coords, radiusMeters = 2000, preferences = {} } = req.body ?? {};
        if (!message || (!destination && !coords)) {
            res.status(400).json({ error: "Provide 'message' and either 'destination' or 'coords'." });
            return;
        }
        const nights = typeof preferences?.duration?.nights === "number"
            ? preferences.duration.nights
            : undefined;
        const minimalPayload = {
            message,
            destination: destination ?? null,
            coords: coords ?? null,
            radiusMeters,
            groupSize: preferences?.groupSize ?? null,
            nights: nights ?? null,
            nowIso: new Date().toISOString(),
        };
        const completion = await openai.chat.completions.create({
            model: JSON_MODEL,
            temperature: 0.4,
            max_tokens: 1400,
            messages: [
                { role: "system", content: SYSTEM_RULES },
                { role: "user", content: userPrompt(minimalPayload) }
            ],
            response_format: {
                type: "json_schema",
                json_schema: { name: "StrictPlanSchema", schema: strictSchema }
            }
        });
        const content = completion.choices?.[0]?.message?.content || "{}";
        let parsed = JSON.parse(content);
        // Normalize strict planDays or fallback from suggestions
        let planDays = parsed.planDays ? normalizeStrictDays(parsed.planDays) : null;
        if (!planDays || planDays.length === 0) {
            planDays = suggestionsToStrictDays(parsed.suggestions || [], nights);
        }
        // De-duplicate/enrich via Google Places around the intended stay area
        const center = coords ?? undefined;
        if (PLACES_API_KEY) {
            planDays = await dedupeAndEnrichPlanDays(planDays, center, radiusMeters);
        }
        // FINAL: remove within-day duplicates, and AUTOMATICALLY TRUNCATE to max 5, ensure min 3
        planDays = enforceDayCount3to5(planDays, parsed.suggestions || [], nights);
        parsed = { ...parsed, planDays };
        res.status(200).json(parsed);
    }
    catch (e) {
        res.status(500).json({ error: e?.message || "server error" });
    }
    finally {
        log(rid, "request_complete", { ms: nowMs() - t0 });
    }
};
// ====================================================================
// Streaming endpoint — STRICT JSON only (jsonDelta + jsonFinal)
// Streams replyText inside the JSON so the UI can show live chat text.
// ====================================================================
const postChatStream = async (req, res) => {
    const rid = randomUUID();
    const t0 = nowMs();
    log(rid, "request_received", {
        method: "POST",
        path: "/api/chat/stream",
        body: truncate(safeStringify(req.body))
    });
    try {
        const { message, destination, coords, radiusMeters = 2000, preferences = {} } = req.body ?? {};
        if (!message || (!destination && !coords)) {
            res.status(400).json({ error: "Provide 'message' and either 'destination' or 'coords'." });
            return;
        }
        const nights = typeof preferences?.duration?.nights === "number"
            ? preferences.duration.nights
            : undefined;
        sseHeaders(res);
        const ping = setInterval(() => sseEvent(res, "ping", { t: Date.now() }), 15000);
        res.on("close", () => clearInterval(ping));
        res.on("finish", () => clearInterval(ping));
        const minimalPayload = {
            message,
            destination: destination ?? null,
            coords: coords ?? null,
            radiusMeters,
            groupSize: preferences?.groupSize ?? null,
            nights: nights ?? null,
            nowIso: new Date().toISOString(),
        };
        const jsonStream = await openai.chat.completions.create({
            model: JSON_MODEL,
            stream: true,
            temperature: 0.4,
            max_tokens: 1600,
            messages: [
                { role: "system", content: SYSTEM_RULES },
                { role: "user", content: userPrompt(minimalPayload) }
            ],
            response_format: {
                type: "json_schema",
                json_schema: { name: "StrictPlanSchema", schema: strictSchema }
            }
        });
        let jsonBuf = "";
        let jsonChunks = 0;
        for await (const part of jsonStream) {
            const delta = part?.choices?.[0]?.delta?.content ?? "";
            if (!delta)
                continue;
            jsonBuf += delta;
            jsonChunks++;
            if (jsonChunks % DELTA_LOG_EVERY === 0) {
                log(rid, "json_stream_delta", { jsonChunks, total_len: jsonBuf.length });
            }
            sseEvent(res, "jsonDelta", delta);
        }
        try {
            let parsed = JSON.parse(jsonBuf);
            // Normalize costs/shape
            let planDays = parsed.planDays ? normalizeStrictDays(parsed.planDays) : null;
            if (!planDays || planDays.length === 0) {
                planDays = suggestionsToStrictDays(parsed.suggestions || [], nights);
            }
            // De-duplicate/enrich via Google Places around intended area
            const center = coords ?? undefined;
            if (PLACES_API_KEY) {
                planDays = await dedupeAndEnrichPlanDays(planDays, center, radiusMeters);
            }
            // FINAL: remove within-day duplicates, and AUTOMATICALLY TRUNCATE to max 5, ensure min 3
            planDays = enforceDayCount3to5(planDays, parsed.suggestions || [], nights);
            parsed = { ...parsed, planDays };
            sseEvent(res, "jsonFinal", parsed);
        }
        catch {
            sseEvent(res, "error", "Invalid JSON returned by the model.");
        }
        sseClose(res);
    }
    catch (e) {
        try {
            sseEvent(res, "error", e?.message || "server error");
        }
        catch { }
        sseClose(res);
    }
    finally {
        log(rid, "request_complete", { ms: nowMs() - t0 });
    }
};
// ---------- Routes ----------
router.post("/", postChat);
router.post("/stream", postChatStream);
export const chat = router;
