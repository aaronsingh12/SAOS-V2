import { useEffect, useState } from 'react';

/*
 * The seam between the Agent page and the global sidebar.
 *
 * The chat list, the task history, the skills panel and the two turn switches
 * are DRAWN in the app's left column but still OWNED by the Agent page, because
 * that is where every piece of state behind them already lives — the session
 * id, the loaded list, the search hits, the running flag that makes rows inert
 * mid-turn, the capture and auto-approve values re-read on every session
 * switch. Lifting all of that into App to move four panels would have rewritten
 * working functionality to change its position, and there is one functional
 * implementation of it, not two.
 *
 * So AgentChat keeps its markup exactly as it was and portals each piece into
 * the slot the sidebar renders for it. React tree unchanged, DOM position
 * changed: state, events and context all still flow from AgentChat, which is
 * what a portal is for.
 *
 * FOUR slots rather than one, because the navigation now files these under
 * different headings — chats and tasks under CHATS, skills and the switches
 * under SETTINGS — and a single blob could only ever land in one of them.
 *
 * The slots are looked up in an effect rather than during render. The sidebar
 * and the page mount in the same commit, so the nodes do not exist yet while
 * AgentChat is rendering; effects run after the whole tree is in the DOM, by
 * which time they do. `deps` re-resolves a slot when the sidebar rebuilds one
 * — collapsing the column unmounts the expanded panes, and the portal has to
 * find the new node rather than keep pointing at the detached one.
 */
export const AGENT_CHATS_SLOT_ID = 'agent-chats-slot';
export const AGENT_TASKS_SLOT_ID = 'agent-tasks-slot';
export const AGENT_SKILLS_SLOT_ID = 'agent-skills-slot';
/* Delete Chats, in the navigation's Settings group. */
export const AGENT_ACTIONS_SLOT_ID = 'agent-actions-slot';
/* Capture changes and Auto-approve, on the Preferences page. They are agent
   settings, so they belong with the other settings rather than in the nav. */
export const AGENT_PREFS_SLOT_ID = 'agent-prefs-slot';

/**
 * Resolve a slot node by id, re-resolving whenever `nonce` changes.
 *
 * The nonce is how the sidebar says "I have rebuilt my DOM": it changes when a
 * section opens or closes, or when the column collapses. Without it a portal
 * would keep writing into a node React has already thrown away, and the panel
 * would silently stop appearing.
 */
function useSlot(id, nonce) {
  const [slot, setSlot] = useState(null);
  useEffect(() => {
    // A frame's grace: the sidebar's own effects may still be committing.
    const raf = requestAnimationFrame(() => setSlot(document.getElementById(id)));
    return () => cancelAnimationFrame(raf);
  }, [id, nonce]);
  return slot;
}

/**
 * The sidebar bumps this on every structural change; the Agent page subscribes
 * to it so its portals re-target. A module-level store rather than context so
 * neither side has to be a parent of the other.
 */
let navNonce = 0;
const navListeners = new Set();

export function bumpNavLayout() {
  navNonce += 1;
  for (const fn of navListeners) fn(navNonce);
}

function useNavNonce() {
  const [n, setN] = useState(navNonce);
  useEffect(() => {
    navListeners.add(setN);
    return () => { navListeners.delete(setN); };
  }, []);
  return n;
}

export function useAgentSlots() {
  const nonce = useNavNonce();
  return {
    chats: useSlot(AGENT_CHATS_SLOT_ID, nonce),
    tasks: useSlot(AGENT_TASKS_SLOT_ID, nonce),
    skills: useSlot(AGENT_SKILLS_SLOT_ID, nonce),
    actions: useSlot(AGENT_ACTIONS_SLOT_ID, nonce),
    prefs: useSlot(AGENT_PREFS_SLOT_ID, nonce),
  };
}
