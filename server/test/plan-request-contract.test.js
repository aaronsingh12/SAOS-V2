import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validatePlan } from '../src/agent/plan/validator.js';
import { toolMap } from '../src/agent/tools.js';

const discover = (capability) => ({
  available: true,
  status: 'known',
  mechanism: capability === 'flow_authoring' || capability === 'schema_authoring' ? 'sdk' : 'rest',
  mutating: ['schema_authoring', 'flow_authoring'].includes(capability),
});

const tableStep = (id, name, label = name) => ({
  id,
  operation: `create ${label}`,
  capability: 'schema_authoring',
  tool: 'dba_create_table',
  mutating: true,
  target: {},
  inputs: {
    spec: {
      name,
      label,
      extends: 'task',
      autoNumber: { prefix: 'EAR' },
      fields: [
        { name: 'requested_for', label: 'Requested For', type: 'reference', reference: 'sys_user', mandatory: true },
        { name: 'request_type', label: 'Request Type', type: 'choice', choices: [{ value: 'new', label: 'New' }] },
      ],
    },
  },
  depends_on: [],
  expected_effects: [`${name} exists`],
  verification: { strategy: 'read_back', asserts: [`${name} exists`] },
});

test('normal plan refuses extra table creates when the request names one table', () => {
  const goal = `
Table Label:
Employee Asset Request

Table Name:
employee_asset_request
`;
  const v = validatePlan({
    goal,
    steps: [
      tableStep('step_1', 'x_2225382_nwforge_emp_asset_re', 'Employee Asset Request'),
      tableStep('step_2', 'x_2225382_nwforge_vendor_contr', 'Vendor Contract'),
    ],
  }, { discover });

  assert.equal(v.valid, false);
  assert.ok(v.fatal.some((p) => p.code === 'extra_table_create_steps'));
});

test('normal plan refuses blueprint-only flow when the request says to create a flow', () => {
  const goal = 'Table Name: employee_asset_request\nAlso create: Flow Designer flow for manager approval';
  const v = validatePlan({
    goal,
    steps: [
      tableStep('step_1', 'x_2225382_nwforge_employee_asset_request', 'Employee Asset Request'),
      {
        id: 'step_2',
        operation: 'design manager approval flow',
        capability: 'flow_authoring',
        tool: 'design_flow_blueprint',
        mutating: false,
        target: {},
        inputs: { description: 'When a new Employee Asset Request record is created, send manager approval.' },
        depends_on: ['step_1'],
        expected_effects: [],
        verification: null,
      },
    ],
  }, { discover });

  assert.equal(v.valid, false);
  assert.ok(v.fatal.some((p) => p.code === 'requested_flow_missing'));
});

test('normal plan refuses literal sys_ids when the request says not to hard-code them', () => {
  const goal = `
Table Name:
employee_asset_request

Also create:
- Flow Designer flow for manager approval
- Assignment to Service Desk after approval

Do not hard-code sys_ids
`;
  const v = validatePlan({
    goal,
    steps: [
      tableStep('step_1', 'x_2225382_nwforge_employee_asset_request', 'Employee Asset Request'),
      {
        id: 'step_2',
        operation: 'create manager approval flow',
        capability: 'flow_authoring',
        tool: 'create_flow_live',
        mutating: true,
        target: {},
        inputs: {
          description: 'After approval, assign to Service Desk group sys_id d625dccec0a8016700a222a0f7900d06.',
        },
        depends_on: ['step_1'],
        expected_effects: ['manager approval flow exists'],
        verification: { strategy: 'read_back', asserts: ['flow exists'] },
      },
    ],
  }, { discover });

  assert.equal(v.valid, false);
  assert.ok(v.fatal.some((p) => p.code === 'hardcoded_sys_id'));
});

test('direct tools refuse request-contract bypass from ordinary chat execution', async () => {
  const dba = toolMap.get('dba_create_table');
  const blueprint = toolMap.get('design_flow_blueprint');
  const flow = toolMap.get('create_flow_live');
  const userText = `
Table Label:
Employee Asset Request

Table Name:
employee_asset_request

Also create:
- Flow Designer flow for manager approval
- UI Policy: Existing Asset mandatory when Request Type = Replacement

Do not hard-code sys_ids
`;

  const wrongTable = await dba.execute({
    spec: { name: 'x_2225382_nwforge_vendor_contr', label: 'Vendor Contract' },
  }, { userText });
  assert.equal(wrongTable.refused, true);
  assert.equal(wrongTable.reason, 'request_contract_table_mismatch');

  const designOnly = await blueprint.execute({
    description: 'When a record is created, approve it.',
  }, { userText });
  assert.equal(designOnly.refused, true);
  assert.equal(designOnly.reason, 'request_contract_blueprint_only');

  const hardcoded = await flow.execute({
    description: 'Assign to Service Desk group sys_id d625dccec0a8016700a222a0f7900d06.',
  }, { userText: userText.replace(/UI Policy:.+/, '') });
  assert.equal(hardcoded.refused, true);
  assert.equal(hardcoded.reason, 'hardcoded_sys_id');
});
