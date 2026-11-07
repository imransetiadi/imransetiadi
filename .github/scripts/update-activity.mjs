// Generates the GitHub activity section of README.md.
// Usage: GITHUB_TOKEN=... node .github/scripts/update-activity.mjs [username]
import { readFile, writeFile } from "node:fs/promises";

const USER = process.argv[2] || process.env.GH_USER || "imransetiadi";
const TOKEN = process.env.GITHUB_TOKEN;
const README = process.env.README_PATH || "README.md";
const START = "<!-- GITHUB_ACTIVITY_START -->";
const END = "<!-- GITHUB_ACTIVITY_END -->";
const TZ = process.env.TZ_NAME || "Asia/Jakarta";
const TZ_LABEL = process.env.TZ_LABEL || "WIB";
const COMMITS_PER_REPO = Number(process.env.COMMITS_PER_REPO || 300); // sample size per repo
const MAX_REPOS_SCANNED = 15;

if (!TOKEN) throw new Error("GITHUB_TOKEN is required");

const headers = {
  Authorization: `bearer ${TOKEN}`,
  "User-Agent": "profile-activity",
  Accept: "application/vnd.github+json",
};

async function gql(query, variables = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && !json.errors) return json.data;
    if (attempt >= 3) throw new Error(`GraphQL ${res.status}: ${JSON.stringify(json.errors || json)}`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

async function rest(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : "0.0");
const fmtDate = (d) =>
  new Date(d.length === 10 ? d + "T00:00:00Z" : d).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: d.length === 10 ? "UTC" : TZ,
  });
const bar = (v, max, width = 25) => {
  const exact = max ? (v / max) * width : 0;
  let full = Math.floor(exact);
  const partials = " ▏▎▍▌▋▊▉";
  let frac = Math.round((exact - full) * 8);
  if (frac === 8) { full++; frac = 0; }
  const s = "█".repeat(full) + (full < width && frac ? partials[frac] : "");
  return s.padEnd(width, "░").slice(0, width);
};
const SPARK = "▁▂▃▄▅▆▇█";
const spark = (vals) => {
  const max = Math.max(...vals, 1);
  return vals.map((v) => (v === 0 ? "·" : SPARK[Math.min(7, Math.floor((v / max) * 7.999))])).join("");
};
const delta = (now, prev) => {
  if (!prev) return now ? "🆕" : "—";
  const d = ((now - prev) / prev) * 100;
  return `${d >= 0 ? "📈 +" : "📉 "}${d.toFixed(0)}%`;
};
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  if (s < 86400 * 365) return `${Math.round(s / 86400 / 30)} mo ago`;
  return `${(s / 86400 / 365).toFixed(1)} y ago`;
};
const localParts = (iso) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23", weekday: "short" })
      .formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  );
  return { hour: Number(p.hour) % 24, weekday: p.weekday };
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------------------------------------------------------------------------
// 1. profile + current year
// ---------------------------------------------------------------------------
const data = await gql(
  `query($login:String!){
    user(login:$login){
      id createdAt
      followers{totalCount} following{totalCount} starredRepositories{totalCount}
      prAll:pullRequests{totalCount} prMerged:pullRequests(states:MERGED){totalCount}
      prOpen:pullRequests(states:OPEN){totalCount} prClosed:pullRequests(states:CLOSED){totalCount}
      issAll:issues{totalCount} issOpen:issues(states:OPEN){totalCount}
      repositoriesContributedTo(includeUserRepositories:false, contributionTypes:[COMMIT,PULL_REQUEST,ISSUE]){totalCount}
      repositories(ownerAffiliations:OWNER, isFork:false, first:100, orderBy:{field:PUSHED_AT,direction:DESC}){
        totalCount
        nodes{ name nameWithOwner url description isPrivate pushedAt createdAt stargazerCount forkCount
          primaryLanguage{name}
          languages(first:10, orderBy:{field:SIZE,direction:DESC}){ edges{ size node{ name } } } }
      }
      forks:repositories(ownerAffiliations:OWNER, isFork:true){totalCount}
      contributionsCollection{
        totalCommitContributions totalIssueContributions totalPullRequestContributions
        totalPullRequestReviewContributions totalRepositoriesWithContributedCommits
        totalRepositoryContributions restrictedContributionsCount
        contributionYears
        contributionCalendar{ totalContributions weeks{ contributionDays{ date contributionCount } } }
        commitContributionsByRepository(maxRepositories:25){
          repository{ nameWithOwner url isPrivate primaryLanguage{name} stargazerCount
            defaultBranchRef{ name } }
          contributions{ totalCount } }
        pullRequestContributionsByRepository(maxRepositories:10){
          repository{ nameWithOwner } contributions{ totalCount } }
      }
    }
  }`,
  { login: USER },
);

const u = data.user;
const c = u.contributionsCollection;
const days = c.contributionCalendar.weeks.flatMap((w) => w.contributionDays);
const total = c.contributionCalendar.totalContributions;

// ---------------------------------------------------------------------------
// 2. contributions per year (all-time)
// ---------------------------------------------------------------------------
const years = [...c.contributionYears].sort();
const yearAliases = years
  .map((y) => `y${y}:contributionsCollection(from:"${y}-01-01T00:00:00Z", to:"${y}-12-31T23:59:59Z"){
      contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}} totalCommitContributions totalPullRequestContributions
      totalIssueContributions totalPullRequestReviewContributions totalRepositoryContributions }`)
  .join("\n");
const yearData = years.length
  ? (await gql(`query($login:String!){ user(login:$login){ ${yearAliases} } }`, { login: USER })).user
  : {};
const perYear = years.map((y) => ({ year: y, ...yearData[`y${y}`] }));
const allTime = perYear.reduce((s, y) => s + y.contributionCalendar.totalContributions, 0);

// ---------------------------------------------------------------------------
// 3. sample commit history (time of day, commit types, lines changed)
// ---------------------------------------------------------------------------
const since = new Date(Date.now() - 365 * 86400 * 1000).toISOString();
const commits = [];
const reposToScan = c.commitContributionsByRepository
  .filter((r) => r.repository.defaultBranchRef)
  .slice(0, MAX_REPOS_SCANNED);
for (const r of reposToScan) {
  const [owner, name] = r.repository.nameWithOwner.split("/");
  let cursor = null, fetched = 0;
  try {
    while (fetched < COMMITS_PER_REPO) {
      const res = await gql(
        `query($owner:String!,$name:String!,$id:ID!,$since:GitTimestamp!,$cursor:String,$n:Int!){
          repository(owner:$owner,name:$name){ defaultBranchRef{ target{ ... on Commit{
            history(first:$n, after:$cursor, since:$since, author:{id:$id}){
              pageInfo{ hasNextPage endCursor }
              nodes{ committedDate authoredDate additions deletions changedFilesIfAvailable messageHeadline url } } } } } }
        }`,
        { owner, name, id: u.id, since, cursor, n: Math.min(100, COMMITS_PER_REPO - fetched) },
      );
      const h = res.repository?.defaultBranchRef?.target?.history;
      if (!h) break;
      for (const n of h.nodes) commits.push({ ...n, repo: r.repository.nameWithOwner, private: r.repository.isPrivate });
      fetched += h.nodes.length;
      if (!h.pageInfo.hasNextPage) break;
      cursor = h.pageInfo.endCursor;
    }
  } catch (err) {
    console.warn(`history ${owner}/${name}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// 4. compute stats
// ---------------------------------------------------------------------------
// streaks — computed over the full history so long streaks aren't cut off at 1 year
const allDays = (() => {
  const m = new Map();
  for (const y of perYear) for (const w of y.contributionCalendar.weeks) for (const d of w.contributionDays) m.set(d.date, d.contributionCount);
  for (const d of days) m.set(d.date, d.contributionCount);
  const today = days.at(-1).date;
  return [...m.entries()].filter(([k]) => k <= today).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, contributionCount]) => ({ date, contributionCount }));
})();
let longest = 0, run = 0, longestEnd = null, longestStart = null, runStart = null;
for (const d of allDays) {
  if (d.contributionCount > 0) { if (run === 0) runStart = d.date; run++; } else run = 0;
  if (run > longest) { longest = run; longestEnd = d.date; longestStart = runStart; }
}
let current = 0;
let currentStart = null;
for (let i = allDays.length - 1; i >= 0; i--) {
  if (allDays[i].contributionCount > 0) { current++; currentStart = allDays[i].date; }
  else if (i === allDays.length - 1) continue; // today may still be empty
  else break;
}
const best = days.reduce((a, b) => (b.contributionCount > a.contributionCount ? b : a));
const activeDays = days.filter((d) => d.contributionCount > 0).length;
const avg = total / days.length;
const median = (() => {
  const s = days.map((d) => d.contributionCount).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
})();
const sumRange = (arr) => arr.reduce((s, d) => s + d.contributionCount, 0);
const last7 = days.slice(-7), prev7 = days.slice(-14, -7);
const last30 = days.slice(-30), prev30 = days.slice(-60, -30);
const last90 = days.slice(-90), prev90 = days.slice(-180, -90);
const weeklyTotals = c.contributionCalendar.weeks.map((w) => sumRange(w.contributionDays));
const bestWeekIdx = weeklyTotals.indexOf(Math.max(...weeklyTotals));
const bestWeekStart = c.contributionCalendar.weeks[bestWeekIdx].contributionDays[0].date;

// monthly (rolling 12 months from calendar)
const monthly = new Map();
for (const d of days) {
  const key = d.date.slice(0, 7);
  monthly.set(key, (monthly.get(key) || 0) + d.contributionCount);
}
const monthRows = [...monthly.entries()].slice(-12);
const monthMax = Math.max(...monthRows.map((m) => m[1]), 1);
const bestMonth = monthRows.reduce((a, b) => (b[1] > a[1] ? b : a));

// weekday from calendar
const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const wdTotals = Array(7).fill(0);
for (const d of days) wdTotals[new Date(d.date + "T00:00:00Z").getUTCDay()] += d.contributionCount;
const wdMax = Math.max(...wdTotals);
const busiestWd = WD[wdTotals.indexOf(wdMax)];
const weekendShare = pct(wdTotals[0] + wdTotals[6], total);

// commits: hours, types, lines
const hours = Array(24).fill(0);
const TYPES = ["feat", "fix", "chore", "docs", "refactor", "test", "perf", "style", "ci", "build"];
const typeCount = Object.fromEntries([...TYPES, "other"].map((t) => [t, 0]));
let additions = 0, deletions = 0, files = 0;
let biggest = null;
const repoLines = new Map();
for (const cm of commits) {
  hours[localParts(cm.committedDate).hour]++;
  const m = /^(\w+)(\(.+?\))?!?:/.exec(cm.messageHeadline || "");
  const t = m && TYPES.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : "other";
  typeCount[t]++;
  additions += cm.additions; deletions += cm.deletions; files += cm.changedFilesIfAvailable || 0;
  const size = cm.additions + cm.deletions;
  if (!cm.private && (!biggest || size > biggest.additions + biggest.deletions)) biggest = cm;
  const rl = repoLines.get(cm.repo) || { add: 0, del: 0, n: 0 };
  rl.add += cm.additions; rl.del += cm.deletions; rl.n++;
  repoLines.set(cm.repo, rl);
}
const nCommits = commits.length || 1;
const periods = [
  ["🌅 Morning", "06–12", [6, 7, 8, 9, 10, 11]],
  ["🌞 Daytime", "12–18", [12, 13, 14, 15, 16, 17]],
  ["🌆 Evening", "18–24", [18, 19, 20, 21, 22, 23]],
  ["🌙 Night", "00–06", [0, 1, 2, 3, 4, 5]],
].map(([label, range, hs]) => ({ label, range, n: hs.reduce((s, h) => s + hours[h], 0) }));
const periodMax = Math.max(...periods.map((p) => p.n), 1);
const topPeriod = periods.reduce((a, b) => (b.n > a.n ? b : a));
const persona = {
  "🌅 Morning": "I'm an Early Bird 🐤",
  "🌞 Daytime": "I'm a Daytime Coder ☀️",
  "🌆 Evening": "I'm an Evening Hacker 🌆",
  "🌙 Night": "I'm a Night Owl 🦉",
}[topPeriod.label];
const peakHour = hours.indexOf(Math.max(...hours));

// languages
const langs = new Map();
for (const r of u.repositories.nodes)
  for (const e of r.languages.edges) langs.set(e.node.name, (langs.get(e.node.name) || 0) + e.size);
const langTotal = [...langs.values()].reduce((a, b) => a + b, 0) || 1;
const topLangs = [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
const fmtBytes = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(0)} KB`);

const stars = u.repositories.nodes.reduce((s, r) => s + r.stargazerCount, 0);
const forksRecv = u.repositories.nodes.reduce((s, r) => s + r.forkCount, 0);
const accountYears = ((Date.now() - new Date(u.createdAt)) / (365.25 * 86400 * 1000)).toFixed(1);
const mergeRate = pct(u.prMerged.totalCount, u.prAll.totalCount);

// ---------------------------------------------------------------------------
// 5. recent public events
// ---------------------------------------------------------------------------
const ICON = {
  PushEvent: "⬆️", PullRequestEvent: "🔀", IssuesEvent: "🐛", IssueCommentEvent: "💬",
  CreateEvent: "✨", DeleteEvent: "🗑️", WatchEvent: "⭐", ForkEvent: "🍴", ReleaseEvent: "🚀",
  PullRequestReviewEvent: "👀", PullRequestReviewCommentEvent: "💬", PublicEvent: "🌍",
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function describe(e) {
  const p = e.payload, gh = `https://github.com/${e.repo.name}`, r = `[${e.repo.name}](${gh})`;
  switch (e.type) {
    case "PushEvent": {
      const n = p.size ?? p.commits?.length ?? p.distinct_size;
      const br = p.ref ? ` \`${p.ref.replace("refs/heads/", "")}\`` : "";
      return n ? `Pushed ${n} commit${n > 1 ? "s" : ""} to${br} in ${r}` : `Pushed to${br} in ${r}`;
    }
    case "PullRequestEvent": {
      const n = p.number ?? p.pull_request?.number;
      const title = p.pull_request?.title ? ` — _${p.pull_request.title.replace(/[|<>]/g, "")}_` : "";
      return `${cap(p.pull_request?.merged ? "merged" : p.action)} PR [#${n}](${gh}/pull/${n}) in ${r}${title}`;
    }
    case "IssuesEvent": return `${cap(p.action)} issue [#${p.issue.number}](${gh}/issues/${p.issue.number}) in ${r}`;
    case "IssueCommentEvent": return `Commented on [#${p.issue.number}](${gh}/issues/${p.issue.number}) in ${r}`;
    case "CreateEvent": return p.ref_type === "repository" ? `Created repository ${r}` : `Created ${p.ref_type} \`${p.ref}\` in ${r}`;
    case "DeleteEvent": return `Deleted ${p.ref_type} \`${p.ref}\` in ${r}`;
    case "WatchEvent": return `Starred ${r}`;
    case "ForkEvent": return `Forked ${r}`;
    case "ReleaseEvent": return `Released [${p.release.tag_name}](${gh}/releases/tag/${p.release.tag_name}) in ${r}`;
    case "PullRequestReviewEvent": return `Reviewed PR [#${p.pull_request.number}](${gh}/pull/${p.pull_request.number}) in ${r}`;
    case "PullRequestReviewCommentEvent": return `Commented on PR [#${p.pull_request.number}](${gh}/pull/${p.pull_request.number}) in ${r}`;
    case "PublicEvent": return `Open-sourced ${r} 🎉`;
    default: return null;
  }
}
let recentRows = "", eventTypeSummary = "";
try {
  const events = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await rest(`/users/${USER}/events/public?per_page=100&page=${page}`);
    events.push(...batch);
    if (batch.length < 100) break;
  }
  events.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  // event type counts (last ~90 days, as returned by the API)
  const counts = {};
  for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;
  eventTypeSummary = Object.entries(counts)
    .filter(([t]) => ICON[t])
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${ICON[t]} ${t.replace("Event", "").replace(/([a-z])([A-Z])/g, "$1 $2")} **${n}**`)
    .join(" · ");
  const seen = new Set();
  const rows = [];
  for (const e of events) {
    const text = describe(e);
    if (!text) continue;
    const pr = e.payload.number ?? e.payload.pull_request?.number;
    const key =
      e.type === "PushEvent" ? `push:${e.repo.name}`
      : e.type === "PullRequestEvent" ? `pr:${e.repo.name}#${pr}`
      : e.type === "IssuesEvent" ? `issue:${e.repo.name}#${e.payload.issue.number}`
      : `${e.type}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(`| ${ICON[e.type] || "•"} | ${text} | ${ago(e.created_at)} |`);
    if (rows.length === 12) break;
  }
  recentRows = rows.join("\n");
} catch (err) {
  console.warn("events:", err.message);
}

// ---------------------------------------------------------------------------
// 6. render
// ---------------------------------------------------------------------------
const updated = new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });
const streakEmoji = current >= 100 ? "🔥🔥🔥" : current >= 30 ? "🔥🔥" : current > 0 ? "🔥" : "💤";
const repoLink = (name, priv) => (priv ? "🔒 private repo" : `[${name.split("/")[1]}](https://github.com/${name})`);

// highlights
const highlights = [];
if (current >= 7) highlights.push(`🔥 **${fmt(current)}-day** contribution streak and counting (since ${fmtDate(currentStart)})`);
if (longest >= 30 && longest !== current) highlights.push(`🏆 Longest streak: **${longest} days** (${fmtDate(longestStart)} → ${fmtDate(longestEnd)})`);
highlights.push(`⚡ Best single day: **${fmt(best.contributionCount)}** contributions on ${fmtDate(best.date)}`);
highlights.push(`📆 Best week: **${fmt(weeklyTotals[bestWeekIdx])}** contributions (week of ${fmtDate(bestWeekStart)})`);
highlights.push(`🗓️ Best month: **${fmt(bestMonth[1])}** contributions in ${MONTHS[Number(bestMonth[0].slice(5)) - 1]} ${bestMonth[0].slice(0, 4)}`);
if (u.prMerged.totalCount >= 100) highlights.push(`🔀 **${fmt(u.prMerged.totalCount)}** pull requests merged all-time (${mergeRate}% merge rate)`);
if (c.totalRepositoryContributions) highlights.push(`🆕 **${c.totalRepositoryContributions}** new repositories created in the last 12 months`);
const activeAll = allDays.filter((d) => d.contributionCount > 0).length;
highlights.push(`📅 Active on **${fmt(activeAll)}** days in total`);
highlights.push(`🎂 On GitHub for **${accountYears} years** (since ${fmtDate(u.createdAt)}) — **${fmt(allTime)}** contributions all-time`);

const yearMax = Math.max(...perYear.map((y) => y.contributionCalendar.totalContributions), 1);
const yearBlock = perYear
  .slice().reverse()
  .map((y) => `${y.year}  ${bar(y.contributionCalendar.totalContributions, yearMax, 30)}  ${fmt(y.contributionCalendar.totalContributions).padStart(7)}`)
  .join("\n");
const yearTable = perYear
  .slice().reverse()
  .map((y) => `| ${y.year} | ${fmt(y.contributionCalendar.totalContributions)} | ${fmt(y.totalCommitContributions)} | ${fmt(y.totalPullRequestContributions)} | ${fmt(y.totalIssueContributions)} | ${fmt(y.totalPullRequestReviewContributions)} | ${fmt(y.totalRepositoryContributions)} |`)
  .join("\n");

const monthBlock = monthRows
  .map(([k, v]) => `${MONTHS[Number(k.slice(5)) - 1]} ${k.slice(0, 4)}  ${bar(v, monthMax, 30)}  ${fmt(v).padStart(6)}`)
  .join("\n");

const last7Block = last7
  .map((d) => {
    const wd = WD[new Date(d.date + "T00:00:00Z").getUTCDay()].slice(0, 3);
    return `${wd} ${d.date.slice(5)}  ${bar(d.contributionCount, Math.max(...last7.map((x) => x.contributionCount), 1), 30)}  ${fmt(d.contributionCount).padStart(5)}`;
  })
  .join("\n");

const weekdayBlock = [1, 2, 3, 4, 5, 6, 0]
  .map((i) => `${WD[i].padEnd(10)} ${fmt(wdTotals[i]).padStart(6)}  ${bar(wdTotals[i], wdMax, 25)}  ${pct(wdTotals[i], total).padStart(5)} %`)
  .join("\n");

const periodBlock = periods
  .map((p) => `${p.label.padEnd(10)} ${p.range}  ${fmt(p.n).padStart(6)} commits  ${bar(p.n, periodMax, 25)}  ${pct(p.n, nCommits).padStart(5)} %`)
  .join("\n");

const typeRows = Object.entries(typeCount).filter(([, n]) => n).sort((a, b) => b[1] - a[1]);
const typeMax = Math.max(...typeRows.map((t) => t[1]), 1);
const TYPE_ICON = { feat: "✨", fix: "🐛", chore: "🧹", docs: "📝", refactor: "♻️", test: "🧪", perf: "⚡", style: "🎨", ci: "🤖", build: "📦", other: "📦" };
const typeBlock = typeRows
  .map(([t, n]) => `${(TYPE_ICON[t] === "📦" && t === "other" ? "🔖" : TYPE_ICON[t])} ${t.padEnd(9)} ${fmt(n).padStart(6)}  ${bar(n, typeMax, 25)}  ${pct(n, nCommits).padStart(5)} %`)
  .join("\n");

const langBlock = topLangs
  .map(([n, s]) => `${n.padEnd(12)} ${fmtBytes(s).padStart(8)}  ${bar(s, topLangs[0][1], 25)}  ${pct(s, langTotal).padStart(5)} %`)
  .join("\n");

const topRepoRows = c.commitContributionsByRepository
  .slice(0, 8)
  .map((r) => {
    const name = r.repository.nameWithOwner;
    const rl = repoLines.get(name);
    const lines = rl ? `+${fmt(rl.add)} / −${fmt(rl.del)}` : "—";
    const share = pct(r.contributions.totalCount, c.totalCommitContributions);
    return `| ${repoLink(name, r.repository.isPrivate)} | ${r.repository.primaryLanguage?.name || "—"} | ${fmt(r.contributions.totalCount)} | ${share}% | ${lines} |`;
  })
  .join("\n");

const recentRepos = u.repositories.nodes
  .filter((r) => !r.isPrivate)
  .slice(0, 8)
  .map((r) => {
    const desc = (r.description || "").replace(/\|/g, "/").slice(0, 70) + ((r.description || "").length > 70 ? "…" : "");
    return `| [${r.name}](${r.url}) | ${r.primaryLanguage?.name || "—"} | ${desc || "—"} | ${ago(r.pushedAt)} |`;
  })
  .join("\n");

const prRepoRows = c.pullRequestContributionsByRepository
  .map((r) => `| ${repoLink(r.repository.nameWithOwner, false)} | ${fmt(r.contributions.totalCount)} |`)
  .join("\n");

const section = `## 📊 GitHub Activity

<div align="center">

| 🟩 Contributions | 🔥 Current Streak | 🏆 Longest Streak | 📅 Active Days |
|:---:|:---:|:---:|:---:|
| **${fmt(total)}**<br><sub>last 12 months</sub> | **${fmt(current)} days** ${streakEmoji}<br><sub>${current ? `since ${fmtDate(currentStart)}` : "start one today!"}</sub> | **${fmt(longest)} days**<br><sub>${current === longest ? "ongoing 🚀" : `${fmtDate(longestStart)} → ${fmtDate(longestEnd)}`}</sub> | **${activeDays}/${days.length}**<br><sub>${pct(activeDays, days.length)}% of days</sub> |

| 💻 Commits | 🔀 PRs | 🐛 Issues | 👀 Reviews | 📦 Repos Touched | 🆕 Repos Created |
|:---:|:---:|:---:|:---:|:---:|:---:|
| **${fmt(c.totalCommitContributions)}** | **${fmt(c.totalPullRequestContributions)}** | **${fmt(c.totalIssueContributions)}** | **${fmt(c.totalPullRequestReviewContributions)}** | **${fmt(c.totalRepositoriesWithContributedCommits)}** | **${fmt(c.totalRepositoryContributions)}** |

| 🌍 All-time | 🔀 PRs Merged | 📂 Public Repos | 🍴 Forks | ⭐ Stars Earned | 👥 Followers |
|:---:|:---:|:---:|:---:|:---:|:---:|
| **${fmt(allTime)}**<br><sub>since ${years[0]}</sub> | **${fmt(u.prMerged.totalCount)}**<br><sub>${mergeRate}% of ${fmt(u.prAll.totalCount)}</sub> | **${fmt(u.repositories.totalCount)}** | **${fmt(u.forks.totalCount)}** | **${fmt(stars)}** | **${fmt(u.followers.totalCount)}** |

</div>

### 🏅 Highlights

${highlights.map((h) => `- ${h}`).join("\n")}

### 📈 Momentum

| Period | Contributions | vs previous period | Daily avg |
|---|---:|:---:|---:|
| Last 7 days | **${fmt(sumRange(last7))}** | ${delta(sumRange(last7), sumRange(prev7))} | ${(sumRange(last7) / 7).toFixed(1)} |
| Last 30 days | **${fmt(sumRange(last30))}** | ${delta(sumRange(last30), sumRange(prev30))} | ${(sumRange(last30) / 30).toFixed(1)} |
| Last 90 days | **${fmt(sumRange(last90))}** | ${delta(sumRange(last90), sumRange(prev90))} | ${(sumRange(last90) / 90).toFixed(1)} |
| Last 12 months | **${fmt(total)}** | — | ${avg.toFixed(1)} <sub>(median ${median})</sub> |

\`\`\`text
Weekly trend (12 mo)  ▕${spark(weeklyTotals)}▏
Daily  trend (30 d)   ▕${spark(last30.map((d) => d.contributionCount))}▏
Hourly commits (${TZ_LABEL})  ▕${spark(hours)}▏  00h → 23h, peak at ${String(peakHour).padStart(2, "0")}:00
\`\`\`

<details open>
<summary><b>🗓️ Last 7 days</b></summary>

\`\`\`text
${last7Block}
\`\`\`
</details>

<details open>
<summary><b>📆 Contributions per month (last 12 months)</b></summary>

\`\`\`text
${monthBlock}
\`\`\`
</details>

<details>
<summary><b>📜 Contributions per year — ${years.length} years on the graph</b></summary>

\`\`\`text
${yearBlock}
\`\`\`

| Year | Total | Commits | PRs | Issues | Reviews | Repos created |
|---|---:|---:|---:|---:|---:|---:|
${yearTable}

</details>

### ⏰ When I Code

<details open>
<summary><b>${persona} — ${pct(topPeriod.n, nCommits)}% of commits happen in the ${topPeriod.label.split(" ")[1].toLowerCase()}</b></summary>

\`\`\`text
${periodBlock}
\`\`\`
</details>

<details open>
<summary><b>📅 Most productive on ${busiestWd}s · ${weekendShare}% of work happens on weekends</b></summary>

\`\`\`text
${weekdayBlock}
\`\`\`
</details>

### 🧬 Commit Anatomy

<sub>Based on ${fmt(commits.length)} recent commits across ${reposToScan.length} repositories (last 12 months, default branches).</sub>

| ➕ Lines Added | ➖ Lines Removed | 📊 Net | 📄 Files Changed | 📏 Avg Lines / Commit |
|:---:|:---:|:---:|:---:|:---:|
| **${fmt(additions)}** | **${fmt(deletions)}** | **${additions - deletions >= 0 ? "+" : ""}${fmt(additions - deletions)}** | **${fmt(files)}** | **${fmt((additions + deletions) / nCommits)}** |

<details open>
<summary><b>🏷️ Commit types (Conventional Commits)</b></summary>

\`\`\`text
${typeBlock}
\`\`\`
</details>
${biggest ? `
> 💥 **Biggest commit:** [${biggest.messageHeadline.replace(/[\[\]|]/g, "")}](${biggest.url}) in \`${biggest.repo.split("/")[1]}\` — +${fmt(biggest.additions)} / −${fmt(biggest.deletions)} lines
` : ""}
### 💬 Languages

\`\`\`text
${langBlock}
\`\`\`

### 🏗️ Where My Commits Went (last 12 months)

| Repository | Language | Commits | Share | Lines (sampled) |
|---|---|---:|---:|---:|
${topRepoRows}
${prRepoRows ? `
<details>
<summary><b>🔀 Pull requests by repository</b></summary>

| Repository | PRs |
|---|---:|
${prRepoRows}

</details>
` : ""}
### 🛠️ Recently Active Repositories

| Repository | Language | Description | Last push |
|---|---|---|---:|
${recentRepos}
${recentRows ? `
### ⚡ Recent Activity

${eventTypeSummary ? `<sub>Public events (last 90 days): ${eventTypeSummary}</sub>\n` : ""}
| | Event | When |
|:---:|---|---:|
${recentRows}
` : ""}
<div align="center"><sub>⏱️ Auto-updated by GitHub Actions · Last update: ${updated} ${TZ_LABEL}</sub></div>`;

const old = await readFile(README, "utf8");
const block = `${START}\n${section}\n${END}`;
const next =
  old.includes(START) && old.includes(END)
    ? old.slice(0, old.indexOf(START)) + block + old.slice(old.indexOf(END) + END.length)
    : old.trimEnd() + "\n\n" + block + "\n";
await writeFile(README, next);
console.log(`README updated: ${total} contributions, streak ${current}/${longest}, ${commits.length} commits sampled`);
