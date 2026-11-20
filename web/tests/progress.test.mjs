import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

/* The `progress` step: one live line per in-flight call_id.

   web/ ships no bundler and no DOM, so this suite is structural — it reads app.js as
   text. A progress contract has a behaviour to it that text cannot prove: a newer line
   has to REPLACE the older one on the same call, and neither the replace nor the meter
   may disturb the running block's counts. So this file does the one thing the others
   cannot: it lifts applyCoreStep out of the IIFE and calls it against fake steps, which
   is also the only way to show an orphan or a malformed step lands nowhere.

   It never renders. There is no document here, and adding a fake one would only let
   these tests pass for reasons the browser would not. */

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(resolve(WEB, 'app.js'), 'utf8');
const CSS = readFileSync(resolve(WEB, 'styles.css'), 'utf8');

// Same helper assets.test.mjs uses: a failing assert.match prints its whole target,
// and app.js is 160 KB of it.
function slice(source, from, to) {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `${JSON.stringify(from)} is gone - the code changed shape`);
  const end = source.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `${JSON.stringify(to)} never closes ${JSON.stringify(from)}`);
  return source.slice(start, end + to.length);
}

function extractFn(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone - the code changed shape`);
  // Scan to the brace that closes the body, ignoring braces inside strings and
  // comments so a `'{'` in a message cannot end the region early.
  let depth = 0;
  let i = APP.indexOf('{', start);
  for (; i < APP.length; i += 1) {
    const c = APP[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(APP, i); continue; }
    if (c === '/' && APP[i + 1] === '/') { i = skipLine(APP, i); continue; }
    if (c === '/' && APP[i + 1] === '*') { i = skipBlock(APP, i); continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) break; }
  }
  assert.ok(depth === 0, `${name} never closes - the brace scan lost the plot`);
  return APP.slice(start, i + 1);
}

function skipString(src, at) {
  const quote = src[at];
  for (let j = at + 1; j < src.length; j += 1) {
    if (src[j] === '\\') { j += 1; continue; }
    if (src[j] === quote) return j;
  }
  return at;
}

function skipLine(src, at) {
  const nl = src.indexOf('\n', at);
  return nl === -1 ? src.length : nl;
}

function skipBlock(src, at) {
  const end = src.indexOf('*/', at + 2);
  return end === -1 ? src.length : end + 1;
}

/* A task shaped like the ones pollCore feeds applyCoreStep, with just the helpers the
   function reaches for. Nothing else runs, so nothing else needs to exist. */
function harness() {
  let nextId = 1;
  const stubs = {
    state: { nextId, queued: [] },
    pushMsg(task, msg) { msg.id = nextId++; task.msgs.push(msg); return msg; },
    describeCall: (name) => ({ title: name, path: '' }),
    toolMeta: (kind) => ({ label: kind || 'Action', icon: '🔧', category: 'other' }),
    looksLikeCall: () => false,
    coreStreamMsg: () => ({ content: '', meta: { stream: true } }),
    noteEnd: () => {},
    deliverFile: () => {},
    saveState: () => {},
    renderQueue: () => {},
  };
  const context = vm.createContext(stubs);
  const fn = vm.runInContext(`(${extractFn('applyCoreStep')})`, context);
  const makeTask = () => ({ id: 1, msgs: [], runGen: 1, status: 'Running' });
  return { fn, makeTask };
}

const PROGRESS = {
  type: 'progress', name: 'web_task', call_id: 'call_7',
  text: 'Deciding step 3 of 12', step: 3, of: 12, i: 7, t: 41.2,
};

test('a progress step rides the card its tool_start made, verbatim', () => {
  const { fn, makeTask } = harness();
  const task = makeTask();
  fn(task, { type: 'tool_start', name: 'web_task', call_id: 'call_7' }, null);
  const before = task.msgs.length;
  fn(task, PROGRESS, null);

  assert.equal(task.msgs.length, before, 'a progress step added a row instead of updating one');
  const card = task.msgs.find((m) => m.meta.toolId === 'call_7');
  assert.ok(card, 'the tool_start card is missing');
  assert.equal(card.meta.progress.text, 'Deciding step 3 of 12', 'the loop sentence was altered');
  assert.equal(card.meta.progress.meter, '3/12');
  assert.equal(card.meta.status, 'Running', 'progress settled the call, which would fold the block');
});

test('a newer progress replaces the older one for the same call', () => {
  const { fn, makeTask } = harness();
  const task = makeTask();
  fn(task, { type: 'tool_start', name: 'web_task', call_id: 'call_7' }, null);
  fn(task, PROGRESS, null);
  fn(task, { ...PROGRESS, text: 'Deciding step 9 of 12', step: 9 }, null);

  const cards = task.msgs.filter((m) => m.kind === 'action');
  assert.equal(cards.length, 1, 'two rows are on screen for one in-flight call');
  assert.equal(cards[0].meta.progress.text, 'Deciding step 9 of 12');
  assert.equal(cards[0].meta.progress.meter, '9/12');
  // The first sentence must be gone, not appended to: a piled-up line is the very
  // thing the user read as the page freezing.
  assert.equal(JSON.stringify(task.msgs).includes('step 3 of 12'), false, 'the old line survived');
});

test('the meter renders only when step and of are both present', () => {
  const { fn, makeTask } = harness();
  const cases = [
    [{ step: 3, of: 12 }, '3/12'],
    [{ step: 3 }, ''],
    [{ of: 12 }, ''],
    [{}, ''],
    // Absent means absent: a zero or a fractional pair is a wrong shape, not a meter.
    [{ step: 0, of: 0 }, ''],
    [{ step: 2.5, of: 12 }, ''],
  ];
  for (const [extra, want] of cases) {
    const task = makeTask();
    fn(task, { type: 'tool_start', name: 'web_task', call_id: 'call_7' }, null);
    const step = { ...PROGRESS, name: 'web_task', call_id: 'call_7' };
    delete step.step; delete step.of;
    fn(task, Object.assign(step, extra), null);
    const card = task.msgs.find((m) => m.meta.toolId === 'call_7');
    assert.equal(card.meta.progress.meter, want, `step=${extra.step} of=${extra.of}`);
    assert.equal(card.meta.progress.text, 'Deciding step 3 of 12', 'the text bent to the meter');
  }
});

test('a progress step changes the running block counts not at all', () => {
  // foldCalls/blockTitle are exercised through their own inputs rather than the DOM:
  // the counts come from the rows a stretch keeps, and a progress step must not put a
  // row in or take one out.
  const foldCalls = extractFn('foldCalls');
  const blockTitle = extractFn('blockTitle');
  assert.match(foldCalls, /foldsUp\(msgs\[i\]\)/, 'foldCalls stopped consulting foldsUp');
  // Only a call row reaches blockTitle's buckets, and progress writes no row, so the
  // single place progress could move a count is by making a card look settled.
  assert.match(blockTitle, /if \(live\) return 'Running · ' \+ clock\(secs\);/);

  const { fn, makeTask } = harness();
  const task = makeTask();
  fn(task, { type: 'tool_start', name: 'read_file', call_id: 'call_1' }, null);
  fn(task, { type: 'tool', name: 'read_file', call_id: 'call_1', ok: true, result: 'x' }, null);
  fn(task, { type: 'tool_start', name: 'web_task', call_id: 'call_7' }, null);
  const counted = () => task.msgs.filter((m) => m.kind !== 'think' && m.kind !== 'attach').length;
  const before = counted();
  fn(task, PROGRESS, null);
  fn(task, { ...PROGRESS, text: 'Deciding step 4 of 12', step: 4 }, null);
  assert.equal(counted(), before, 'progress moved the number of calls the block counts');

  // And the in-flight card still folds up as Running, which is what keeps the block live.
  const running = task.msgs.find((m) => m.meta.toolId === 'call_7');
  assert.equal(running.meta.status, 'Running');
  assert.ok(running.meta.progress, 'the live line was dropped on the floor');
});

test('an orphan or malformed progress step is ignored silently', () => {
  const { fn, makeTask } = harness();
  // Positive control first: without one, this test would also pass on a build with no
  // progress handler at all, which is exactly the case it exists to police.
  const ok = makeTask();
  fn(ok, { type: 'tool_start', name: 'web_task', call_id: 'call_7' }, null);
  fn(ok, PROGRESS, null);
  assert.ok(ok.msgs.find((m) => m.meta.toolId === 'call_7').meta.progress,
    'a well-formed progress step did not land, so the checks below prove nothing');

  const bad = [
    { ...PROGRESS, call_id: 'call_never_started' },          // no tool_start for it
    { ...PROGRESS, text: undefined },                        // missing text
    { ...PROGRESS, text: 42 },                               // non-string text
    { ...PROGRESS, text: '' },                               // empty text
    { ...PROGRESS, text: null },
    { ...PROGRESS, call_id: undefined },                     // text without call_id
    { ...PROGRESS, call_id: '' },                            // empty id matches nothing
    { ...PROGRESS, call_id: { nested: true } },              // unusable id shape
    { type: 'progress', text: 'no id at all' },
    { type: 'progress' },                                    // nothing usable at all
  ];
  for (const step of bad) {
    const task = makeTask();
    fn(task, { type: 'tool_start', name: 'web_task', call_id: 'call_7' }, null);
    const before = JSON.stringify(task.msgs);
    assert.doesNotThrow(() => fn(task, step, null), JSON.stringify(step));
    assert.equal(JSON.stringify(task.msgs), before, `a bad step changed the timeline: ${JSON.stringify(step)}`);
  }
});

test('a progress step finds its card by call_id alone', () => {
  // Two calls in flight on different ids: only the named one may move, or the live
  // line would land on the wrong tool and read as a lie about what is running.
  const { fn, makeTask } = harness();
  const task = makeTask();
  fn(task, { type: 'tool_start', name: 'read_file', call_id: 'call_1' }, null);
  fn(task, { type: 'tool_start', name: 'web_task', call_id: 'call_7' }, null);
  fn(task, PROGRESS, null);
  const other = task.msgs.find((m) => m.meta.toolId === 'call_1');
  const mine = task.msgs.find((m) => m.meta.toolId === 'call_7');
  assert.equal(other.meta.progress, undefined, 'the line jumped to another call');
  assert.equal(mine.meta.progress.text, 'Deciding step 3 of 12');
  // A numeric id is still an id: tool_start falls back to s.name, so ids are not
  // guaranteed to be strings on either side.
  const numeric = makeTask();
  fn(numeric, { type: 'tool_start', name: 'web_task', call_id: 7 }, null);
  fn(numeric, { ...PROGRESS, call_id: 7 }, null);
  assert.equal(numeric.msgs[0].meta.progress.text, 'Deciding step 3 of 12', 'a numeric call_id was rejected');
});

test('a finished call stops showing the live line', () => {
  const { fn, makeTask } = harness();
  const task = makeTask();
  fn(task, { type: 'tool_start', name: 'web_task', call_id: 'call_7' }, null);
  fn(task, PROGRESS, null);
  fn(task, { type: 'tool', name: 'web_task', call_id: 'call_7', ok: true, result: 'done' }, null);
  const card = task.msgs.find((m) => m.meta.toolId === 'call_7');
  assert.equal(card.meta.status, 'Complete');
  // groupRowOf and case 'action' both gate the line on Running, so a stale progress
  // left on a settled card can never print over the answer.
  assert.match(APP, /const prog = status === 'Running' \? meta\.progress : null;/);
  assert.match(APP, /const running = d\.status === 'Running';/);
});

test('STEP_TYPES names progress, matching the loop vocabulary', () => {
  const list = slice(APP, 'const STEP_TYPES = [', '];');
  const named = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(named.includes('progress'), 'the mirror never learned the new step type');
  assert.deepEqual([...new Set(named)].sort(), named.slice().sort(), 'STEP_TYPES lists a type twice');
  // The chain has to agree with the list: every type the dispatch speaks for is
  // listed. Scoped to the `kind ===` comparisons, because the branches also match on
  // a message's kind ('result', 'think') when looking one up, which is not a step type.
  const chain = extractFn('applyCoreStep');
  // Anchored on `kind ===` as an if/else-if condition, so a branch that matches on a
  // message's kind while looking it up (x.kind === 'result') is not read as a step type.
  const handled = [...chain.matchAll(/(?:^|[{(]\s*)kind === '([a-z_]+)'/gm)].map((m) => m[1]);
  assert.ok(handled.length >= 10, `only ${handled.length} dispatch arms parsed - the chain changed shape`);
  assert.deepEqual(handled.filter((k) => !named.includes(k)), [],
    'applyCoreStep handles a type STEP_TYPES does not list');
  for (const kind of ['tool_start', 'progress', 'tool']) {
    assert.ok(handled.includes(kind), `applyCoreStep no longer speaks for ${kind}`);
  }
  // Order carries meaning: progress is documented as landing between the two.
  assert.ok(named.indexOf('tool_start') < named.indexOf('progress'),
    'progress is listed before the tool_start that owns its card');
  assert.ok(named.indexOf('progress') < named.indexOf('tool'),
    'progress is listed after the tool step that ends its call');
  // The chain keeps its open ending: it stops after `cancelled` with no terminal
  // else, which is why an unknown type vanishes quietly instead of throwing or
  // logging. Nested `} else {` inside a branch is fine and stays unchecked.
  const tail = chain.slice(chain.lastIndexOf("kind === 'cancelled'"));
  assert.doesNotMatch(tail, /else\s+if|}\s*else\s*\{/,
    'the chain grew a terminal arm, so unknown types no longer vanish silently');
});

test('the live line is styled from theme variables, in both schemes', () => {
  // The card a Running call draws is its own card (foldsUp keeps it out of every
  // block), so .chunk-hint.call-progress is the only place the line prints.
  const hint = slice(CSS, '.chunk-hint.call-progress {', '\n}');
  assert.match(hint, /color: var\(--text-muted\)/, 'the dim line needs a muted colour');
  assert.match(hint, /overflow-wrap: anywhere/, 'a long loop sentence must wrap, not clip');
  // --bg, --panel, --surface and --text are what the theme presets rewrite, so every
  // colour here has to reach the screen through a variable rather than a literal.
  assert.doesNotMatch(hint, /#[0-9A-Fa-f]{3,8}\b/, 'a hardcoded colour will not follow the light scheme');
  assert.doesNotMatch(hint, /\brgba?\(/, 'a literal alpha colour will not follow the light scheme');
  // The tool_start card is pushed collapsed, and collapsing hides the body only. If
  // that ever reached the header too, the live line would be invisible on exactly the
  // card the user is watching, which is the "website looks frozen" bug this step fixes.
  assert.match(CSS, /\.message\.collapsed \.message-body \{ display: none; \}/);
  assert.doesNotMatch(CSS, /\.message\.collapsed[^{]*\{[^}]*\.message-header[^}]*display: none/,
    'a collapsed card hides its header, so the live line would never show');
});

test('the progress line reaches the DOM escaped, and stays id-free', () => {
  // The card a Running call draws is its own card (foldsUp keeps it out of every
  // block), so case 'action' is where the live line prints. Both slots go through
  // escapeHtml, which is what stops a loop sentence carrying markup from becoming any.
  const card = slice(APP, "      case 'action': {", '\n        break;');
  assert.match(card, /const prog = status === 'Running' \? meta\.progress : null;/);
  assert.match(card, /<span class="chunk-hint\$\{prog \? ' call-progress' : ''\}">\$\{escapeHtml\(hint\)\}<\/span>/);
  assert.match(card, /\$\{escapeHtml\(prog \? prog\.text : bodyText\)\}/);
  // The meter rides on the hint only when the pair was complete.
  assert.match(card, /prog\.text \+ \(prog\.meter \? ' · ' \+ prog\.meter : ''\)/);
  // No new shell id: assets.test.mjs pins every $('id') to index.html, and the live
  // line is a class on a node the card already builds.
  assert.match(card, /class="chunk-hint\$\{prog \? ' call-progress' : ''\}/);
  assert.doesNotMatch(card.slice(card.indexOf('wrap.innerHTML')), /id=/, 'the card grew a new id');
  const html = readFileSync(resolve(WEB, 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const looked = new Set([...APP.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
  assert.deepEqual([...looked].filter((id) => !ids.has(id)), [],
    'app.js looks up an id the shell never renders');
});
