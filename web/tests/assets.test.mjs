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

test('GitHub settings exposes read-only account and repository integration', () => {
  assert.match(HTML, /data-tab="github"/);
  assert.match(HTML, /id="github-account-status"/);
  assert.match(HTML, /id="github-repository-list"/);
  assert.match(HTML, /id="github-refresh"/);
  assert.match(APP, /apiFetch\('\/api\/github\/account'\)/);
  assert.match(APP, /apiFetch\('\/api\/github\/repositories'\)/);
  assert.match(APP, /noopener noreferrer/);
  assert.doesNotMatch(APP, /github-token|github-access-token/i, 'GitHub tokens must not be stored by the PWA');
});

test('the Working in panel shows on every workspace, like the native shell', () => {
  // fennec-ui::repository::working_in_banner always renders: bound it names the
  // repository, unbound it carries the connect action, which is the picker's
  // only entry point from the rail. A panel hidden until a repository is
  // already bound could never be bound from the rail at all.
  assert.doesNotMatch(HTML, /id="working-in"[^>]*hidden/);
  assert.match(HTML, /id="change-repository"/);
  assert.match(HTML, /id="repository-name"/);
  assert.match(HTML, /id="repository-bound"/);
  assert.match(HTML, /id="repository-unbound" hidden/);
  assert.match(HTML, /id="connect-repository"/);
  // The unbound state names both ways out of itself: create a repository inline,
  // or connect one that already exists.
  assert.match(HTML, /id="repository-create-name"/);
  assert.match(HTML, />Connect existing</);
  assert.match(APP, /boundEl\.hidden = !bound/);
  assert.match(APP, /unboundEl\.hidden = bound/);
  assert.match(APP, /ws\.githubRepo/);
  assert.match(APP, /if \(connectRepository\) connectRepository\.addEventListener\('click', openRepositoryDialog\)/);
});

test('the repository picker binds a repository or creates a private one', () => {
  assert.match(HTML, /id="repository-dialog"/);
  assert.match(HTML, /id="repository-choice-list"/);
  assert.match(HTML, /id="repository-create"/);
  assert.match(APP, /function openRepositoryDialog\(\)/);
  assert.match(APP, /No GitHub repositories are available\. Sign in with gh, or create one below\./);
  assert.match(APP, /method: 'POST'/);
  assert.match(APP, /private: true/);
});

test('unbound workspaces adopt the repository of their first source folder', () => {
  // Mirrors fennec-desktop's sync_workspace_github_repos: the Rust backend
  // resolves the folder's git remote through fennec_client::git, so the
  // banner-bootstrap is identical on both surfaces.
  assert.match(APP, /function syncWorkspaceRepositories\(\)/);
  assert.match(APP, /\/api\/github\/detect\?path=/);
  assert.match(APP, /if \(ws\.githubRepo\) continue;/);
  assert.match(APP, /syncBackendRepositories\(\);\n  syncWorkspaceRepositories\(\);/);
});

test('the download row keeps its icon inside the shared ui-icon box', () => {
  // iconSvg's second argument replaces the whole class list. Passing only the
  // row-specific class dropped the 16px sizing and stroke from .ui-icon, and
  // the browser-default 300x150 svg stretched the dropdown until the flex:1
  // name span collapsed to one character per line.
  const dd = slice(APP, 'function renderModelDropdown()', '\n  }\n');
  assert.match(dd, /iconSvg\('download', 'ui-icon model-download-icon'\)/);
  const css = read('styles.css');
  assert.match(css, /\.model-download-icon\s*\{[^}]*flex-shrink: 0/, 'the icon must not be squeezed by its row');
});

test('the rail carries only the native filter toggles, with the GitHub chip', () => {
  // The native left rail (fennec-desktop gui_main::left) offers My attention
  // and Search; new tasks come from a workspace row's + or the composer. The
  // GitHub control is the account chip at the rail's foot, as it is natively.
  const nav = slice(HTML, '<nav class="nav-section">', '</nav>');
  assert.doesNotMatch(nav, /data-nav="coding"|data-nav="new-task"/, 'Recent tasks and New task are not rail entries on the native surface');
  assert.match(nav, /data-nav="attention"/);
  assert.match(nav, /data-nav="search"/);
  assert.match(HTML, /id="github-account-button"/);
  assert.match(APP, /document\.querySelector\('\[data-nav="attention"\]'\)\.classList\.toggle\('active', state\.attentionOnly\)/, 'the highlight follows the persisted filter, not the click');
});

test('settings expose the Integrations tab with the capability contract', () => {
  assert.match(HTML, /data-tab="integrations"/);
  assert.match(HTML, /id="panel-integrations"/);
  assert.match(HTML, /Native Rust stdio MCP server: fennec-nod/);
  assert.match(HTML, /Backend capabilities are unavailable\./);
  assert.match(APP, /apiFetch\('\/api\/capabilities'\)/);
  assert.match(APP, /· protocol /);
  assert.match(APP, /Start fennec-agent to load integration capabilities\./);
});

test('the PWA has no Connection tab; same-origin is the only backend', () => {
  // The native shell (fennec-desktop gui_main settings-save) keeps a Connection
  // tab because it is a separate client that must find the backend and engine.
  // The PWA is served by that Rust backend, so the page cannot mis-configure
  // its way to another one; the old Engine URL and API Key fields were
  // localStorage writes with no readers, and the server URL override predates
  // the Rust backend being canonical.
  assert.doesNotMatch(HTML, /data-tab="connection"|id="panel-connection"/);
  assert.doesNotMatch(HTML, /id="server-url"|id="engine-url"|id="access-token"|id="save-connection"|id="disconnect-button"/);
  assert.match(HTML, /<button class="settings-tab active" data-tab="appearance"/, 'Appearance is the default tab now');
  assert.doesNotMatch(APP, /fennec-server-url|fennec-engine-url|fennec-access-token/, 'no dead connection settings may be stored');
  assert.match(APP, /const apiBase = '';/, 'api calls are pinned to the serving origin');
});

test('workspace rows expose an isolated add-task action', () => {
  const render = slice(APP, 'function renderWorkspaces()', '\n  }\n\n  // ── Workspace creation dialog');
  assert.match(render, /class="workspace-new-task"/);
  assert.match(render, /aria-label="Add task to workspace"/);
  assert.match(render, /createTaskInWorkspace\(btn\.dataset\.id\)/);
  assert.match(render, /e\.stopPropagation\(\);\n        createTaskInWorkspace/);
  assert.match(render, /e\.target\.classList\.contains\('workspace-new-task'\)/);
  assert.match(APP, /function createTaskInWorkspace\(workspaceId\)/);
  assert.match(APP, /workspaceId: ws\.id,/);
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
  // And each rail must ask on *any* reply from the loop. Keying the probe to the
  // legacy payload's `app` field read a healthy Rust backend — which serves
  // /api/outlets and identifies itself by `backend` — as "agent loop offline",
  // which is what the gpui shell and the PWA both did until 2026-11-23.
  assert.match(gpui, /if core_up \|\| axum \{ core\.outlets\(\) \}/,
    'the gpui rail gates the outlets probe on the legacy health payload');
  assert.match(egui, /core0\.health\(\)[\s\S]{0,400}?core0\.outlets\(\)/,
    'the egui rail no longer probes outlets off the loop reply');
  assert.match(APP, /state\.backendConnected \? await loadOutlets\(\)/,
    'the PWA gates the outlets probe on the legacy health payload');
  // The pair is what the rail is keyed by, so a row that core no longer answers for
  // has to be deleted here too, not just left to render an empty line. The pattern
  // stays off a line anchor: two fields in one struct literal can split across
  // lines on a reformat, and the test is about the set of outlets, not the layout.
  const labels = [...client.matchAll(/id:\s*"(\w+)",\s*label:\s*"(\w+)"/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(labels.sort(), [['fennec', 'Fennec'], ['openbot', 'OpenBot'], ['antigravity', 'Antigravity']].sort(),
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

test('the queue keeps two compact rows visible and protects agent work', () => {
  const css = read('styles.css');
  const list = css.slice(css.indexOf('.task-queue-list'), css.indexOf('.task-queue-item'));
  assert.match(list, /max-height:\s*58px/);
  assert.match(list, /overflow-y:\s*auto/);
  assert.doesNotMatch(css.slice(css.indexOf('.task-queue {'), css.indexOf('.task-queue-header')), /overflow-y/);

  const render = slice(APP, 'function renderQueue()', '\n  }\n\n  function drainQueue');
  assert.match(render, /AI · locked/);
  assert.match(render, /data-action="edit"/);
  assert.match(render, /data-action="remove"/);
  assert.match(render, /isAgentQueueItem\(item\)\) return/);
  assert.match(APP, /return entries\.filter\(\(item\) => item\.owner === 'ai'\)\.concat/);
});

test('each theme carries its own accent on both surfaces', () => {
  // The PWA kept one terracotta --brand across every theme; applyTheme now sets
  // --brand per theme, and the translucent derivatives mix from var(--brand) so
  // icons and accent chrome follow. fennec-ui/src/theme.rs mirrors the same map
  // token for token, so the native gpui shell paints the same seven accents
  // through t.accent.
  const apply = slice(APP, 'function applyTheme(theme)', '\n  }\n');
  const brands = {
    dark: '#E9865D', light: '#C2542A', ocean: '#1F6FE4', forest: '#2E9458',
    sunset: '#DC4A38', lavender: '#8B5CF6', coffee: '#A9713F',
  };
  for (const [theme, brand] of Object.entries(brands)) {
    assert.match(apply, new RegExp(`${theme}: \{[^}]*brand: '${brand}'`), `${theme} must ship accent ${brand}`);
  }
  assert.match(apply, /setProperty\('--brand', t\.brand\)/);

  const css = read('styles.css');
  assert.doesNotMatch(css, /rgba\(233, 134, 93/, 'the terracotta alpha literals must not come back');
  for (const token of ['--brand-dim', '--brand-bg', '--user-bg']) {
    const at = css.indexOf(token);
    assert.notEqual(at, -1, `${token} is gone`);
    assert.match(css.slice(at, at + 80), /color-mix\(in srgb, var\(--brand\)/, `${token} must derive from --brand`);
  }

  const native = readSibling('fennec-ui/src/theme.rs');
  if (!native) {
    console.log('skipped native accent parity: no fennec-ui sibling to read');
    return;
  }
  assert.doesNotMatch(native, /accent: ACCENT,/, 'the shared one-accent constant must stay gone');
  for (const theme of Object.keys(brands)) {
    assert.match(native, new RegExp(`accent: ACCENT_${theme.toUpperCase()},`), `${theme} preset must use its own accent const`);
    assert.ok(native.includes(brands[theme]), `the native comments must name ${brands[theme]}`);
  }
});

test('both side panes are draggable and the width survives reload', () => {
  const css = read('styles.css');
  // The shell ships one handle per pane, focusable, inside .app-layout.
  for (const pane of ['rail', 'insp']) {
    const at = HTML.indexOf(`data-pane="${pane}"`);
    assert.notEqual(at, -1, `the ${pane} resizer is gone from the shell`);
    const tag = HTML.slice(HTML.lastIndexOf('<div', at), HTML.indexOf('>', at) + 1);
    assert.match(tag, /class="pane-resizer"/);
    assert.match(tag, /role="separator"\s+aria-orientation="vertical"/);
    assert.match(tag, /tabindex="0"/);
  }
  // The grid must read the same two variables app.js writes inline, and each
  // handle must sit on its pane border by the same variable.
  const layout = css.slice(css.indexOf('.app-layout {'), css.indexOf('.pane-resizer {'));
  assert.match(layout, /--rail-w: \d+px/);
  assert.match(layout, /--insp-w: \d+px/);
  assert.match(layout, /grid-template-columns: var\(--rail-w\) 1fr var\(--insp-w\)/);
  assert.match(css, /#rail-resizer \{ left: calc\(var\(--rail-w\) - 3px\)/);
  assert.match(css, /#inspector-resizer \{ right: calc\(var\(--insp-w\) - 3px\)/);
  assert.match(css, /\.app-layout\.inspector-closed #inspector-resizer \{ display: none/);
  // The narrow tier keeps both handles live: the rail stays a variable
  // column, and the floating inspector and its handle both read --insp-w.
  const narrow = css.slice(css.indexOf('@media (max-width: 1100px)'));
  const tier = narrow.slice(0, narrow.indexOf('@media', 1));
  assert.doesNotMatch(tier, /\.pane-resizer \{ display: none/);
  assert.match(tier, /grid-template-columns: var\(--rail-w\) 1fr/);
  assert.match(tier, /--inspector-w: min\(var\(--insp-w\), 88vw\)/);
  assert.match(tier, /#inspector-resizer \{ right: calc\(var\(--inspector-w\) - 3px\)/);
  // Mobile drops the rail outright, so only its handle goes with it.
  const mobile = css.slice(css.indexOf('@media (max-width: 700px)'));
  assert.match(mobile, /#rail-resizer \{ display: none/);

  const init = slice(APP, 'function initPaneResize()', '\n  }\n');
  assert.match(APP, /^\s+initPaneResize\(\);$/m, 'boot never calls it');
  assert.match(init, /'fennec-pane-widths'/, 'widths must survive reload');
  assert.match(init, /setProperty\(varName\(pane\)/, 'the width is written as the grid variable');
  assert.match(init, /addEventListener\('pointerdown'/);
  assert.match(init, /window\.addEventListener\('pointermove'/, 'tracking must survive the pointer leaving the strip');
  assert.match(init, /pane === 'rail' \? dx : -dx/, 'the inspector grows leftward');
  assert.match(init, /Math\.min\(hi, Math\.max\(lo, w\)\)/, 'both ends are clamped');
  assert.match(init, /addEventListener\('dblclick'/, 'double-click hands back the default width');
  assert.match(init, /ArrowLeft' && e\.key !== 'ArrowRight'/);
});

test('the inspector runs as three tabs, each with its own panel', () => {
  const panel = slice(HTML, '<aside class="right-panel"', '</aside>');
  const tabs = slice(panel, '<div class="insp-tabs"', '</div>');
  assert.match(tabs, /role="tablist"/);
  for (const name of ['overview', 'files', 'browser']) {
    assert.match(tabs, new RegExp(`id="insp-tab-${name}" type="button" role="tab"`));
    assert.match(tabs, new RegExp(`id="insp-tab-${name}"[^>]*aria-controls="insp-view-${name}"`));
    assert.match(panel, new RegExp(`id="insp-view-${name}" role="tabpanel" aria-labelledby="insp-tab-${name}"`));
  }
  // Only Overview is visible at rest; the other two are hidden until picked.
  assert.doesNotMatch(panel, /id="insp-view-overview"[^>]*hidden/);
  assert.match(panel, /id="insp-view-files"[^>]*hidden/);
  assert.match(panel, /id="insp-view-browser"[^>]*hidden/);

  // The Files pane is the bar, the list and a note slot.
  const files = slice(panel, 'id="insp-view-files"', 'id="insp-view-browser"');
  for (const id of ['fm-up', 'fm-path', 'fm-refresh', 'fm-list', 'fm-note']) {
    assert.match(files, new RegExp(`id="${id}"`), `the Files bar lost #${id}`);
  }
  // The reader is a dialog rather than a strip inside the pane: showing it reveals
  // the file from anywhere in a long listing, which is the whole point of the click.
  const viewer = slice(HTML, '<dialog id="file-viewer-dialog"', '</dialog>');
  for (const id of ['file-viewer-close', 'file-viewer-title', 'file-viewer-path', 'file-viewer-meta', 'file-viewer-body', 'file-viewer-image']) {
    assert.match(viewer, new RegExp(`id="${id}"`), `the file viewer lost #${id}`);
  }
  // Two bodies, one shown: the route answers text with `content` and an image
  // with base64 bytes, and at rest the page has no bitmap to paint.
  assert.match(viewer, /<img class="file-viewer-image" id="file-viewer-image"[^>]*hidden/);
  assert.doesNotMatch(viewer, /id="file-viewer-body"[^>]*hidden/);

  const browser = slice(panel, 'id="insp-view-browser"', '</aside>');
  for (const id of ['browser-form', 'browser-url', 'browser-go', 'br-back', 'browser-title', 'browser-meta', 'browser-frame']) {
    assert.match(browser, new RegExp(`id="${id}"`), `the Browser pane lost #${id}`);
  }
  assert.match(browser, /<form class="br-bar"[^>]*>/);
  assert.match(browser, /type="submit"/);
  // The frame may run the page's scripts and submit its forms, but shares no
  // origin with the app: the site can paint itself, it cannot touch the pane
  // that shows it. `allow-modals` stays off on purpose — a page's `alert()`
  // blocks the renderer every tab in this window shares.
  assert.match(browser, /<iframe[^>]*id="browser-frame"[^>]*sandbox="allow-scripts allow-forms"/);
  assert.doesNotMatch(
    browser,
    /allow-same-origin|allow-modals|allow-popups|allow-top-navigation/,
    'the reader jail has a door too many open',
  );

  const css = read('styles.css');
  for (const rule of ['.insp-tabs {', '.insp-tab.active {', '.fm-row {', '.br-bar {', '.br-frame {']) {
    assert.ok(css.includes(rule), `styles.css no longer styles ${rule}`);
  }
});

test('tab switching, the file manager and the reader are wired in app.js', () => {
  assert.match(APP, /const INSP_TABS = \['overview', 'files', 'browser'\]/);
  const setTab = slice(APP, 'function setInspTab(', '\n  }\n');
  assert.match(setTab, /localStorage\.setItem\('fennec-insp-tab', inspTab\)/, 'the opened tab must survive reload');
  assert.match(setTab, /setAttribute\('aria-selected'/);
  assert.match(setTab, /view\.hidden = tab !== inspTab/);
  assert.match(setTab, /if \(inspTab === 'files' && !fmState\.loaded\) loadFmDir\(fmState\.path\)/);

  const load = slice(APP, 'async function loadFmDir(', 'function fmUp()');
  assert.match(load, /seq !== fmSeq/, 'a slow listing must not land on top of a newer one');
  assert.match(load, /apiFetch\('\/api\/work\/files\?path=' \+ encodeURIComponent/);
  assert.match(load, /Number\(!!b\.is_dir\) - Number\(!!a\.is_dir\)/, 'directories sort before files');

  const open = slice(APP, 'async function openFmFile(', '\n  }\n');
  assert.match(open, /\+\+fileViewSeq/, 'the viewer shares one race guard with delivered cards');
  assert.match(open, /apiFetch\('\/api\/work\/file\?path=' \+ encodeURIComponent/);
  assert.match(open, /if \(!dialog\.open\) dialog\.showModal\(\)/, 'a click far down a folder must reveal the file it opened');

  const nav = slice(APP, 'function brNavigate(', '\n  }\n');
  assert.match(nav, /frame\.src = '\/browse\/doc\?u=' \+ encodeURIComponent/, 'the frame must load the Rust reader document');
  assert.match(nav, /brHist\.push\(url\)/, 'the pane keeps no back history');
  const back = slice(APP, 'function brBack(', '\n  }\n');
  assert.match(back, /brHist\.pop\(\)/);
  const listen = slice(APP, 'function initBrowserFrame(', '\n  }\n');
  assert.match(listen, /event\.source !== frame\.contentWindow/, 'anything but the viewer frame could ask for a navigation');
  assert.match(listen, /fennecBrowseGo/);
  assert.match(listen, /fennecBrowseRead/);
  assert.match(listen, /data\.fennecBrowseErr/, 'a form the pane cannot carry stops without a word');
  assert.match(listen, /\/\^https\?:\/i\.test\(target\)/, 'the frame cannot send the reader to another scheme');
  // The strip says what the reader actually fetched, from the frame's own
  // report: the page's title, and the address plus status behind it.
  const report = slice(APP, 'const read = data.fennecBrowseRead;', 'function initInspectorTabs(');
  assert.match(report, /titleEl\.textContent = read\.title/, 'the pane lost the page title');
  assert.match(report, /metaEl\.textContent = read\.status \+ ' · ' \+ read\.url/);
  assert.match(report, /read\.truncated/, 'a clipped read has to say so');

  // A page can drive the pane by itself — a form it submits as it boots, a
  // `location` it writes — and each hop is another read of a real site.
  // Measured on a Google results page: nine reads in nine seconds, none of
  // them asked for. The pane follows, but only so far, and it says so.
  const stop = slice(APP, 'function brStopAuto(', '\n  }\n');
  assert.match(stop, /frame\.src = 'about:blank'/, 'stopping a looping page leaves it loaded');
  assert.match(stop, /kept navigating on its own/);
  assert.match(APP, /const brAutoMax = 3;/);
  assert.match(nav, /brAuto = auto \? brAuto \+ 1 : 0;/, 'a hop the user asked for must clear the count');
  assert.match(nav, /if \(brAuto >= brAutoMax\) \{/);
  assert.match(listen, /brNavigate\(target, true, !!data\.fennecBrowseAuto\)/,
    'a page-driven hop is no longer told from a link the user clicked');
  assert.match(report, /if \(!brAsked\) \{/, 'a read the pane never asked for stops counting as the page');

  // A delivered card opens the same dialog a Files row does — one viewer for both
  // ways a file gets opened, and a modal needs no tab to reveal itself in.
  const delivered = slice(APP, 'async function openDeliveredFile(', '\n  }\n');
  assert.match(delivered, /\$\('file-viewer-dialog'\)/);
  assert.match(delivered, /if \(!dialog\.open\) dialog\.showModal\(\)/);

  assert.match(APP, /function initInspectorTabs\(\)/);
  assert.match(APP, /^\s+initInspectorTabs\(\);$/m, 'boot never calls it');
  assert.match(APP, /setInspTab\(readSetting\('fennec-insp-tab', 'overview'\)\)/);
});

test('the reader hands a page back the tools its frame denies', () => {
  const work = readSibling('fennec-coding-agent/src/work.rs');
  assert.ok(work, 'work.rs vanished');
  const shim = slice(work, 'const BROWSE_SHIM', '"##;');
  // Measured in the pane: these throw on first touch, which stops a site's boot
  // script before it paints. Each gets an in-memory stand-in for one read.
  assert.ok(shim.includes('fix("localStorage")'), 'localStorage lost its bag');
  assert.ok(shim.includes('fix("sessionStorage")'), 'sessionStorage lost its bag');
  assert.ok(shim.includes('defineProperty(document,"cookie"'), 'document.cookie lost its jar');
  assert.ok(shim.includes('defineProperty(navigator,"serviceWorker"'), 'a refused worker must not throw at boot');
  // IndexedDB is the one whose getter answers happily and whose `open` refuses,
  // and the sandboxed frame reports the origin of the URL it was read from, so
  // the shim cannot tell the two cases from outside. It asks the native instead:
  // the page's own call reaches the real factory first, and the standing-in
  // request answers only when that one throws. A working IndexedDB stays.
  assert.ok(shim.includes('open:function(){try{return IO.apply(NIDB,arguments)}catch(e){return freq()}}'),
    'the IndexedDB stub stopped deferring to the native');
  assert.ok(shim.includes('return IDP.apply(NIDB,arguments).catch(function(){return[]})'),
    'databases() refuses asynchronously, so its stand-in has to catch that too');
  // Measured in the pane: a fetch or XHR to a host other than the one that
  // served the markup died as `TypeError: Failed to fetch` / `status=0`, because
  // an opaque origin has no origin a server can allow. So every http(s) target
  // goes to the relay; only a `data:`/`blob:` target and the relay's own address
  // keep theirs (rewriting that asks the reader for its own port, which its
  // private-address gate refuses — measured: 403, 61 bytes).
  assert.ok(shim.includes('if(t.protocol!=="http:"&&t.protocol!=="https:")return u'),
    'a data: or blob: target stopped being left to the browser');
  assert.ok(shim.includes('if(t.host===H&&t.pathname.indexOf("/browse/")===0)return u'),
    'the relay is rewriting its own address again');
  assert.ok(!shim.includes('if(t.host!==H)return u'),
    'the relay went back to serving only the host that served the page');
  assert.ok(shim.includes('return "/browse/raw?u="+encodeURIComponent(t.href)'));
  assert.ok(shim.includes('window.fetch=function') && shim.includes('X.prototype.open='),
    'the rewrite left fetch or XHR');
  // `"` followed by `##` ends the raw string early and rustc reads the rest of
  // the shim as Rust.
  assert.ok(!shim.slice(0, -'"##;'.length).includes('"##'), 'the shim carries a raw-string terminator');

  // The router and the shim are injected after the opening tag, ahead of any
  // script the page brings with it.
  const prep = slice(work, 'pub fn prepare_readable', 'fn drop_declaration_metas');
  assert.ok(prep.includes('"<head"') && prep.includes('"<html"'), 'the injection point moved');
  const boot = slice(work, 'fn bootstrap(', '\n}\n');
  assert.ok(boot.includes('{BROWSE_SHIM}{BROWSE_ROUTER}'), 'the doc lane stopped injecting the shim');
  assert.ok(boot.includes('.replace(\'<\', "\\\\u003c")'), 'a page title could otherwise close this script');

  // A click or submit the user made by hand is forwarded as their ask. A page
  // that fires its own click is not, and forwarding one loops. Measured on a
  // Google results page: its boot script submits a consent form, and because a
  // read cannot carry that form's fields the pane re-read the action seven
  // times in twelve seconds, each reply another page that submitted itself.
  const router = slice(work, 'const BROWSE_ROUTER', '"##;');
  assert.equal((router.match(/if\(!e\.isTrusted\)return;/g) || []).length, 2,
    'a page that clicks or submits its own forms can drive the pane in a loop');
  assert.ok(router.includes('fennecBrowseErr:"This form sends data'),
    'a posted form is being read as a bare address, which is its own loop');
  // A scripted `form.submit()` fires no event, so the browser carries it out
  // against the frame's own address — the pane's read address, where the reader
  // sees only `u` and drops every field. Measured: nine reads in nine seconds.
  assert.ok(router.includes('FP[n]=function(){if(!brf(this,true))return O.apply(this,arguments)}'),
    'a scripted form.submit() is left to the browser, fields and all');
  assert.ok(router.includes('var b=M.url||location.href,u=new URL(f.getAttribute("action")||b,b)'),
    'a form is being resolved against the pane, not the page it came from');
  assert.ok(router.includes('fennecBrowseGo:u.href,fennecBrowseAuto:1'),
    'a hop the page asked for is no longer told from one the user asked for');
  assert.ok(router.includes('if(t&&t!=="_self")return false'),
    'a form aimed at another frame is being stolen by the pane');
  // A page whose boot script throws still paints its markup, so the pane would
  // otherwise show a site that looks like it is ignoring the user.
  assert.ok(router.includes('fennecBrowseErr:"Script stopped:'),
    'a script that died inside the page stops saying so');
  assert.ok(!router.slice(0, -'"##;'.length).includes('"##'),
    'the router carries a raw-string terminator');

  // The relay answers any script that reaches it, so two gates decide who may:
  // the caller must have no origin of its own, and the target must be public.
  const relay = slice(work, 'pub async fn browse_raw', 'let mut builder = PUBLIC_READER');
  assert.ok(relay.includes('if !relay_allowed'), 'the origin gate is gone');
  assert.ok(relay.includes('if private_host(&host)'), 'the public-web gate is gone');
  assert.ok(relay.indexOf('relay_allowed') < relay.indexOf('private_host'),
    'who is asking has to be settled before what they asked for');
  // And the document lane forbids storing another site's page on this machine.
  const doc = slice(work, 'pub async fn browse_doc', 'pub struct RawQuery');
  assert.ok(doc.includes('CACHE_CONTROL') && doc.includes('"no-store"'),
    'the reader wrote a third party, possibly signed-in, page into the browser cache');
  const main = readSibling('fennec-coding-agent/src/main.rs');
  assert.ok(main && main.includes('!path.starts_with("/browse/")'),
    'revalidate_assets would overwrite that with no-cache');
});

test('the routes the tabs fetch exist in the Rust backend and client', () => {
  const main = readSibling('fennec-coding-agent/src/main.rs');
  if (main) {
    for (const route of ['/api/work/files', '/api/work/file', '/api/browse', '/browse/doc', '/browse/raw']) {
      assert.ok(main.includes(`"${route}"`), `the Axum router no longer registers ${route}`);
    }
  }
  const client = readSibling('fennec-core/src/fennec-client/src/coding_agent.rs');
  if (client) {
    // The native shell builds against these; renaming one here without there
    // is the same silent break the id checks exist for.
    for (const method of ['pub fn work_files', 'pub fn work_file', 'pub fn browse']) {
      assert.ok(client.includes(method), `fennec-client no longer has ${method}()`);
    }
  }
});
