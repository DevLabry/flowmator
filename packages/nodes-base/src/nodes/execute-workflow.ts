import { errorItem } from '../utils/object';
import { NodeOperationError, type IExecuteFunctions, type INodeExecutionData, type INodeType, type IWorkflowBase } from '@8n8/workflow';

export const ExecuteWorkflowTrigger: INodeType = {
  description: {
    name: '8n8.executeWorkflowTrigger',
    displayName: 'When Executed by Another Workflow',
    description: 'Starts the workflow when another workflow calls it with Execute Workflow',
    group: ['trigger'],
    version: [1, 1.1],
    defaults: { name: 'When Executed by Another Workflow', color: '#ff6d5a' },
    icon: 'fa:sign-out-alt',
    inputs: [],
    outputs: ['main'],
    maxNodes: 1,
    properties: [
      {
        displayName: 'Input data mode',
        name: 'inputSource',
        type: 'options',
        default: 'passthrough',
        options: [
          { name: 'Accept all data', value: 'passthrough' },
          { name: 'Define using fields below', value: 'workflowInputs' },
          { name: 'Define using JSON example', value: 'jsonExample' },
        ],
      },
      {
        displayName: 'Workflow Input Schema',
        name: 'workflowInputs',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true, sortable: true },
        default: {},
        displayOptions: { show: { inputSource: ['workflowInputs'] } },
        options: [
          {
            name: 'values',
            displayName: 'Values',
            values: [
              { displayName: 'Name', name: 'name', type: 'string', default: '' },
              { displayName: 'Type', name: 'type', type: 'options', default: 'any',
                options: ['any', 'string', 'number', 'boolean', 'array', 'object'].map((t) => ({ name: t, value: t })) },
            ],
          },
        ],
      },
      { displayName: 'JSON Example', name: 'jsonExample', type: 'json', default: '{\n  "aField": "a string",\n  "aNumber": 123\n}', displayOptions: { show: { inputSource: ['jsonExample'] } } },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const source = this.getNodeParameter('inputSource', 0, 'passthrough') as string;
    if (source === 'passthrough') return [items];
    let fields: string[] = [];
    if (source === 'workflowInputs') {
      fields = ((this.getNodeParameter('workflowInputs.values', 0, []) as Array<{ name: string }>) ?? []).map((v) => v.name);
    } else {
      const raw = this.getNodeParameter('jsonExample', 0);
      fields = Object.keys(typeof raw === 'string' ? JSON.parse(raw) : raw);
    }
    return [items.map((item) => ({ ...item, json: Object.fromEntries(fields.map((f) => [f, item.json[f] ?? null])) }))];
  },
};

export const ExecuteWorkflow: INodeType = {
  description: {
    name: '8n8.executeWorkflow',
    displayName: 'Execute Workflow',
    description: 'Runs another workflow (sub-workflow) and returns its output',
    group: ['transform'],
    version: [1, 1.1, 1.2],
    defaults: { name: 'Execute Workflow', color: '#ff6d5a' },
    icon: 'fa:sign-in-alt',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Source',
        name: 'source',
        type: 'options',
        default: 'database',
        options: [
          { name: 'Database', value: 'database', description: 'Load the workflow by ID' },
          { name: 'Define Below', value: 'parameter', description: 'Pass the workflow JSON' },
        ],
      },
      {
        displayName: 'Workflow',
        name: 'workflowId',
        type: 'resourceLocator',
        default: { __rl: true, mode: 'list', value: '' },
        displayOptions: { show: { source: ['database'] } },
        modes: [
          { displayName: 'From list', name: 'list', type: 'list' },
          { displayName: 'By ID', name: 'id', type: 'string', placeholder: 'Workflow ID' },
        ],
      },
      { displayName: 'Workflow JSON', name: 'workflowJson', type: 'json', default: '\n\n\n', displayOptions: { show: { source: ['parameter'] } } },
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        default: 'once',
        options: [
          { name: 'Run once with all items', value: 'once' },
          { name: 'Run once for each item', value: 'each' },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [{ displayName: 'Wait For Sub-Workflow Completion', name: 'waitForSubWorkflow', type: 'boolean', default: true }],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const source = this.getNodeParameter('source', 0) as string;
    const mode = this.getNodeParameter('mode', 0, 'once') as string;
    const wait = this.getNodeParameter('options.waitForSubWorkflow', 0, true) as boolean;

    const infoFor = (itemIndex: number) => {
      if (source === 'parameter') {
        const raw = this.getNodeParameter('workflowJson', itemIndex);
        const code = (typeof raw === 'string' ? JSON.parse(raw) : raw) as IWorkflowBase;
        return { code };
      }
      const id = this.getNodeParameter('workflowId', itemIndex, undefined, { extractValue: true }) as string;
      if (!id) throw new NodeOperationError(this.getNode(), 'Please select a workflow to execute', { itemIndex });
      return { id: String(id) };
    };

    if (mode === 'each') {
      const out: INodeExecutionData[] = [];
      for (let i = 0; i < items.length; i++) {
        try {
          const result = await this.executeWorkflow(infoFor(i), [items[i]], { waitForSubWorkflow: wait });
          if (!wait) out.push({ ...items[i], pairedItem: { item: i } });
          else for (const item of result.data?.[0] ?? []) out.push({ ...item, pairedItem: { item: i } });
        } catch (e) {
          if (this.continueOnFail()) out.push(errorItem(e, i));
          else throw e;
        }
      }
      return [out];
    }

    const result = await this.executeWorkflow(infoFor(0), items, { waitForSubWorkflow: wait });
    if (!wait) return [items];
    const data = result.data?.[0] ?? [];
    return [data.map((item, i) => ({ ...item, pairedItem: items.length === data.length ? { item: i } : items.map((_, j) => ({ item: j })) }))];
  },
};
