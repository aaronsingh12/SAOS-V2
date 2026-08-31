/**
 * The scope an artifact belongs to, as a mono badge.
 *
 * One component wherever a scope is shown, so Flows, Catalog, SLA and Access
 * cannot drift into four spellings of the same fact. It renders the scope NAME
 * (`x_2002152_nwforge`, `global`) rather than the application's display label,
 * because the scope name is the address — it is what prefixes an artifact, what
 * `now.config.json` claims, and what decides which update set a change can move
 * into. The friendly name goes in the tooltip.
 *
 * An unresolved sys_id is shown as itself, truncated. A badge that silently
 * emptied would be indistinguishable from an artifact with no scope, and the
 * two are different facts.
 */
export default function ScopeBadge({ scope, name = null, managed = false, title = null }) {
  if (!scope) return null;
  const isId = /^[0-9a-f]{32}$/i.test(String(scope));
  const shown = isId ? `${String(scope).slice(0, 8)}…` : String(scope);
  const global = shown === 'global';
  return (
    <span
      className={`badge mono${managed ? ' green' : global ? '' : ' blue'}`}
      title={title || [name, isId ? `sys_id ${scope}` : null, managed ? 'managed by NowHelpAssist' : null].filter(Boolean).join(' · ') || shown}
    >
      {shown}
    </span>
  );
}
