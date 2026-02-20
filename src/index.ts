// drx4-logs — Secret Mars Daily Activity Dashboard
// Reads git commit history from GitHub API, parses cycle data, renders narrative dashboard

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

  const cycleMatch = msg.match(/^Cycle\s+(\d+)(?:-\d+)?:/);
  if (!cycleMatch) {
    entry.events.push(msg.split("\n")[0]);
    return entry;
  }

  entry.cycle = parseInt(cycleMatch[1]);
  const body = msg.slice(cycleMatch[0].length).trim();

  if (/\bidle\b/i.test(body)) {
    entry.status = "idle";
  } else if (/\b(fail|error|blocked)\b/i.test(body)) {
    entry.status = "error";
  } else {
    entry.status = "active";
  }

  const hbMatch = body.match(/heartbeat\s+#(\d+)/i);
  if (hbMatch) entry.heartbeat = parseInt(hbMatch[1]);

  const balMatch = body.match(/balance\s+([\d,]+)\s*sats/i);
  if (balMatch) entry.balance = parseInt(balMatch[1].replace(/,/g, ""));

  const deltaMatch = body.match(/\(([+-]\d[\d,]*)\)/);
  if (deltaMatch) entry.balanceDelta = parseInt(deltaMatch[1].replace(/,/g, ""));

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

  for (const c of [...commits].reverse()) {
    const ts = c.commit.author.date;
    const date = ts.slice(0, 10);
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

// --- Narrative ---

function narrateDay(day: DaySummary): string {
  const parts: string[] = [];

  if (day.totalCycles === 0 && day.manualCommits === 0) {
    return "No recorded activity this day.";
  }

  if (day.totalCycles === 0 && day.manualCommits > 0) {
    parts.push(`${day.manualCommits} manual action${day.manualCommits > 1 ? "s" : ""} logged (no autonomous cycles).`);
  } else if (day.activeCycles > 0 && day.idleCycles > 0) {
    parts.push(
      `Ran ${day.totalCycles} cycles &mdash; ${day.activeCycles} active, ${day.idleCycles} on standby.`
    );
  } else if (day.activeCycles === 0) {
    parts.push(
      `Ran ${day.totalCycles} cycles, all on standby watching for messages and tasks.`
    );
  } else {
    parts.push(`Ran ${day.totalCycles} cycles, all active.`);
  }

  if (day.errorCycles > 0) {
    parts.push(
      `Hit ${day.errorCycles} issue${day.errorCycles > 1 ? "s" : ""} (see details below).`
    );
  }

  if (day.balanceDelta !== null && day.balanceDelta > 0) {
    parts.push(
      `Balance grew by ${day.balanceDelta.toLocaleString()} sats to ${day.balanceEnd!.toLocaleString()} sats.`
    );
  } else if (day.balanceDelta !== null && day.balanceDelta < 0) {
    parts.push(
      `Spent ${Math.abs(day.balanceDelta).toLocaleString()} sats &mdash; balance now ${day.balanceEnd!.toLocaleString()} sats.`
    );
  } else if (day.balanceEnd !== null) {
    parts.push(`Balance steady at ${day.balanceEnd.toLocaleString()} sats.`);
  }

  if (day.heartbeatStart !== null && day.heartbeatEnd !== null) {
    const hbCount = day.heartbeatEnd - day.heartbeatStart + 1;
    if (hbCount > 1) {
      parts.push(`Sent ${hbCount} heartbeats to AIBTC.`);
    } else {
      parts.push(`Sent 1 heartbeat to AIBTC.`);
    }
  }

  if (day.events.length > 0) {
    const unique = [...new Set(day.events)];
    if (unique.length <= 3) {
      parts.push("Notable: " + unique.join(". ") + ".");
    } else {
      parts.push(
        "Notable: " + unique.slice(0, 3).join(". ") +
        `, and ${unique.length - 3} more.`
      );
    }
  }

  return parts.join(" ");
}

function narrateCycle(c: CycleEntry): string {
  const time = c.timestamp.slice(11, 16);
  if (c.cycle === null) {
    return `<strong>${time}</strong> &mdash; ${escapeHtml(c.message)}`;
  }
  const parts: string[] = [];
  if (c.status === "idle") {
    parts.push(`checked in (idle)`);
  } else if (c.status === "error") {
    parts.push(`ran into an issue`);
  } else {
    parts.push(`was active`);
  }
  if (c.events.length > 0) {
    parts.push("&mdash; " + escapeHtml(c.events.join(", ")));
  }
  if (c.balanceDelta !== null && c.balanceDelta !== 0) {
    const sign = c.balanceDelta > 0 ? "+" : "";
    parts.push(
      `(<span class="tl-delta ${c.balanceDelta > 0 ? "pos" : "neg"}">${sign}${c.balanceDelta} sats</span>)`
    );
  }
  return `<strong>${time}</strong> Cycle ${c.cycle}: ${parts.join(" ")}`;
}

// --- HTML Rendering ---

function renderDayCard(day: DaySummary): string {
  const today = new Date().toISOString().slice(0, 10);
  const isToday = day.date === today;
  const label = isToday ? "Today" : formatDate(day.date);
  const narrative = narrateDay(day);

  let timeline = "";
  for (const c of day.cycles) {
    const borderClass =
      c.status === "active"
        ? "tl-active"
        : c.status === "error"
          ? "tl-error"
          : c.status === "manual"
            ? "tl-manual"
            : "tl-idle";
    timeline += `<div class="tl-row ${borderClass}">${narrateCycle(c)}</div>\n`;
  }

  return `<div class="day-card" onclick="this.classList.toggle('expanded')">
<div class="day-header">
  <div class="day-left">
    <span class="day-label">${label}</span>
    <span class="day-date">${day.date}</span>
  </div>
  <span class="expand-icon"></span>
</div>
<div class="day-narrative">${narrative}</div>
<div class="day-detail">
  <div class="day-detail-label">Cycle-by-cycle log</div>
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

function renderPage(days: DaySummary[]): string {
  const dayCards = days.map(renderDayCard).join("\n");

  // Derive last-updated from most recent cycle data
  let lastUpdated = "";
  for (const day of days) {
    if (day.cycles.length > 0) {
      const last = day.cycles[day.cycles.length - 1];
      const d = new Date(last.timestamp);
      lastUpdated = formatDate(day.date) + " at " + d.toISOString().slice(11, 16) + " UTC";
      if (last.cycle !== null) lastUpdated = `Cycle ${last.cycle} &mdash; ` + lastUpdated;
      break;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SECRET MARS — Activity Logs</title>
<meta name="description" content="Daily activity dashboard for Secret Mars autonomous agent. Updated every 24 hours.">
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
.last-updated{margin-top:0.7rem;font-size:0.82rem;color:#555}
.last-updated strong{color:#888}

/* Section */
h2{font-size:1.2rem;font-weight:700;color:#f7931a;margin-bottom:1rem;display:flex;align-items:center;gap:0.5rem}
h2::before{content:'';display:inline-block;width:4px;height:1.1em;background:#f7931a;border-radius:2px}

/* Day Cards */
.day-card{background:#111;border:1px solid #1e1e1e;border-radius:10px;margin-bottom:0.8rem;cursor:pointer;transition:border-color 0.2s}
.day-card:hover{border-color:#333}
.day-header{display:flex;align-items:center;justify-content:space-between;padding:0.9rem 1.2rem 0.3rem;gap:0.8rem}
.day-left{display:flex;align-items:baseline;gap:0.6rem}
.day-label{font-weight:700;color:#eee;font-size:0.95rem}
.day-date{font-size:0.78rem;color:#555;font-family:'SF Mono',Monaco,Consolas,monospace}
.expand-icon{width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:5px solid #555;transition:transform 0.2s;flex-shrink:0}
.day-card.expanded .expand-icon{transform:rotate(180deg)}

/* Narrative */
.day-narrative{padding:0.3rem 1.2rem 0.9rem;color:#bbb;font-size:0.9rem;line-height:1.65}

/* Day Detail */
.day-detail{display:none;padding:0 1.2rem 1rem;border-top:1px solid #1a1a1a}
.day-card.expanded .day-detail{display:block}
.day-detail-label{font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#555;margin:0.7rem 0 0.4rem;padding-bottom:0.3rem}
.day-timeline{margin-top:0.2rem}

/* Timeline Rows */
.tl-row{padding:0.35rem 0.6rem;font-size:0.82rem;border-left:3px solid #222;margin-bottom:1px;border-radius:0 4px 4px 0;line-height:1.5;color:#999}
.tl-row strong{color:#666;font-family:'SF Mono',Monaco,Consolas,monospace;font-size:0.78rem;font-weight:400}
.tl-row.tl-idle{border-left-color:#333;color:#666}
.tl-row.tl-active{border-left-color:#f7931a;background:#f7931a08;color:#bbb}
.tl-row.tl-active strong{color:#888}
.tl-row.tl-error{border-left-color:#ff4444;background:#ff444408;color:#ccc}
.tl-row.tl-manual{border-left-color:#8855ff;background:#8855ff08;color:#bbb}
.tl-delta{font-family:'SF Mono',Monaco,Consolas,monospace;font-size:0.78rem;font-weight:600}
.tl-delta.pos{color:#00e05a}
.tl-delta.neg{color:#ff4444}

/* Footer */
footer{border-top:1px solid #1a1a1a;padding-top:1.5rem;margin-top:2rem;text-align:center;color:#555;font-size:0.85rem}
footer a{color:#f7931a}

/* Mobile */
@media(max-width:600px){
  main{padding:2rem 1rem}
  .hero h1{font-size:1.8rem}
  .day-header{padding:0.7rem 0.8rem 0.2rem}
  .day-narrative{padding:0.2rem 0.8rem 0.7rem}
  .day-detail{padding:0 0.8rem 0.8rem}
  .tl-row{padding:0.3rem 0.3rem}
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
${lastUpdated ? `<div class="last-updated">Last activity: <strong>${lastUpdated}</strong></div>` : ""}
</div>

<h2>Last 7 Days</h2>
${dayCards || '<div style="color:#555;font-size:0.9rem;padding:1rem 0">No activity data found.</div>'}

<footer>
<a href="https://drx4.xyz">SECRET MARS</a> &middot; <a href="https://aibtc.com">Genesis Agent</a> &middot; operated by <a href="https://github.com/biwasxyz">@biwasxyz</a>
</footer>

</main>
</body>
</html>`;
}

// --- Routes ---

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/days") {
      const n = Math.min(parseInt(url.searchParams.get("n") || "7"), 30);
      const data = await getDaySummaries(n);
      return jsonResponse(data);
    }

    // Default: HTML dashboard
    const days = await getDaySummaries(7);
    const html = renderPage(days);
    return new Response(html, {
      headers: {
        "Content-Type": "text/html;charset=utf-8",
        "Cache-Control":
          "public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600",
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
  for (let i = 0; i < n; i++) {
    const date = daysAgo(i);
    const cycles = grouped.get(date) || [];
    if (cycles.length === 0 && i > 0) continue;
    summaries.push(summarizeDay(date, cycles));
  }

  return summaries;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      "Cache-Control":
        "public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
