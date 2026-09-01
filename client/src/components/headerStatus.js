/**
 * What the header pill says, decided in plain JS.
 *
 * Split out of the component for the same reason instanceState.js is: this is
 * the part carrying a rule, and a rule that cannot be rendered in the offline
 * suite is a rule nobody is checking. Node cannot import `.jsx`.
 *
 * The rule is the honesty rule the whole product runs on: `unknown` is its own
 * answer and must never be shown as health. "Nothing disagreed" and "nothing
 * was compared" look identical unless something states which it is — the same
 * distinction listIndexes refuses a false zero for, and the same one
 * describeInstanceState draws between an empty page and an unreadable one.
 */

const TONE_CLASS = {
  ok: 'on',
  warn: 'warn',
  bad: 'bad',
  busy: 'busy',
  idle: '',
};

/**
 * @param {{loading:boolean, error:string|null, binding:object|null}} snap
 * @returns {{label:string, tone:string, dotClass:string, title:string, detail:string|null}}
 */
export function describeHeaderStatus(snap) {
  if (snap.loading && !snap.binding) {
    return { label: 'checking…', tone: 'idle', dotClass: '', title: 'Reading the binding status.', detail: null };
  }
  if (snap.error) {
    // The LOCAL server is unreachable. That is not an instance problem, and
    // saying "disconnected" here would send someone to look at their PDI.
    return {
      label: 'server down',
      tone: 'bad',
      dotClass: 'bad',
      title: `The NowHelpAssist server is not responding: ${snap.error}`,
      detail: 'This is the local API on :4000, not your instance.',
    };
  }
  const b = snap.binding;
  if (!b) {
    return { label: 'unknown', tone: 'warn', dotClass: 'warn', title: 'No status has been read yet.', detail: null };
  }

  const status = b.status || { state: 'unknown', label: 'unknown', tone: 'warn' };
  const parts = [];
  if (b.binding?.ok) parts.push('binding verified (tiers agree, app binding holds)');
  else if (b.binding?.reason) parts.push(`binding FAILED: ${b.binding.reason}`);
  if (b.deploying) parts.push('a build/install is in flight');
  if (b.sync?.detail) parts.push(b.sync.detail);

  return {
    label: status.label,
    tone: status.tone || 'warn',
    dotClass: TONE_CLASS[status.tone] ?? 'warn',
    title: parts.join(' · ') || 'No detail available.',
    detail: b.sync?.detail ?? null,
  };
}

/**
 * The scope, as the header shows it: the NAME is the address (it prefixes every
 * artifact), the friendly label is context. Never invented — an unresolved
 * scope reads as "no scope", because a blank badge and a missing one are
 * different facts.
 */
export function describeScope(scope) {
  if (!scope || !scope.scope) {
    return { text: 'no scope', title: 'No application scope could be read from the workspace identity.', known: false };
  }
  return {
    text: scope.scope,
    title: [scope.name, scope.sys_id ? `sys_id ${scope.sys_id}` : null].filter(Boolean).join(' · ') || scope.scope,
    known: true,
  };
}
