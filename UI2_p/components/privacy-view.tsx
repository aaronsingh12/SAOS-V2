import {
  Database,
  LockKey,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";

type PrivacyData = {
  sourceHost: string | null;
  snapshotSourceHost: string | null;
  sourceMismatch: boolean;
  lastSync: string | null;
  twinVersion: number;
  storedObjectCount: number;
  tableCounts: { table: string; count: number }[];
  sourceTables: string[];
  sourceMissingTables: string[];
  sourceTableErrors: Record<string, string>;
  secretStorage: string;
};
const formatted = (date: string | null) =>
  date ? new Date(date).toLocaleString() : "Never";

export function PrivacyView({ data }: { data: PrivacyData }) {
  return (
    <div className="grid gap-5 p-4 sm:p-7 xl:grid-cols-2 xl:overflow-y-auto">
      <Card
        icon={<Database size={22} weight="bold" />}
        title="Where records came from"
      >
        <dl className="space-y-3 text-sm">
          <Row label="Selected instance" value={data.sourceHost ?? "None"} />
          <Row label="Copied from" value={data.snapshotSourceHost ?? "None"} />
          <Row label="Last loaded" value={formatted(data.lastSync)} />
          <Row
            label="Local copy"
            value={data.twinVersion ? `Version ${data.twinVersion}` : "Empty"}
          />
          <Row
            label="Verified allow-listed tables"
            value={`${data.sourceTables.length} of ${data.sourceTables.length + data.sourceMissingTables.length}`}
          />
          {data.tableCounts.map((entry) => (
            <Row
              key={entry.table}
              label={entry.table}
              value={`${entry.count} records`}
            />
          ))}
        </dl>
        <p className="mt-4 border-l-4 border-[#0d2f3f] pl-3 text-xs leading-5">
          Scoped app tables, when listed above, are an inventory only. SAOS does
          not claim to audit scoped scripts, flows or ACL logic yet.
        </p>
        {data.sourceMismatch && (
          <p className="mt-4 flex gap-2 border-2 border-[#0d2f3f] bg-[#f3ba63] p-3 text-xs font-bold">
            <WarningCircle size={18} weight="bold" />
            Old records are hidden because the selected instance changed.
          </p>
        )}
        {data.sourceMissingTables.length > 0 && (
          <div className="mt-4 border-2 border-[#0d2f3f] bg-[#fff0d6] p-3 text-sm">
            <p className="font-black">
              {data.sourceMissingTables.length} tables were not verified. This
              copy is incomplete.
            </p>
            <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
              {data.sourceMissingTables.map((table) => (
                <li key={table} className="break-all">
                  <strong>{table}</strong>:{" "}
                  {data.sourceTableErrors[table] ??
                    "Not exposed in the instance metadata"}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
      <Card
        icon={<LockKey size={22} weight="bold" />}
        title="Stored on this device"
      >
        <p className="text-sm leading-6">
          {data.storedObjectCount} records, findings, plans and action history
          are stored in <code>.saos-data/postgres</code>. Copied fields include
          IDs, names, class, relationships, discovery dates and ownership
          references. Ownership fields can identify people.
        </p>
        <p className="mt-3 text-sm leading-6">
          The connection secret is stored in a {data.secretStorage}. A saved
          local file is account-readable only, but not encrypted at rest.
          Reviewer names and decisions are retained in the action history.
        </p>
      </Card>
      <Card
        icon={<ShieldCheck size={22} weight="bold" />}
        title="What leaves this device"
      >
        <p className="text-sm leading-6">
          Test connection and Load records make read-only HTTPS requests to the
          ServiceNow instance you choose. Apply is a separate, explicit
          write-back and is currently limited to the reviewed duplicate-
          relationship delete; rollback data is stored locally. A cloud-backed
          Ollama explanation can leave the device only when you explicitly
          request it. Ollama never decides findings.
        </p>
      </Card>
      <Card
        icon={<WarningCircle size={22} weight="bold" />}
        title="Why a result appears"
      >
        <p className="text-sm leading-6">
          A fixed rule checks source fields in the local copy. Same names alone
          are not treated as duplicate CIs. A missing relationship endpoint
          alone is not called broken, because account permissions may hide
          records. Each issue shows its proof and the safe next step.
        </p>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-[#0d2f3f] pb-2">
      <dt className="font-black">{label}</dt>
      <dd className="text-right break-all">{value}</dd>
    </div>
  );
}
function Card({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-[3px] border-[#0d2f3f] bg-[#ffffff]">
      <div className="flex items-center gap-2 border-b-[3px] border-[#0d2f3f] p-4">
        {icon}
        <h2 className="font-display text-xl font-black">{title}</h2>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}
