/**
 * The rules the write forms enforce, in plain JS.
 *
 * ── WHY THE FORM CARRIES THE CONSTRAINTS ─────────────────────────────────────
 *
 * A weak runtime model, asked in free-form chat, forgets the scope prefix,
 * blows the 30-character cap and invents column types that do not exist. Those
 * are not reasoning failures worth solving with a better prompt — they are
 * shape failures, and a form can make them unrepresentable. So the form holds
 * the rules and the gated tools hold the safety, and the two do not overlap.
 *
 * Everything here is DERIVED FROM THE LIVE CONSTRAINTS the server publishes
 * (`GET /api/dba/constraints` → `tableSpecConstraints`), not restated. The
 * supported column types come from the same map the SDK type test guards, so a
 * type the SDK cannot emit cannot be offered — the `GlideDateTimeColumn` /
 * "date is unsupported" class of gap cannot reappear through this door.
 *
 * Split out of the JSX because Node cannot import `.jsx`, and a rule that
 * cannot be asserted in the offline suite is a rule nobody is checking.
 */

/** Apply the prefix the way the server's normalizer does, for live preview. */
export function previewName(raw, constraints) {
  const prefix = constraints?.namePrefix ?? '';
  const name = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+/, '');
  if (!name) return { name: '', stem: '' };
  const full = prefix && !name.startsWith(prefix) ? `${prefix}${name}` : name;
  return { name: full, stem: prefix && full.startsWith(prefix) ? full.slice(prefix.length) : full };
}

/**
 * Validate a create-table spec against the LIVE constraints.
 *
 * Returns every problem at once — the same contract the tool has, so the form
 * and the server agree about what is wrong rather than the form letting through
 * something the server then rejects one item at a time.
 *
 * `blocking` is what makes Submit unavailable. The acceptance for this phase is
 * that an invalid spec is UNSUBMITTABLE, not submitted-then-rejected.
 */
export function validateCreateForm(form, constraints) {
  const problems = [];
  const { name } = previewName(form.name, constraints);
  const max = constraints?.maxNameLength ?? 30;
  const types = constraints?.columnTypes ?? [];

  if (!String(form.name || '').trim()) problems.push({ field: 'name', message: 'A table name is required.' });
  else if (!/^[a-z][a-z0-9_]*[a-z0-9]$/.test(name)) {
    problems.push({ field: 'name', message: `"${name}" must be lowercase letters, digits and underscores, starting with a letter and ending in a letter or digit.` });
  }
  if (name.length > max) {
    const room = Math.max(0, max - (constraints?.namePrefix?.length ?? 0));
    problems.push({ field: 'name', message: `${name} is ${name.length} characters; the cap is ${max}. The prefix leaves ${room} for your part.` });
  }
  if (!String(form.label || '').trim()) problems.push({ field: 'label', message: 'A label is required — it is what people see.' });

  const fields = Array.isArray(form.fields) ? form.fields : [];
  if (!fields.length) problems.push({ field: 'fields', message: 'A table needs at least one column.' });

  const seen = new Set();
  fields.forEach((f, i) => {
    const el = String(f.name || '').trim().toLowerCase();
    if (!el) { problems.push({ field: `fields.${i}.name`, message: `Column ${i + 1} has no name.` }); return; }
    if (!/^[a-z][a-z0-9_]*[a-z0-9]?$/.test(el)) problems.push({ field: `fields.${i}.name`, message: `"${el}" is not a valid column name.` });
    if (seen.has(el)) problems.push({ field: `fields.${i}.name`, message: `"${el}" is defined twice.` });
    seen.add(el);
    // The offered list IS the supported list; anything else is a bug in the form.
    if (!types.includes(f.type)) problems.push({ field: `fields.${i}.type`, message: `"${f.type}" is not a column type this layer can emit.` });
    if (f.type === 'reference' && !String(f.reference || '').trim()) {
      problems.push({ field: `fields.${i}.reference`, message: `Reference column "${el}" must name the table it points at.` });
    }
    if (f.type === 'choice' && !String(f.choices || '').trim()) {
      problems.push({ field: `fields.${i}.choices`, message: `Choice column "${el}" must supply at least one choice.` });
    }
  });

  if (form.display && !seen.has(String(form.display).toLowerCase())) {
    problems.push({ field: 'display', message: `The display field "${form.display}" is not one of the columns above.` });
  }

  return { ok: problems.length === 0, problems, resolvedName: name };
}

/** `a=Laptop, b=Desktop` (or one per line) → the tool's choices object. */
export function parseChoices(text) {
  const out = {};
  for (const line of String(text || '').split(/[\n,]/)) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq === -1) { out[t] = t; continue; }
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim() || t.slice(0, eq).trim();
  }
  return out;
}

/** Build the `spec` the create tool takes, from the form. */
export function toCreateSpec(form, constraints) {
  const { name } = previewName(form.name, constraints);
  return {
    name,
    label: String(form.label || '').trim(),
    ...(form.extendsTable ? { extends: form.extendsTable } : {}),
    ...(form.display ? { display: String(form.display).toLowerCase() } : {}),
    fields: (form.fields || []).map((f) => ({
      name: String(f.name || '').trim().toLowerCase(),
      type: f.type,
      label: String(f.label || f.name || '').trim(),
      ...(f.maxLength ? { maxLength: Number(f.maxLength) } : {}),
      ...(f.mandatory ? { mandatory: true } : {}),
      ...(f.type === 'reference' && f.reference ? { reference: String(f.reference).trim() } : {}),
      ...(f.type === 'choice' && f.choices ? { choices: parseChoices(f.choices) } : {}),
    })),
  };
}

/**
 * Split a requested column change the way `classifyColumnChange` does.
 *
 * The form must not offer narrowing or retyping as an ordinary edit. They are
 * irreversible operations with their own gate, so the UI's job is to NAME them
 * and route the user to the gate — not to submit them and let the tool refuse,
 * and certainly not to quietly substitute a smaller change that is permitted.
 */
export function describeModify(current, requested) {
  const safe = [];
  const gated = [];

  const cur = {
    label: current?.label ?? '',
    hint: current?.hint ?? '',
    help: current?.help ?? '',
    default: current?.defaultValue ?? '',
    maxLength: current?.maxLength == null ? null : Number(current.maxLength),
  };

  for (const key of ['label', 'hint', 'help', 'default']) {
    if (requested[key] === undefined) continue;
    if (String(requested[key] ?? '') === String(cur[key] ?? '')) continue;
    safe.push({ option: key, from: cur[key], to: requested[key] });
  }

  if (requested.maxLength !== undefined && requested.maxLength !== '' && requested.maxLength !== null) {
    const want = Number(requested.maxLength);
    if (Number.isFinite(want) && cur.maxLength != null && want !== cur.maxLength) {
      if (want < cur.maxLength) {
        gated.push({
          option: 'maxLength', operation: 'decrease_column_width', from: cur.maxLength, to: want,
          why: 'Narrowing truncates every value that no longer fits and creates no rollback context.',
        });
      } else safe.push({ option: 'maxLength', from: cur.maxLength, to: want });
    }
  }
  if (requested.type !== undefined && requested.type && requested.type !== current?.type) {
    gated.push({
      option: 'type', operation: 'change_column_type', from: current?.type, to: requested.type,
      why: 'A type change creates no rollback context, and data that does not fit the new type is lost.',
    });
  }

  return {
    safe,
    gated,
    // A mixed request is refused WHOLE by the tool, so the form says so before
    // the user submits rather than after.
    submittable: safe.length > 0 && gated.length === 0,
    reason: gated.length
      ? `This change includes ${gated.map((g) => g.operation).join(' and ')}, which is irreversible and gated. `
        + 'It cannot be applied here, and the safe parts are not applied on their own — a partial change that '
        + 'looked whole would be worse than a refusal.'
      : (safe.length ? null : 'Nothing would change.'),
  };
}

/**
 * What the drop gate still needs, phrased for a person.
 *
 * The UI never offers a one-click delete. It shows the same four requirements
 * `destructiveGate` enforces and lets the user satisfy them; the escalation is
 * deliberately NOT among the things this form can set, because no tool and no
 * pane may grant it.
 */
export function describeDropGate(gate) {
  if (!gate) return { requirements: [], ready: false, escalationOpen: false };
  const unmet = new Set((gate.unmet || []).map((u) => u.requirement));
  const req = (gate.requirements || []).map((r) => ({
    key: r.key,
    met: !unmet.has(r.key),
    how: r.how,
    // The one a human must do outside this app entirely.
    operatorOnly: r.key === 'escalation',
  }));
  return {
    requirements: req,
    ready: unmet.size === 0,
    escalationOpen: !unmet.has('escalation'),
    phrase: gate.requiredPhrase ?? null,
    statement: gate.statement ?? null,
  };
}
