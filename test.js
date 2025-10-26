// test.js
/**
 * Simple agent pipeline test (vanilla Node.js)
 *
 * Usage (defaults shown):
 *   node test.js --server http://localhost:8080 --nights 2 --destination "San Diego waterfront" --radius 2000 --group 2
 *
 * Or env:
 *   SERVER=http://localhost:8080 TIMEOUT_MS=120000 node test.js
 */

const defaults = {
  server: 'http://localhost:8080',
  nights: 2,
  destination: 'San Diego waterfront',
  radius: 2000,
  group: 2,
  timeoutMs: Number(process.env.TIMEOUT_MS || 120000),
};

function parseArgs(argv) {
  const out = { ...defaults };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--server') out.server = v, i++;
    else if (k === '--nights') out.nights = Number(v), i++;
    else if (k === '--destination') out.destination = v, i++;
    else if (k === '--radius') out.radius = Number(v), i++;
    else if (k === '--group') out.group = Number(v), i++;
    else if (k === '--lat') out.lat = Number(v), i++;
    else if (k === '--lng') out.lng = Number(v), i++;
  }
  if (!Number.isFinite(out.nights) || out.nights < 1) out.nights = 1;
  if (!Number.isFinite(out.radius) || out.radius < 200) out.radius = 2000;
  if (!Number.isFinite(out.group) || out.group < 1) out.group = 1;
  return out;
}

// Minimal SSE parser that preserves whitespace in data
function createSSEParser(onEvent) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';

    for (const frame of frames) {
      let ev = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) {
          let v = line.slice(6);
          if (v.startsWith(' ')) v = v.slice(1);
          ev = v.replace(/\r$/, '');
        } else if (line.startsWith('data:')) {
          let v = line.slice(5);
          if (v.startsWith(' ')) v = v.slice(1);
          v = v.replace(/\r$/, '');
          data += (data ? '\n' : '') + v;
        }
      }
      onEvent(ev, data);
    }
  };
}

function nowISO() { return new Date().toISOString(); }
function addDaysISO(d) { return new Date(Date.now() + d * 86400000).toISOString(); }

async function main() {
  const cfg = parseArgs(process.argv);

  const payload = {
    message: `please plan a ${cfg.nights}-night ultra-walkable micro-itinerary`,
    destination: cfg.destination,
    coords: (typeof cfg.lat === 'number' && typeof cfg.lng === 'number')
      ? { lat: cfg.lat, lng: cfg.lng }
      : undefined, // optional
    radiusMeters: cfg.radius,
    preferences: {
      groupSize: cfg.group,
      duration: {
        startISO: nowISO(),
        endISO: addDaysISO(cfg.nights),
        nights: cfg.nights,
      },
    },
  };

  console.log('=== TEST CONFIG ===');
  console.log(JSON.stringify({ ...cfg, payload }, null, 2));

  // State to validate
  let announcedDays = null;          // from plan:init
  const dayBuckets = [];             // PlanItem[] per day
  const dayDone = new Set();         // completed dayIdx
  let gotComplete = false;
  const errors = [];

  function ensureDayIndex(idx) {
    while (dayBuckets.length <= idx) dayBuckets.push([]);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('test-timeout'), cfg.timeoutMs);

  let res;
  try {
    res = await fetch(`${cfg.server}/api/agent/plan/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    console.error('❌ Fetch failed:', e);
    process.exitCode = 1;
    clearTimeout(timeout);
    return;
  }

  console.log('\n=== Response ===');
  console.log('Status:', res.status);
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    console.error('❌ Bad response body:\n', text);
    process.exitCode = 1;
    clearTimeout(timeout);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');

  const feed = createSSEParser((event, data) => {
    // Uncomment if you want verbose logs:
    // console.log(`[SSE] ${event}:`, data);

    if (event === 'error') {
      errors.push(`server error: ${data}`);
      return;
    }

    if (event === 'plan:init') {
      try {
        const obj = JSON.parse(data);
        announcedDays = obj.days;
        console.log(`[plan:init] days=${announcedDays}`);
      } catch {
        errors.push('plan:init parse error');
      }
      return;
    }

    if (event === 'plan:event') {
      try {
        const obj = JSON.parse(data);
        const { dayIdx, item } = obj;
        console.log(`[plan:event] day=${dayIdx}, title="${item?.title}"`);
        if (typeof dayIdx !== 'number' || dayIdx < 0) {
          errors.push('plan:event invalid dayIdx');
          return;
        }
        if (!item || !item.title || !item.short_desc) {
          errors.push('plan:event invalid item');
          return;
        }
        ensureDayIndex(dayIdx);
        dayBuckets[dayIdx].push(item);
      } catch {
        errors.push('plan:event parse error');
      }
      return;
    }

    if (event === 'plan:dayDone') {
      try {
        const obj = JSON.parse(data);
        console.log(`[plan:dayDone] day=${obj.dayIdx}`);
        if (typeof obj.dayIdx === 'number' && obj.dayIdx >= 0) {
          dayDone.add(obj.dayIdx);
        } else {
          errors.push('plan:dayDone invalid dayIdx');
        }
      } catch {
        errors.push('plan:dayDone parse error');
      }
      return;
    }

    if (event === 'plan:complete') {
      console.log('[plan:complete]');
      gotComplete = true;
      return;
    }

    // Ignore other events (e.g., open/ping/etc)
  });

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
    feed(decoder.decode());
  } catch (e) {
    errors.push(`stream read error: ${e?.message || e}`);
  } finally {
    clearTimeout(timeout);
  }

  // ---- Validations ----
  console.log('\n=== SUMMARY ===');
  console.log('announcedDays:', announcedDays);
  console.log('dayBuckets:', dayBuckets.map((d, i) => ({ day: i, count: d.length })));
  console.log('dayDone:', [...dayDone].sort((a, b) => a - b));
  console.log('gotComplete:', gotComplete);

  function assert(cond, msg) {
    if (!cond) errors.push(msg);
  }

  assert(announcedDays !== null, 'did not receive plan:init');
  if (announcedDays !== null) {
    assert(
      dayBuckets.length === announcedDays,
      `expected ${announcedDays} day buckets, got ${dayBuckets.length}`
    );
  }
  for (let d = 0; d < (announcedDays || 0); d++) {
    const count = (dayBuckets[d] || []).length;
    assert(count >= 3 && count <= 7, `day ${d}: expected 3–7 items, got ${count}`);
    assert(dayDone.has(d), `day ${d}: missing plan:dayDone`);
  }
  assert(gotComplete, 'missing plan:complete');

  if (errors.length) {
    console.error('\n❌ TEST FAILED');
    for (const e of errors) console.error(' -', e);
    process.exitCode = 1;
  } else {
    console.log('\n✅ TEST PASSED');
  }
}

main().catch((e) => {
  console.error('❌ Fatal error:', e);
  process.exitCode = 1;
});
