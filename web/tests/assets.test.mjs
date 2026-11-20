import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/* Structural checks for the no-build PWA.

   web/ has no bundler, no modules and no DOM: app.js is one script that reaches
   the shell by id. So the failure mode this suite exists for is silent - a renamed
   or deleted id, an asset that no longer exists, a tool the core advertises that the
   timeline has no words for. None of those throw; they just make a button do nothing.
   Nothing here starts a server or a browser, and nothing here asserts a number a
   measurement owns somewhere else. */

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = resolve(WEB, '..', '..');
const read = name => readFileSync(resolve(WEB, name), 'utf8');

const HTML = read('index.html');
const APP = read('app.js');

function pngSize(file) {
  const bytes = readFileSync(resolve(WEB, file));
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG', `${file} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/* Three-surface parity can only be checked by reading the other surfaces: web/
   imports nothing, so app.js just says in a comment that it mirrors a Rust
   function. A standalone web/ checkout has no siblings to read, so a test that is
   nothing but parity skips out loud rather than passing over an empty set; a test
   that has already proved something about web/ on its own just stops early. */
function readSibling(path) {
  const file = resolve(SUITE, path);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

// A failing assert.match prints its whole target, and app.js is 160 KB of it, so
// every substring check below runs against a cut region, not the file.
function slice(source, from, to) {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `${JSON.stringify(from)} is gone - the code changed shape`);
  const end = source.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `${JSON.stringify(to)} never closes ${JSON.stringify(from)}`);
  return source.slice(start, end + to.length);
}

function jsFlags(text) {
  const out = {};
  for (const pair of text.split(',')) {
    const [key, value] = pair.split(':').map((bit) => bit.trim().replace(/'/g, ''));
    if (!key) continue;
    out[key] = value === 'true' ? true : value === 'false' ? false : value;
  }
  return out;
}

function rustFlags(text) {
  const out = {};
  for (const m of text.matchAll(/self\.(\w+) = (true|false)/g)) out[m[1]] = m[2] === 'true';
  return out;
}

test('manifest icons exist at the sizes it declares', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  assert.ok(manifest.icons.length >= 4, 'the install prompt needs several icon sizes');
  for (const icon of manifest.icons) {
    const file = icon.src.replace(/^\.\//, '').replace(/\?.*$/, '');
    assert.ok(existsSync(resolve(WEB, file)), `${icon.src} is missing`);
    if (icon.type === 'image/png') {
      const [width, height] = icon.sizes.split('x').map(Number);
      assert.deepEqual(pngSize(file), { width, height }, `${file} dimensions`);
    }
  }
});

test('every local asset referenced by index.html exists', () => {
  const refs = [...HTML.matchAll(/(?:href|src)="\.\/([^"?#]+)/g)].map(match => match[1]);
  assert.ok(refs.length >= 5, 'the shell should reference its icons, manifest, css and js');
  for (const file of new Set(refs)) assert.ok(existsSync(resolve(WEB, file)), `${file} is missing`);
});

test('neither shell file points at a script the refactor left behind', () => {
  // web/ has been emptied and re-added before; a leftover `<script src="./helpers.js">`
  // or `./service-worker.js` is a 404 that only shows up as dead features.
  const named = new Set();
  for (const source of [HTML, APP]) {
    for (const m of source.matchAll(/["'`]\.\/([\w./-]+?\.(?:js|mjs|css|webmanifest|json|png|svg))(?:[?#][^"'`]*)?["'`]/g)) {
      named.add(m[1]);
    }
  }
  assert.ok(named.size >= 3, `only ${named.size} assets named by the shell - the reference style changed`);
  for (const file of named) assert.ok(existsSync(resolve(WEB, file)), `${file} is referenced but not on disk`);
  assert.doesNotMatch(HTML, /helpers\.js|updater\.js|service-worker\.js/, 'dangling script reference');
});

test("every $('id') app.js reaches for is in the shell", () => {
  const ids = new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const looked = new Set([...APP.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(match => match[1]));
  assert.ok(looked.size >= 50, `only ${looked.size} id lookups parsed - the helper changed shape`);
  const absent = [...looked].filter(id => !ids.has(id));
  assert.deepEqual(absent, [], 'app.js looks up ids the shell never renders');
});

test('the shell has no duplicate ids', () => {
  // A duplicate id does not throw, it makes the first element win, so half the
  // wiring silently addresses the wrong node.
  const seen = new Map();
  for (const m of HTML.matchAll(/\bid="([^"]+)"/g)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepEqual(dupes, [], 'index.html renders these ids more than once');
});

test('the timeline words each tool exactly as the native shells word it', (t) => {
  // app.js:describeCall says it mirrors fennec-ui/src/attention.rs:describe_call.
  // Parity between the three surfaces is a standing requirement, and a phrase that
  // drifts in one of them is invisible until someone compares screenshots.
  const rs = readSibling('fennec-ui/src/attention.rs');
  if (!rs) return t.skip('no sibling fennec-ui checkout to compare against');
  const body = rs.slice(rs.indexOf('pub fn describe_call'), rs.indexOf('/// The words a gated call'));
  const native = new Map();
  for (const m of body.matchAll(/"([a-z_]+)" => \("[A-Z]+"\.into\(\), (?:format!\("([^"]*)\{\}|"([^"]+)"\.into)/g)) {
    native.set(m[1], (m[2] || m[3]).trimEnd());
  }
  assert.ok(native.size >= 12, `only ${native.size} native titles parsed - describe_call changed shape`);
  const web = new Map();
  for (const m of APP.matchAll(/case '([a-z_]+)': return \{ title: '([^']+)'/g)) {
    web.set(m[1], m[2].trimEnd());
  }
  assert.ok(web.size >= 12, `only ${web.size} web titles parsed - describeCall changed shape`);
  assert.deepEqual([...web.keys()].sort(), [...native.keys()].sort(), 'the two surfaces title a different set of tools');
  for (const [tool, phrase] of native) {
    assert.equal(web.get(tool), phrase, `${tool} is worded differently on the web`);
  }
});

test('no tool the core advertises falls through to its raw name', (t) => {
  const core = readSibling('fennec-core/tools.py');
  if (!core) return t.skip('no sibling fennec-core checkout to read the tool table from');
  const advertised = new Set(
    [...core.matchAll(/^    "([a-z_]+)": \(/gm)].map(match => match[1]),
  );
  assert.ok(advertised.size >= 10, `only ${advertised.size} TOOLS entries parsed - the table changed shape`);
  const titled = new Set([...APP.matchAll(/case '([a-z_]+)': return \{ title:/g)].map(match => match[1]));
  const raw = [...advertised].filter(name => !titled.has(name));
  assert.deepEqual(raw, [], 'the core offers tools the timeline would show as a bare identifier');
});

test('the permission modes send the flags their labels promise', (t) => {
  const modes = {};
  const block = slice(APP, 'const PERM_MODES = {', '\n  };');
  for (const m of block.matchAll(/^ {4}(ask|auto|full): \{[\s\S]*?label: '([^']*)'[\s\S]*?flags: \{([^}]*)\}/gm)) {
    modes[m[1]] = { label: m[2], flags: jsFlags(m[3]) };
  }
  assert.deepEqual(Object.keys(modes).sort(), ['ask', 'auto', 'full'], 'the composer offers three modes');
  assert.deepEqual(modes.ask, {
    label: 'Ask every time',
    flags: { allow_write: false, allow_shell: false, allow_web: false, ask_each: true },
  }, 'ask must pre-grant nothing and interrupt everything');
  for (const mode of ['auto', 'full']) {
    assert.deepEqual(modes[mode].flags, {
      allow_write: true, allow_shell: true, allow_web: true, ask_each: false,
    }, `${mode} (${modes[mode].label}) promises not to ask, so it has to carry every grant`);
  }

  // The desktop dropdown is the same three rows; two surfaces may not disagree
  // about what "Auto approve" buys. fennec-desktop owns the flags, fennec-ui the words.
  const shell = readSibling('fennec-desktop/src/gui_main.rs');
  const controls = readSibling('fennec-ui/src/controls.rs');
  if (!shell || !controls) return;
  const arms = {};
  const setter = slice(shell, 'fn set_access_mode', '\n    fn access_label');
  for (const m of setter.matchAll(/"(auto|full)" => \{([^}]*)\}/g)) arms[m[1]] = rustFlags(m[2]);
  arms.ask = rustFlags(/_ => \{([^}]*)\}/.exec(setter)[1]);
  const labels = {};
  const labelBody = slice(controls, 'pub fn access_label', '\n}');
  for (const m of labelBody.matchAll(/"(auto|full)" => "([^"]*)"/g)) labels[m[1]] = m[2];
  labels.ask = /_ => "([^"]*)"/.exec(labelBody)[1];
  for (const mode of ['ask', 'auto', 'full']) {
    assert.deepEqual(modes[mode].flags, arms[mode], `${mode} means different things on the two surfaces`);
    assert.equal(modes[mode].label, labels[mode], `${mode} is named differently on the two surfaces`);
  }
});

test('approval cards ask in user words, never with the tool name', () => {
  // The loop names the tool (run_shell); the card has to say "Run command".
  assert.match(APP, /Run command/);
  assert.doesNotMatch(APP, /<\$\{[^}]*\btool\b\}[^>]*>\s*\$\{[^}]*\bname\b\}/, 'a card titled by raw tool name');
  const htmlIds = new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  for (const id of ['attention-list', 'approval-answer']) {
    if (APP.includes(`('${id}')`)) assert.ok(htmlIds.has(id), `${id} is looked up but not rendered`);
  }
});

test('the running block counts the work it delivered, in the natives words', () => {
  const buckets = [...slice(APP, 'const COUNT_BUCKETS = [', '\n  ];')
    .matchAll(/\['(\w+)', '(\w+)', '(\w+)'\]/g)].map(m => m.slice(1));
  assert.deepEqual(buckets, [['tools', 'ran', 'tool'], ['reads', 'read', 'file'], ['writes', 'wrote', 'file']]);

  const title = slice(APP, 'function blockTitle', '\n  }\n');
  assert.match(title, /if \(live\) return 'Running · ' \+ clock\(secs\);/, 'open block shows the timer');
  // A thought is not work delivered, so it lands in no bucket - the user's brief
  // was thinking inside the block but never counted by it.
  assert.match(title, /if \(!r\.kind\) \{ n\.thoughts \+= 1; continue; \}/);
  assert.match(title, /'Thinking'/, 'a run that only thought still needs a title');
  assert.match(title, /'No calls'/);

  // fennec_ui::timeline::block_title builds the native line from the same triples.
  const rs = readSibling('fennec-ui/src/timeline.rs');
  if (!rs) return;
  const native = [...slice(rs, 'let buckets = [', '];').matchAll(/\(\w+, "(\w+)", "(\w+)"\)/g)].map(m => m.slice(1));
  assert.deepEqual(native, buckets.map(([, verb, noun]) => [verb, noun]),
    'the web and native running blocks count in different words');
  assert.match(rs, /format!\("Running · \{\}", clock\(elapsed_secs\)\)/);
  assert.match(rs, /\{ "Thinking"\.to_string\(\) \} else \{ "No calls"\.to_string\(\) \}/);
});

test('the outlet rows read as the native client reads them', (t) => {
  // core answers /api/outlets with raw probe keys; every shell turns them into one
  // line per outlet. app.js has no import, so this is the second copy of that
  // wording, and the second copy is where a word drifts.
  const client = readSibling('fennec-core/src/fennec-client/src/agent.rs');
  const egui = readSibling('fennec-desktop/src/main.rs');
  const gpui = readSibling('fennec-desktop/src/gui_main.rs');
  if (!client || !egui || !gpui) return t.skip('no sibling fennec-core / fennec-desktop checkout to compare against');

  // Each phrase must appear verbatim on both sides: the joiners are what make a row
  // say "install this" rather than "no".
  const phrases = [
    'installed — ', 'not installed', 'not installed — no python with the browser transport',
    ' needs LIQUID_API_KEY', ' · browser transport ', 'this interpreter', 'd1.2',
    'unavailable — ', ' coworker', 'no agent list at ',
    // The two "no rows" states belong to the rail, not to one outlet.
    'unknown (agent loop offline)', 'the agent server named none',
  ];
  for (const phrase of phrases) {
    assert.ok(APP.includes(`'${phrase}`) || APP.includes(`'${phrase.trimEnd()}'`),
      `app.js never says ${JSON.stringify(phrase)}`);
    // The native side composes with `{}` placeholders, so a phrase can sit in the
    // middle of its format! string rather than at the start.
    assert.ok(client.includes(phrase), `the native client never says ${JSON.stringify(phrase)}`);
  }
  // Wording the client owns only reaches the screen if a shell asks for it: both
  // natives build their rail from outlet_rows rather than word the probe locally,
  // which is what keeps three surfaces down to two copies of the sentences.
  for (const [name, src] of [['egui', egui], ['gpui', gpui]]) {
    assert.match(src, /\boutlet_rows\(/, `the ${name} rail never asks the client for its rows`);
  }
  // The pair is what the rail is keyed by, so a row that core no longer answers for
  // has to be deleted here too, not just left to render an empty line. The pattern
  // stays off a line anchor: two fields in one struct literal can split across
  // lines on a reformat, and the test is about the set of outlets, not the layout.
  const labels = [...client.matchAll(/id:\s*"(\w+)",\s*label:\s*"(\w+)"/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(labels, [['fennec', 'Fennec'], ['openbot', 'OpenBot']],
    'the native client names a different set of outlets');
  const block = slice(APP, 'const OUTLETS = [', '\n  ];');
  for (const [id, label] of labels) {
    assert.match(block, new RegExp(`id: '${id}', label: '${label}'`), `${label} is not in the web list`);
  }

  // Same probe keys decide the wording, or a renamed key silently pins every row to
  // its "absent" branch on one surface only.
  const native = new Set([...client.matchAll(/v\.get\("([a-z_]+)"\)/g)].map(m => m[1])
    .concat([...client.matchAll(/flag\(v, "([a-z_]+)"\)/g)].map(m => m[1])));
  const web = new Set([...slice(APP, 'function transportNote', 'function outletLines')
    .matchAll(/\bo\.([a-z_]+)\b/g)].map(m => m[1]));
  assert.deepEqual([...web].filter(k => !native.has(k)), [],
    'app.js reads a probe key the native client never asks core for');
  for (const key of ['present', 'transport', 'transport_from', 'interpreter', 'model',
                     'error', 'url', 'agents']) {
    assert.ok(web.has(key), `app.js stopped reading ${key}`);
  }
});

test('the outlet rows reach the DOM as text, never as markup', () => {
  const ids = new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  assert.ok(ids.has('env-outlets'), 'the shell has no slot for the outlet rows');
  assert.ok(APP.includes("$('env-outlets')"), 'app.js never looks the slot up');
  const body = slice(APP, 'function renderOutlets', '\n  }\n');
  assert.doesNotMatch(body, /innerHTML/, 'a probe string is server data; it goes in as text');
  assert.match(body, /replaceChildren\(\)/, 'rows must not accumulate across polls');
  assert.match(body, /state\.outlets \|\| outletLines\(null\)/, 'an unprobed rail has to say unknown');
  const css = read('styles.css');
  assert.match(css, /\.env-row\.outlet\s*\{[^}]*align-items: flex-start/, 'a two-line outlet row needs the label on top');
  assert.match(css, /\.env-value\.wrap\s*\{[^}]*overflow-wrap: anywhere/, 'a Windows path has no break point to find');
});

test('an installed shell cannot be shadowed by the old caching worker', () => {
  /* Measured on a live origin, 2026-11-20. The module-era PWA registered
     /service-worker.js and answered every script and style from Cache Storage with
     ignoreSearch, so app.js?v=40 was served the app.js it happened to have cached -
     a file whose first line was `import`. The current shell loads app.js as a classic
     script, so it failed to parse and *nothing in it ran*: no boot, no API calls, an
     entirely dead page with an error the console showed only if you were watching.
     Deleting that worker from the repo does not clear it from a browser that loaded
     the old shell - a 404 on the script URL reads as "no update", not "uninstall" -
     so the cure is a worker at that same URL that removes itself and its caches. */
  assert.ok(existsSync(resolve(WEB, 'service-worker.js')),
    'the self-destructing worker is gone, so every browser still holding the old registration stays dead');
  // The header comment quotes the broken call, so assert against the code only.
  const worker = read('service-worker.js').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(worker, /caches\.open|\.addAll\(|cache\.put\(/,
    'a worker that caches the shell is what broke the installed PWA once');
  assert.doesNotMatch(worker, /ignoreSearch/, 'query-insensitive matching answers every ?v= with one version');
  assert.doesNotMatch(worker, /['"]fetch['"]/, 'it must not intercept requests even to pass them through');
  assert.match(worker, /caches\.keys\(\)/, 'it has to delete the caches the old worker left behind');
  assert.match(worker, /registration\.unregister\(\)/, 'and drop the registration, or it keeps controlling the scope');
  assert.match(worker, /skipWaiting\(\)/, 'otherwise the repair waits for every tab to close');
  // Nothing in the shell may register a worker again. The dead-page failure needs no
  // code change to come back - only a registration and a later deletion.
  for (const [name, source] of [['index.html', HTML], ['app.js', APP]]) {
    assert.doesNotMatch(source, /serviceWorker/, `${name} registers a service worker again`);
  }
});
