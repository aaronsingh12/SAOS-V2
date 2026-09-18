/**
 * Regression proof for the "the Agent page scrolls itself down" defect.
 *
 *   node --test server/test/
 *
 * What happened: D-6 made the session rail's rename/delete buttons reachable
 * by keyboard by clipping them (`position: absolute; clip: rect(0 0 0 0)`)
 * instead of hiding them with `display: none`, which removes an element from
 * the tab order. Correct fix, one omission — `.rail-item` was `position:
 * static`, so those absolutely-positioned buttons had no positioned ancestor,
 * took the INITIAL containing block instead, escaped `.rail-list`'s
 * `overflow-y: auto`, and pushed `documentElement.scrollHeight` to 999px
 * against a 904px viewport.
 *
 * That made the whole document scrollable. The chat's auto-scroll then used
 * `scrollIntoView`, which walks every scrollable ancestor — so it scrolled the
 * document too, and the topbar slid off screen on load and again on every
 * click that touched `messages`.
 *
 * Both halves are pinned below. This is a CSS/DOM defect, so the numbers above
 * come from the browser; what a Node test can hold is the two invariants that,
 * had either been true, would have prevented it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(here, '../..', rel), 'utf8');

const css = read('client/src/styles.css');
const agentChat = read('client/src/pages/AgentChat.jsx');

/**
 * Comments explain the defect by name, so a naive search for the banned call
 * matches the paragraph warning against it. The first draft of this test did
 * exactly that and failed on its own prose. Assert against code.
 */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const agentCode = code(agentChat);

/** The declaration block of a selector, as written. */
function ruleBody(source, selector) {
  const i = source.indexOf(`\n${selector} {`);
  assert.notEqual(i, -1, `no rule for "${selector}" in styles.css`);
  const start = source.indexOf('{', i);
  const end = source.indexOf('}', start);
  return source.slice(start + 1, end);
}

test('a clipped, absolutely-positioned control has a positioned ancestor', () => {
  const actions = ruleBody(css, '.rail-actions');
  if (!/position:\s*absolute/.test(actions)) return;   // technique changed; nothing to hold

  // Without this, the containing block is the initial one: the element leaves
  // its scroll container and extends the document instead of being clipped.
  const item = ruleBody(css, '.rail-item');
  assert.match(
    item,
    /position:\s*relative/,
    '.rail-actions is absolutely positioned, so .rail-item must establish the containing block'
  );
});

test('the chat pins itself by scrolling its own column, not via scrollIntoView', () => {
  // scrollIntoView scrolls EVERY scrollable ancestor. Whatever the layout above
  // the chat does, only the message column may move.
  assert.ok(
    !agentCode.includes('scrollIntoView'),
    'AgentChat calls scrollIntoView, which walks scrollable ancestors and scrolled the whole page'
  );
  assert.ok(agentCode.includes('msgsRef.current'), 'the message column is not held by a ref');
  /* The guarantee is the CALL, not the local name it is made through: the column
     the ref holds is scrolled to its own scrollHeight. Pinning `el` failed the
     day the local became `node`, while the behaviour was unchanged. */
  assert.match(agentCode, /scrollTo\(\{\s*top:\s*[A-Za-z_$][\w$]*\.scrollHeight/);
});

test('the auto-scroll honours prefers-reduced-motion', () => {
  // The global CSS reset kills animations and transitions, but not smooth
  // scrolling — that is a JS behaviour and has to opt out for itself.
  assert.ok(agentCode.includes('prefers-reduced-motion: reduce'));
});
