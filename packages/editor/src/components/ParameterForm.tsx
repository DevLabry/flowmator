import { getParameterDisplayed, type INodeParameters, type INodeProperties, type INodePropertyCollection, type INodePropertyOption } from '@8n8/workflow';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Api } from '../lib/api';
import { useApp } from '../store/app';
import { useWorkflow } from '../store/workflow';
import { CodeEditor, ExpressionEditor } from './Editors';
import { Switch } from './ui';

type Value = unknown;

const isExpr = (v: unknown): v is string => typeof v === 'string' && v.startsWith('=');
const uid = () => crypto.randomUUID();

const isPropertyOption = (o: unknown): o is INodePropertyOption => !!o && typeof o === 'object' && 'value' in (o as object) && !('type' in (o as object));
const isCollectionGroup = (o: unknown): o is INodePropertyCollection => !!o && typeof o === 'object' && 'values' in (o as object);

/** Value dropped from the data panels: an expression string, plus the field path for assignments. */
export function readDrop(e: React.DragEvent): { expression: string; path?: string } | null {
  const expression = e.dataTransfer.getData('application/8n8-expr');
  if (!expression) return null;
  return { expression, path: e.dataTransfer.getData('application/8n8-path') || undefined };
}

/** An input that is plain text until it holds an expression; dropping a field turns it into one. */
function SmartInput({ value, onChange, nodeName, placeholder, type = 'text' }: { value: Value; onChange: (v: Value) => void; nodeName: string; placeholder?: string; type?: string }) {
  const [over, setOver] = useState(false);
  const drop = (e: React.DragEvent) => {
    const d = readDrop(e);
    setOver(false);
    if (!d) return;
    e.preventDefault();
    const cur = isExpr(value) ? value.slice(1) : value === undefined || value === null ? '' : String(value);
    onChange(`=${cur}${d.expression}`);
  };
  const dragProps = { onDragOver: (e: React.DragEvent) => { e.preventDefault(); setOver(true); }, onDragLeave: () => setOver(false), onDrop: drop };
  if (isExpr(value)) {
    return (
      <div className={over ? 'param-drop' : ''} {...dragProps}>
        <ExpressionEditor value={value.slice(1)} onChange={(v) => onChange(`=${v}`)} nodeName={nodeName} />
      </div>
    );
  }
  return (
    <input
      className={over ? 'param-drop' : ''}
      {...dragProps}
      type={type}
      value={value === undefined || value === null ? '' : String(value)}
      placeholder={placeholder}
      onChange={(e) => onChange(type === 'number' && e.target.value !== '' && !Number.isNaN(Number(e.target.value)) ? Number(e.target.value) : e.target.value)}
    />
  );
}

function OptionsInput({ prop, value, onChange, nodeName }: { prop: INodeProperties; value: Value; onChange: (v: Value) => void; nodeName: string }) {
  const [loaded, setLoaded] = useState<INodePropertyOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const method = prop.typeOptions?.loadOptionsMethod;
  const load = async () => {
    if (!method || loading) return;
    setLoading(true);
    const node = useWorkflow.getState().workflow.nodes.find((n) => n.name === nodeName)!;
    try {
      const res = await Api.loadOptions({ nodeTypeAndVersion: { name: node.type, version: node.typeVersion }, methodName: method, currentNodeParameters: node.parameters, credentials: node.credentials });
      setLoaded(Array.isArray(res) ? res : res.results);
    } catch (e) {
      useApp.getState().toast('error', `Could not load options for "${prop.displayName}"`, (e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const options = (loaded ?? (prop.options ?? []).filter(isPropertyOption)) as INodePropertyOption[];
  return (
    <select value={String(value ?? '')} onFocus={load} onChange={(e) => {
      const opt = options.find((o) => String(o.value) === e.target.value);
      onChange(opt ? opt.value : e.target.value);
    }}>
      {method && !options.some((o) => String(o.value) === String(value)) && <option value={String(value ?? '')}>{loading ? 'Loading…' : String(value ?? '— select —')}</option>}
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)} title={o.description}>{o.name}</option>
      ))}
    </select>
  );
}

/* ---------- filter (conditions) ---------- */

const OPERATORS: Record<string, Array<[string, string, boolean?]>> = {
  string: [['exists', 'exists', true], ['notExists', 'does not exist', true], ['empty', 'is empty', true], ['notEmpty', 'is not empty', true], ['equals', 'is equal to'], ['notEquals', 'is not equal to'], ['contains', 'contains'], ['notContains', 'does not contain'], ['startsWith', 'starts with'], ['notStartsWith', 'does not start with'], ['endsWith', 'ends with'], ['notEndsWith', 'does not end with'], ['regex', 'matches regex'], ['notRegex', 'does not match regex']],
  number: [['exists', 'exists', true], ['notExists', 'does not exist', true], ['empty', 'is empty', true], ['notEmpty', 'is not empty', true], ['equals', 'is equal to'], ['notEquals', 'is not equal to'], ['gt', 'is greater than'], ['lt', 'is less than'], ['gte', 'is greater than or equal to'], ['lte', 'is less than or equal to']],
  dateTime: [['exists', 'exists', true], ['notExists', 'does not exist', true], ['empty', 'is empty', true], ['notEmpty', 'is not empty', true], ['equals', 'is equal to'], ['notEquals', 'is not equal to'], ['after', 'is after'], ['before', 'is before'], ['afterOrEquals', 'is after or equal to'], ['beforeOrEquals', 'is before or equal to']],
  boolean: [['exists', 'exists', true], ['notExists', 'does not exist', true], ['empty', 'is empty', true], ['notEmpty', 'is not empty', true], ['true', 'is true', true], ['false', 'is false', true], ['equals', 'is equal to'], ['notEquals', 'is not equal to']],
  array: [['exists', 'exists', true], ['notExists', 'does not exist', true], ['empty', 'is empty', true], ['notEmpty', 'is not empty', true], ['contains', 'contains'], ['notContains', 'does not contain'], ['lengthEquals', 'length equal to'], ['lengthNotEquals', 'length not equal to'], ['lengthGt', 'length greater than'], ['lengthLt', 'length less than'], ['lengthGte', 'length greater than or equal to'], ['lengthLte', 'length less than or equal to']],
  object: [['exists', 'exists', true], ['notExists', 'does not exist', true], ['empty', 'is empty', true], ['notEmpty', 'is not empty', true]],
};

interface FilterValue {
  options?: Record<string, unknown>;
  conditions: Array<{ id?: string; leftValue: Value; rightValue?: Value; operator: { type: string; operation: string; singleValue?: boolean } }>;
  combinator: 'and' | 'or';
}

function FilterInput({ value, onChange, nodeName }: { value: Value; onChange: (v: Value) => void; nodeName: string }) {
  const f = (value && typeof value === 'object' ? value : { conditions: [], combinator: 'and' }) as FilterValue;
  const conditions = f.conditions ?? [];
  const set = (patch: Partial<FilterValue>) => onChange({ ...f, ...patch });
  const setCond = (i: number, patch: Partial<FilterValue['conditions'][number]>) => set({ conditions: conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const add = (left: Value = '') => set({ conditions: [...conditions, { id: uid(), leftValue: left, rightValue: '', operator: { type: 'string', operation: 'equals' } }] });
  return (
    <div className="col" onDragOver={(e) => e.preventDefault()}>
      {conditions.map((c, i) => {
        const single = OPERATORS[c.operator.type]?.find(([op]) => op === c.operator.operation)?.[2];
        return (
          <div key={c.id ?? i}>
            {i > 0 && (
              <div className="row" style={{ margin: '2px 0 6px' }}>
                <select style={{ width: 80, minHeight: 26, padding: '2px 6px' }} value={f.combinator} onChange={(e) => set({ combinator: e.target.value as 'and' | 'or' })}>
                  <option value="and">AND</option>
                  <option value="or">OR</option>
                </select>
              </div>
            )}
            <div className="condition-row">
              <SmartInput value={c.leftValue} onChange={(v) => setCond(i, { leftValue: v })} nodeName={nodeName} placeholder="value1" />
              <select
                value={`${c.operator.type}:${c.operator.operation}`}
                onChange={(e) => {
                  const [type, operation] = e.target.value.split(':');
                  const singleValue = OPERATORS[type].find(([op]) => op === operation)?.[2];
                  setCond(i, { operator: { type, operation, ...(singleValue ? { singleValue: true } : {}) } });
                }}
              >
                {Object.entries(OPERATORS).map(([type, ops]) => (
                  <optgroup key={type} label={type[0].toUpperCase() + type.slice(1)}>
                    {ops.map(([op, label]) => (
                      <option key={op} value={`${type}:${op}`}>{label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {single ? <span /> : <SmartInput value={c.rightValue} onChange={(v) => setCond(i, { rightValue: v })} nodeName={nodeName} placeholder="value2" />}
              <button className="ghost sm icon" onClick={() => set({ conditions: conditions.filter((_, j) => j !== i) })}><Trash2 size={13} /></button>
            </div>
          </div>
        );
      })}
      <div
        onDrop={(e) => {
          const d = readDrop(e);
          if (d) {
            e.preventDefault();
            add(`=${d.expression}`);
          }
        }}
      >
        <button className="sm" onClick={() => add()}><Plus size={13} /> Add condition</button>
      </div>
    </div>
  );
}

/* ---------- assignments (Edit Fields) ---------- */

interface Assignment { id: string; name: string; value: Value; type: string }

function AssignmentsInput({ value, onChange, nodeName }: { value: Value; onChange: (v: Value) => void; nodeName: string }) {
  const list = ((value as { assignments?: Assignment[] })?.assignments ?? []) as Assignment[];
  const [over, setOver] = useState(false);
  const set = (assignments: Assignment[]) => onChange({ assignments });
  const update = (i: number, patch: Partial<Assignment>) => set(list.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  return (
    <div
      className={`col ${over ? 'param-drop' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const d = readDrop(e);
        if (!d || (e.target as HTMLElement).closest('.assignment-value')) return;
        e.preventDefault();
        set([...list, { id: uid(), name: d.path?.split('.').pop() ?? 'field', value: `=${d.expression}`, type: 'string' }]);
      }}
    >
      {list.map((a, i) => (
        <div key={a.id} className="collection-item" style={{ padding: 8, gap: 6 }}>
          <div className="row">
            <GripVertical size={13} className="faint" />
            <input value={a.name} placeholder="name" onChange={(e) => update(i, { name: e.target.value })} />
            <select style={{ width: 100 }} value={a.type} onChange={(e) => update(i, { type: e.target.value })}>
              {['string', 'number', 'boolean', 'array', 'object'].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <button className="ghost sm icon" onClick={() => set(list.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
          </div>
          <div className="assignment-value">
            {a.type === 'boolean' && !isExpr(a.value) ? (
              <select value={String(a.value ?? 'false')} onChange={(e) => update(i, { value: e.target.value === 'true' })}>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <SmartInput value={a.value} onChange={(v) => update(i, { value: v })} nodeName={nodeName} placeholder="value" />
            )}
          </div>
        </div>
      ))}
      <div className="faint" style={{ fontSize: 12, textAlign: 'center', padding: 8, border: '1px dashed var(--border)', borderRadius: 6 }}>
        Drag input fields here, or <a href="#" onClick={(e) => { e.preventDefault(); set([...list, { id: uid(), name: '', value: '', type: 'string' }]); }}>add a field</a>
      </div>
    </div>
  );
}

/* ---------- collections ---------- */

function CollectionInput({ prop, value, onChange, nodeName, root, typeVersion }: ParamProps & { root: INodeParameters }) {
  const v = (value && typeof value === 'object' ? value : {}) as INodeParameters;
  const options = (prop.options ?? []).filter((o): o is INodeProperties => !!o && typeof o === 'object' && 'type' in o);
  const unused = options.filter((o) => v[o.name] === undefined);
  const present = options.filter((o) => v[o.name] !== undefined);
  return (
    <div className="collection">
      {present.map((o) => (
        <div key={o.name} className="row" style={{ alignItems: 'flex-start' }}>
          <div className="grow">
            <Parameter prop={o} value={v[o.name]} onChange={(nv) => onChange({ ...v, [o.name]: nv as never })} nodeName={nodeName} root={root} typeVersion={typeVersion} />
          </div>
          <button className="ghost sm icon" style={{ marginTop: 18 }} onClick={() => {
            const { [o.name]: _drop, ...rest } = v;
            onChange(rest);
          }}><Trash2 size={13} /></button>
        </div>
      ))}
      {unused.length > 0 && (
        <select value="" onChange={(e) => {
          const o = options.find((x) => x.name === e.target.value);
          if (o) onChange({ ...v, [o.name]: structuredClone(o.default) as never });
        }}>
          <option value="">{(prop.typeOptions as { multipleValueButtonText?: string })?.multipleValueButtonText ?? (prop.placeholder || 'Add option')}</option>
          {unused.map((o) => <option key={o.name} value={o.name}>{o.displayName}</option>)}
        </select>
      )}
      {!present.length && !unused.length && <span className="faint">No options</span>}
    </div>
  );
}

function FixedCollectionInput({ prop, value, onChange, nodeName, root, typeVersion }: ParamProps & { root: INodeParameters }) {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, INodeParameters | INodeParameters[]>;
  const groups = (prop.options ?? []).filter(isCollectionGroup);
  const multiple = !!prop.typeOptions?.multipleValues;
  const emptyItem = (g: INodePropertyCollection) => Object.fromEntries(g.values.map((p) => [p.name, structuredClone(p.default)])) as INodeParameters;
  const addable = groups.filter((g) => multiple || v[g.name] === undefined);

  const renderItem = (g: INodePropertyCollection, item: INodeParameters, update: (i: INodeParameters) => void, remove: () => void, key: string | number) => (
    <div key={key} className="collection-item">
      <button className="ghost sm icon remove" onClick={remove}><Trash2 size={13} /></button>
      <ParameterList properties={g.values} values={item} root={root} onChange={update} nodeName={nodeName} typeVersion={typeVersion} />
    </div>
  );

  return (
    <div className="collection">
      {groups.map((g) => {
        const gv = v[g.name];
        if (gv === undefined) return null;
        return (
          <div key={g.name} className="col">
            {groups.length > 1 && <div className="faint" style={{ fontSize: 12, fontWeight: 600 }}>{g.displayName}</div>}
            {multiple && Array.isArray(gv)
              ? gv.map((item, i) =>
                  renderItem(
                    g,
                    item,
                    (ni) => onChange({ ...v, [g.name]: gv.map((x, j) => (j === i ? ni : x)) }),
                    () => {
                      const next = gv.filter((_, j) => j !== i);
                      const { [g.name]: _d, ...rest } = v;
                      onChange(next.length ? { ...v, [g.name]: next } : rest);
                    },
                    i,
                  ),
                )
              : renderItem(g, gv as INodeParameters, (ni) => onChange({ ...v, [g.name]: ni }), () => {
                  const { [g.name]: _d, ...rest } = v;
                  onChange(rest);
                }, g.name)}
          </div>
        );
      })}
      {addable.length > 0 &&
        (addable.length === 1 ? (
          <button className="sm" onClick={() => {
            const g = addable[0];
            const cur = v[g.name];
            onChange({ ...v, [g.name]: multiple ? [...(Array.isArray(cur) ? cur : []), emptyItem(g)] : emptyItem(g) });
          }}>
            <Plus size={13} /> {prop.typeOptions?.multipleValueButtonText ?? `Add ${addable[0].displayName || prop.displayName}`}
          </button>
        ) : (
          <select value="" onChange={(e) => {
            const g = groups.find((x) => x.name === e.target.value);
            if (!g) return;
            const cur = v[g.name];
            onChange({ ...v, [g.name]: multiple ? [...(Array.isArray(cur) ? cur : []), emptyItem(g)] : emptyItem(g) });
          }}>
            <option value="">{prop.placeholder || `Add ${prop.displayName}`}</option>
            {addable.map((g) => <option key={g.name} value={g.name}>{g.displayName}</option>)}
          </select>
        ))}
    </div>
  );
}

function ResourceLocatorInput({ prop, value, onChange, nodeName }: ParamProps) {
  const v = (value && typeof value === 'object' ? value : { __rl: true, mode: prop.modes?.[0]?.name ?? 'id', value: value ?? '' }) as { __rl: true; mode: string; value: Value };
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <select style={{ width: 110 }} value={v.mode} onChange={(e) => onChange({ ...v, mode: e.target.value })}>
        {(prop.modes ?? [{ name: 'id', displayName: 'By ID' }]).map((m) => <option key={m.name} value={m.name}>{m.displayName}</option>)}
      </select>
      <div className="grow">
        <SmartInput value={v.value} onChange={(nv) => onChange({ ...v, value: nv })} nodeName={nodeName} placeholder={prop.modes?.find((m) => m.name === v.mode)?.placeholder} />
      </div>
    </div>
  );
}

/* ---------- single parameter ---------- */

interface ParamProps {
  prop: INodeProperties;
  value: Value;
  onChange: (v: Value) => void;
  nodeName: string;
  typeVersion?: number;
}

const NO_EXPRESSION_TOGGLE = new Set(['collection', 'fixedCollection', 'notice', 'filter', 'assignmentCollection', 'button', 'hidden']);

function ParameterInput({ prop, value, onChange, nodeName, root, typeVersion }: ParamProps & { root: INodeParameters }) {
  const credentialTypes = useApp((s) => s.credentialTypes);
  if (isExpr(value) && !NO_EXPRESSION_TOGGLE.has(prop.type)) {
    const editor = prop.typeOptions?.editor;
    return <ExpressionEditor value={value.slice(1)} onChange={(v) => onChange(`=${v}`)} nodeName={nodeName} minHeight={editor ? 80 : 32} />;
  }
  switch (prop.type) {
    case 'string': {
      if (prop.typeOptions?.editor) {
        const lang = prop.typeOptions.editorLanguage ?? (prop.typeOptions.editor === 'sqlEditor' ? 'sql' : 'javaScript');
        return <CodeEditor value={String(value ?? '')} onChange={onChange} language={lang} nodeName={nodeName} minHeight={prop.typeOptions.editor === 'codeNodeEditor' ? 320 : 140} />;
      }
      if (prop.typeOptions?.rows) return <textarea rows={prop.typeOptions.rows} value={String(value ?? '')} placeholder={prop.placeholder} onChange={(e) => onChange(e.target.value)} />;
      return <SmartInput value={value} onChange={onChange} nodeName={nodeName} placeholder={prop.placeholder} type={prop.typeOptions?.password ? 'password' : 'text'} />;
    }
    case 'number':
      return <SmartInput value={value} onChange={onChange} nodeName={nodeName} placeholder={prop.placeholder} type="number" />;
    case 'boolean':
      return <Switch checked={!!value} onChange={onChange} />;
    case 'options':
      return <OptionsInput prop={prop} value={value} onChange={onChange} nodeName={nodeName} />;
    case 'multiOptions': {
      const arr = Array.isArray(value) ? value : [];
      return (
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          {(prop.options ?? []).filter(isPropertyOption).map((o) => (
            <label key={String(o.value)} className="row" style={{ gap: 4 }}>
              <input type="checkbox" checked={arr.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value))} />
              {o.name}
            </label>
          ))}
        </div>
      );
    }
    case 'json':
      return <CodeEditor value={typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2)} onChange={onChange} language="json" minHeight={100} />;
    case 'dateTime':
      return <SmartInput value={value} onChange={onChange} nodeName={nodeName} placeholder="2025-01-31T09:00:00" />;
    case 'color':
      return <input type="color" value={String(value || '#000000')} onChange={(e) => onChange(e.target.value)} style={{ width: 60, padding: 2 }} />;
    case 'collection':
      return <CollectionInput prop={prop} value={value} onChange={onChange} nodeName={nodeName} root={root} typeVersion={typeVersion} />;
    case 'fixedCollection':
      return <FixedCollectionInput prop={prop} value={value} onChange={onChange} nodeName={nodeName} root={root} typeVersion={typeVersion} />;
    case 'filter':
      return <FilterInput value={value} onChange={onChange} nodeName={nodeName} />;
    case 'assignmentCollection':
      return <AssignmentsInput value={value} onChange={onChange} nodeName={nodeName} />;
    case 'resourceLocator':
      return <ResourceLocatorInput prop={prop} value={value} onChange={onChange} nodeName={nodeName} />;
    case 'credentialsSelect': {
      const opts = (prop.options ?? []).filter(isPropertyOption);
      const list = opts.length ? opts : Object.values(credentialTypes).map((t) => ({ name: t.displayName, value: t.name }));
      return (
        <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="">— select —</option>
          {list.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.name}</option>)}
        </select>
      );
    }
    default:
      return <SmartInput value={value} onChange={onChange} nodeName={nodeName} />;
  }
}

export function Parameter({ prop, value, onChange, nodeName, root, typeVersion }: ParamProps & { root: INodeParameters }) {
  const [over, setOver] = useState(false);
  if (prop.type === 'hidden') return null;
  if (prop.type === 'notice') return <div className="notice">{prop.displayName}</div>;
  const expr = isExpr(value);
  const canToggle = !NO_EXPRESSION_TOGGLE.has(prop.type) && !prop.noDataExpression;
  const acceptsDrop = canToggle && !['options', 'boolean', 'multiOptions', 'json', 'credentialsSelect'].includes(prop.type) || (canToggle && expr);
  return (
    <div
      className={`param ${over ? 'param-drop' : ''}`}
      onDragOver={acceptsDrop ? (e) => { e.preventDefault(); setOver(true); } : undefined}
      onDragLeave={() => setOver(false)}
      onDrop={acceptsDrop ? (e) => {
        setOver(false);
        if (e.defaultPrevented) return;
        const d = readDrop(e);
        if (!d) return;
        e.preventDefault();
        const cur = expr ? (value as string).slice(1) : value === undefined || value === null || value === '' ? '' : String(value);
        onChange(`=${cur}${d.expression}`);
      } : undefined}
    >
      <div className="param-head">
        <span className="label" title={prop.description}>
          {prop.displayName}
          {prop.required && <span className="req">*</span>}
        </span>
        {canToggle && (
          <span className="mode-toggle">
            <button className={!expr ? 'active' : ''} onClick={() => expr && onChange(fromExpression(value as string, prop))}>Fixed</button>
            <button className={expr ? 'active' : ''} onClick={() => !expr && onChange(toExpression(value))}>Expression</button>
          </span>
        )}
      </div>
      <ParameterInput prop={prop} value={value} onChange={onChange} nodeName={nodeName} root={root} typeVersion={typeVersion} />
      {(prop.hint || (prop.description && ['string', 'number', 'options', 'boolean'].includes(prop.type))) && (
        <div className="param-hint">{prop.hint ?? prop.description}</div>
      )}
    </div>
  );
}

function toExpression(value: Value): string {
  if (value === undefined || value === null || value === '') return '=';
  if (typeof value === 'object') return `={{ ${JSON.stringify(value)} }}`;
  return `=${String(value)}`;
}

function fromExpression(value: string, prop: INodeProperties): Value {
  const raw = value.slice(1);
  if (/\{\{/.test(raw)) return prop.default;
  if (prop.type === 'number') return Number(raw) || 0;
  if (prop.type === 'boolean') return raw === 'true';
  return raw;
}

interface ListProps {
  properties: INodeProperties[];
  values: INodeParameters;
  root: INodeParameters;
  onChange: (values: INodeParameters) => void;
  nodeName: string;
  typeVersion?: number;
}

/** Renders the properties that are visible for the current values (displayOptions). */
export function ParameterList({ properties, values, root, onChange, nodeName, typeVersion }: ListProps) {
  const withDefaults: INodeParameters = { ...values };
  for (const p of properties) if (withDefaults[p.name] === undefined && p.type !== 'notice') withDefaults[p.name] = p.default as never;
  const rootWithDefaults = root === values ? withDefaults : root;
  const seen = new Set<string>();
  return (
    <>
      {properties.map((p, i) => {
        if (!getParameterDisplayed(p, withDefaults, rootWithDefaults, typeVersion)) return null;
        if (p.type !== 'notice' && seen.has(p.name)) return null;
        seen.add(p.name);
        return (
          <Parameter
            key={`${p.name}-${i}`}
            prop={p}
            value={withDefaults[p.name]}
            onChange={(v) => onChange({ ...values, [p.name]: v as never })}
            nodeName={nodeName}
            root={rootWithDefaults}
            typeVersion={typeVersion}
          />
        );
      })}
    </>
  );
}
