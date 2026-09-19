import test from 'node:test';
import assert from 'node:assert/strict';

import { table } from '../src/servicenow/client.js';
import { catalog } from '../src/servicenow/catalog.js';

test('catalog variable choices accept label/value shape and create question_choice rows', async () => {
  const originalCreate = table.create;
  const calls = [];
  table.create = async (name, payload) => {
    calls.push({ name, payload });
    if (name === 'item_option_new') return { sys_id: 'var_sys_id', ...payload };
    if (name === 'question_choice') return { sys_id: `choice_${calls.length}`, ...payload };
    throw new Error(`unexpected table ${name}`);
  };
  try {
    const out = await catalog.createVariable(
      { cat_item: 'item_sys_id' },
      {
        name: 'laptop_type',
        question_text: 'Laptop Type',
        type: 5,
        choices: [
          { label: 'Dell', value: 'dell' },
          { label: 'Lenovo' },
          'MacBook',
        ],
      },
    );

    assert.equal(out.choices.length, 3);
    assert.deepEqual(
      calls.filter((c) => c.name === 'question_choice').map((c) => ({
        question: c.payload.question,
        text: c.payload.text,
        value: c.payload.value,
      })),
      [
        { question: 'var_sys_id', text: 'Dell', value: 'dell' },
        { question: 'var_sys_id', text: 'Lenovo', value: 'lenovo' },
        { question: 'var_sys_id', text: 'MacBook', value: 'macbook' },
      ],
    );
  } finally {
    table.create = originalCreate;
  }
});
