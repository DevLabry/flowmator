import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { errorItem } from '../utils/object';
import { NodeOperationError, type IDataObject, type IExecuteFunctions, type INodeExecutionData, type INodeType } from '@flowmator/workflow';

const nodeRequire = createRequire(import.meta.url);

/** Modules the Code node may `require`. Configure with NODE_FUNCTION_ALLOW_BUILTIN / NODE_FUNCTION_ALLOW_EXTERNAL (comma separated, * for all). */
function makeRequire() {
  const builtin = (process.env.NODE_FUNCTION_ALLOW_BUILTIN ?? '*').split(',').map((s) => s.trim());
  const external = (process.env.NODE_FUNCTION_ALLOW_EXTERNAL ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return (name: string) => {
    const bare = name.replace(/^node:/, '');
    const isBuiltin = nodeRequire('node:module').builtinModules.includes(bare);
    const allowed = isBuiltin ? builtin.includes('*') || builtin.includes(bare) : external.includes('*') || external.includes(name);
    if (!allowed) throw new Error(`Cannot find module '${name}' (not allowed; set NODE_FUNCTION_ALLOW_${isBuiltin ? 'BUILTIN' : 'EXTERNAL'})`);
    return nodeRequire(name);
  };
}

function normalizeAllItems(result: unknown, node: IExecuteFunctions): INodeExecutionData[] {
  if (result === undefined || result === null) {
    throw new NodeOperationError(node.getNode(), 'Code doesn\'t return items properly', { description: 'Please return an array of objects, one for each item you would like to output.' });
  }
  const arr = Array.isArray(result) ? result : [result];
  return arr.map((entry, i) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new NodeOperationError(node.getNode(), `Code doesn't return items properly`, { description: `Item ${i} is not an object` });
    }
    if ('json' in entry && typeof (entry as INodeExecutionData).json === 'object') return entry as INodeExecutionData;
    return { json: entry as IDataObject };
  });
}

function normalizeEachItem(result: unknown, node: IExecuteFunctions, itemIndex: number): INodeExecutionData | null {
  if (result === undefined || result === null) return null;
  if (Array.isArray(result) || typeof result !== 'object') {
    throw new NodeOperationError(node.getNode(), `Code doesn't return an object`, { itemIndex, description: 'In "Run Once for Each Item" mode, return a single object' });
  }
  if ('json' in result && typeof (result as INodeExecutionData).json === 'object') return result as INodeExecutionData;
  return { json: result as IDataObject };
}

async function runJs(ctx: IExecuteFunctions, code: string, itemIndex: number, extra: Record<string, unknown>): Promise<unknown> {
  const proxy = ctx.getWorkflowDataProxy(itemIndex);
  const logs: unknown[][] = [];
  const consoleProxy = {
    log: (...args: unknown[]) => {
      logs.push(args);
      ctx.sendMessageToUI(...args);
      if (ctx.getMode() !== 'manual') console.log('[Code node]', ...args);
    },
  };
  const sandbox: Record<string, unknown> = {
    ...proxy,
    ...extra,
    console: { ...consoleProxy, info: consoleProxy.log, warn: consoleProxy.log, error: consoleProxy.log, debug: consoleProxy.log },
    require: makeRequire(),
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    structuredClone,
    fetch,
    helpers: ctx.helpers,
    $getWorkflowStaticData: (type: 'global' | 'node') => ctx.getWorkflowStaticData(type),
  };
  const context = vm.createContext(sandbox);
  const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'Code' });
  return await script.runInContext(context);
}

function runPython(code: string, input: unknown): Promise<unknown> {
  const runner = `
import json, sys
_in = json.loads(sys.stdin.read())
class _Obj(dict):
    __getattr__ = dict.get
def _wrap(v):
    if isinstance(v, dict): return _Obj({k: _wrap(x) for k, x in v.items()})
    if isinstance(v, list): return [_wrap(x) for x in v]
    return v
class _Input:
    def __init__(self, items): self._items = [_wrap(i) for i in items]
    def all(self): return self._items
    def first(self): return self._items[0] if self._items else None
    def last(self): return self._items[-1] if self._items else None
    @property
    def item(self): return self._items[_in.get("itemIndex", 0)] if self._items else None
_input = _Input(_in["items"])
_json = _input.item["json"] if _input.item else {}
def __user():
${code.split('\n').map((l) => `    ${l}`).join('\n')}
    return None
_scope = {"_input": _input, "_json": _json}
globals().update(_scope)
__r = __user()
print("__flowmator_RESULT__" + json.dumps(__r, default=str))
`;
  return new Promise((resolve, reject) => {
    const proc = spawn(process.env.N8N_PYTHON_BIN ?? 'python3', ['-c', runner], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      const marker = out.lastIndexOf('__flowmator_RESULT__');
      if (code !== 0 || marker === -1) return reject(new Error(err.trim() || `Python exited with code ${code}`));
      resolve(JSON.parse(out.slice(marker + '__flowmator_RESULT__'.length)));
    });
    proc.stdin.end(JSON.stringify(input));
  });
}

export const Code: INodeType = {
  description: {
    name: 'flowmator.code',
    displayName: 'Code',
    description: 'Run custom JavaScript or Python code',
    group: ['transform'],
    version: [1, 2],
    defaults: { name: 'Code', color: '#FF9922' },
    icon: 'fa:code',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        noDataExpression: true,
        default: 'runOnceForAllItems',
        options: [
          { name: 'Run Once for All Items', value: 'runOnceForAllItems' },
          { name: 'Run Once for Each Item', value: 'runOnceForEachItem' },
        ],
      },
      {
        displayName: 'Language',
        name: 'language',
        type: 'options',
        noDataExpression: true,
        default: 'javaScript',
        options: [
          { name: 'JavaScript', value: 'javaScript' },
          { name: 'Python (Beta)', value: 'python' },
        ],
      },
      {
        displayName: 'JavaScript',
        name: 'jsCode',
        type: 'string',
        typeOptions: { editor: 'codeNodeEditor', editorLanguage: 'javaScript' },
        noDataExpression: true,
        default:
          "// Loop over input items and add a new field called 'myNewField' to the JSON of each one\nfor (const item of $input.all()) {\n  item.json.myNewField = 1;\n}\n\nreturn $input.all();",
        displayOptions: { show: { language: ['javaScript'] } },
      },
      {
        displayName: 'Python',
        name: 'pythonCode',
        type: 'string',
        typeOptions: { editor: 'codeNodeEditor', editorLanguage: 'python' },
        noDataExpression: true,
        default: "# Loop over input items and add a new field called 'myNewField' to the JSON of each one\nfor item in _input.all():\n  item['json']['myNewField'] = 1\nreturn _input.all()",
        displayOptions: { show: { language: ['python'] } },
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const mode = this.getNodeParameter('mode', 0) as string;
    const language = this.getNodeParameter('language', 0, 'javaScript') as string;
    const items = this.getInputData();
    const node = this.getNode();

    const wrapError = (e: unknown, itemIndex?: number) => {
      if (e instanceof NodeOperationError) return e;
      const err = e as Error;
      const line = err.stack?.match(/Code:(\d+)/)?.[1];
      return new NodeOperationError(node, `${err.message}${line ? ` [line ${Number(line) - 1}]` : ''}`, { itemIndex });
    };

    if (language === 'python') {
      const code = this.getNodeParameter('pythonCode', 0) as string;
      if (mode === 'runOnceForAllItems') {
        try {
          return [normalizeAllItems(await runPython(code, { items }), this)];
        } catch (e) {
          throw wrapError(e);
        }
      }
      const out: INodeExecutionData[] = [];
      for (let i = 0; i < items.length; i++) {
        try {
          const r = normalizeEachItem(await runPython(code.replaceAll('_input.item', '_input.item'), { items, itemIndex: i }), this, i);
          if (r) out.push({ ...r, pairedItem: { item: i } });
        } catch (e) {
          if (this.continueOnFail()) out.push(errorItem(e, i));
          else throw wrapError(e, i);
        }
      }
      return [out];
    }

    const code = this.getNodeParameter('jsCode', 0) as string;
    if (mode === 'runOnceForAllItems') {
      try {
        const result = await runJs(this, code, 0, { items });
        return [normalizeAllItems(result, this)];
      } catch (e) {
        if (this.continueOnFail()) return [[errorItem(e, 0)]];
        throw wrapError(e);
      }
    }

    const out: INodeExecutionData[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const result = await runJs(this, code, i, { item: items[i] });
        const normalized = normalizeEachItem(result, this, i);
        if (normalized) out.push({ ...normalized, pairedItem: normalized.pairedItem ?? { item: i } });
      } catch (e) {
        if (this.continueOnFail()) out.push(errorItem(e, i));
        else throw wrapError(e, i);
      }
    }
    return [out];
  },
};
