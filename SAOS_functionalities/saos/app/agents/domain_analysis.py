"""Deterministic domain rules over a versioned estate; no network tools."""
import hashlib
import re
from collections import defaultdict, deque
from datetime import datetime, timezone

RULE_VERSION = "2.0.0"
AGENTS = {
    "cmdb_agent": ("CMDB", "CMDB quality"),
    "relationship_agent": ("RELATIONSHIP", "Relationship integrity"),
    "csdm_agent": ("CSDM", "Service model completeness"),
    "customization_agent": ("CUSTOMIZATION", "Business rule review"),
    "integration_agent": ("INTEGRATION", "Integration configuration"),
    "performance_agent": ("PERFORMANCE", "Queue and job health"),
    "upgrade_agent": ("UPGRADE", "Upgrade review"),
    "security_agent": ("SECURITY", "Access hygiene"),
    "mid_server_agent": ("MID_SERVER", "MID server health"),
    "event_management_agent": ("EVENT_MANAGEMENT", "Alert binding"),
}


def truth(value):
    return str(value).lower() in ("true", "1", "yes")


def parse_date(value):
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


class EstateRules:
    def __init__(self, estate, coverage, stale_days=90):
        self.estate, self.coverage, self.stale_days = estate, coverage, stale_days
        self.findings = []
        self.skipped = []
        self.now = datetime.now(timezone.utc)

    def rows(self, table, fields=(), complete=False, rule=""):
        c = self.coverage.get(table, {})
        if c.get("status") not in ("complete", "limited", "truncated"):
            self.skipped.append({"rule": rule, "table": table, "reason": c.get("status", "not_requested")})
            return []
        if complete and c.get("status") != "complete":
            self.skipped.append({"rule": rule, "table": table, "reason": "Complete visible-table coverage required"})
            return []
        rows = self.estate.get(table, [])
        eligible = [r for r in rows if all(k in r for k in fields)]
        if len(eligible) != len(rows):
            self.skipped.append({"rule": rule, "table": table, "reason": "Fields omitted by API/ACL", "excluded_records": len(rows) - len(eligible)})
        return eligible

    def add(self, agent, rule, table, records, fields, title, description, severity="MEDIUM", confidence=1.0, recommendation="Review the evidence with the responsible owner before making changes."):
        evidence = []
        for r in records:
            for field in fields:
                if field in r:
                    evidence.append({"source": "ServiceNow Table REST API", "sn_table": table, "sn_sys_id": r["sys_id"],
                        "field_name": field, "field_value": str(r[field]), "reason": description,
                        "collected_at": self.now.isoformat()})
        identity = rule + "|" + table + "|" + "|".join(sorted(r["sys_id"] for r in records))
        fid = hashlib.sha256(identity.encode()).hexdigest()
        self.findings.append({"fingerprint": fid, "agent_id": agent, "rule_id": rule,
            "domain": AGENTS[agent][0], "table": table, "target_ids": [r["sys_id"] for r in records],
            "title": title, "description": description, "severity": severity, "confidence": confidence,
            "affected_ci_ids": [r["sys_id"] for r in records] if table == "cmdb_ci" else [],
            "affected_service_ids": [], "evidence": evidence, "recommendation": recommendation})

    def analyze(self):
        cis = self.rows("cmdb_ci")
        for c in cis:
            name = c.get("name") or c["sys_id"]
            if "owned_by" in c and not c["owned_by"]:
                self.add("cmdb_agent", "CMDB-OWNER", "cmdb_ci", [c], ["owned_by", "name"],
                    f"CI has no owner: {name}", "The owned_by field is empty in the extracted record.",
                    recommendation="Ask the service owner to confirm ownership; do not infer an assignee automatically.")
            updated = parse_date(c.get("sys_updated_on"))
            if updated and (self.now - updated).days > self.stale_days:
                self.add("cmdb_agent", "CMDB-STALE", "cmdb_ci", [c], ["sys_updated_on", "last_discovered"],
                    f"CI record unchanged for {(self.now-updated).days} days: {name}",
                    f"No record update in more than {self.stale_days} days. This is a review signal, not proof of retirement.",
                    confidence=0.8, recommendation="Compare fresh Discovery evidence and lifecycle policy before retaining or retiring the CI.")
        identifiers = defaultdict(list)
        for c in self.rows("cmdb_ci", ("serial_number", "sys_class_name"), rule="CMDB-DUPLICATE"):
            serial = str(c["serial_number"]).strip().casefold()
            if serial and serial not in {"unknown", "none", "null", "n/a", "0", "to be filled by o.e.m."}:
                identifiers[(serial, c["sys_class_name"])].append(c)
        for (serial, _), records in identifiers.items():
            if len(records) > 1:
                self.add("cmdb_agent", "CMDB-DUPLICATE", "cmdb_ci", records, ["serial_number", "name", "sys_class_name"],
                    f"{len(records)} CIs share a serial number", "Same normalized serial and CI class; identity merge requires corroborating evidence.",
                    "HIGH", 0.8, "Compare stable identifiers, Discovery sources and relationships; a human must select any survivor.")

        relations = self.rows("cmdb_rel_ci", ("parent", "child", "type"), rule="REL-SELF")
        related = set()
        edge_groups = defaultdict(list)
        for r in relations:
            related.update((r["parent"], r["child"]))
            edge_groups[(r["parent"], r["child"], r["type"])].append(r)
            if r["parent"] and r["parent"] == r["child"]:
                self.add("relationship_agent", "REL-SELF", "cmdb_rel_ci", [r], ["parent", "child", "type"],
                    "CI relationship references itself", "The parent and child reference the same CI.", "HIGH")
        for _, records in edge_groups.items():
            if len(records) > 1:
                self.add("relationship_agent", "REL-DUPLICATE", "cmdb_rel_ci", records, ["parent", "child", "type"],
                    "Duplicate relationship edges", "Multiple records have the same parent, child and relationship type.")
        # Absence rules only run when visible-table extraction is complete.
        rel_complete = self.coverage.get("cmdb_rel_ci", {}).get("status") == "complete"
        if rel_complete:
            for c in cis:
                if c["sys_id"] not in related:
                    self.add("cmdb_agent", "CMDB-UNRELATED", "cmdb_ci", [c], ["name", "sys_class_name"],
                        f"No visible relationships: {c.get('name') or c['sys_id']}",
                        "No edge references this CI in the complete integration-account-visible relationship extract. Hidden ACL/domain records are outside scope.",
                        "LOW", 0.75)
        else:
            self.skipped.append({"rule": "CMDB-UNRELATED", "reason": "Relationship coverage incomplete"})
        services = self.rows("cmdb_ci_service", rule="CSDM")
        offerings_complete = self.coverage.get("service_offering", {}).get("status") == "complete"
        parents = {o.get("parent") for o in self.rows("service_offering", ("parent",), rule="CSDM-OFFERING")}
        for s in services:
            name = s.get("name") or s["sys_id"]
            if "owned_by" in s and not s["owned_by"]:
                self.add("csdm_agent", "CSDM-OWNER", "cmdb_ci_service", [s], ["owned_by", "name"],
                    f"Service has no owner: {name}", "Service ownership is empty; assignment requires a business decision.")
            if "life_cycle_stage" in s and not s["life_cycle_stage"]:
                self.add("csdm_agent", "CSDM-LIFECYCLE", "cmdb_ci_service", [s], ["life_cycle_stage", "life_cycle_stage_status"],
                    f"Service lifecycle stage is empty: {name}", "No lifecycle stage is recorded; validate the instance's CSDM policy before assigning it.")
            if offerings_complete and s.get("sys_class_name") == "cmdb_ci_service" and s["sys_id"] not in parents:
                self.add("csdm_agent", "CSDM-OFFERING", "cmdb_ci_service", [s], ["name", "sys_class_name"],
                    f"No visible service offering: {name}", "No offering references this business service in the complete visible offering extract.",
                    confidence=0.85)

        for r in self.rows("sys_script", ("active", "script", "when"), rule="CUSTOM-BEFORE-UPDATE"):
            if truth(r["active"]) and r["when"] == "before" and re.search(r"\bcurrent\s*\.\s*update\s*\(", r["script"] or ""):
                self.add("customization_agent", "CUSTOM-BEFORE-UPDATE", "sys_script", [r], ["name", "collection", "when", "script"],
                    f"Review current.update() in before rule: {r.get('name') or r['sys_id']}",
                    "Static pattern matched current.update() in an active before business rule. Comments or unreachable branches can be false positives; review the code.",
                    "HIGH", 0.85, "Review recursion risk and redundant updates in sub-production; package any tested change through your release process.")
        for r in self.rows("sys_rest_message", ("rest_endpoint",), rule="INT-HTTP"):
            if str(r["rest_endpoint"]).lower().startswith("http://"):
                self.add("integration_agent", "INT-HTTP", "sys_rest_message", [r], ["name", "rest_endpoint"],
                    f"Integration uses HTTP: {r.get('name') or r['sys_id']}", "The configured endpoint starts with unencrypted HTTP; runtime overrides are not evaluated.",
                    "HIGH", 1.0, "Confirm endpoint TLS support and test an HTTPS configuration in sub-production.")
        for r in self.rows("sys_trigger", ("state",), rule="PERF-JOB-ERROR"):
            if str(r["state"]) == "3":
                self.add("performance_agent", "PERF-JOB-ERROR", "sys_trigger", [r], ["name", "state"],
                    f"Scheduled job is in error state: {r.get('name') or r['sys_id']}",
                    "sys_trigger state equals 3 (error). Inspect scheduler logs before restarting.")
        for r in self.rows("ecc_queue", ("state", "sys_created_on"), rule="PERF-ECC-AGE"):
            created = parse_date(r["sys_created_on"])
            if r["state"] == "ready" and created and (self.now-created).total_seconds() > 3600:
                self.add("performance_agent", "PERF-ECC-AGE", "ecc_queue", [r], ["state", "sys_created_on", "agent"],
                    "ECC item has waited over one hour", "A ready ECC record is older than one hour; inspect MID connectivity and queue consumers.")
        for r in self.rows("sys_upgrade_history_log", ("disposition",), rule="UPGRADE-SKIPPED"):
            if str(r["disposition"]).lower() == "skipped":
                self.add("upgrade_agent", "UPGRADE-SKIPPED", "sys_upgrade_history_log", [r], ["name", "disposition", "resolution_status"],
                    f"Skipped upgrade record needs review: {r.get('name') or r['sys_id']}",
                    "Upgrade disposition is skipped. Check resolution status; a deliberate preserved customization may be acceptable.", confidence=0.85)
        for r in self.rows("sys_user_has_role", ("user.active", "user", "role"), rule="SEC-INACTIVE-ROLE"):
            if str(r["user.active"]).lower() in ("false", "0"):
                self.add("security_agent", "SEC-INACTIVE-ROLE", "sys_user_has_role", [r], ["user", "user.active", "role", "role.name"],
                    "Inactive user still holds a role", "The referenced user is inactive and a role assignment remains.",
                    "HIGH" if r.get("role.name") == "admin" else "MEDIUM",
                    recommendation="Review retention and reactivation policy; remove privileges only through the approved identity process.")
        for r in self.rows("ecc_agent", ("status",), rule="MID-DOWN"):
            if str(r["status"]).lower() == "down":
                self.add("mid_server_agent", "MID-DOWN", "ecc_agent", [r], ["name", "status", "last_refreshed"],
                    f"MID server is down: {r.get('name') or r['sys_id']}", "ServiceNow reports this MID server as Down.", "HIGH")
        for r in self.rows("em_alert", ("cmdb_ci", "state"), rule="EVENT-UNBOUND"):
            if not r["cmdb_ci"] and str(r["state"]).lower() in ("open", "reopen"):
                self.add("event_management_agent", "EVENT-UNBOUND", "em_alert", [r], ["number", "cmdb_ci", "state"],
                    f"Open alert has no CI binding: {r.get('number') or r['sys_id']}",
                    "An open or reopened alert has an empty cmdb_ci reference.")
        self.synthesize()
        return self.findings

    def synthesize(self):
        graph = defaultdict(set)
        ci_ids = {c["sys_id"] for c in self.estate.get("cmdb_ci", [])}
        services = {s["sys_id"] for s in self.estate.get("cmdb_ci_service", [])}
        relation_by_id = {r["sys_id"]: r for r in self.estate.get("cmdb_rel_ci", [])}
        for r in relation_by_id.values():
            if r.get("parent") and r.get("child"):
                graph[r["parent"]].add(r["child"])
                graph[r["child"]].add(r["parent"])
        for f in self.findings:
            seeds = set(f["target_ids"]) & (ci_ids | services)
            if f["table"] == "cmdb_rel_ci":
                for sid in f["target_ids"]:
                    seeds.update([relation_by_id[sid].get("parent"), relation_by_id[sid].get("child")])
                seeds.discard(None)
                seeds.discard("")
            visited, queue = set(seeds), deque((s, 0) for s in seeds)
            while queue:
                node, depth = queue.popleft()
                if depth >= 3:
                    continue
                for neighbor in graph[node] - visited:
                    visited.add(neighbor)
                    queue.append((neighbor, depth + 1))
            f["affected_ci_ids"] = sorted(visited & ci_ids)
            f["affected_service_ids"] = sorted(visited & services)
            f["impact"] = {"reachable_nodes": len(visited), "max_depth": 3, "direction": "undirected",
                "interpretation": "Topology reachability for review, not proven outage propagation"}
            severity = {"CRITICAL": 5, "HIGH": 4, "MEDIUM": 3, "LOW": 2, "INFO": 1}[f["severity"]]
            business = 1 + min(len(f["affected_service_ids"]), 4)
            dependency = 1 + min(len(visited), 20) / 20
            f["priority_score"] = round(severity * business * dependency * f["confidence"], 3)
            f["priority_factors"] = {"severity": severity, "business_impact_proxy": business,
                "dependency_criticality_proxy": dependency, "confidence": f["confidence"],
                "remediation_value": 1, "effort": 1, "note": "Value/effort default to 1 pending human assessment"}
            f["priority"] = "P1" if f["priority_score"] >= 20 else "P2" if f["priority_score"] >= 8 else "P3"
        self.findings.sort(key=lambda f: (-f["priority_score"], f["fingerprint"]))
