// drx4-logs — Secret Mars Daily Activity Dashboard
// Reads git commit history from GitHub API, parses cycle data, renders dashboard

interface Commit {
  sha: string;
  commit: {
    message: string;
    author: { date: string };
  };
}

interface CycleEntry {
  cycle: number | null;
  status: "idle" | "active" | "error" | "manual";
  message: string;
  timestamp: string;
  heartbeat: number | null;
  balance: number | null;
  balanceDelta: number | null;
  events: string[];
}

interface DaySummary {
  date: string;
  cycles: CycleEntry[];
  totalCycles: number;
  activeCycles: number;
  idleCycles: number;
  errorCycles: number;
  manualCommits: number;
  balanceStart: number | null;
  balanceEnd: number | null;
  balanceDelta: number | null;
  heartbeatStart: number | null;
  heartbeatEnd: number | null;
  events: string[];
}

interface Health {
  cycle: number;
  timestamp: string;
  status: string;
  stats: {
    checkin_count: number;
    sbtc_balance: number;
    idle_cycles_count: number;
    tasks_executed: number;
    replies_sent: number;
  };
  next_cycle_at: string;
}

// --- Data Layer ---

async function fetchCommits(since: string, until: string): Promise<Commit[]> {
  const commits: Commit[] = [];
  let page = 1;
  const perPage = 100;

  while (page <= 10) {
    const url = `https://api.github.com/repos/secret-mars/drx4/commits?since=${since}&until=${until}&per_page=${perPage}&page=${page}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "drx4-logs-worker",
      },
    });
    if (!res.ok) break;
    const data: Commit[] = await res.json();
    if (data.length === 0) break;
    commits.push(...data);
    if (data.length < perPage) break;
    page++;
  }

  return commits;
}

async function fetchHealth(): Promise<Health | null> {
  try {
    const res = await fetch(
      "https://raw.githubusercontent.com/secret-mars/drx4/main/daemon/health.json",
      { headers: { "User-Agent": "drx4-logs-worker" } }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// --- Parser ---

function parseCommit(msg: string, timestamp: string): CycleEntry {
  const entry: CycleEntry = {
    cycle: null,
    status: "manual",
    message: msg.split("\n")[0],
    timestamp,
    heartbeat: null,
    balance: null,
    balanceDelta: null,
    events: [],
  };

  // Match "Cycle NNN:" pattern
  const cycleMatch = msg.match(/^Cycle\s+(\d+)(?:-\d+)?:/);
  if (!cycleMatch) {
    // Non-cycle commit (e.g. "Loop adoption: ...")
    entry.events.push(msg.split("\n")[0]);
    return entry;
  }

  entry.cycle = parseInt(cycleMatch[1]);
  const body = msg.slice(cycleMatch[0].length).trim();

  // Determine status
  if (/\bidle\b/i.test(body)) {
    entry.status = "idle";
  } else if (/\b(fail|error|blocked)\b/i.test(body)) {
    entry.status = "error";
  } else {
    entry.status = "active";
  }

  // Extract heartbeat
  const hbMatch = body.match(/heartbeat\s+#(\d+)/i);
  if (hbMatch) entry.heartbeat = parseInt(hbMatch[1]);

  // Extract balance
  const balMatch = body.match(/balance\s+([\d,]+)\s*sats/i);
  if (balMatch) entry.balance = parseInt(balMatch[1].replace(/,/g, ""));

  // Extract balance delta
  const deltaMatch = body.match(/\(([+-]\d[\d,]*)\)/);
  if (deltaMatch) entry.balanceDelta = parseInt(deltaMatch[1].replace(/,/g, ""));

  // Extract notable events (anything that's not just "idle, heartbeat, balance")
  const parts = body.split(",").map((s) => s.trim());
  for (const part of parts) {
    if (/^idle$/i.test(part)) continue;
    if (/^heartbeat\s+#\d+$/i.test(part)) continue;
    if (/^balance\s+[\d,]+\s*sats(\s*\([+-][\d,]+\))?$/i.test(part)) continue;
    if (/^GitHub clean$/i.test(part)) continue;
    if (part.length > 0) entry.events.push(part);
  }

  return entry;
}

function groupByDay(commits: Commit[]): Map<string, CycleEntry[]> {
  const days = new Map<string, CycleEntry[]>();

  // Commits come newest-first from GitHub API, reverse for chronological
  for (const c of [...commits].reverse()) {
    const ts = c.commit.author.date;
    const date = ts.slice(0, 10); // YYYY-MM-DD UTC
    const entry = parseCommit(c.commit.message, ts);
    if (!days.has(date)) days.set(date, []);
    days.get(date)!.push(entry);
  }

  return days;
}

function summarizeDay(date: string, cycles: CycleEntry[]): DaySummary {
  const cycleCounts = { idle: 0, active: 0, error: 0, manual: 0 };
  const allEvents: string[] = [];
  let balanceStart: number | null = null;
  let balanceEnd: number | null = null;
  let heartbeatStart: number | null = null;
  let heartbeatEnd: number | null = null;

  for (const c of cycles) {
    cycleCounts[c.status]++;
    allEvents.push(...c.events);

    if (c.balance !== null) {
      if (balanceStart === null) balanceStart = c.balance;
      balanceEnd = c.balance;
    }
    if (c.heartbeat !== null) {
      if (heartbeatStart === null) heartbeatStart = c.heartbeat;
      heartbeatEnd = c.heartbeat;
    }
  }

  return {
    date,
    cycles,
    totalCycles: cycleCounts.idle + cycleCounts.active + cycleCounts.error,
    activeCycles: cycleCounts.active,
    idleCycles: cycleCounts.idle,
    errorCycles: cycleCounts.error,
    manualCommits: cycleCounts.manual,
    balanceStart,
    balanceEnd,
    balanceDelta:
      balanceStart !== null && balanceEnd !== null
        ? balanceEnd - balanceStart
        : null,
    heartbeatStart,
    heartbeatEnd,
    events: allEvents,
  };
}

// --- Date helpers ---

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// --- HTML Rendering ---

function renderStatusBar(health: Health | null): string {
  if (!health) {
    return `<div class="status-bar"><span class="status-dot off"></span> Status unavailable</div>`;
  }
  const nextAt = new Date(health.next_cycle_at);
  const bal = health.stats.sbtc_balance.toLocaleString();
  return `<div class="status-bar">
<span class="status-dot on"></span>
<span class="status-item"><strong>Cycle ${health.cycle}</strong></span>
<span class="status-sep"></span>
<span class="status-item">${bal} sats</span>
<span class="status-sep"></span>
<span class="status-item">Heartbeat #${health.stats.checkin_count}</span>
<span class="status-sep"></span>
<span class="status-item next-cycle" data-next="${nextAt.toISOString()}">Next cycle: <span class="countdown"></span></span>
</div>`;
}

function renderDayCard(day: DaySummary): string {
  const today = new Date().toISOString().slice(0, 10);
  const isToday = day.date === today;
  const label = isToday ? "Today" : formatDate(day.date);
  const ratio =
    day.totalCycles > 0
      ? Math.round((day.activeCycles / day.totalCycles) * 100)
      : 0;
  const deltaStr =
    day.balanceDelta !== null && day.balanceDelta !== 0
      ? `<span class="delta ${day.balanceDelta > 0 ? "pos" : "neg"}">${day.balanceDelta > 0 ? "+" : ""}${day.balanceDelta.toLocaleString()} sats</span>`
      : "";
  const balStr =
    day.balanceEnd !== null
      ? `<span class="bal">${day.balanceEnd.toLocaleString()} sats</span>`
      : "";
  const eventCount = day.events.length;
  const evtBadge =
    eventCount > 0
      ? `<span class="evt-badge">${eventCount} event${eventCount > 1 ? "s" : ""}</span>`
      : "";
  const errorBadge =
    day.errorCycles > 0
      ? `<span class="err-badge">${day.errorCycles} error${day.errorCycles > 1 ? "s" : ""}</span>`
      : "";

  // Cycle timeline
  let timeline = "";
  for (const c of day.cycles) {
    const time = c.timestamp.slice(11, 16);
    const borderClass =
      c.status === "active"
        ? "tl-active"
        : c.status === "error"
          ? "tl-error"
          : c.status === "manual"
            ? "tl-manual"
            : "tl-idle";
    const cycleLabel =
      c.cycle !== null ? `Cycle ${c.cycle}` : "Manual";
    const evts =
      c.events.length > 0
        ? `<span class="tl-events">${escapeHtml(c.events.join(", "))}</span>`
        : "";
    timeline += `<div class="tl-row ${borderClass}">
<span class="tl-time">${time}</span>
<span class="tl-label">${cycleLabel}</span>
<span class="tl-status">${c.status}</span>
${c.heartbeat !== null ? `<span class="tl-hb">#${c.heartbeat}</span>` : ""}
${c.balance !== null ? `<span class="tl-bal">${c.balance.toLocaleString()}</span>` : ""}
${c.balanceDelta !== null ? `<span class="tl-delta ${c.balanceDelta > 0 ? "pos" : "neg"}">${c.balanceDelta > 0 ? "+" : ""}${c.balanceDelta}</span>` : ""}
${evts}
</div>`;
  }

  return `<div class="day-card" onclick="this.classList.toggle('expanded')">
<div class="day-header">
  <div class="day-left">
    <span class="day-label">${label}</span>
    <span class="day-date">${day.date}</span>
  </div>
  <div class="day-stats">
    ${errorBadge}
    ${evtBadge}
    <span class="day-cycles">${day.totalCycles} cycles${day.manualCommits > 0 ? ` + ${day.manualCommits} manual` : ""}</span>
    ${ratio > 0 ? `<span class="day-ratio">${ratio}% active</span>` : ""}
    ${deltaStr}
    ${balStr}
  </div>
  <span class="expand-icon"></span>
</div>
<div class="day-detail">
  <div class="day-timeline">${timeline}</div>
</div>
</div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPage(days: DaySummary[], health: Health | null): string {
  const dayCards = days.map(renderDayCard).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SECRET MARS — Activity Logs</title>
<meta name="description" content="Daily activity dashboard for Secret Mars autonomous agent.">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#d4d4d4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:1rem;line-height:1.7}
main{max-width:860px;margin:0 auto;padding:3rem 1.5rem}
a{color:#f7931a;text-decoration:none;transition:opacity 0.2s}
a:hover{opacity:0.8;text-decoration:underline}

/* Header */
.hero{text-align:center;margin-bottom:2rem;padding-bottom:1.5rem;border-bottom:1px solid #1a1a1a}
.hero h1{font-size:2.2rem;font-weight:800;color:#f7931a;letter-spacing:0.08em;margin-bottom:0.3rem}
.hero p{color:#777;font-size:1rem}
.hero-links{margin-top:0.6rem;font-size:0.85rem;color:#555}
.hero-links a{color:#888;margin:0 0.4rem}
.hero-links a:hover{color:#f7931a}

/* Status Bar */
.status-bar{display:flex;align-items:center;gap:0.8rem;background:#111;border:1px solid #1e1e1e;border-radius:10px;padding:0.8rem 1.2rem;margin-bottom:2rem;flex-wrap:wrap;font-size:0.9rem}
.status-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.status-dot.on{background:#00e05a;box-shadow:0 0 6px #00e05a80}
.status-dot.off{background:#555}
.status-sep{width:1px;height:1em;background:#2a2a2a}
.status-item{color:#bbb}
.status-item strong{color:#f7931a}
.next-cycle{color:#777}

/* Section */
h2{font-size:1.2rem;font-weight:700;color:#f7931a;margin-bottom:1rem;display:flex;align-items:center;gap:0.5rem}
h2::before{content:'';display:inline-block;width:4px;height:1.1em;background:#f7931a;border-radius:2px}

/* Day Cards */
.day-card{background:#111;border:1px solid #1e1e1e;border-radius:10px;margin-bottom:0.6rem;cursor:pointer;transition:border-color 0.2s}
.day-card:hover{border-color:#333}
.day-header{display:flex;align-items:center;justify-content:space-between;padding:0.9rem 1.2rem;gap:0.8rem;flex-wrap:wrap}
.day-left{display:flex;align-items:baseline;gap:0.6rem}
.day-label{font-weight:700;color:#eee;font-size:0.95rem}
.day-date{font-size:0.78rem;color:#555;font-family:'SF Mono',Monaco,Consolas,monospace}
.day-stats{display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;font-size:0.82rem}
.day-cycles{color:#888}
.day-ratio{color:#f7931a;font-weight:600}
.delta{font-weight:600;font-family:'SF Mono',Monaco,Consolas,monospace;font-size:0.8rem}
.delta.pos{color:#00e05a}
.delta.neg{color:#ff4444}
.bal{color:#666;font-family:'SF Mono',Monaco,Consolas,monospace;font-size:0.8rem}
.evt-badge{background:#f7931a20;color:#f7931a;padding:0.15rem 0.5rem;border-radius:4px;font-size:0.75rem;font-weight:600}
.err-badge{background:#ff444420;color:#ff4444;padding:0.15rem 0.5rem;border-radius:4px;font-size:0.75rem;font-weight:600}
.expand-icon{width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:5px solid #555;transition:transform 0.2s;flex-shrink:0}
.day-card.expanded .expand-icon{transform:rotate(180deg)}

/* Day Detail */
.day-detail{display:none;padding:0 1.2rem 1rem;border-top:1px solid #1a1a1a}
.day-card.expanded .day-detail{display:block}
.day-timeline{margin-top:0.6rem}

/* Timeline Rows */
.tl-row{display:flex;align-items:center;gap:0.5rem;padding:0.3rem 0.5rem;font-size:0.8rem;border-left:3px solid #222;margin-bottom:1px;border-radius:0 4px 4px 0;flex-wrap:wrap}
.tl-row.tl-idle{border-left-color:#333;color:#666}
.tl-row.tl-active{border-left-color:#f7931a;background:#f7931a08}
.tl-row.tl-error{border-left-color:#ff4444;background:#ff444408}
.tl-row.tl-manual{border-left-color:#8855ff;background:#8855ff08}
.tl-time{font-family:'SF Mono',Monaco,Consolas,monospace;color:#555;min-width:3.2rem}
.tl-label{font-weight:600;color:#bbb;min-width:5rem}
.tl-row.tl-idle .tl-label{color:#555}
.tl-status{font-size:0.72rem;text-transform:uppercase;letter-spacing:0.04em;color:#666;min-width:3.5rem}
.tl-row.tl-active .tl-status{color:#f7931a}
.tl-row.tl-error .tl-status{color:#ff4444}
.tl-hb{color:#555;font-size:0.75rem}
.tl-bal{color:#555;font-family:'SF Mono',Monaco,Consolas,monospace;font-size:0.75rem}
.tl-delta{font-family:'SF Mono',Monaco,Consolas,monospace;font-size:0.75rem;font-weight:600}
.tl-delta.pos{color:#00e05a}
.tl-delta.neg{color:#ff4444}
.tl-events{color:#bbb;font-size:0.78rem;flex-basis:100%;padding-left:3.7rem;margin-top:0.1rem}
.tl-row.tl-idle .tl-events{color:#777}

/* Footer */
footer{border-top:1px solid #1a1a1a;padding-top:1.5rem;margin-top:2rem;text-align:center;color:#555;font-size:0.85rem}
footer a{color:#f7931a}

/* Mobile */
@media(max-width:600px){
  main{padding:2rem 1rem}
  .hero h1{font-size:1.8rem}
  .status-bar{font-size:0.82rem;gap:0.5rem;padding:0.6rem 0.8rem}
  .day-header{padding:0.7rem 0.8rem}
  .day-detail{padding:0 0.8rem 0.8rem}
  .tl-events{padding-left:0;flex-basis:100%}
  .tl-row{gap:0.3rem;padding:0.3rem 0.3rem}
}
</style>
</head>
<body>
<main>

<div class="hero">
<h1>SECRET MARS</h1>
<p>Activity Logs</p>
<div class="hero-links">
<a href="https://drx4.xyz">Home</a>
<a href="https://github.com/secret-mars/drx4">GitHub</a>
<a href="https://aibtc.com">AIBTC</a>
</div>
</div>

${renderStatusBar(health)}

<h2>Last 7 Days</h2>
${dayCards || '<div style="color:#555;font-size:0.9rem;padding:1rem 0">No activity data found.</div>'}

<footer>
<a href="https://drx4.xyz">SECRET MARS</a> &middot; <a href="https://aibtc.com">Genesis Agent</a> &middot; operated by <a href="https://github.com/biwasxyz">@biwasxyz</a>
</footer>

</main>
<script>
// Countdown timer for next cycle
function updateCountdown(){
  const el=document.querySelector('.countdown');
  const parent=document.querySelector('.next-cycle');
  if(!el||!parent)return;
  const next=new Date(parent.dataset.next);
  const diff=next-Date.now();
  if(diff<=0){el.textContent='now';return}
  const m=Math.floor(diff/60000);
  const s=Math.floor((diff%60000)/1000);
  el.textContent=m+'m '+s+'s';
}
updateCountdown();
setInterval(updateCountdown,1000);
</script>
</body>
</html>`;
}

// --- Routes ---

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/health") {
      const health = await fetchHealth();
      return jsonResponse(health);
    }

    if (path === "/api/days") {
      const n = Math.min(parseInt(url.searchParams.get("n") || "7"), 30);
      const data = await getDaySummaries(n);
      return jsonResponse(data);
    }

    // Default: HTML dashboard
    const [days, health] = await Promise.all([
      getDaySummaries(7),
      fetchHealth(),
    ]);

    const html = renderPage(days, health);
    return new Response(html, {
      headers: {
        "Content-Type": "text/html;charset=utf-8",
        "Cache-Control":
          "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
      },
    });
  },
} satisfies ExportedHandler;

async function getDaySummaries(n: number): Promise<DaySummary[]> {
  const since = daysAgo(n) + "T00:00:00Z";
  const until = new Date().toISOString();
  const commits = await fetchCommits(since, until);
  const grouped = groupByDay(commits);

  const summaries: DaySummary[] = [];
  // Build day list from most recent to oldest
  for (let i = 0; i < n; i++) {
    const date = daysAgo(i);
    const cycles = grouped.get(date) || [];
    if (cycles.length === 0 && i > 0) continue; // skip empty past days
    summaries.push(summarizeDay(date, cycles));
  }

  return summaries;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      "Cache-Control":
        "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
