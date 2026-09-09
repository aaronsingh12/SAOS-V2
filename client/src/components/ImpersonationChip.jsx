/**
 * Whose authority the thing next to this chip carries.
 *
 * Built on the existing `.badge` tokens rather than new styling — amber is
 * already this interface's colour for "this one is consequential", and the
 * mutation badge beside it uses the same class.
 *
 * TWO WORDINGS, NEVER INTERCHANGED. The chip renders whatever the server sent,
 * and the server distinguishes:
 *
 *   amber "AS <user> (impersonated)"
 *       the operation genuinely executes as that user, and the instance will
 *       record it as their work.
 *
 *   blue  "impersonating <user> · this runs as NowHelpAssist"
 *       impersonation mode is on, but THIS operation goes over the ordinary
 *       REST path as the service account.
 *
 * The distinction is not pedantry. Today no mutating tool routes its write
 * through the impersonation wrapper, so an approval card showing "AS aagamya"
 * over a write that will be stamped `admin` would be a false claim about a
 * person, presented at the exact moment a human is deciding whether to allow
 * it. The colour difference is the point: the two states must not be scannable
 * as the same thing.
 */
export default function ImpersonationChip({ chip }) {
  if (!chip?.label) return null;
  const tone = chip.tone === 'amber' ? 'amber' : 'blue';
  return (
    <span className={`badge ${tone}`} title={chip.title || undefined}>
      {chip.label}
    </span>
  );
}
