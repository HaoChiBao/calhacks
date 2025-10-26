// src/components/Chat.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../css/Chat.css';
import DestinationAutocomplete from '../components/DestinationAutocomplete';
import DurationRangePicker from '../components/DurationRangePicker';
import PeopleCounter from '../components/PeopleCounter';

import type { StrictPlanDays } from '../types/plan';
// If your StrictPlanItem in ../types/plan doesn't yet have `image_url?: string`,
// consider adding it there for full type-safety.

type Range = { start: Date | null; end: Date | null };

type ChatProps = {
  hideContent?: boolean;
  setHideContent?: (b: boolean) => void;

  destination: string;
  onDestinationChange: (s: string) => void;
  onDestinationSelect?: (coords: { lat: string; lon: string }) => void;

  duration: Range;
  onDurationChange: (r: Range) => void;

  who: number;
  onWhoChange: (n: number) => void;


  planDays: StrictPlanDays;
  setPlanDays: React.Dispatch<React.SetStateAction<StrictPlanDays>>;
};

type Suggestion = {
  name: string;
  category: string;
  why: string;
  address?: string;
  distanceMeters?: number;
  estSpend?: string;
  hours?: string;
  website?: string;
  mapHint?: string;
  tags?: string[];
};

type ChatTurn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; suggestions?: Suggestion[] };

// --- helper type guard to narrow assistant turns ---
function isAssistantTurn(
  t: ChatTurn | undefined | null
): t is Extract<ChatTurn, { role: 'assistant' }> {
  return !!t && (t as ChatTurn).role === 'assistant';
}

// --- Robust SSE parser (keeps whitespace, multi-frame safe) ---
function parseSSEStream(
  onEvent: (event: string, data: string) => void
): (chunk: string) => void {
  let buffer = '';
  return (chunk: string): void => {
    buffer += chunk;
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const lines = frame.split('\n');
      let ev = 'message';
      let data = '';

      for (const raw of lines) {
        if (raw.startsWith('event:')) {
          let v = raw.slice(6);
          if (v.startsWith(' ')) v = v.slice(1);
          ev = v.replace(/\r$/, '');
        } else if (raw.startsWith('data:')) {
          let v = raw.slice(5);
          if (v.startsWith(' ')) v = v.slice(1);
          v = v.replace(/\r$/, '');
          data += (data ? '\n' : '') + v; // preserve whitespace + newlines
        }
      }

      if (data !== '[DONE]') onEvent(ev, data);
    }
  };
}

/** Validate strict item shape (without image_url) */
function isStrictItem(x: unknown): x is {
  title: string;
  short_description: string;
  estimated_cost?: string;
} {
  return (
    !!x &&
    typeof x === 'object' &&
    typeof (x as any).title === 'string' &&
    typeof (x as any).short_description === 'string' &&
    (typeof (x as any).estimated_cost === 'undefined' ||
      typeof (x as any).estimated_cost === 'string')
  );
}

/** Normalize a title to catch near-duplicates like "Visit Balboa Park" vs "Balboa Park" */
function normalizeTitleKey(t: string) {
  return t
    .toLowerCase()
    .replace(/^[\s]*(visit|explore|walk|tour|see|go to|discover)\s+/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Dedupe within a single day by normalized title and cap to 5 items */
function dedupeWithinDay(day: Array<{ title: string; short_description: string; estimated_cost?: string }>) {
  const seen = new Set<string>();
  const out: typeof day = [];
  for (const it of day) {
    if (!isStrictItem(it)) continue;
    const key = normalizeTitleKey(it.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
    if (out.length >= 5) break; // cap to 5 immediately
  }
  return out;
}

/** Final pass: dedupe each day and cap to 5 (no min-fill here to avoid fabricating items) */
function sanitizePlanDays(days: StrictPlanDays): StrictPlanDays {
  return (days || []).map((day) => dedupeWithinDay(day)).slice(0); // shallow copy
}

/** Merge progressive plan progress into state, avoiding dupes and capping to 5 per day */
function mergePlanProgress(prev: StrictPlanDays, incoming: StrictPlanDays): StrictPlanDays {
  const out: StrictPlanDays = prev.map((d) => d.slice());
  for (let d = 0; d < incoming.length; d++) {
    if (!out[d]) out[d] = [];
    // build a normalized key set for existing entries
    const existing = out[d];
    const seen = new Set(existing.map((it) => normalizeTitleKey(it.title)));
    for (const it of incoming[d]) {
      if (!isStrictItem(it)) continue;
      if (existing.length >= 5) break; // don't exceed 5 while streaming
      const key = normalizeTitleKey(it.title);
      if (!seen.has(key)) {
        existing.push(it);
        seen.add(key);
      }
    }
    // safety: cap to 5 and dedupe once more
    out[d] = dedupeWithinDay(out[d]);
  }
  return out;
}

/**
 * Extract completed plan objects as they are streamed.
 * - Scans `jsonText` to find `"planDays": [ ... ]`
 * - Then walks the char stream, tracking string/escape/brackets/braces
 * - Yields every fully-closed `{...}` inside each day array as soon as complete
 */
function extractCompletedActivities(jsonText: string): StrictPlanDays {
  const match = /"planDays"\s*:\s*\[/m.exec(jsonText);
  if (!match) return [];
  let i = match.index + match[0].length;

  let inString = false;
  let escape = false;
  let depthSquare = 1; // in the outer `[` of planDays
  let depthCurly = 0;
  let currentDay: any[] | null = null;
  const days: StrictPlanDays = [];

  let objStart = -1;

  while (i < jsonText.length && depthSquare > 0) {
    const ch = jsonText[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      i++;
      continue;
    }

    if (ch === '[') {
      depthSquare++;
      if (depthSquare === 2) currentDay = [];
      i++;
      continue;
    }

    if (ch === ']') {
      if (depthSquare === 2 && currentDay) {
        if (currentDay.length > 0) days.push(currentDay);
        currentDay = null;
      }
      depthSquare--;
      i++;
      continue;
    }

    if (ch === '{') {
      depthCurly++;
      if (depthSquare === 2 && depthCurly === 1) objStart = i;
      i++;
      continue;
    }

    if (ch === '}') {
      if (depthSquare === 2 && depthCurly === 1 && objStart >= 0 && currentDay) {
        const slice = jsonText.slice(objStart, i + 1);
        try {
          const obj = JSON.parse(slice);
          if (isStrictItem(obj)) currentDay.push(obj);
        } catch {
          // ignore malformed partial
        }
        objStart = -1;
      }
      depthCurly--;
      i++;
      continue;
    }

    i++;
  }

  // Deduplicate within each day and cap to 5 as we go
  return days
    .filter((d) => Array.isArray(d) && d.length > 0)
    .map((d) => dedupeWithinDay(d));
}

const Chat: React.FC<ChatProps> = ({
  hideContent,
  setHideContent,

  destination,
  onDestinationChange,
  onDestinationSelect,

  duration,
  onDurationChange,

  who,
  onWhoChange,

  planDays,
  setPlanDays,
}) => {
  console.log(planDays)
  const input = useRef<HTMLTextAreaElement | null>(null);
  const coordsRef = useRef<{ lat: number; lng: number } | null>(null);

  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  // Track the assistant index & streamed text safely
  const assistantIndexRef = useRef<number | null>(null);
  const replyRef = useRef<string>('');           // full reply accumulated so far
  const lastSeenReplyLenRef = useRef<number>(0); // previously applied length to UI

  // Progressive JSON buffer
  const jsonBufferRef = useRef<string>('');
  // Guard to avoid applying deltas after final (prevents duplicate/near-duplicate replay)
  const finalizedRef = useRef<boolean>(false);

  // seed assistant bubble
  useEffect(() => {
    if (messages.length === 0) {
      setMessages([
        {
          role: 'assistant',
          content:
            'Tell me destination + dates + who’s going. I’ll stream your plan as JSON and live chat text.',
        },
      ]);
    }
  }, [messages.length]);

  // derive nights
  const nights = useMemo<number | undefined>(() => {
    if (duration.start && duration.end) {
      const diff = +duration.end - +duration.start;
      const days = Math.round(diff / (1000 * 60 * 60 * 24));
      return Math.max(0, days);
    }
    return undefined;
  }, [duration.start, duration.end]);

  // autofocus after stream completes
  useEffect(() => {
    if (!loading && input.current) {
      input.current.focus();
      input.current.placeholder = 'Type a follow-up… (Shift+Enter for newline)';
    }
  }, [loading]);

  const handleDestinationSelect = useCallback(
    (p: { lat: string; lon: string }): void => {
      onDestinationSelect?.(p);
      const lat = Number.parseFloat(p.lat);
      const lng = Number.parseFloat(p.lon);
      coordsRef.current = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    },
    [onDestinationSelect]
  );

  // minimal chat history
  const historyForServer = useMemo<
    Array<{ role: ChatTurn['role']; content: string; suggestions?: string[] }>
  >(() => {
    return messages.map((m) => {
      if (isAssistantTurn(m)) {
        return {
          role: m.role,
          content: m.content,
          suggestions: m.suggestions?.map((s) => s.name),
        };
      }
      return { role: m.role, content: m.content };
    });
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setErrorText(null);

    setHideContent?.(false);

    const text = (input.current?.value ?? '').trim();
    if (!text || loading) return;

    // reset accumulators
    replyRef.current = '';
    lastSeenReplyLenRef.current = 0;
    jsonBufferRef.current = '';
    finalizedRef.current = false;
    setPlanDays([]); // clear last plan

    // push user + assistant placeholder atomically
    setMessages((prev) => {
      const userTurn: ChatTurn = { role: 'user', content: text };
      const assistantTurn: ChatTurn = { role: 'assistant', content: '' };
      const assistantIndex = prev.length + 1;
      assistantIndexRef.current = assistantIndex;
      return [...prev, userTurn, assistantTurn];
    });

    const payload = {
      message: text,
      destination: destination || undefined,
      coords: coordsRef.current || undefined,
      radiusMeters: 2000,
      preferences: {
        groupSize: who,
        duration:
          duration.start && duration.end
            ? {
                startISO: duration.start.toISOString(),
                endISO: duration.end.toISOString(),
                nights,
              }
            : null,
      },
      history: historyForServer,
    };

    try {
      setLoading(true);

      console.log('[chat] fetch /api/chat/stream ->', payload);
      // const res = await fetch('http://localhost:8080/api/chat/stream', {

      // use api env variable
      const res = await fetch(import.meta.env.VITE_API_BASE + '/api/chat/stream', {
    
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Stream error: ${res.status} ${errBody}`);
      }
      if (!res.body) {
        throw new Error('Readable stream not available on response');
      }

      const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      const startedAt = Date.now();
      console.log('[stream] opened');

      // The ONLY place we react to SSE frames:
      const feed = parseSSEStream((event: string, data: string) => {
        if (event !== 'ping') {
          console.log(
            '[stream:event]',
            event,
            data.length > 200 ? data.slice(0, 200) + '…' : data
          );
        }

        // If we've already applied the final object, ignore any stray deltas
        if (finalizedRef.current && (event === 'jsonDelta' || event === 'planImage' || event === 'planImageError')) {
          return;
        }

        switch (event) {
          case 'jsonDelta': {
            // 1) Accumulate streaming JSON and update replyText progressively
            jsonBufferRef.current += data;

            try {
              const tmp = JSON.parse(jsonBufferRef.current) as {
                replyText?: string;
                planDays?: StrictPlanDays;
              };
              // Progressive text
              if (typeof tmp.replyText === 'string') {
                const full = tmp.replyText;
                const prevLen = lastSeenReplyLenRef.current;
                if (full.length > prevLen) {
                  const deltaText = full.slice(prevLen);
                  replyRef.current += deltaText;
                  lastSeenReplyLenRef.current = full.length;
                  const idx = assistantIndexRef.current;
                  if (idx !== null) {
                    setMessages((m) => {
                      const msg = m[idx];
                      if (!isAssistantTurn(msg)) return m;
                      const copy = m.slice();
                      copy[idx] = { ...msg, content: replyRef.current };
                      return copy;
                    });
                  }
                  console.log('[reply.delta]', { added: deltaText.length, total: full.length });
                }
              }
            } catch {
              // wait for valid JSON
            }

            // 2) Extract any newly completed activities and merge (deduped + capped to 5)
            const progress = extractCompletedActivities(jsonBufferRef.current);
            if (progress.length > 0) {
              setPlanDays((prev) => {
                const merged = mergePlanProgress(prev, progress);
                const lastDay = merged[merged.length - 1];
                const lastItem = lastDay?.[lastDay.length - 1];
                if (lastItem) {
                  console.log('[plan.item.completed]', {
                    day: merged.length,
                    countOnDay: lastDay.length,
                    item: lastItem,
                  });
                }
                return merged;
              });
            }
            break;
          }

          case 'planImage': {
            // Update image URL on a specific activity
            try {
              const { dayIdx, itemIdx, image_url } = JSON.parse(data) as {
                dayIdx: number; itemIdx: number; image_url: string;
              };
              setPlanDays((prev) => {
                const next = prev.map((d) => d.slice());
                if (next[dayIdx] && next[dayIdx][itemIdx]) {
                  next[dayIdx][itemIdx] = { ...next[dayIdx][itemIdx], image_url };
                }
                return next;
              });
            } catch (err) {
              console.warn('[planImage.parse_error]', err, data);
            }
            break;
          }

          case 'planImageError': {
            console.warn('[planImageError]', data);
            break;
          }

          case 'jsonFinal': {
            // Reconcile anything we might have missed — REPLACE instead of merge to avoid duplicates
            try {
              const parsed = JSON.parse(data) as { replyText: string; planDays: StrictPlanDays };
              finalizedRef.current = true;

              // finalize text
              const finalText = parsed.replyText || '';
              const prevLen = lastSeenReplyLenRef.current;
              if (finalText.length > prevLen) {
                const deltaText = finalText.slice(prevLen);
                replyRef.current += deltaText;
                lastSeenReplyLenRef.current = finalText.length;
              }
              const idx = assistantIndexRef.current;
              if (idx !== null) {
                setMessages((m) => {
                  const msg = m[idx];
                  if (!isAssistantTurn(msg)) return m;
                  const copy = m.slice();
                  copy[idx] = { ...msg, content: replyRef.current };
                  return copy;
                });
              }

              // FINAL STATE: replace planDays with sanitized final (deduped + max 5)
              setPlanDays(sanitizePlanDays(parsed.planDays || []));

              console.log('[stream.completed]', {
                ms: Date.now() - startedAt,
                totalReplyLen: replyRef.current.length,
                days: parsed.planDays?.length ?? 0,
              });
            } catch (err) {
              console.warn('[stream.final.parse_error]', err);
            } finally {
              jsonBufferRef.current = '';
            }
            break;
          }

          case 'error': {
            setErrorText(data || 'Server stream error');
            console.error('[stream.error]', data);
            break;
          }

          default:
            // ignore pings and other events (or add cases for suggestions/planDays if you also emit them)
            break;
        }
      });

      // read stream fully
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        feed(chunk);
      }
      // flush trailing bytes
      feed(decoder.decode());

      // safety: ensure we saved the full accumulator
      const idx = assistantIndexRef.current;
      if (idx !== null) {
        setMessages((m) => {
          const msg = m[idx];
          if (!isAssistantTurn(msg)) return m;
          const copy = m.slice();
          copy[idx] = { ...msg, content: replyRef.current || msg.content };
          return copy;
        });
      }

      // clear + refocus
      if (input.current) {
        input.current.value = '';
        input.current.focus();
      }
    } catch (err) {
      console.error('stream exception', err);
      const message = err instanceof Error ? err.message : 'Network error';
      setErrorText(message);
    } finally {
      setLoading(false);
    }
  };

  // Enter to send; Shift+Enter for newline
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
    }
  };

  return (
    <div className={`chat-area ${hideContent ? '' : 'hidden'}`}>
      <div className="chat">
        {/* Chat history — user turns appear instantly; assistant streams from JSON replyText */}
        {(messages.length > 1 || !hideContent) && (

          <div className="history">
          {messages.map((t, i) => (
            <div key={i} className={`bubble ${t.role}`}>
              <p>{t.content}</p>
              {t.role === 'assistant' && t.suggestions && t.suggestions.length > 0 && (
                <ul className="suggestions">
                  {t.suggestions.slice(0, 6).map((s, idx) => (
                    <li key={idx}>
                      <strong>{s.name}</strong>
                      {s.category ? ` — ${s.category}` : ''}
                      {s.why ? ` • ${s.why}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {errorText && <div className="error">{errorText}</div>}
        </div>

        )}

        {/* JSON blocks per day (updates per activity) */}
        {/* <div className="history">
          {planDays.map((day, dIdx) => (
            <div key={dIdx} className="bubble assistant">
              <p>
                <strong>Day {dIdx + 1}</strong> {loading && <em>(streaming…)</em>}
              </p>
              <ul className="suggestions">
                {day.slice(0, 5).map((it, idx) => ( // UI-side cap to 5 as a last resort
                  <li key={idx}>
                    <code>
                      {`{ "title": "${it.title.replace(/"/g, '\\"')}", "short_description": "${it.short_description.replace(/"/g, '\\"')}"${
                        it.estimated_cost ? `, "estimated_cost": "${it.estimated_cost.replace(/"/g, '\\"')}"` : ''
                      }${
                        (it as any).image_url ? `, "image_url": "${String((it as any).image_url).replace(/"/g, '\\"')}"` : ''
                      } }`}
                    </code>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div> */}

        <div className="info-bar">
          <div className="info">
            <p>Destination</p>
            <DestinationAutocomplete
              value={destination}
              onChange={onDestinationChange}
              onSelect={(p) => handleDestinationSelect(p)}
              placeholder="Where you going?"
            />
          </div>

          <div className="info">
            <p>Duration</p>
            <DurationRangePicker
              value={duration}
              onChange={onDurationChange}
              placeholder="How long you staying?"
            />
          </div>

          <div className="info">
            <p>Who</p>
            <PeopleCounter value={who} onChange={onWhoChange} min={1} max={16} />
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <textarea
            ref={input}
            id="chat-area"
            placeholder="Tell me about where you're going ✨"
            disabled={loading}
            onKeyDown={handleKeyDown}
          />
          <div className="buttons">
            <button id="upload-btn" type="button" disabled={loading}>
              -
            </button>
            <button id="submit-btn" type="submit" disabled={loading}>
              {loading ? '…' : '+'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default Chat;
