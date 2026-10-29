import { describe, expect, it } from 'vitest';
import { WorkflowExecute } from '../src';
import { additionalData, cond, connections, filter, items, makeWorkflow, node, out, run } from './helpers';

const trigger = () => node('Trigger', 'manualTrigger');
const set = (name: string, assignments: Array<[string, unknown, string?]>, extra: Record<string, unknown> = {}) =>
  node(name, 'set', {
    mode: 'manual',
    includeOtherFields: true,
    assignments: { assignments: assignments.map(([n, value, type]) => ({ name: n, value: value as never, type: (type ?? 'string') as never })) },
    ...extra,
  });

describe('linear execution', () => {
  it('passes items through nodes and resolves expressions', async () => {
    const wf = makeWorkflow(
      [trigger(), set('Set', [['greeting', '=Hello {{ $json.name }}'], ['n', '={{ $json.n * 2 }}', 'number']])],
      connections(['Trigger', 'Set']),
    );
    const r = await run(wf, { triggerData: items({ name: 'Ada', n: 2 }, { name: 'Bob', n: 5 }) });
    expect(r.status).toBe('success');
    expect(out(r, 'Set')).toEqual([
      { name: 'Ada', n: 4, greeting: 'Hello Ada' },
      { name: 'Bob', n: 10, greeting: 'Hello Bob' },
    ]);
    expect(r.data.resultData.lastNodeExecuted).toBe('Set');
  });

  it('runs a manual trigger with a single empty item by default', async () => {
    const wf = makeWorkflow([trigger(), set('Set', [['a', '1']])], connections(['Trigger', 'Set']));
    const r = await run(wf);
    expect(out(r, 'Set')).toEqual([{ a: '1' }]);
  });

  it('accepts n8n-exported node type names', async () => {
    const wf = makeWorkflow(
      [node('T', 'n8n-nodes-base.manualTrigger'), node('N', 'n8n-nodes-base.noOp')],
      connections(['T', 'N']),
    );
    const r = await run(wf, { triggerData: items({ x: 1 }) });
    expect(out(r, 'N')).toEqual([{ x: 1 }]);
  });
});

describe('branching and order', () => {
  it('routes If items and runs the true branch to completion before the false branch (v1 order)', async () => {
    const order: string[] = [];
    const wf = makeWorkflow(
      [
        trigger(),
        node('If', 'if', { conditions: filter(cond('={{ $json.n }}', 'gt', 2, 'number')) }),
        node('T1', 'noOp'),
        node('T2', 'noOp'),
        node('F1', 'noOp'),
      ],
      connections(['Trigger', 'If'], ['If', 'T1', 0], ['T1', 'T2'], ['If', 'F1', 1]),
    );
    const r = await new WorkflowExecute(additionalData({ hooks: { nodeExecuteBefore: (n) => void order.push(n) } })).run({
      workflow: wf,
      triggerData: items({ n: 1 }, { n: 3 }, { n: 5 }),
    });
    expect(out(r, 'If', 0)).toEqual([{ n: 3 }, { n: 5 }]);
    expect(out(r, 'If', 1)).toEqual([{ n: 1 }]);
    expect(order).toEqual(['Trigger', 'If', 'T1', 'T2', 'F1']);
  });

  it('does not run children of an empty output', async () => {
    const wf = makeWorkflow(
      [trigger(), node('If', 'if', { conditions: filter(cond('={{ $json.n }}', 'gt', 100, 'number')) }), node('T', 'noOp')],
      connections(['Trigger', 'If'], ['If', 'T', 0]),
    );
    const r = await run(wf, { triggerData: items({ n: 1 }) });
    expect(r.data.resultData.runData.T).toBeUndefined();
  });

  it('routes with Switch rules and fallback output', async () => {
    const wf = makeWorkflow(
      [
        trigger(),
        node('Switch', 'switch', {
          mode: 'rules',
          rules: {
            values: [
              { conditions: filter(cond('={{ $json.t }}', 'equals', 'a')) },
              { conditions: filter(cond('={{ $json.t }}', 'equals', 'b')) },
            ],
          },
          options: { fallbackOutput: 'extra' },
        }),
      ],
      connections(['Trigger', 'Switch']),
    );
    const r = await run(wf, { triggerData: items({ t: 'a' }, { t: 'b' }, { t: 'c' }, { t: 'a' }) });
    expect(out(r, 'Switch', 0)).toEqual([{ t: 'a' }, { t: 'a' }]);
    expect(out(r, 'Switch', 1)).toEqual([{ t: 'b' }]);
    expect(out(r, 'Switch', 2)).toEqual([{ t: 'c' }]);
  });
});

describe('merge', () => {
  const branches = (mergeParams: Record<string, unknown>) =>
    makeWorkflow(
      [
        trigger(),
        set('Users', [['src', 'users']], { includeOtherFields: false, mode: 'raw', jsonOutput: '={{ JSON.stringify({ id: $json.id, name: $json.name }) }}' }),
        set('Orders', [], { includeOtherFields: false, mode: 'raw', jsonOutput: '={{ JSON.stringify({ id: $json.id, total: $json.id * 10 }) }}' }),
        node('Merge', 'merge', mergeParams),
      ],
      connections(['Trigger', 'Users'], ['Trigger', 'Orders'], ['Users', 'Merge', 0, 0], ['Orders', 'Merge', 0, 1]),
    );

  it('waits for both inputs and combines by matching fields', async () => {
    const r = await run(branches({ mode: 'combine', combineBy: 'combineByFields', fieldsToMatchString: 'id' }), {
      triggerData: items({ id: 1, name: 'a' }, { id: 2, name: 'b' }),
    });
    expect(r.data.resultData.runData.Merge).toHaveLength(1);
    expect(out(r, 'Merge')).toEqual([
      { id: 1, name: 'a', total: 10 },
      { id: 2, name: 'b', total: 20 },
    ]);
  });

  it('appends inputs in order', async () => {
    const r = await run(branches({ mode: 'append' }), { triggerData: items({ id: 1, name: 'a' }) });
    expect(out(r, 'Merge')).toEqual([{ id: 1, name: 'a' }, { id: 1, total: 10 }]);
  });

  it('runs with partial input when the other branch produces nothing', async () => {
    const wf = makeWorkflow(
      [
        trigger(),
        node('If', 'if', { conditions: filter(cond('={{ $json.n }}', 'gt', 100, 'number')) }),
        node('Merge', 'merge', { mode: 'append' }),
      ],
      connections(['Trigger', 'If'], ['If', 'Merge', 0, 0], ['Trigger', 'Merge', 0, 1]),
    );
    const r = await run(wf, { triggerData: items({ n: 1 }) });
    expect(out(r, 'Merge')).toEqual([{ n: 1 }]);
  });
});

describe('loops', () => {
  it('Loop Over Items processes every batch and outputs all results on done', async () => {
    const wf = makeWorkflow(
      [
        trigger(),
        node('Loop', 'splitInBatches', { batchSize: 2 }),
        set('Process', [['done', '=yes {{ $json.i }}']]),
        node('After', 'noOp'),
      ],
      connections(['Trigger', 'Loop'], ['Loop', 'After', 0], ['Loop', 'Process', 1], ['Process', 'Loop']),
    );
    const r = await run(wf, { triggerData: items({ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }) });
    expect(r.status).toBe('success');
    expect(r.data.resultData.runData.Process).toHaveLength(3);
    expect(out(r, 'After')).toEqual([1, 2, 3, 4, 5].map((i) => ({ i, done: `yes ${i}` })));
  });
});

describe('expressions across nodes', () => {
  it('resolves $("Node").item via paired items, plus .first() and $node legacy syntax', async () => {
    const wf = makeWorkflow(
      [
        trigger(),
        set('A', [['upper', '={{ $json.name.toUpperCase() }}']]),
        set('B', [], { includeOtherFields: false, mode: 'raw', jsonOutput: '={{ JSON.stringify({ x: 1 }) }}' }),
        set('C', [
          ['fromTrigger', "={{ $('Trigger').item.json.name }}"],
          ['fromA', "={{ $('A').item.json.upper }}"],
          ['first', "={{ $('A').first().json.name }}"],
          ['legacy', '={{ $node["A"].json.upper }}'],
        ]),
      ],
      connections(['Trigger', 'A'], ['A', 'B'], ['B', 'C']),
    );
    const r = await run(wf, { triggerData: items({ name: 'ada' }, { name: 'bob' }) });
    expect(out(r, 'C')).toEqual([
      { x: 1, fromTrigger: 'ada', fromA: 'ADA', first: 'ada', legacy: 'ADA' },
      { x: 1, fromTrigger: 'bob', fromA: 'BOB', first: 'ada', legacy: 'BOB' },
    ]);
  });
});

describe('error handling', () => {
  const failing = (extra = {}) => node('Fail', 'stopAndError', { errorMessage: 'boom' }, extra);

  it('stops the workflow on error by default', async () => {
    const wf = makeWorkflow([trigger(), failing(), node('After', 'noOp')], connections(['Trigger', 'Fail'], ['Fail', 'After']));
    const r = await run(wf);
    expect(r.status).toBe('error');
    expect(r.data.resultData.error?.message).toBe('boom');
    expect(r.data.resultData.runData.Fail[0].error?.message).toBe('boom');
  });

  it('continues with the regular output', async () => {
    const wf = makeWorkflow(
      [trigger(), node('Code', 'code', { jsCode: 'throw new Error("bad")' }, { onError: 'continueRegularOutput' }), node('After', 'noOp')],
      connections(['Trigger', 'Code'], ['Code', 'After']),
    );
    const r = await run(wf);
    expect(r.status).toBe('success');
    expect(out(r, 'After')).toEqual([{ error: 'bad' }]);
  });

  it('routes failed items to the error output per item', async () => {
    const wf = makeWorkflow(
      [
        trigger(),
        node('Code', 'code', { mode: 'runOnceForEachItem', jsCode: 'if ($json.n === 2) throw new Error("two"); return $json;' }, { onError: 'continueErrorOutput' }),
        node('Ok', 'noOp'),
        node('Err', 'noOp'),
      ],
      connections(['Trigger', 'Code'], ['Code', 'Ok', 0], ['Code', 'Err', 1]),
    );
    const r = await run(wf, { triggerData: items({ n: 1 }, { n: 2 }, { n: 3 }) });
    expect(out(r, 'Ok')).toEqual([{ n: 1 }, { n: 3 }]);
    expect(out(r, 'Err')?.[0].error).toContain('two');
  });

  it('retries on fail', async () => {
    const wf = makeWorkflow(
      [
        trigger(),
        node(
          'Flaky',
          'code',
          { jsCode: 'const s = $getWorkflowStaticData("global"); s.tries = (s.tries ?? 0) + 1; if (s.tries < 3) throw new Error("not yet"); return [{ tries: s.tries }];' },
          { retryOnFail: true, maxTries: 3, waitBetweenTries: 0 },
        ),
      ],
      connections(['Trigger', 'Flaky']),
    );
    const r = await run(wf);
    expect(out(r, 'Flaky')).toEqual([{ tries: 3 }]);
  });
});

describe('pinned data, partial runs and destination', () => {
  it('uses pinned data in manual mode instead of executing', async () => {
    const wf = makeWorkflow(
      [trigger(), node('Code', 'code', { jsCode: 'throw new Error("should not run")' }), node('After', 'noOp')],
      connections(['Trigger', 'Code'], ['Code', 'After']),
      { pinData: { Code: items({ pinned: true }) } },
    );
    const r = await run(wf);
    expect(out(r, 'After')).toEqual([{ pinned: true }]);
  });

  it('stops at the destination node', async () => {
    const wf = makeWorkflow([trigger(), node('A', 'noOp'), node('B', 'noOp')], connections(['Trigger', 'A'], ['A', 'B']));
    const r = await run(wf, { destinationNode: 'A' });
    expect(r.data.resultData.runData.B).toBeUndefined();
    expect(r.data.resultData.lastNodeExecuted).toBe('A');
  });

  it('partial run reuses parents run data and only re-runs dirty nodes', async () => {
    const wf = makeWorkflow(
      [trigger(), node('Expensive', 'code', { jsCode: 'return [{ v: 42 }]' }), set('Use', [['double', '={{ $json.v * 2 }}', 'number']])],
      connections(['Trigger', 'Expensive'], ['Expensive', 'Use']),
    );
    const first = await run(wf);
    const ranBefore: string[] = [];
    const second = await new WorkflowExecute(additionalData({ hooks: { nodeExecuteBefore: (n) => void ranBefore.push(n) } })).runPartial({
      workflow: wf,
      destinationNode: 'Use',
      runData: first.data.resultData.runData,
      dirtyNodes: ['Use'],
    });
    expect(ranBefore).toEqual(['Use']);
    expect(out(second, 'Use')).toEqual([{ v: 42, double: 84 }]);
  });
});

describe('wait and resume', () => {
  it('pauses long waits and resumes from saved state', async () => {
    const wf = makeWorkflow(
      [trigger(), node('Wait', 'wait', { resume: 'timeInterval', amount: 2, unit: 'hours' }), set('After', [['resumed', 'true', 'boolean']])],
      connections(['Trigger', 'Wait'], ['Wait', 'After']),
    );
    const paused = await run(wf, { triggerData: items({ a: 1 }) });
    expect(paused.status).toBe('waiting');
    expect(paused.waitTill!.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(paused.data.resultData.runData.After).toBeUndefined();

    const saved = JSON.parse(JSON.stringify(paused.data.executionData));
    const resumed = await new WorkflowExecute(additionalData()).resume(wf, saved);
    expect(resumed.status).toBe('success');
    expect(resumed.data.resultData.runData.Wait).toHaveLength(1);
    expect(out(resumed, 'After')).toEqual([{ a: 1, resumed: true }]);
  });

  it('webhook resume replaces the output with the received data', async () => {
    const wf = makeWorkflow(
      [trigger(), node('Wait', 'wait', { resume: 'webhook' }), node('After', 'noOp')],
      connections(['Trigger', 'Wait'], ['Wait', 'After']),
    );
    const paused = await run(wf);
    expect(paused.status).toBe('waiting');
    const resumed = await new WorkflowExecute(additionalData()).resume(wf, paused.data.executionData!, items({ body: { approved: true } }));
    expect(out(resumed, 'After')).toEqual([{ body: { approved: true } }]);
  });
});

describe('code node', () => {
  it('runs once for all items with $input and require', async () => {
    const wf = makeWorkflow(
      [trigger(), node('Code', 'code', { jsCode: "const { createHash } = require('crypto');\nreturn $input.all().map(i => ({ json: { n: i.json.n + 1, h: createHash('md5').update('x').digest('hex').length } }));" })],
      connections(['Trigger', 'Code']),
    );
    const r = await run(wf, { triggerData: items({ n: 1 }, { n: 2 }) });
    expect(out(r, 'Code')).toEqual([{ n: 2, h: 32 }, { n: 3, h: 32 }]);
  });

  it('supports async code in each-item mode', async () => {
    const wf = makeWorkflow(
      [trigger(), node('Code', 'code', { mode: 'runOnceForEachItem', jsCode: 'await new Promise(r => setTimeout(r, 1));\nreturn { json: { sq: $json.n ** 2, idx: $itemIndex } };' })],
      connections(['Trigger', 'Code']),
    );
    const r = await run(wf, { triggerData: items({ n: 3 }, { n: 4 }) });
    expect(out(r, 'Code')).toEqual([{ sq: 9, idx: 0 }, { sq: 16, idx: 1 }]);
  });
});

describe('sub-workflows', () => {
  it('executes an inline sub-workflow and returns its last node output', async () => {
    const sub = {
      name: 'Sub',
      nodes: [node('Start', 'executeWorkflowTrigger'), set('Double', [['d', '={{ $json.n * 2 }}', 'number']])],
      connections: connections(['Start', 'Double']),
    };
    const wf = makeWorkflow(
      [trigger(), node('Call', 'executeWorkflow', { source: 'parameter', workflowJson: JSON.stringify(sub) })],
      connections(['Trigger', 'Call']),
    );
    const r = await run(wf, { triggerData: items({ n: 2 }, { n: 5 }) });
    expect(out(r, 'Call')).toEqual([{ n: 2, d: 4 }, { n: 5, d: 10 }]);
  });
});

describe('data nodes', () => {
  it('sort, limit, aggregate, split out and dedupe', async () => {
    const wf = makeWorkflow(
      [
        trigger(),
        node('Dedupe', 'removeDuplicates', { compare: 'selectedFields', fieldsToCompare: 'n' }),
        node('Sort', 'sort', { type: 'simple', sortFieldsUi: { sortField: [{ fieldName: 'n', order: 'descending' }] } }),
        node('Limit', 'limit', { maxItems: 2 }),
        node('Agg', 'aggregate', { aggregate: 'aggregateIndividualFields', fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: 'n' }] } }),
        node('Split', 'splitOut', { fieldToSplitOut: 'n' }),
      ],
      connections(['Trigger', 'Dedupe'], ['Dedupe', 'Sort'], ['Sort', 'Limit'], ['Limit', 'Agg'], ['Agg', 'Split']),
    );
    const r = await run(wf, { triggerData: items({ n: 1 }, { n: 3 }, { n: 2 }, { n: 3 }) });
    expect(out(r, 'Dedupe')).toHaveLength(3);
    expect(out(r, 'Limit')).toEqual([{ n: 3 }, { n: 2 }]);
    expect(out(r, 'Agg')).toEqual([{ n: [3, 2] }]);
    expect(out(r, 'Split')).toEqual([{ n: 3 }, { n: 2 }]);
  });
});
