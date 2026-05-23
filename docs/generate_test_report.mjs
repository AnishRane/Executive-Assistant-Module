// Reads docs/.test-report.json (vitest --reporter=json output) and
// emits docs/test_report.html. Idempotent — re-run after every
// `vitest run --reporter=json --outputFile=docs/.test-report.json`.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const reportPath = resolve(here, ".test-report.json");
const outPath = resolve(here, "test_report.html");

const raw = JSON.parse(readFileSync(reportPath, "utf8"));

const summary = {
  total: raw.numTotalTests,
  passed: raw.numPassedTests,
  failed: raw.numFailedTests,
  skipped: raw.numPendingTests || 0,
  startTime: raw.startTime,
  files: raw.testResults.length,
};

// Group assertions by file + ancestor.
const files = raw.testResults.map((tr) => ({
  name: tr.name.split("/").slice(-3).join("/"),
  status: tr.status,
  duration: tr.endTime - tr.startTime,
  groups: groupBy(tr.assertionResults, (a) => a.ancestorTitles.join(" › ")),
}));

function groupBy(arr, key) {
  const m = new Map();
  for (const a of arr) {
    const k = key(a);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(a);
  }
  return [...m.entries()].map(([title, tests]) => ({ title, tests }));
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtMs(ms) {
  if (ms < 1) return ms.toFixed(2) + " ms";
  if (ms < 1000) return ms.toFixed(0) + " ms";
  return (ms / 1000).toFixed(2) + " s";
}

function fmtTimestamp(ms) {
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

const passRate =
  summary.total === 0 ? 0 : Math.round((summary.passed / summary.total) * 1000) / 10;

const totalDuration = files.reduce((s, f) => s + f.duration, 0);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Executive Assistant — Test Report</title>
<style>
  :root {
    --paper: #faf7f1;
    --ink: #1a1814;
    --ink-soft: #4a4640;
    --ink-faint: #7a7468;
    --rule: #d8cfbe;
    --rule-soft: #e8e0cf;
    --green: #2f6b3a;
    --green-soft: #e3eedf;
    --red: #9b2c1f;
    --red-soft: #f3dcd7;
    --amber: #a86417;
    --amber-soft: #f3e6c8;
    --slate: #5a5a5a;
    --chip-bg-soft: #f5efe1;
  }
  html { background: var(--paper); }
  body {
    margin: 0;
    font-family: "Georgia", "Iowan Old Style", "Charter", "Times New Roman", serif;
    color: var(--ink);
    background: var(--paper);
    line-height: 1.5;
    font-size: 15.5px;
  }
  .mono {
    font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
    letter-spacing: 0.02em;
  }
  .page { max-width: 980px; margin: 0 auto; padding: 56px 32px 96px; }
  header.cover {
    border-bottom: 1px solid var(--rule);
    padding-bottom: 24px;
    margin-bottom: 32px;
  }
  .eyebrow {
    font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--ink-faint);
    margin-bottom: 12px;
  }
  h1 {
    font-size: 34px;
    font-weight: 500;
    line-height: 1.12;
    letter-spacing: -0.01em;
    margin: 0 0 10px;
  }
  .deck { color: var(--ink-soft); font-size: 16.5px; max-width: 640px; }
  .meta-row {
    display: flex; flex-wrap: wrap; gap: 16px 26px;
    margin-top: 18px;
    font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
    font-size: 11.5px;
    color: var(--ink-faint);
  }
  .meta-row span b { color: var(--ink); font-weight: 600; }

  .stats {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 0;
    margin-bottom: 36px;
    border: 1px solid var(--rule);
    background: var(--chip-bg-soft);
  }
  .stat { padding: 18px 16px; border-right: 1px solid var(--rule); }
  .stat:last-child { border-right: 0; }
  .stat .num { font-size: 30px; font-weight: 500; line-height: 1; }
  .stat .num.green { color: var(--green); }
  .stat .num.red { color: var(--red); }
  .stat .num.amber { color: var(--amber); }
  .stat .lbl {
    font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
    font-size: 10.5px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--ink-faint);
    margin-top: 6px;
  }

  .gauge {
    margin-bottom: 36px;
    display: flex;
    align-items: center;
    gap: 18px;
  }
  .gauge .bar {
    flex: 1;
    height: 14px;
    background: var(--rule-soft);
    border: 1px solid var(--rule);
    position: relative;
    overflow: hidden;
  }
  .gauge .fill {
    height: 100%;
    background: var(--green);
  }
  .gauge .pct {
    font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
    font-size: 13px;
    color: var(--ink);
  }

  section.suite {
    margin-bottom: 38px;
  }
  section.suite > header {
    display: flex;
    align-items: baseline;
    gap: 14px;
    border-bottom: 1px solid var(--rule);
    padding-bottom: 8px;
    margin-bottom: 12px;
  }
  section.suite > header h2 {
    margin: 0;
    font-size: 19px;
    font-weight: 500;
    font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
    letter-spacing: 0;
  }
  section.suite > header .meta {
    margin-left: auto;
    font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
    font-size: 11.5px;
    color: var(--ink-faint);
  }

  .group {
    margin-bottom: 14px;
  }
  .group h3 {
    margin: 0 0 4px;
    font-size: 14px;
    font-weight: 500;
    color: var(--ink-soft);
    font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
    letter-spacing: 0.02em;
  }
  table.tests {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }
  table.tests td {
    padding: 5px 8px;
    border-bottom: 1px solid var(--rule-soft);
    vertical-align: top;
  }
  table.tests tr:last-child td { border-bottom: 0; }
  table.tests td.s {
    width: 22px;
    padding-left: 0;
    font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
    text-align: center;
  }
  table.tests td.d {
    width: 90px;
    font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
    font-size: 11.5px;
    color: var(--ink-faint);
    text-align: right;
  }
  table.tests td.t { color: var(--ink); }
  .pill {
    display: inline-block;
    font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: 2px;
    line-height: 1.5;
    font-weight: 500;
  }
  .pill.green { background: var(--green-soft); color: var(--green); }
  .pill.red { background: var(--red-soft); color: var(--red); }
  .pill.amber { background: var(--amber-soft); color: var(--amber); }

  .icon-pass { color: var(--green); }
  .icon-fail { color: var(--red); }
  .icon-skip { color: var(--amber); }

  .fail-message {
    background: var(--red-soft);
    border-left: 3px solid var(--red);
    padding: 8px 12px;
    margin: 4px 0 4px 30px;
    font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
    font-size: 11.5px;
    color: var(--ink);
    white-space: pre-wrap;
  }

  footer.foot {
    margin-top: 60px;
    padding-top: 18px;
    border-top: 1px solid var(--rule);
    font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
    font-size: 11px;
    color: var(--ink-faint);
  }

  @media (max-width: 720px) {
    .stats { grid-template-columns: repeat(2, 1fr); }
    .stat { border-bottom: 1px solid var(--rule); }
    .stat:nth-child(2) { border-right: 0; }
    table.tests td.d { width: 60px; }
  }
</style>
</head>
<body>
<div class="page">

  <header class="cover">
    <div class="eyebrow">Test report</div>
    <h1>Executive Assistant — test run</h1>
    <p class="deck">
      Snapshot of the most recent <code>vitest</code> run captured via the
      JSON reporter. Re-run <code>EA_INTEGRATION_TEST=1 pnpm exec vitest
      run --reporter=json --outputFile=docs/.test-report.json</code> and then
      <code>node docs/generate_test_report.mjs</code> to refresh.
    </p>
    <div class="meta-row">
      <span>Run started <b>${fmtTimestamp(summary.startTime)}</b></span>
      <span>Total duration <b>${fmtMs(totalDuration)}</b></span>
      <span>Test files <b>${summary.files}</b></span>
    </div>
  </header>

  <div class="stats">
    <div class="stat"><div class="num">${summary.total}</div><div class="lbl">Total</div></div>
    <div class="stat"><div class="num green">${summary.passed}</div><div class="lbl">Passed</div></div>
    <div class="stat"><div class="num ${summary.failed > 0 ? "red" : ""}">${summary.failed}</div><div class="lbl">Failed</div></div>
    <div class="stat"><div class="num ${summary.skipped > 0 ? "amber" : ""}">${summary.skipped}</div><div class="lbl">Skipped</div></div>
    <div class="stat"><div class="num">${passRate}%</div><div class="lbl">Pass rate</div></div>
  </div>

  <div class="gauge">
    <div class="bar"><div class="fill" style="width:${passRate}%"></div></div>
    <div class="pct">${summary.passed} / ${summary.total} passing</div>
  </div>

  ${files
    .map((f) => {
      const fileTotal = f.groups.reduce((s, g) => s + g.tests.length, 0);
      const filePassed = f.groups.reduce(
        (s, g) => s + g.tests.filter((t) => t.status === "passed").length,
        0,
      );
      const fileFailed = f.groups.reduce(
        (s, g) => s + g.tests.filter((t) => t.status === "failed").length,
        0,
      );
      const fileSkipped = f.groups.reduce(
        (s, g) =>
          s +
          g.tests.filter((t) => t.status === "skipped" || t.status === "pending").length,
        0,
      );
      const overallPill =
        fileFailed > 0
          ? '<span class="pill red">Failed</span>'
          : fileSkipped > 0 && filePassed === 0
            ? '<span class="pill amber">Skipped</span>'
            : '<span class="pill green">Passed</span>';
      return `
  <section class="suite">
    <header>
      <h2>${esc(f.name)}</h2>
      ${overallPill}
      <div class="meta">${fileTotal} tests · ${filePassed} passed${fileFailed > 0 ? " · " + fileFailed + " failed" : ""}${fileSkipped > 0 ? " · " + fileSkipped + " skipped" : ""} · ${fmtMs(f.duration)}</div>
    </header>

    ${f.groups
      .map((g) => {
        const rows = g.tests
          .map((t) => {
            const icon =
              t.status === "passed"
                ? '<span class="icon-pass">✓</span>'
                : t.status === "failed"
                  ? '<span class="icon-fail">✗</span>'
                  : '<span class="icon-skip">↓</span>';
            const failBlock =
              t.failureMessages && t.failureMessages.length > 0
                ? `<tr><td colspan="3"><div class="fail-message">${esc(t.failureMessages.join("\n"))}</div></td></tr>`
                : "";
            return `<tr>
              <td class="s">${icon}</td>
              <td class="t">${esc(t.title)}</td>
              <td class="d">${t.duration != null ? fmtMs(t.duration) : ""}</td>
            </tr>${failBlock}`;
          })
          .join("");
        return `
    <div class="group">
      <h3>${esc(g.title)}</h3>
      <table class="tests">${rows}</table>
    </div>`;
      })
      .join("")}
  </section>`;
    })
    .join("")}

  <footer class="foot">
    <div>executive-assistant · vitest report · generated ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC</div>
    <div style="margin-top:4px;">Source: <code>docs/.test-report.json</code> · regenerate with <code>node docs/generate_test_report.mjs</code></div>
  </footer>

</div>
</body>
</html>
`;

writeFileSync(outPath, html);
console.log(`wrote ${outPath} (${html.length} bytes)`);
console.log(
  `  ${summary.total} tests · ${summary.passed} passed · ${summary.failed} failed · ${summary.skipped} skipped`,
);
