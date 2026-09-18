// nowforge-spec: e2e-matrix-05
/*
 * E2E 05 — the subflow half of the matrix.
 *
 * Under test: typed inputs of four different column types, a REFERENCE input
 * carrying its table, mandatory vs optional, declared outputs, more than one
 * action, flow logic inside the subflow body, and `assignSubflowOutputs` on
 * every reachable path.
 *
 * Every input is READ, every output is ASSIGNED — not to satisfy a linter, but
 * because an input nothing reads is a parameter the caller can pass with no
 * effect, and an unassigned output reads back empty with nothing to say so.
 *
 * Read-only body: a lookUpRecord and two logs.
 */
import { Subflow, wfa, action } from '@servicenow/sdk/automation'
import { StringColumn, IntegerColumn, BooleanColumn, ReferenceColumn } from '@servicenow/sdk/core'

export const e2eClassifyIncident = Subflow(
    {
        $id: Now.ID['e2e05_subflow'],
        name: 'E2E 05 Classify Incident',
        description: 'E2E matrix: typed inputs including a reference, declared outputs, internal logic.',
        runAs: 'system',
        inputs: {
            incident: ReferenceColumn({
                label: 'Incident',
                referenceTable: 'incident',
                mandatory: true,
            }),
            threshold: IntegerColumn({ label: 'Priority Threshold', mandatory: true }),
            note: StringColumn({ label: 'Note' }),
            verbose: BooleanColumn({ label: 'Verbose' }),
        },
        outputs: {
            classification: StringColumn({ label: 'Classification' }),
            escalate: BooleanColumn({ label: 'Escalate' }),
            examined: IntegerColumn({ label: 'Examined Count' }),
        },
    },
    (params) => {
        const found = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['e2e05_lookup'] },
            {
                table: 'incident',
                conditions: `sys_id=${wfa.dataPill(params.inputs.incident, 'string')}`,
            }
        )

        wfa.action(
            action.core.log,
            { $id: Now.ID['e2e05_log_note'] },
            {
                log_level: 'info',
                log_message: `E2E 05 note=${wfa.dataPill(params.inputs.note, 'string')} verbose=${wfa.dataPill(params.inputs.verbose, 'boolean')}`,
            }
        )

        wfa.flowLogic.if(
            {
                $id: Now.ID['e2e05_if_over'],
                label: 'At or above the threshold',
                condition: `${wfa.dataPill(found.Record.priority, 'string')}<=${wfa.dataPill(params.inputs.threshold, 'integer')}`,
            },
            () => {
                wfa.action(
                    action.core.log,
                    { $id: Now.ID['e2e05_log_high'] },
                    { log_level: 'info', log_message: 'E2E 05 classified high' }
                )
                wfa.flowLogic.assignSubflowOutputs(
                    { $id: Now.ID['e2e05_out_high'] },
                    params.outputs,
                    {
                        classification: 'high',
                        escalate: true,
                        examined: 1,
                    }
                )
            }
        )
        wfa.flowLogic.else({ $id: Now.ID['e2e05_else_low'] }, () => {
            wfa.flowLogic.assignSubflowOutputs(
                { $id: Now.ID['e2e05_out_low'] },
                params.outputs,
                {
                    classification: 'low',
                    escalate: false,
                    examined: 1,
                }
            )
        })
    }
)
