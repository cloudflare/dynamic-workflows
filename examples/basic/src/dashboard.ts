/**
 * Static HTML dashboard served at `GET /`.
 *
 * Pure frontend — no build step, no framework. Talks to the dispatcher via:
 *
 *   GET  /api/source            → default editor contents
 *   POST /api/run               → { source, payload } → start a run
 *   GET  /api/status/:runId     → instance status
 *   GET  /api/stream/:runId     → SSE: log entries + 'done' event
 */

export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>dynamic-workflows playground</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b1020;
        --panel: #141a2e;
        --panel-2: #1b2340;
        --text: #e6e8ef;
        --muted: #8a93ad;
        --border: #27304f;
        --accent: #6d83ff;
        --success: #22c55e;
        --warn: #f59e0b;
        --error: #ef4444;
      }
      * { box-sizing: border-box; }
      html, body, #app {
        margin: 0; padding: 0; height: 100%;
        background: var(--bg); color: var(--text);
        font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      header {
        display: flex; align-items: baseline; gap: 16px;
        padding: 18px 24px;
        border-bottom: 1px solid var(--border);
      }
      header h1 { margin: 0; font-size: 18px; }
      header p { margin: 0; color: var(--muted); font-size: 13px; }
      main {
        display: grid;
        grid-template-columns: 1fr 1fr;
        grid-template-rows: 1fr;
        gap: 0;
        height: calc(100vh - 62px);
      }
      @media (max-width: 900px) {
        main { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; height: auto; }
      }
      .pane { display: flex; flex-direction: column; min-height: 0; }
      .pane + .pane { border-left: 1px solid var(--border); }
      .pane-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 16px;
        border-bottom: 1px solid var(--border);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--muted);
      }
      .pane-head .right { display: flex; gap: 8px; align-items: center; }
      button {
        font: inherit;
        background: var(--accent); color: white;
        border: none; border-radius: 6px;
        padding: 6px 14px; font-weight: 600;
        cursor: pointer;
      }
      button:hover:not(:disabled) { filter: brightness(1.1); }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
      button.secondary {
        background: var(--panel-2);
        color: var(--text);
        border: 1px solid var(--border);
      }
      textarea.editor, textarea.payload {
        flex: 1;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13px;
        line-height: 1.5;
        background: var(--panel);
        color: var(--text);
        border: none; outline: none;
        padding: 14px 16px;
        resize: none;
        tab-size: 2;
      }
      textarea.payload {
        flex: 0;
        min-height: 60px;
        max-height: 120px;
        border-top: 1px solid var(--border);
      }
      .payload-label {
        padding: 8px 16px 0;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
      }

      /* Output pane */
      .output {
        flex: 1;
        overflow-y: auto;
        padding: 14px 16px;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 12px 14px;
      }
      .card h3 {
        margin: 0 0 8px;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--muted);
      }
      .run-head {
        display: flex; align-items: center; justify-content: space-between;
        gap: 10px;
      }
      .run-id {
        font-family: ui-monospace, monospace;
        font-size: 11px;
        color: var(--muted);
      }
      .pill {
        font-size: 11px;
        padding: 3px 8px;
        border-radius: 999px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: 600;
        background: var(--panel-2);
        border: 1px solid var(--border);
        color: var(--muted);
      }
      .pill.running { color: #fff; background: var(--accent); border-color: var(--accent); }
      .pill.complete { color: #fff; background: var(--success); border-color: var(--success); }
      .pill.errored, .pill.terminated { color: #fff; background: var(--error); border-color: var(--error); }
      .pill.running::before {
        content: ""; display: inline-block;
        width: 6px; height: 6px; border-radius: 50%;
        background: white; margin-right: 6px;
        vertical-align: middle;
        animation: pulse 1s infinite;
      }
      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

      .timeline {
        display: flex; flex-direction: column; gap: 6px;
        margin-top: 8px;
      }
      .tl-step {
        display: grid;
        grid-template-columns: 18px 1fr;
        gap: 10px;
        align-items: center;
        font-size: 13px;
        color: var(--muted);
      }
      .tl-step .dot {
        width: 10px; height: 10px; border-radius: 50%;
        border: 2px solid var(--border);
        margin-left: 4px;
      }
      .tl-step.done { color: var(--text); }
      .tl-step.done .dot { background: var(--success); border-color: var(--success); }
      .tl-step.active { color: var(--text); }
      .tl-step.active .dot {
        background: var(--accent); border-color: var(--accent);
        box-shadow: 0 0 0 4px rgba(109, 131, 255, 0.2);
        animation: pulse 1s infinite;
      }

      .logs {
        background: var(--panel-2);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 8px 10px;
        font-family: ui-monospace, monospace;
        font-size: 12px;
        max-height: 280px;
        overflow-y: auto;
      }
      .log-line { display: flex; gap: 8px; padding: 1px 0; }
      .log-line .prefix { width: 50px; flex: 0 0 auto; opacity: 0.5; font-size: 11px; text-align: right; }
      .log-line .msg { flex: 1; white-space: pre-wrap; word-break: break-word; }
      .log-line.level-warn .msg { color: var(--warn); }
      .log-line.level-error .msg { color: var(--error); }
      .log-line.meta .msg { color: var(--muted); font-style: italic; }
      .logs-empty { color: var(--muted); font-style: italic; }

      pre.output-json {
        margin: 0;
        background: var(--panel-2);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 10px 12px;
        font-family: ui-monospace, monospace;
        font-size: 12px;
        overflow-x: auto;
        white-space: pre-wrap;
      }
      pre.output-error {
        margin: 0;
        background: #3a1111;
        border: 1px solid #5a1818;
        border-radius: 6px;
        padding: 10px 12px;
        color: #ffcdcd;
        font-family: ui-monospace, monospace;
        font-size: 12px;
      }
      .empty {
        color: var(--muted);
        font-style: italic;
        padding: 40px 0;
        text-align: center;
      }
    </style>
  </head>
  <body>
    <div id="app">
      <header>
        <h1>dynamic-workflows playground</h1>
        <p>Write a Workflow in JavaScript, hit Run, watch every step and every <code>console.log()</code> stream in live.</p>
      </header>
      <main>
        <section class="pane" aria-label="Editor">
          <div class="pane-head">
            <span>Tenant worker (JavaScript)</span>
            <div class="right">
              <button class="secondary" id="reset-btn">Reset</button>
              <button id="run-btn">Run</button>
            </div>
          </div>
          <textarea class="editor" id="editor" spellcheck="false" autocomplete="off"></textarea>
          <div class="payload-label">Input payload (JSON)</div>
          <textarea class="payload" id="payload" spellcheck="false" autocomplete="off">{"name":"world"}</textarea>
        </section>

        <section class="pane" aria-label="Output">
          <div class="pane-head"><span>Run output</span></div>
          <div class="output" id="output">
            <div class="empty">No runs yet. Edit the code on the left and hit <b>Run</b>.</div>
          </div>
        </section>
      </main>
    </div>

    <script type="module">
      const editorEl = document.getElementById('editor');
      const payloadEl = document.getElementById('payload');
      const runBtn = document.getElementById('run-btn');
      const resetBtn = document.getElementById('reset-btn');
      const outputEl = document.getElementById('output');

      let defaultSource = '';

      function escape(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
      }

      // --- Editor helpers ----------------------------------------------
      editorEl.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const start = editorEl.selectionStart;
          const end = editorEl.selectionEnd;
          editorEl.value = editorEl.value.slice(0, start) + '  ' + editorEl.value.slice(end);
          editorEl.selectionStart = editorEl.selectionEnd = start + 2;
        }
      });

      resetBtn.addEventListener('click', () => {
        if (confirm('Discard your code and reload the default?')) {
          editorEl.value = defaultSource;
        }
      });

      // --- Step-name extraction ----------------------------------------
      // We eagerly parse the editor text for step.do('name', ...) / step.sleep('name', ...)
      // calls and use that list to render a checklist of planned steps.
      // This is a best-effort regex pass — it's purely cosmetic.
      function extractStepNames(source) {
        const re = /step\\.(?:do|sleep|sleepUntil|waitForEvent)\\s*\\(\\s*(['"\`])([^'"\`]+)\\1/g;
        const out = [];
        let m;
        while ((m = re.exec(source)) !== null) {
          if (!out.includes(m[2])) out.push(m[2]);
        }
        return out;
      }

      // --- Run workflow -------------------------------------------------
      async function runWorkflow() {
        const source = editorEl.value;
        let payload;
        try {
          payload = payloadEl.value.trim() ? JSON.parse(payloadEl.value) : {};
        } catch (err) {
          alert('Payload is not valid JSON: ' + err.message);
          return;
        }
        runBtn.disabled = true;

        const plannedSteps = extractStepNames(source);
        const run = {
          runId: null,
          status: 'pending',
          logs: [],
          output: null,
          error: null,
          steps: plannedSteps,
          completedSteps: 0,
          startedAt: Date.now(),
        };

        // Clear empty state
        if (outputEl.querySelector('.empty')) outputEl.innerHTML = '';
        const card = document.createElement('div');
        card.className = 'card';
        outputEl.prepend(card);
        render(card, run);

        try {
          const res = await fetch('/api/run', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source, payload }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'run failed');
          run.runId = data.runId;
          run.status = data.status?.status ?? 'running';
          render(card, run);

          streamLogs(card, run);
          pollStatus(card, run);
        } catch (err) {
          run.status = 'errored';
          run.error = { message: String(err.message || err) };
          render(card, run);
        } finally {
          runBtn.disabled = false;
        }
      }

      runBtn.addEventListener('click', runWorkflow);

      // --- Live log stream ---------------------------------------------
      function streamLogs(card, run) {
        const es = new EventSource('/api/stream/' + encodeURIComponent(run.runId));
        es.addEventListener('log', (ev) => {
          const entry = JSON.parse(ev.data);
          run.logs.push(entry);
          // Heuristic: count "RunningStep" logs emitted by Workflows as step
          // completion markers. These are the Workflows engine's own log
          // lines and give us per-step progress in real time.
          if (/(^|\\s)Running\\s+step:?\\s/i.test(entry.message)
              || /Starting.*step/i.test(entry.message)) {
            run.completedSteps = Math.min(run.steps.length, run.completedSteps + 1);
          }
          render(card, run);
        });
        es.addEventListener('done', () => es.close());
        es.onerror = () => es.close();
      }

      async function pollStatus(card, run) {
        let stable = 0;
        while (stable < 3) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const res = await fetch('/api/status/' + encodeURIComponent(run.runId));
            if (!res.ok) throw new Error('status ' + res.status);
            const data = await res.json();
            const s = data.status || {};
            run.status = s.status ?? run.status;
            run.output = s.output ?? run.output;
            run.error = s.error ?? run.error;
            const localSteps = Array.isArray(s.__LOCAL_DEV_STEP_OUTPUTS)
              ? s.__LOCAL_DEV_STEP_OUTPUTS.length
              : null;
            if (localSteps != null) {
              run.completedSteps = Math.min(run.steps.length, localSteps);
            }
            render(card, run);
            if (['complete', 'errored', 'terminated'].includes(run.status)) {
              stable++;
            } else {
              stable = 0;
            }
          } catch (err) {
            run.error = { message: String(err.message || err) };
            render(card, run);
            break;
          }
        }
      }

      // --- Rendering ----------------------------------------------------
      function render(card, run) {
        const stepStates = computeStepStates(run);
        card.innerHTML = \`
          <div class="run-head">
            <div>
              <strong>Workflow run</strong>
              \${run.runId ? \`<div class="run-id">\${escape(run.runId)}</div>\` : ''}
            </div>
            <span class="pill \${run.status}">\${escape(run.status)}</span>
          </div>

          \${run.steps.length ? \`
            <div class="timeline">
              \${run.steps.map((name, i) => \`
                <div class="tl-step \${stepStates[i]}">
                  <div class="dot"></div>
                  <div>\${escape(name)}</div>
                </div>
              \`).join('')}
            </div>
          \` : ''}

          <h3 style="margin-top:14px">Logs (\${run.logs.length})</h3>
          <div class="logs">
            \${run.logs.length === 0
              ? '<div class="logs-empty">Waiting for logs…</div>'
              : run.logs.map((l) => \`
                <div class="log-line level-\${escape(l.level)} \${l.kind === 'exception' ? 'level-error' : ''}">
                  <span class="prefix">\${escape(l.level.toUpperCase())}</span>
                  <span class="msg">\${escape(l.message)}</span>
                </div>
              \`).join('')}
          </div>

          \${run.output ? \`
            <h3 style="margin-top:14px">Return value</h3>
            <pre class="output-json">\${escape(JSON.stringify(run.output, null, 2))}</pre>
          \` : ''}

          \${run.error ? \`
            <h3 style="margin-top:14px">Error</h3>
            <pre class="output-error">\${escape(run.error.name ? run.error.name + ': ' : '')}\${escape(run.error.message || String(run.error))}</pre>
          \` : ''}
        \`;
      }

      function computeStepStates(run) {
        const n = run.steps.length;
        if (!n) return [];
        if (run.status === 'complete') return Array(n).fill('done');
        if (run.status === 'errored' || run.status === 'terminated') return Array(n).fill('');
        const active = Math.min(n - 1, run.completedSteps);
        return Array.from({ length: n }, (_, i) => {
          if (i < active) return 'done';
          if (i === active) return 'active';
          return '';
        });
      }

      // --- Boot ---------------------------------------------------------
      (async () => {
        const res = await fetch('/api/source');
        defaultSource = await res.text();
        editorEl.value = defaultSource;
      })();
    </script>
  </body>
</html>
`;
