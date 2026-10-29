import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { INodeExecutionData } from '@8n8/workflow';
import { connections, items, makeWorkflow, node, out, run } from './helpers';

/** Runs Trigger → (node) and returns the run, so tests can read any output. */
async function runNode(type: string, parameters: Record<string, unknown>, input: INodeExecutionData[] = items({})) {
  const wf = makeWorkflow([node('Trigger', 'manualTrigger'), node('N', type, parameters)], connections(['Trigger', 'N']));
  const r = await run(wf, { triggerData: input });
  if (r.status !== 'success') throw new Error(r.data.resultData.error?.message);
  return r;
}

const tmp = mkdtempSync(path.join(os.tmpdir(), '8n8-nodes-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('Date & Time', () => {
  it('adds, formats, rounds, diffs and extracts', async () => {
    const base = { d: '2025-03-15T10:45:00.000Z' };
    const opts = { options: { timezone: 'UTC' } };
    const add = await runNode('dateTime', { operation: 'addToDate', magnitude: '={{ $json.d }}', timeUnit: 'days', duration: 20, ...opts }, items(base));
    expect(out(add, 'N')![0].newDate).toBe('2025-04-04T10:45:00.000Z');
    const fmt = await runNode('dateTime', { operation: 'formatDate', date: '={{ $json.d }}', format: 'custom', customFormat: 'dd/MM/yyyy HH:mm', ...opts }, items(base));
    expect(out(fmt, 'N')![0].formattedDate).toBe('15/03/2025 10:45');
    const round = await runNode('dateTime', { operation: 'roundDate', date: '={{ $json.d }}', mode: 'roundUp', toNearest: 'hour', ...opts }, items(base));
    expect(out(round, 'N')![0].roundedDate).toBe('2025-03-15T11:00:00.000Z');
    const diff = await runNode('dateTime', { operation: 'getTimeBetweenDates', startDate: '2025-01-01', endDate: '2025-01-03T12:00:00', units: ['days', 'hours'], ...opts });
    expect(out(diff, 'N')![0].timeDifference).toEqual({ days: 2, hours: 12 });
    const part = await runNode('dateTime', { operation: 'extractDate', date: '15/03/2025', part: 'month', options: { timezone: 'UTC', fromFormat: 'dd/MM/yyyy' } });
    expect(out(part, 'N')![0].datePart).toBe(3);
  });
});

describe('Crypto', () => {
  it('hashes, hmacs and generates', async () => {
    const hash = await runNode('crypto', { action: 'hash', type: 'SHA256', value: 'abc', dataPropertyName: 'h' });
    expect(out(hash, 'N')![0].h).toBe(createHash('sha256').update('abc').digest('hex'));
    const hmac = await runNode('crypto', { action: 'hmac', type: 'SHA1', value: 'abc', secret: 'k', encoding: 'base64', dataPropertyName: 'h' });
    expect(out(hmac, 'N')![0].h).toBe(createHmac('sha1', 'k').update('abc').digest('base64'));
    const gen = await runNode('crypto', { action: 'generate', encodingType: 'ascii', stringLength: 12, dataPropertyName: 'r' });
    expect(out(gen, 'N')![0].r).toMatch(/^[A-Za-z0-9]{12}$/);
  });
});

describe('Rename Keys', () => {
  it('renames with dot paths and regex', async () => {
    const r = await runNode('renameKeys', {
      keys: { key: [{ currentKey: 'a.b', newKey: 'flat' }] },
      additionalOptions: { regexReplacement: { replacements: [{ searchRegex: '^user_', replaceRegex: '' }] } },
    }, items({ a: { b: 1, c: 2 }, user_name: 'x' }));
    expect(out(r, 'N')).toEqual([{ a: { c: 2 }, flat: 1, name: 'x' }]);
  });
});

describe('Summarize', () => {
  it('groups and aggregates', async () => {
    const r = await runNode('summarize', {
      fieldsToSummarize: { values: [{ aggregation: 'sum', field: 'amount' }, { aggregation: 'count', field: 'amount' }, { aggregation: 'concatenate', field: 'who', separateBy: 'comma' }] },
      fieldsToSplitBy: 'country',
    }, items({ country: 'ES', amount: 10, who: 'a' }, { country: 'MX', amount: 5, who: 'b' }, { country: 'ES', amount: 7, who: 'c' }));
    expect(out(r, 'N')).toEqual([
      { country: 'ES', sum_amount: 17, count_amount: 2, concatenated_who: 'a,c' },
      { country: 'MX', sum_amount: 5, count_amount: 1, concatenated_who: 'b' },
    ]);
  });
});

describe('Compare Datasets', () => {
  it('splits into A only, same, different and B only', async () => {
    const wf = makeWorkflow(
      [
        node('Trigger', 'manualTrigger'),
        node('A', 'code', { jsCode: 'return [{id:1,v:"x"},{id:2,v:"y"},{id:3,v:"z"}]' }),
        node('B', 'code', { jsCode: 'return [{id:2,v:"y"},{id:3,v:"CHANGED"},{id:4,v:"w"}]' }),
        node('N', 'compareDatasets', { mergeByFields: { values: [{ field1: 'id', field2: 'id' }] }, resolve: 'includeBoth' }),
      ],
      connections(['Trigger', 'A'], ['Trigger', 'B'], ['A', 'N', 0, 0], ['B', 'N', 0, 1]),
    );
    const r = await run(wf);
    expect(out(r, 'N', 0)).toEqual([{ id: 1, v: 'x' }]);
    expect(out(r, 'N', 1)).toEqual([{ id: 2, v: 'y' }]);
    expect(out(r, 'N', 2)).toEqual([{ keys: { id: 3 }, same: { id: 3 }, different: { v: { inputA: 'z', inputB: 'CHANGED' } } }]);
    expect(out(r, 'N', 3)).toEqual([{ id: 4, v: 'w' }]);
  });
});

describe('XML, HTML, Markdown', () => {
  it('round-trips XML', async () => {
    const toXml = await runNode('xml', { mode: 'jsonToxml', dataPropertyName: 'xml', options: { headless: true, pretty: false } }, items({ order: { id: 7, item: ['a', 'b'] } }));
    const xml = out(toXml, 'N')![0].xml;
    expect(xml).toBe('<order><id>7</id><item>a</item><item>b</item></order>');
    const back = await runNode('xml', { mode: 'xmlToJson', dataPropertyName: 'xml', options: { parseValues: true } }, items({ xml: '<order id="9"><item>a</item><item>b</item></order>' }));
    expect(out(back, 'N')).toEqual([{ order: { $id: 9, item: ['a', 'b'] } }]);
  });

  it('extracts HTML with selectors, renders templates and tables', async () => {
    const html = '<ul><li class="p">  Apple <span class="x">skip</span></li><li class="p">Pear</li></ul><a href="/home">Home</a>';
    const ex = await runNode('html', {
      operation: 'extractHtmlContent',
      dataPropertyName: 'page',
      extractionValues: { values: [
        { key: 'fruits', cssSelector: '.p', returnValue: 'text', skipSelectors: '.x', returnArray: true },
        { key: 'link', cssSelector: 'a', returnValue: 'attribute', attribute: 'href' },
      ] },
    }, items({ page: html }));
    expect(out(ex, 'N')).toEqual([{ fruits: ['Apple', 'Pear'], link: '/home' }]);
    const tpl = await runNode('html', { operation: 'generateHtmlTemplate', html: '<h1>{{ $json.title }}</h1>' }, items({ title: 'Hi' }));
    expect(out(tpl, 'N')![0].html).toBe('<h1>Hi</h1>');
    const table = await runNode('html', { operation: 'convertToHtmlTable' }, items({ a: 1, b: '<x>' }));
    expect(out(table, 'N')![0].table).toContain('<td>&#60;x&#62;</td>');
  });

  it('converts Markdown both ways', async () => {
    const toHtml = await runNode('markdown', { mode: 'markdownToHtml', markdown: '# Title\n\n**bold**' });
    expect(out(toHtml, 'N')![0].data).toBe('<h1>Title</h1>\n<p><strong>bold</strong></p>\n');
    const toMd = await runNode('markdown', { mode: 'htmlToMarkdown', html: '<h2>Sub</h2><ul><li>one</li></ul>' });
    expect(out(toMd, 'N')![0].data).toBe('## Sub\n\n*   one');
  });
});

describe('files', () => {
  const convertThenExtract = async (convert: Record<string, unknown>, extract: Record<string, unknown>, input: INodeExecutionData[]) => {
    const wf = makeWorkflow(
      [node('Trigger', 'manualTrigger'), node('Convert', 'convertToFile', convert), node('Extract', 'extractFromFile', extract)],
      connections(['Trigger', 'Convert'], ['Convert', 'Extract']),
    );
    const r = await run(wf, { triggerData: input });
    if (r.status !== 'success') throw new Error(r.data.resultData.error?.message);
    return r;
  };
  const rows = items({ name: 'Ada', age: 36 }, { name: 'Linus, Jr', age: 55 });

  it('round-trips CSV', async () => {
    const r = await convertThenExtract({ operation: 'csv', binaryPropertyName: 'data' }, { operation: 'csv', binaryPropertyName: 'data' }, rows);
    expect(r.data.resultData.runData.Convert![0]!.data!.main![0]![0]!.binary!.data).toMatchObject({ fileName: 'data.csv', mimeType: 'text/csv' });
    expect(out(r, 'Extract')).toEqual([{ name: 'Ada', age: '36' }, { name: 'Linus, Jr', age: '55' }]);
  });

  it('round-trips XLSX', async () => {
    const r = await convertThenExtract({ operation: 'xlsx', binaryPropertyName: 'data', options: { sheetName: 'People' } }, { operation: 'xlsx', binaryPropertyName: 'data', options: { sheetName: 'People' } }, rows);
    expect(out(r, 'Extract')).toEqual([{ name: 'Ada', age: 36 }, { name: 'Linus, Jr', age: 55 }]);
  });

  it('round-trips JSON and text', async () => {
    const json = await convertThenExtract({ operation: 'toJson', binaryPropertyName: 'data' }, { operation: 'fromJson', binaryPropertyName: 'data', destinationKey: 'parsed' }, rows);
    expect(out(json, 'Extract')).toEqual([{ parsed: [{ name: 'Ada', age: 36 }, { name: 'Linus, Jr', age: 55 }] }]);
    const text = await convertThenExtract({ operation: 'toText', sourceProperty: 'name', binaryPropertyName: 'data' }, { operation: 'text', binaryPropertyName: 'data', destinationKey: 't' }, rows);
    expect(out(text, 'Extract')).toEqual([{ t: 'Ada' }, { t: 'Linus, Jr' }]);
  });

  it('extracts text from a PDF', async () => {
    // smallest useful PDF: one page drawing "Hello PDF"
    const stream = 'BT /F1 24 Tf 72 720 Td (Hello PDF) Tj ET';
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    objs.forEach((o, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const file = path.join(tmp, 'hello.pdf');
    writeFileSync(file, pdf);

    const wf = makeWorkflow(
      [node('Trigger', 'manualTrigger'), node('Read', 'readWriteFile', { operation: 'read', fileSelector: file }), node('Extract', 'extractFromFile', { operation: 'pdf', binaryPropertyName: 'data' })],
      connections(['Trigger', 'Read'], ['Read', 'Extract']),
    );
    const r = await run(wf);
    expect(r.status).toBe('success');
    expect(out(r, 'Extract')![0]).toMatchObject({ numpages: 1, text: 'Hello PDF', fileName: 'hello.pdf' });
  });

  it('reads with globs, writes files and blocks the data folder', async () => {
    writeFileSync(path.join(tmp, 'a.txt'), 'A');
    writeFileSync(path.join(tmp, 'b.txt'), 'B');
    const read = await runNode('readWriteFile', { operation: 'read', fileSelector: path.join(tmp, '*.txt') });
    expect(out(read, 'N')!.map((j) => j.fileName)).toEqual(['a.txt', 'b.txt']);

    const target = path.join(tmp, 'out', 'copy.txt');
    const wf = makeWorkflow(
      [node('Trigger', 'manualTrigger'), node('Read', 'readWriteFile', { operation: 'read', fileSelector: path.join(tmp, 'a.txt') }), node('Write', 'readWriteFile', { operation: 'write', fileName: target, dataPropertyName: 'data' })],
      connections(['Trigger', 'Read'], ['Read', 'Write']),
    );
    expect((await run(wf)).status).toBe('success');
    expect(readFileSync(target, 'utf8')).toBe('A');

    const prev = process.env.N8N_USER_FOLDER;
    process.env.N8N_USER_FOLDER = tmp;
    await expect(runNode('readWriteFile', { operation: 'read', fileSelector: path.join(tmp, 'a.txt') })).rejects.toThrow(/data folder/);
    if (prev === undefined) delete process.env.N8N_USER_FOLDER;
    else process.env.N8N_USER_FOLDER = prev;
  });
});

describe('Execute Command', () => {
  it('runs once and reports output and failures', async () => {
    const ok = await runNode('executeCommand', { command: 'echo hello && echo oops 1>&2' }, items({ a: 1 }, { a: 2 }));
    expect(out(ok, 'N')).toEqual([{ exitCode: 0, stdout: 'hello', stderr: 'oops' }]);
    await expect(runNode('executeCommand', { command: 'exit 3' })).rejects.toThrow(/exit code 3/);
  });
});
