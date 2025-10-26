// src/components/Chat.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../css/Chat.css';
import DestinationAutocomplete from '../components/DestinationAutocomplete';
import DurationRangePicker from '../components/DurationRangePicker';
import PeopleCounter from '../components/PeopleCounter';

type Range = { start: Date | null; end: Date | null };

type ChatProps = {
  hideContent?: boolean;

  destination: string;
  onDestinationChange: (s: string) => void;
  onDestinationSelect?: (coords: { lat: string; lon: string }) => void;

  duration: Range;
  onDurationChange: (r: Range) => void;

  who: number;
  onWhoChange: (n: number) => void;
};

type Suggestion = {
  name: string; category: string; why: string;
  address?: string; distanceMeters?: number; estSpend?: string; hours?: string;
  website?: string; mapHint?: string; tags?: string[];
};

type PlanItem = { title: string; short_desc: string; est_cost?: string };
type PlanDays = PlanItem[][];

type ChatTurn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; suggestions?: Suggestion[] };

// SSE parser that PRESERVES leading spaces/newlines in data
function parseSSEStream(
  onEvent: (event: string, data: string) => void
): (chunk: string) => void {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const frame of parts) {
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
          data += (data ? '\n' : '') + v; // no trim — keep spaces!
        }
      }

      if (data !== '[DONE]') onEvent(ev, data);
    }
  };
}

// Build day-indexed plan on the client if the server didn't send it
function suggestionsToPlanDays(suggestions: Suggestion[], nights?: number): PlanDays {
  const days = Math.max(1, nights ?? 1);
  const items: PlanItem[] = suggestions.map(s => ({
    title: s.name,
    short_desc: s.why || s.category || '',
    est_cost: s.estSpend
  }));

  let perDay = Math.ceil(items.length / days);
  perDay = Math.min(7, Math.max(3, perDay));
  const needed = days * perDay;

  const pool: PlanItem[] = [];
  for (let i = 0; i < needed; i++) {
    pool.push(items[i % Math.max(1, items.length)]);
  }

  const out: PlanDays = [];
  for (let d = 0; d < days; d++) {
    out.push(pool.slice(d * perDay, d * perDay + perDay));
  }
  return out;
}

const Chat: React.FC<ChatProps> = ({
  hideContent,

  destination,
  onDestinationChange,
  onDestinationSelect,

  duration,
  onDurationChange,

  who,
  onWhoChange,
}) => {
  const input = useRef<HTMLTextAreaElement>(null);
  const coordsRef = useRef<{ lat: number; lng: number } | null>(null);
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  // NEW: day-indexed plan state
  const [planDays, setPlanDays] = useState<PlanDays>([
    [
      { title: 'Example: Shibuya Crossing', short_desc: 'Experience the world-famous scramble crossing and vibrant city life.' },
      { title: 'Example: Hachiko Statue', short_desc: 'Quick stop at the famous loyal dog statue.' },
      { title: 'Example: Shibuya Noodle Bar', short_desc: 'Yummy noods', est_cost: '25 CAD' },
    ]
  ]);

  // derive nights
  const nights = useMemo(() => {
    if (duration.start && duration.end) {
      return Math.max(0, Math.round((+duration.end - +duration.start) / (1000 * 60 * 60 * 24)));
    }
    return undefined;
  }, [duration.start, duration.end]);

  // auto-focus after stream completes
  useEffect(() => {
    if (!loading && input.current) {
      input.current.focus();
      input.current.placeholder = 'Type a follow-up… (Shift+Enter for newline)';
    }
  }, [loading]);

  const handleDestinationSelect = useCallback(
    (p: { lat: string; lon: string }) => {
      onDestinationSelect?.(p);
      const lat = parseFloat(p.lat);
      const lng = parseFloat(p.lon);
      coordsRef.current = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    },
    [onDestinationSelect]
  );

  // prior-turn context
  const historyForServer = useMemo(() => {
    return messages.map(m => ({
      role: m.role,
      content: m.content,
      suggestions: m.role === 'assistant' && m.suggestions ? m.suggestions.map(s => s.name) : undefined,
    }));
  }, [messages]);

  const jsonBufferRef = useRef<string>("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorText(null);

    const text = input.current?.value?.trim() ?? '';
    if (!text || loading) return;

    // push user turn
    setMessages(m => [...m, { role: 'user', content: text }]);

    // placeholder assistant turn
    const assistantIndex = messages.length + 1;
    setMessages(m => [...m, { role: 'assistant', content: '' }]);

    const payload = {
      message: text,
      destination: destination || undefined,
      coords: coordsRef.current ? { lat: coordsRef.current.lat, lng: coordsRef.current.lng } : undefined,
      radiusMeters: 2000,
      preferences: {
        groupSize: who,
        duration:
          duration.start && duration.end
            ? {
                startISO: duration.start.toISOString(),
                endISO: duration.end.toISOString(),
                nights
              }
            : null,
      },
      history: historyForServer,
      context: { destination, who, nights }
    };

    try {
      setLoading(true);

      const res = await fetch('http://localhost:8080/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok || !res.body) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Stream error: ${res.status} ${errBody}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');

      let finalReply = '';
      let finalSuggestions: Suggestion[] = [];
      let finalPlanDays: PlanDays = [];

      let gotFinalReply = false;
      let gotSuggestions = false;
      let gotPlanDaysEvent = false;

      jsonBufferRef.current = "";

      const feed = parseSSEStream((event, data) => {
        console.log('[sse]', event, data);

        if (event === 'replyDelta') {
          setMessages((m) => {
            const copy = m.slice();
            const last = copy[assistantIndex] as ChatTurn | undefined;
            if (last && last.role === 'assistant') {
              last.content += data;
            }
            return copy;
          });
        } else if (event === 'replyDone') {
          // no-op
        } else if (event === 'finalReply') {
          finalReply = data;
          gotFinalReply = true;
          setMessages((m) => {
            const copy = m.slice();
            const last = copy[assistantIndex] as ChatTurn | undefined;
            if (last && last.role === 'assistant') last.content = data;
            return copy;
          });
        } else if (event === 'suggestions') {
          try {
            const suggestions: Suggestion[] = JSON.parse(data);
            finalSuggestions = suggestions;
            gotSuggestions = true;
            setMessages((m) => {
              const copy = m.slice();
              const last = copy[assistantIndex] as ChatTurn | undefined;
              if (last && last.role === 'assistant') last.suggestions = suggestions;
              return copy;
            });
            // live fallback planDays if server hasn't sent yet
            if (!gotPlanDaysEvent) {
              setPlanDays(suggestionsToPlanDays(suggestions, nights));
            }
          } catch {}
        } else if (event === 'planDays') {
          try {
            finalPlanDays = JSON.parse(data) as PlanDays;
            setPlanDays(finalPlanDays);
            gotPlanDaysEvent = true;
          } catch {}
        } else if (event === 'jsonDelta') {
          // buffer raw JSON tokens; attempt progressive parse
          jsonBufferRef.current += data;
          console.log('[json.delta]', data);
          try {
            const parsed = JSON.parse(jsonBufferRef.current) as { replyText?: string; suggestions?: Suggestion[]; planDays?: PlanDays };
            if (parsed.replyText) {
              finalReply = parsed.replyText;
              gotFinalReply = true;
              setMessages((m) => {
                const copy = m.slice();
                const last = copy[assistantIndex] as ChatTurn | undefined;
                if (last && last.role === 'assistant') last.content = parsed.replyText!;
                return copy;
              });
            }
            if (Array.isArray(parsed.suggestions)) {
              finalSuggestions = parsed.suggestions;
              gotSuggestions = true;
              setMessages((m) => {
                const copy = m.slice();
                const last = copy[assistantIndex] as ChatTurn | undefined;
                if (last && last.role === 'assistant') last.suggestions = parsed.suggestions!;
                return copy;
              });
              if (!gotPlanDaysEvent) {
                setPlanDays(suggestionsToPlanDays(parsed.suggestions, nights));
              }
            }
            if (Array.isArray(parsed.planDays) && parsed.planDays.length) {
              finalPlanDays = parsed.planDays;
              setPlanDays(finalPlanDays);
              gotPlanDaysEvent = true;
            }
          } catch {
            // partial JSON — ignore until parseable
          }
        } else if (event === 'jsonFinal') {
          try {
            const parsed = JSON.parse(data) as { replyText: string; suggestions: Suggestion[]; planDays?: PlanDays };
            finalReply = parsed.replyText || finalReply;
            finalSuggestions = parsed.suggestions || finalSuggestions;
            finalPlanDays = parsed.planDays && parsed.planDays.length
              ? parsed.planDays
              : (finalSuggestions.length ? suggestionsToPlanDays(finalSuggestions, nights) : finalPlanDays);

            setMessages((m) => {
              const copy = m.slice();
              const last = copy[assistantIndex] as ChatTurn | undefined;
              if (last && last.role === 'assistant') {
                last.content = finalReply;
                last.suggestions = finalSuggestions;
              }
              return copy;
            });
            if (finalPlanDays && finalPlanDays.length) setPlanDays(finalPlanDays);

            console.log('[chat.json:final]', { ...parsed, planDays: finalPlanDays });
            console.log('[chat.json:final:string]', JSON.stringify({ ...parsed, planDays: finalPlanDays }));
          } catch (e) {
            console.warn('jsonFinal parse error', e, data);
          } finally {
            jsonBufferRef.current = "";
          }
        } else if (event === 'error') {
          setErrorText(data || 'Server stream error');
        }

        // consolidated log when ready
        if (gotFinalReply && gotSuggestions && (gotPlanDaysEvent || (finalPlanDays?.length ?? 0) > 0)) {
          const jsonOut = { replyText: finalReply, suggestions: finalSuggestions, planDays: finalPlanDays };
          console.log('[chat.json]', jsonOut);
          console.log('[chat.json:string]', JSON.stringify(jsonOut));
        }
      });

      // read stream
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        feed(decoder.decode(value, { stream: true }));
      }
      feed(decoder.decode());

      // final consolidated log
      if (finalReply || finalSuggestions.length || (finalPlanDays?.length ?? 0) > 0) {
        const jsonOut = { replyText: finalReply, suggestions: finalSuggestions, planDays: finalPlanDays };
        console.log('[chat.json]', jsonOut);
        console.log('[chat.json:string]', JSON.stringify(jsonOut));
      }

      // clear + refocus
      if (input.current) {
        input.current.value = '';
        input.current.focus();
      }
    } catch (err: any) {
      console.error('stream exception', err);
      setErrorText(err?.message || 'Network error');
    } finally {
      setLoading(false);
    }
  };

  // Enter to send; Shift+Enter for newline
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
    }
  };

  return (
    <div className={`chat-area ${hideContent ? '' : 'hidden'}`}>
      <div className="chat">

        {/* simple history */}
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

        {/* Simple inline view of day-indexed plan (optional; adjust to your UI) */}
        {/* <div className="history">
          {planDays.map((day, dIdx) => (
            <div key={dIdx} className="bubble assistant">
              <p><strong>Day {dIdx + 1}</strong></p>
              <ul className="suggestions">
                {day.map((it, idx) => (
                  <li key={idx}>
                    <strong>{it.title}</strong>
                    {it.short_desc ? ` — ${it.short_desc}` : ''}
                    {it.est_cost ? ` • ${it.est_cost}` : ''}
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
            <button id="upload-btn" type="button" disabled={loading}>-</button>
            <button id="submit-btn" type="submit" disabled={loading}>{loading ? '…' : '+'}</button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default Chat;
