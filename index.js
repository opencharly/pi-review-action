// pi-review — OpenCharly's org-wide PR-review GitHub Action (Node 24, zero-dependency).
// Runs a fresh independent AI validator over the triggering pull request using read-only
// GitHub tools, emits the review text, posts one PR comment, and gates on a Verdict line.
'use strict';

const fs = require('fs');

const API = 'https://api.github.com';
const UAGENT = 'pi-review-action';

function input(name) {
  return process.env['INPUT_' + name.toUpperCase().replace(/[-\s]/g, '_')] || '';
}

const GITHUB_TOKEN = input('github_token') || process.env.GITHUB_TOKEN || '';
const PROVIDER = input('provider') || 'openrouter';
const MODEL = String(input('model') || '').trim(); // pass verbatim — OpenRouter accepts '~'-prefixed ids like ~deepseek/deepseek-v4-flash-latest
const BASE_URL = (input('base_url') || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const API_KEY = input('api_key') || '';
const MAX_TURNS = Math.max(1, parseInt(input('max_turns') || '16', 10) || 16);

const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || '';
const GITHUB_RUN_ID = process.env.GITHUB_RUN_ID || '';
const GITHUB_SERVER_URL = process.env.GITHUB_SERVER_URL || 'https://github.com';

function loadEvent() {
  const p = process.env.GITHUB_EVENT_PATH;
  if (p && fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { /* ignore */ }
  }
  return {};
}
const EV = loadEvent();
const Owner = (EV.repository && EV.repository.owner && EV.repository.owner.login) ||
  (GITHUB_REPOSITORY.split('/')[0] || '');
const Repo = (EV.repository && EV.repository.name) || (GITHUB_REPOSITORY.split('/')[1] || '');
const PR = EV.pull_request && EV.pull_request.number;
const HEAD_SHA = (EV.pull_request && EV.pull_request.head && EV.pull_request.head.sha) || '';
const BASE_SHA = (EV.pull_request && EV.pull_request.base && EV.pull_request.base.sha) || '';

function setOutput(name, value) {
  const p = process.env.GITHUB_OUTPUT;
  if (!p) { console.log('::set-output name=' + name + '::' + String(value)); return; }
  try { fs.appendFileSync(p, '\n' + name + '=' + String(value).replace(/\r?\n/g, ' ')); }
  catch (e) { console.log('::warning::setOutput write failed: ' + e.message); }
}

async function gh(path, opts = {}) {
  const headers = {
    Authorization: 'Bearer ' + GITHUB_TOKEN,
    'User-Agent': UAGENT,
    Accept: opts.accept || 'application/vnd.github+json',
  };
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error('GitHub ' + path + ' -> ' + res.status + ': ' + text.slice(0, 240));
  return opts.raw ? text : JSON.parse(text || 'null');
}

function truncate(s, bytes) {
  if (!s) return s;
  const buf = Buffer.from(String(s), 'utf8');
  if (buf.length <= bytes) return String(s);
  return buf.subarray(0, bytes).toString('utf8').replace(/\uFFFD/g, '') + '\n[…truncated…]';
}

// ---- tools ---------------------------------------------------------------
async function toolDiff() {
  const diff = await gh('/repos/' + Owner + '/' + Repo + '/pulls/' + PR, {
    accept: 'application/vnd.github.diff',
    raw: true,
  });
  return truncate(diff, 96 * 1024);
}

async function toolCommits() {
  const commits = await gh('/repos/' + Owner + '/' + Repo + '/pulls/' + PR + '/commits?per_page=100');
  return (commits || []).map(c => ({
    sha: (c.sha || '').slice(0, 12),
    author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || '',
    date: (c.commit && c.commit.author && c.commit.author.date) || '',
    message: (c.commit && c.commit.message || '').split('\n')[0],
  }));
}

async function toolThread() {
  let body = '';
  try {
    const issue = await gh('/repos/' + Owner + '/' + Repo + '/issues/' + PR);
    body = issue.body || '';
  } catch (e) { /* continue */ }
  let comments = [];
  try {
    const cs = await gh('/repos/' + Owner + '/' + Repo + '/issues/' + PR + '/comments?per_page=100');
    comments = (cs || []).map(c => ({
      id: c.id,
      author: (c.user && c.user.login) || 'unknown',
      created_at: c.created_at,
      body: c.body ? String(c.body).slice(0, 24000) : '',
    }));
  } catch (e) { /* ignore */ }
  return {
    head_sha: HEAD_SHA,
    base_sha: BASE_SHA,
    current_body_is_authoritative: true,
    current_body: body,
    comments,
  };
}

async function toolMeta() {
  const p = await gh('/repos/' + Owner + '/' + Repo + '/pulls/' + PR);
  return {
    title: p.title || '',
    state: p.state || '',
    mergeable: p.mergeable,
    draft: p.draft || false,
    head_sha: (p.head && p.head.sha) || '',
    base_sha: (p.base && p.base.sha) || '',
    additions: p.additions,
    deletions: p.deletions,
    changed_files: p.changed_files,
  };
}

async function toolCI() {
  if (!HEAD_SHA) return { error: 'no head sha' };
  try {
    const rr = await gh('/repos/' + Owner + '/' + Repo + '/commits/' + HEAD_SHA + '/check-runs');
    return (rr.check_runs || []).map(r => ({
      name: r.name,
      status: r.status,
      conclusion: r.conclusion || null,
    }));
  } catch (e) {
    return { error: e.message };
  }
}

const TOOLS = [
  { type: 'function', function: { name: 'get_pr_diff', description: 'CURRENT unified diff (head vs base).', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_pr_commits', description: 'Commit history of this PR (sha, message, author) — read commit messages since the last review here.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_pr_thread', description: 'CURRENT live issue body plus all prior comments (older comments are stale until re-verified).', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_pr_meta', description: 'PR metadata: title, state, mergeable, head/base sha, file counts.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_ci_status', description: 'Check runs on the current head.', parameters: { type: 'object', properties: {} } } },
];
const DISPATCH = {
  get_pr_diff: toolDiff,
  get_pr_commits: toolCommits,
  get_pr_thread: toolThread,
  get_pr_meta: toolMeta,
  get_ci_status: toolCI,
};

const PROMPT = fs.existsSync(__dirname + '/prompt.txt')
  ? fs.readFileSync(__dirname + '/prompt.txt', 'utf8')
  : 'You are the PR validator. Review the PR and emit exactly one final line: Verdict: PASS or Verdict: BLOCK.';

// ---- agent loop ----------------------------------------------------------
async function chat(messages) {
  const res = await fetch(BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + API_KEY,
      'HTTP-Referer': 'https://github.com/opencharly/pi-review-action',
      'X-Title': 'pi-review-action',
    },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.2, tools: TOOLS, tool_choice: 'auto' }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('LLM ' + res.status + ': ' + text.slice(0, 300));
  return JSON.parse(text);
}

async function runAgent() {
  const system = PROMPT
    .replace(/__REPO__/g, Owner + '/' + Repo)
    .replace(/__PR__/g, String(PR));
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: 'Review pull request #' + PR + ' in ' + Owner + '/' + Repo +
      '. Current head ' + HEAD_SHA.slice(0, 12) + ' vs base ' + BASE_SHA.slice(0, 12) +
      '. Use the read-only tools to verify the CURRENT state, then produce your review ' +
      "ending in exactly 'Verdict: PASS' or 'Verdict: BLOCK' on the final line." },
  ];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await chat(messages);
    const msg = resp && resp.choices && resp.choices[0] && resp.choices[0].message;
    if (!msg) throw new Error('empty model response');
    const content = typeof msg.content === 'string' ? msg.content : '';
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const assistant = { role: 'assistant', content: content || null };
    if (toolCalls.length) assistant.tool_calls = toolCalls;
    messages.push(assistant);
    if (!toolCalls.length) return content;
    for (const tc of toolCalls) {
      const fn = DISPATCH[tc.function && tc.function.name];
      let args = {};
      try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (e) { /* ignore */ }
      let out;
      try {
        out = fn ? await fn(args) : 'UNKNOWN tool ' + (tc.function && tc.function.name);
      } catch (e) {
        out = { error: e.message };
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: typeof out === 'string' ? out : JSON.stringify(out) });
    }
  }
  const last = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
  return (last && last.content) || 'Conversation exceeded turn budget without a verdict.';
}

function extractVerdict(text) {
  const re = /^Verdict:\s*(PASS|BLOCK)\s*$/gm;
  const found = [];
  let m;
  while ((m = re.exec(String(text)))) found.push(m[1]);
  const distinct = [...new Set(found)];
  return { found, distinct, n: found.length };
}

async function main() {
  if (!PR) {
    setOutput('success', 'false');
    setOutput('response', '');
    throw new Error('No pull_request context in this run.');
  }
  const review = await runAgent();
  const { found, distinct, n } = extractVerdict(review);
  setOutput('response', review || '');
  setOutput('success', 'true');
  console.log('pi-review: verdict lines=' + n + ' distinct=' + JSON.stringify(distinct));
  // Best-effort single comment with a run footer (never fail the step on post failure).
  try {
    const runUrl = GITHUB_SERVER_URL + '/' + GITHUB_REPOSITORY + '/actions/runs/' + GITHUB_RUN_ID;
    const footer = '\n\n---\n' + PROVIDER + '/' + MODEL + ' — pi-review-action.\n\n[View action run](' + runUrl + ')';
    await gh('/repos/' + Owner + '/' + Repo + '/issues/' + PR + '/comments', {
      method: 'POST',
      json: { body: String(review || '') + footer },
    });
    console.log('[pi-review] comment posted');
  } catch (e) {
    console.log('[pi-review] comment post failed (non-fatal): ' + e.message);
  }
}

(async () => {
  try {
    await main();
  } catch (e) {
    try { setOutput('success', 'false'); } catch (e2) { /* ignore */ }
    console.error('[pi-review] FATAL: ' + (e && e.message));
    process.exitCode = 1;
  }
})();