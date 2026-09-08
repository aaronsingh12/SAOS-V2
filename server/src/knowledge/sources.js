import { getSettings } from '../config/store.js';

/**
 * K2a — what counts as an OFFICIAL ServiceNow source.
 *
 * The corpus feeds the agent's system prompt, and the agent cites what it
 * retrieves. So the question "is this document official?" has to be answered
 * before ingestion, mechanically, by something that cannot be argued with —
 * not by whoever assembled the corpus remembering to be careful. A community
 * forum post, a consultancy blog and a vendor documentation page are all just
 * text once they are chunked, and the metadata is the only thing that ever
 * distinguished them.
 *
 * WHAT THIS ACTUALLY CHECKS, stated precisely because it is easy to overclaim:
 *
 *   It checks the URL's HOST. That is a verifiable fact about a document — the
 *   domain it was published under — and it is the only claim being made.
 *
 *   It does NOT and CANNOT verify that the page exists, that the path is real,
 *   or that the text in the file is what that URL actually served. Nothing
 *   offline can, and a check that implied otherwise would be a false assurance
 *   worse than no check. Fabricated paths under a real host are caught by the
 *   operator supplying the corpus, not by this.
 *
 * WHAT IS CLAIMED AS FACT HERE: one thing only — that ServiceNow publishes
 * under `servicenow.com`. Everything else is either a categorical judgement
 * stated in the open (community content is user-written, not documentation) or
 * operator configuration. No specific documentation URL, path shape, product
 * name or release name is asserted anywhere in this file.
 */

/**
 * The vendor's registrable domain. A host qualifies if it IS this or is a
 * subdomain of it — which covers whatever documentation, developer and support
 * subdomains ServiceNow actually uses, without this file having to enumerate
 * them and be wrong about one.
 */
export const OFFICIAL_DOMAIN = 'servicenow.com';

/**
 * Hosts under the official domain that are NOT official documentation.
 *
 * Community and forum content is written by users. It is often correct and it
 * is not a source SNADA may cite as documentation, because the precedence
 * ladder ranks rung 3 as "current official documentation" and a forum answer
 * is not that — it is a stranger's model knowledge with a URL.
 *
 * An entry here that turns out not to exist is inert, which is the safe
 * direction for a denylist to be wrong in.
 */
export const EXCLUDED_HOSTS = Object.freeze([
  'community.servicenow.com',
]);

/**
 * Additional hosts the operator has declared official for their situation: a
 * licensed documentation mirror, an internal proxy, an air-gapped copy.
 *
 * Empty by default. This is the ONLY way to widen the allowlist, and it is
 * configuration rather than code so that widening it is a decision someone
 * makes and can be shown to have made.
 */
function configuredHosts() {
  const extra = getSettings().rag?.allowedHosts;
  return Array.isArray(extra) ? extra.filter((h) => typeof h === 'string' && h.trim()) : [];
}

const normaliseHost = (h) => String(h || '').trim().toLowerCase().replace(/\.$/, '');

/** Is `host` the domain itself, or a subdomain of it? Never a suffix match. */
function isWithin(host, domain) {
  const h = normaliseHost(host);
  const d = normaliseHost(domain);
  // The `.` matters: a bare `endsWith` would admit `notservicenow.com` and
  // `servicenow.com.attacker.example`, which is precisely the trick an
  // allowlist exists to refuse.
  return h === d || h.endsWith(`.${d}`);
}

/**
 * Classify one URL.
 *
 * @returns {{ ok: boolean, host: string|null, rule: string|null, reason: string|null }}
 *   `rule` records WHICH rule admitted it, so an audit of the corpus can tell a
 *   document admitted by the vendor domain from one admitted by an operator
 *   override — those are different strengths of claim and must not look alike.
 */
export function classifySourceUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, host: null, rule: null, reason: `"${url}" is not a parseable URL` };
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    return {
      ok: false, host: parsed.hostname, rule: null,
      reason: `"${url}" is not an http(s) URL`,
    };
  }

  const host = normaliseHost(parsed.hostname);

  if (EXCLUDED_HOSTS.some((x) => isWithin(host, x))) {
    return {
      ok: false, host, rule: null,
      reason:
        `${host} is user-written community content, not official ServiceNow documentation. `
        + 'The precedence ladder ranks documentation above the model\'s own knowledge precisely because '
        + 'it is vendor-published; a forum answer is a stranger\'s model knowledge with a URL, and '
        + 'indexing it here would launder it into a rung it has not earned.',
    };
  }

  if (isWithin(host, OFFICIAL_DOMAIN)) {
    return { ok: true, host, rule: `official-domain:${OFFICIAL_DOMAIN}`, reason: null };
  }

  for (const allowed of configuredHosts()) {
    if (isWithin(host, allowed)) {
      return { ok: true, host, rule: `operator-allowed:${normaliseHost(allowed)}`, reason: null };
    }
  }

  return {
    ok: false, host, rule: null,
    reason:
      `${host} is not an official ServiceNow source. This corpus indexes vendor-published documentation `
      + `only — anything under ${OFFICIAL_DOMAIN} — so blogs, forums, aggregators and third-party `
      + 'tutorials are refused however accurate they are. If this host is a licensed mirror or an '
      + 'internal proxy of the official documentation, add it to settings.rag.allowedHosts, which is '
      + 'the only way to widen this and exists so that widening it is a decision on the record.',
  };
}

/** The policy, for the status route and for an operator wondering what is allowed. */
export function sourcePolicy() {
  return {
    officialDomain: OFFICIAL_DOMAIN,
    excludedHosts: [...EXCLUDED_HOSTS],
    operatorAllowedHosts: configuredHosts(),
    checks:
      'The URL host is checked against the official domain. Whether the page exists, whether the path '
      + 'is real, and whether the supplied text is what that URL served are NOT checked and cannot be '
      + 'checked offline — those remain the responsibility of whoever assembles the corpus.',
  };
}
