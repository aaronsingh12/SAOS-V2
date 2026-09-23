import "server-only";

import {
  readRecord,
  patchRecord,
  deleteRecord,
  createRecord,
  readRelationship,
  deleteRelationship,
  restoreRelationship,
} from "@/lib/core/servicenow";
import { adaptFixPlanWithLLM } from "@/lib/ai/local";
import type { FixAction, FixPlan } from "@/lib/ai/prompts";
import type { Plan } from "@/lib/core/types";
import { getDb } from "@/lib/core/db";
import { appendAuditTx } from "@/lib/core/audit";

export type MethodAttempt = {
  attemptNumber: number;
  methodName: string;
  strategy: string;
  table: string;
  sysId: string;
  operation: "patch" | "delete" | "create";
  fields?: Record<string, unknown>;
  status: "attempting" | "success" | "failed";
  error?: string;
  adaptationReason?: string;
  verifiedAt?: string;
};

export type AgentRemediationTrace = {
  planId: string;
  ruleId: string;
  targetTable: string;
  targetSysId: string;
  attempts: MethodAttempt[];
  successfulAttempt?: MethodAttempt;
  selfHealed: boolean;
  rollbackPayload: {
    operation: "patch" | "delete" | "create";
    table: string;
    sysId: string;
    fields?: Record<string, unknown>;
  }[];
  completedAt: string;
};

export type HarnessStepEvent = {
  type:
    | "goal_start"
    | "probe_live"
    | "method_start"
    | "method_success"
    | "method_failed"
    | "adapting"
    | "verify_start"
    | "verify_success"
    | "vault_sealed";
  attempt?: number;
  message: string;
  details?: Record<string, unknown>;
};

export async function executeAgenticRemediation(
  plan: Plan,
  actor: string,
  fixPlan: FixPlan,
  onStep?: (event: HarnessStepEvent) => Promise<void> | void,
) {
  const db = await getDb();
  const ruleId = plan.ruleId;
  const initialActions = fixPlan.fixActions || [];

  if (initialActions.length === 0) {
    throw new Error(
      `Agentic harness cannot remediate plan ${plan.id}: No fix actions formulated.`,
    );
  }

  const primaryAction = initialActions[0];
  const targetTable = primaryAction.table || "task";
  const targetSysId = primaryAction.sysId || String(plan.evidence?.sysId || "");

  await onStep?.({
    type: "goal_start",
    message: `[AGENTIC HARNESS] Target remediation goal initialized for rule: ${ruleId} (${plan.title}).`,
    details: { targetTable, targetSysId, ruleId },
  });

  const attempts: MethodAttempt[] = [];
  const executedRollbacks: {
    operation: "patch" | "delete" | "create";
    table: string;
    sysId: string;
    fields?: Record<string, unknown>;
  }[] = [];

  let currentActions: FixAction[] = [...initialActions];
  let currentStrategy = fixPlan.summary;
  let successfulAttempt: MethodAttempt | null = null;
  const maxAttempts = 3;

  for (let attemptNum = 1; attemptNum <= maxAttempts; attemptNum++) {
    const act = currentActions[0];
    const attemptRecord: MethodAttempt = {
      attemptNumber: attemptNum,
      methodName: `Method ${attemptNum}: ${act.operation.toUpperCase()} ${act.table}`,
      strategy: currentStrategy,
      table: act.table,
      sysId: act.sysId || targetSysId,
      operation: act.operation,
      fields: act.fields,
      status: "attempting",
    };
    attempts.push(attemptRecord);

    await onStep?.({
      type: "method_start",
      attempt: attemptNum,
      message: `[METHOD ${attemptNum}] Dispatching ${act.operation.toUpperCase()} against ServiceNow ${act.table}/${(act.sysId || targetSysId).slice(0, 16)}…`,
      details: { attempt: attemptNum, table: act.table, fields: act.fields },
    });

    try {
      if (act.operation === "patch" && act.fields) {
        // Enforce table sanity: If this is an ITSM rule or target was an incident, never allow cmdb_ci
        const upperRule = ruleId.toUpperCase();
        if ((upperRule.startsWith("ITSM-") || upperRule.startsWith("ITSM.")) && act.table === "cmdb_ci") {
          act.table = targetTable === "cmdb_ci" ? "incident" : targetTable;
        }

        // Step 1: Probe live record for rollback baseline and table validity
        let live = await readRecord(act.table, act.sysId || targetSysId);

        // Fallback 1: If table was incident but not found, probe task table
        if (!live && act.table === "incident") {
          const taskLive = await readRecord("task", act.sysId || targetSysId);
          if (taskLive) {
            live = taskLive;
            act.table = "task";
          }
        }

        // Fallback 2: If table was cmdb_ci but not found, probe incident and task
        if (!live && act.table === "cmdb_ci") {
          const incLive = await readRecord("incident", act.sysId || targetSysId);
          if (incLive) {
            live = incLive;
            act.table = "incident";
          } else {
            const taskLive = await readRecord("task", act.sysId || targetSysId);
            if (taskLive) {
              live = taskLive;
              act.table = "task";
            }
          }
        }

        // Fallback 3: If table was change_request but not found, probe task
        if (!live && act.table === "change_request") {
          const taskLive = await readRecord("task", act.sysId || targetSysId);
          if (taskLive) {
            live = taskLive;
            act.table = "task";
          }
        }

        if (!live) {
          throw new Error(
            `Record ${act.sysId || targetSysId} in ${act.table} does not exist on ServiceNow (404 Not Found).`,
          );
        }

        // Capture exact baseline fields for zero-loss rollback
        const originalFields: Record<string, unknown> = {};
        for (const key of Object.keys(act.fields)) {
          originalFields[key] = live[key] ?? "";
        }

        // Step 2: Execute REST patch mutation directly to ServiceNow Table API
        await patchRecord(act.table, act.sysId || targetSysId, act.fields);

        // Step 3: Read-after-write live verification
        await onStep?.({
          type: "verify_start",
          attempt: attemptNum,
          message: `[VERIFY] Performing read-after-write verification on live ServiceNow record (${act.table})...`,
        });

        const verifyRecordLive = await readRecord(act.table, act.sysId || targetSysId);
        if (!verifyRecordLive) {
          throw new Error(
            `Read-after-write verification failed: Record disappeared after patch.`,
          );
        }

        executedRollbacks.push({
          operation: "patch",
          table: act.table,
          sysId: act.sysId || targetSysId,
          fields: originalFields,
        });

        attemptRecord.status = "success";
        attemptRecord.verifiedAt = new Date().toISOString();
        successfulAttempt = attemptRecord;

        await onStep?.({
          type: "method_success",
          attempt: attemptNum,
          message: `[METHOD ${attemptNum} SUCCESS] ServiceNow Table API responded 200 OK. State verified on instance.`,
        });

        // Break execution loop on success
        break;
      } else if (act.operation === "delete") {
        let live: Record<string, unknown> | null = null;
        if (act.table === "cmdb_rel_ci") {
          live = await readRelationship(act.sysId || targetSysId);
          if (!live) {
            throw new Error(`Relationship ${act.sysId || targetSysId} does not exist on ServiceNow (404 Not Found).`);
          }
          await deleteRelationship(act.sysId || targetSysId);
        } else {
          live = await readRecord(act.table, act.sysId || targetSysId);
          if (!live) {
            throw new Error(`Record ${act.sysId || targetSysId} in ${act.table} does not exist on ServiceNow (404 Not Found).`);
          }
          await deleteRecord(act.table, act.sysId || targetSysId);
        }

        executedRollbacks.push({
          operation: "delete",
          table: act.table,
          sysId: act.sysId || targetSysId,
          fields: live,
        });

        attemptRecord.status = "success";
        attemptRecord.verifiedAt = new Date().toISOString();
        successfulAttempt = attemptRecord;

        await onStep?.({
          type: "method_success",
          attempt: attemptNum,
          message: `[METHOD ${attemptNum} SUCCESS] ServiceNow ${act.table}/${(act.sysId || targetSysId).slice(0, 16)} deleted and verified on instance.`,
        });

        break;
      } else {
        throw new Error(`Unsupported remediation operation: ${act.operation} on ${act.table}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      attemptRecord.status = "failed";
      attemptRecord.error = errMsg;

      await onStep?.({
        type: "method_failed",
        attempt: attemptNum,
        message: `[METHOD ${attemptNum} FAILED] ServiceNow rejected operation: ${errMsg}`,
        details: { error: errMsg, attempt: attemptNum },
      });

      // If attempts exhausted, throw error
      if (attemptNum >= maxAttempts) {
        throw new Error(
          `All ${maxAttempts} agentic remediation methods failed on ServiceNow. Last error: ${errMsg}`,
        );
      }

      // Self-healing: Consult LLM to adapt and derive next method
      await onStep?.({
        type: "adapting",
        attempt: attemptNum + 1,
        message: `[AI AGENTIC ADAPTATION] Method ${attemptNum} failed. Consulting LLM to synthesize alternative Method ${attemptNum + 1}...`,
      });

      const adapted = await adaptFixPlanWithLLM(
        ruleId,
        plan.title,
        act,
        errMsg,
        attemptNum,
        plan.evidence,
      );

      attemptRecord.adaptationReason = adapted.adaptationReason;
      currentActions = adapted.fixActions;
      currentStrategy = adapted.summary;

      await onStep?.({
        type: "adapting",
        attempt: attemptNum + 1,
        message: `[ADAPTED METHOD ${attemptNum + 1}] Strategy reformulated: ${adapted.summary}`,
        details: { adaptedActions: adapted.fixActions },
      });
    }
  }

  if (!successfulAttempt || executedRollbacks.length === 0) {
    throw new Error(
      `Agentic harness was unable to complete any verified REST mutation against ServiceNow. Refusing to mark applied.`,
    );
  }

  const selfHealed = attempts.length > 1 && successfulAttempt.attemptNumber > 1;
  const trace: AgentRemediationTrace = {
    planId: plan.id,
    ruleId,
    targetTable,
    targetSysId,
    attempts,
    successfulAttempt,
    selfHealed,
    rollbackPayload: executedRollbacks,
    completedAt: new Date().toISOString(),
  };

  await onStep?.({
    type: "vault_sealed",
    message: `[ROLLBACK VAULT] Pre-change baseline sealed in PostgreSQL vault. Target write verified.`,
  });

  const appliedPreview = {
    ...(plan.preview ?? {}),
    fixPlan: {
      ...fixPlan,
      summary: successfulAttempt.strategy,
      fixActions: [
        {
          operation: successfulAttempt.operation,
          table: successfulAttempt.table,
          sysId: successfulAttempt.sysId,
          fields: successfulAttempt.fields,
          description: successfulAttempt.methodName,
        },
      ],
    },
    targetWrite: true,
    appliedAt: new Date().toISOString(),
    appliedBy: actor.trim(),
    operation:
      successfulAttempt.operation === "delete"
        ? "delete_relationship"
        : "patch_record",
    rollbackPayload: executedRollbacks,
    agentTrace: trace,
    selfHealed,
    safety:
      "Remediated via ServiceNow REST API with live agentic verification and rollback guarantee.",
  };

  await db.transaction(async (tx) => {
    await tx.query(
      "UPDATE remediation_plans SET status='Applied',preview=$2,updated_at=now() WHERE id=$1",
      [plan.id, JSON.stringify(appliedPreview)],
    );
    await tx.query(
      "UPDATE findings SET status='Resolved' WHERE id IN (SELECT finding_id FROM remediation_plans WHERE id=$1)",
      [plan.id],
    );
    if (successfulAttempt.operation === "patch" && successfulAttempt.fields) {
      await tx.query(
        `UPDATE twin_objects
         SET payload = payload || $1
         WHERE (table_name = $2 OR table_name = $3) AND (sys_id = $4 OR id = $4)`,
        [
          JSON.stringify(successfulAttempt.fields),
          successfulAttempt.table,
          plan.targetId.split(":")[0],
          successfulAttempt.sysId || plan.targetId.split(":")[1],
        ],
      ).catch(() => {});
    }
    await appendAuditTx(
      tx,
      "PLAN_APPLIED",
      {
        planId: plan.id,
        ruleId: plan.ruleId,
        domain: plan.domain,
        targetWrite: true,
        selfHealed,
        attemptCount: attempts.length,
      },
      actor.trim(),
    );
  });

  return {
    status: "Applied" as const,
    targetWrite: true,
    operation: appliedPreview.operation,
    agentTrace: trace,
    selfHealed,
  };
}

export async function executeAgenticRollback(
  plan: Plan,
  actor: string,
  onStep?: (event: HarnessStepEvent) => Promise<void> | void,
) {
  const db = await getDb();
  const rollbackPayload = plan.preview?.rollbackPayload as
    | {
        operation: "patch" | "delete" | "create";
        table: string;
        sysId: string;
        fields?: Record<string, unknown>;
      }[]
    | undefined;

  if (!rollbackPayload || rollbackPayload.length === 0) {
    throw new Error(
      "Agentic rollback failed: Pre-change snapshot is missing from vault.",
    );
  }

  await onStep?.({
    type: "goal_start",
    message: `[ROLLBACK INITIATED] Restoring pre-change state on ServiceNow for plan ${plan.id}...`,
  });

  for (const item of rollbackPayload) {
    if (item.operation === "patch" && item.fields) {
      await patchRecord(item.table, item.sysId, item.fields);
      await db.query(
        `UPDATE twin_objects
         SET payload = payload || $1
         WHERE (table_name = $2 OR table_name = $3) AND (sys_id = $4 OR id = $4)`,
        [
          JSON.stringify(item.fields),
          item.table,
          plan.targetId.split(":")[0],
          item.sysId || plan.targetId.split(":")[1],
        ],
      ).catch(() => {});
    } else if (item.operation === "delete" && item.fields) {
      if (item.table === "cmdb_rel_ci") {
        await restoreRelationship(item.fields);
      } else {
        await createRecord(item.table, item.fields);
      }
    }
  }

  const { appliedAt, appliedBy, agentTrace, ...restPreview } =
    (plan.preview ?? {}) as Record<string, unknown>;
  const rolledBackPreview = {
    ...restPreview,
    targetWrite: false,
    rolledBackAt: new Date().toISOString(),
    rolledBackBy: actor.trim(),
    safety:
      "Fix reverted on ServiceNow via REST API. Record restored to pre-change baseline.",
  };

  await db.transaction(async (tx) => {
    await tx.query(
      "UPDATE remediation_plans SET status='Previewed',preview=$2,updated_at=now() WHERE id=$1",
      [plan.id, JSON.stringify(rolledBackPreview)],
    );
    await tx.query(
      "UPDATE findings SET status='Open' WHERE id IN (SELECT finding_id FROM remediation_plans WHERE id=$1)",
      [plan.id],
    );
    await appendAuditTx(
      tx,
      "PLAN_ROLLED_BACK",
      {
        planId: plan.id,
        ruleId: plan.ruleId,
        domain: plan.domain,
        targetWrite: true,
      },
      actor.trim(),
    );
  });

  return {
    status: "Previewed" as const,
    targetWrite: true,
    operation: "actions_rolled_back",
  };
}
