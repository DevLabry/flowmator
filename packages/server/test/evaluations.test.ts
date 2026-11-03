import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, type App } from '../src';
import { signIn } from './auth-helper';
import { averageMetrics } from '../src/evaluations';

let app: App;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'flowmator-eval-'));
  app = await createApp({ userFolder: dir, port: 0, webhookUrl: 'http://localhost:5678/', encryptionKey: 'test-key' });
  await signIn(app);
  await app.ctx.executions.start();
});

afterAll(async () => {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
});

const api = async (method: string, url: string, payload?: unknown) => {
  const res = await app.app.inject({ method: method as 'GET', url, payload: payload as never });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
};

let n = 0;
const node = (name: string, type: string, parameters: Record<string, unknown> = {}) => ({ id: `n${++n}`, name, type: `flowmator.${type}`, typeVersion: 1, position: [0, 0], parameters });
const chain = (...names: string[]) => {
  const c: Record<string, unknown> = {};
  for (let i = 0; i < names.length - 1; i++) c[names[i]] = { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] };
  return c;
};
const rl = (value: string) => ({ __rl: true, mode: 'list', value });

async function dataset(name: string, rows: Array<Record<string, unknown>>) {
  const res = await api('POST', '/rest/data-tables', { name, columns: [{ name: 'question', type: 'string' }, { name: 'expected', type: 'string' }], rows });
  expect(res.status).toBe(200);
  return res.body.data.id as string;
}

/** Dataset row → upper-cases the question → writes the answer back → scores it. */
async function evalWorkflow(tableId: string, extra: { code?: string; trigger?: Record<string, unknown> } = {}) {
  const nodes = [
    node('When fetching a dataset row', 'evaluationTrigger', { dataTableId: rl(tableId), ...extra.trigger }),
    node('Answer', 'code', { mode: 'runOnceForAllItems', jsCode: extra.code ?? 'return $input.all().map((i) => ({ json: { ...i.json, answer: i.json.question.toUpperCase() } }));' }),
    node('Save Answer', 'evaluation', { operation: 'setOutputs', outputs: { values: [{ outputName: 'answer', outputValue: '={{ $json.answer }}' }] } }),
    node('Score', 'evaluation', { operation: 'setMetrics', metric: 'categorization', expectedAnswer: '={{ $json.expected }}', actualAnswer: '={{ $json.answer }}', options: { metricName: 'Exact' } }),
    node('Length', 'evaluation', { operation: 'setMetrics', metric: 'customMetrics', metrics: { values: [{ name: 'chars', value: '={{ $json.answer.length }}' }] } }),
  ];
  const connections = { ...chain('When fetching a dataset row', 'Answer', 'Save Answer', 'Score'), Answer: { main: [[{ node: 'Save Answer', type: 'main', index: 0 }, { node: 'Length', type: 'main', index: 0 }]] } };
  const res = await api('POST', '/rest/workflows', { name: `Eval ${++n}`, nodes, connections });
  return res.body.data.id as string;
}

async function finished(workflowId: string, runId: string) {
  for (let i = 0; i < 200; i++) {
    const run = (await api('GET', `/rest/workflows/${workflowId}/test-runs/${runId}`)).body.data;
    if (!['new', 'running'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('test run did not finish');
}

describe('evaluations', () => {
  it('runs the workflow once per dataset row and averages the metrics', async () => {
    const tableId = await dataset('qa', [
      { question: 'abc', expected: 'ABC' },
      { question: 'hi', expected: 'HI' },
      { question: 'yes', expected: 'NO' },
    ]);
    const wf = await evalWorkflow(tableId);

    const started = await api('POST', `/rest/workflows/${wf}/test-runs/new`);
    expect(started.status).toBe(200);
    expect(started.body.data.status).toBe('running');
    const run = await finished(wf, started.body.data.id);
    expect(run.status).toBe('completed');
    expect(run.metrics.Exact).toBeCloseTo(2 / 3);
    expect(run.metrics.chars).toBeCloseTo(8 / 3);

    const cases = (await api('GET', `/rest/workflows/${wf}/test-runs/${run.id}/test-cases`)).body.data;
    expect(cases.map((c: any) => [c.status, c.metrics, c.inputs.question])).toEqual([
      ['success', { Exact: 1, chars: 3 }, 'abc'],
      ['success', { Exact: 1, chars: 2 }, 'hi'],
      ['success', { Exact: 0, chars: 3 }, 'yes'],
    ]);

    // each case is a saved execution in evaluation mode
    const execution = (await api('GET', `/rest/executions/${cases[2].executionId}`)).body.data;
    expect(execution.mode).toBe('evaluation');
    expect(execution.status).toBe('success');

    // outputs were written back to each row, in a column created on the way
    const rows = (await api('GET', `/rest/data-tables/${tableId}/rows?sortBy=id:asc`)).body.data.data;
    expect(rows.map((r: any) => r.answer)).toEqual(['ABC', 'HI', 'YES']);

    const list = (await api('GET', `/rest/workflows/${wf}/test-runs`)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: run.id, status: 'completed', finalResult: 'success' });
  });

  it('marks failing cases and keeps the metrics of the others', async () => {
    const tableId = await dataset('qa-errors', [{ question: 'ok', expected: 'OK' }, { question: 'boom', expected: '' }]);
    const wf = await evalWorkflow(tableId, { code: "if ($input.first().json.question === 'boom') throw new Error('Boom!'); return $input.all().map((i) => ({ json: { ...i.json, answer: i.json.question.toUpperCase() } }));" });
    const run = await finished(wf, (await api('POST', `/rest/workflows/${wf}/test-runs/new`)).body.data.id);
    expect(run).toMatchObject({ status: 'completed', metrics: { Exact: 1, chars: 2 } });
    const cases = (await api('GET', `/rest/workflows/${wf}/test-runs/${run.id}/test-cases`)).body.data;
    expect(cases[1]).toMatchObject({ status: 'error', errorCode: 'FAILED_TO_EXECUTE_WORKFLOW' });
    expect(cases[1].errorDetails.message).toContain('Boom!');
    expect((await api('GET', `/rest/workflows/${wf}/test-runs`)).body.data[0].finalResult).toBe('warning');
  });

  it('limits and filters the dataset rows', async () => {
    const tableId = await dataset('qa-limit', [
      { question: 'a', expected: 'A' },
      { question: 'skip', expected: 'SKIP' },
      { question: 'b', expected: 'B' },
      { question: 'c', expected: 'C' },
    ]);
    const wf = await evalWorkflow(tableId, {
      trigger: { limitRows: true, maxRows: 2, filterRows: true, filters: { conditions: [{ keyName: 'question', condition: 'neq', keyValue: 'skip' }] } },
    });
    const run = await finished(wf, (await api('POST', `/rest/workflows/${wf}/test-runs/new`)).body.data.id);
    const cases = (await api('GET', `/rest/workflows/${wf}/test-runs/${run.id}/test-cases`)).body.data;
    expect(cases.map((c: any) => c.inputs.question)).toEqual(['a', 'b']);
  });

  it('uses the first row when the workflow runs from the editor', async () => {
    const tableId = await dataset('qa-manual', [{ question: 'first', expected: 'FIRST' }, { question: 'second', expected: 'SECOND' }]);
    const wf = await evalWorkflow(tableId);
    const res = await api('POST', `/rest/workflows/${wf}/run?wait=true`, {});
    const runData = res.body.data.data.runData;
    expect(runData['When fetching a dataset row'][0].data.main[0].map((i: any) => i.json.question)).toEqual(['first']);
    expect(runData.Score[0].data.main[0][0].json).toEqual({ Exact: 1 });
  });

  it('explains what is missing before running', async () => {
    const noTrigger = (await api('POST', '/rest/workflows', { name: 'No trigger', nodes: [node('Manual', 'manualTrigger')], connections: {} })).body.data.id;
    const r1 = await api('POST', `/rest/workflows/${noTrigger}/test-runs/new`);
    expect(r1.status).toBe(400);
    expect(r1.body.message).toContain('Evaluation Trigger');

    const tableId = await dataset('qa-nometric', [{ question: 'x', expected: 'X' }]);
    const noMetrics = (await api('POST', '/rest/workflows', { name: 'No metrics', nodes: [node('T', 'evaluationTrigger', { dataTableId: rl(tableId) })], connections: {} })).body.data.id;
    const r2 = await api('POST', `/rest/workflows/${noMetrics}/test-runs/new`);
    expect(r2.status).toBe(400);
    expect(r2.body.message).toContain('Set Metrics');

    const emptyTable = await dataset('qa-empty', []);
    const wf = await evalWorkflow(emptyTable);
    const run = await finished(wf, (await api('POST', `/rest/workflows/${wf}/test-runs/new`)).body.data.id);
    expect(run).toMatchObject({ status: 'error', errorCode: 'EVALUATION_DATASET_EMPTY' });
  });

  it('cancels a run and deletes runs', async () => {
    const tableId = await dataset('qa-slow', [{ question: 'a', expected: 'A' }, { question: 'b', expected: 'B' }, { question: 'c', expected: 'C' }]);
    const wf = await evalWorkflow(tableId, { code: 'await new Promise((r) => setTimeout(r, 300)); return $input.all().map((i) => ({ json: { ...i.json, answer: i.json.question.toUpperCase() } }));' });
    const runId = (await api('POST', `/rest/workflows/${wf}/test-runs/new`)).body.data.id;
    const again = await api('POST', `/rest/workflows/${wf}/test-runs/new`);
    expect(again.status).toBe(409);

    await new Promise((r) => setTimeout(r, 50));
    const cancelled = await api('POST', `/rest/workflows/${wf}/test-runs/${runId}/cancel`);
    expect(cancelled.body.data.status).toBe('cancelled');
    const cases = (await api('GET', `/rest/workflows/${wf}/test-runs/${runId}/test-cases`)).body.data;
    expect(cases.every((c: any) => c.status === 'cancelled')).toBe(true);

    expect((await api('DELETE', `/rest/workflows/${wf}/test-runs/${runId}`)).status).toBe(200);
    expect((await api('GET', `/rest/workflows/${wf}/test-runs/${runId}`)).status).toBe(404);
    expect((await api('GET', `/rest/workflows/${wf}/test-runs`)).body.data).toEqual([]);
  });

  it('averages each metric over the cases that recorded it', () => {
    expect(averageMetrics([{ a: 1, b: 2 }, { a: 0 }, { a: 0.5, b: 4 }])).toEqual({ a: 0.5, b: 3 });
  });

  describe('with a Google Sheets dataset', () => {
    /** The sheet, as Sheets' values API reads and writes it ('Q&A'!A1 notation). */
    let grid: string[][];
    const cell = (a1: string) => {
      const [, col, row] = a1.match(/([A-Z]+)(\d+)$/)!;
      return [Number(row) - 1, col.charCodeAt(0) - 65] as const;
    };
    const set = (a1: string, values: unknown[][]) => {
      const [r, c] = cell(a1);
      values[0].forEach((v, j) => ((grid[r] ??= [])[c + j] = String(v)));
    };
    const realFetch = globalThis.fetch;
    const tokens: string[] = [];

    beforeAll(() => {
      vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        if (url.hostname !== 'sheets.googleapis.com') return realFetch(input, init);
        tokens.push(String((init.headers as Record<string, string>).Authorization));
        const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        const path = decodeURIComponent(url.pathname.replace('/v4/spreadsheets/DOC123', ''));
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        if (path === '/values:batchUpdate') return json(body.data.forEach((d: { range: string; values: unknown[][] }) => set(d.range, d.values)) ?? {});
        const range = path.replace('/values/', '');
        if (init.method === 'PUT') return json(set(range, body.values) ?? {});
        expect(url.searchParams.get('valueRenderOption')).toBe('UNFORMATTED_VALUE');
        return json({ values: range === "'Q&A'!1:1" ? grid.slice(0, 1) : grid });
      });
    });
    afterEach(() => void (tokens.length = 0));
    afterAll(() => vi.unstubAllGlobals());

    it('runs one case per sheet row and writes the outputs back to the sheet', async () => {
      grid = [
        ['question', 'expected', 'split'],
        ['abc', 'ABC', 'test'],
        [],
        ['hi', 'HI', 'test'],
        ['train me', 'X', 'train'],
      ];
      const cred = app.ctx.credentials.create('Sheets', 'googleSheetsOAuth2Api', { oauthTokenData: { access_token: 'ya29.sheet' } });
      const sheets = { authentication: 'oAuth2', source: 'googleSheets' };
      const credentials = { credentials: { googleSheetsOAuth2Api: { id: cred.id, name: 'Sheets' } } };
      const nodes = [
        {
          ...node('When fetching a dataset row', 'evaluationTrigger', {
            ...sheets,
            documentId: 'https://docs.google.com/spreadsheets/d/DOC123/edit#gid=0',
            sheetName: 'Q&A',
            filtersUI: { values: [{ lookupColumn: 'split', lookupValue: 'test' }] },
          }),
          ...credentials,
        },
        node('Answer', 'code', { mode: 'runOnceForAllItems', jsCode: 'return $input.all().map((i) => ({ json: { ...i.json, answer: i.json.question.toUpperCase() } }));' }),
        { ...node('Save Answer', 'evaluation', { operation: 'setOutputs', ...sheets, outputs: { values: [{ outputName: 'answer', outputValue: '={{ $json.answer }}' }] } }), ...credentials },
        node('Score', 'evaluation', { operation: 'setMetrics', metric: 'categorization', expectedAnswer: '={{ $json.expected }}', actualAnswer: '={{ $json.answer }}', options: { metricName: 'Exact' } }),
      ];
      const wf = (await api('POST', '/rest/workflows', { name: 'Sheets eval', nodes, connections: chain('When fetching a dataset row', 'Answer', 'Save Answer', 'Score') })).body.data.id;

      const run = await finished(wf, (await api('POST', `/rest/workflows/${wf}/test-runs/new`)).body.data.id);
      expect(run).toMatchObject({ status: 'completed', metrics: { Exact: 1 } });
      const cases = (await api('GET', `/rest/workflows/${wf}/test-runs/${run.id}/test-cases`)).body.data;
      // empty rows are skipped and the filter keeps the test split
      expect(cases.map((c: any) => c.inputs)).toEqual([
        { row_number: 2, question: 'abc', expected: 'ABC', split: 'test' },
        { row_number: 4, question: 'hi', expected: 'HI', split: 'test' },
      ]);
      // a new answer column, filled in on each case's own row
      expect(grid.map((r) => r[3])).toEqual(['answer', 'ABC', undefined, 'HI', undefined]);
      expect(new Set(tokens)).toEqual(new Set(['Bearer ya29.sheet']));
    });
  });
});
