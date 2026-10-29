import type { DataTableColumnType, DataTableRow, IDataTable, IDataTableColumn } from '@8n8/workflow';
import { ArrowDown, ArrowLeft, ArrowUp, Calendar, ChevronLeft, ChevronRight, Download, Hash, MoreHorizontal, Plus, Search, Table2, ToggleLeft, Trash2, Type, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Modal, Popover, timeAgo } from '../components/ui';
import { Api } from '../lib/api';
import { errorToast } from '../store/app';

const TYPES: Array<{ value: DataTableColumnType; label: string; Icon: typeof Type }> = [
  { value: 'string', label: 'String', Icon: Type },
  { value: 'number', label: 'Number', Icon: Hash },
  { value: 'boolean', label: 'Boolean', Icon: ToggleLeft },
  { value: 'date', label: 'Date', Icon: Calendar },
];
const typeIcon = (t: DataTableColumnType) => TYPES.find((x) => x.value === t)!.Icon;
const PAGE_SIZE = 50;

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}

/** Column names and types guessed from a CSV (types from the values present). */
function csvToTable(text: string) {
  const [header = [], ...body] = parseCsv(text);
  const used = new Set<string>();
  const names = header.map((h, i) => {
    let name = h.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || `column_${i + 1}`;
    if (!/^[A-Za-z]/.test(name)) name = `c_${name}`;
    if (['id', 'createdAt', 'updatedAt'].includes(name)) name = `${name}_csv`;
    while (used.has(name)) name = `${name}_${i + 1}`;
    used.add(name);
    return name;
  });
  const columns = names.map((name, i) => {
    const values = body.map((r) => (r[i] ?? '').trim()).filter((v) => v !== '');
    let type: DataTableColumnType = 'string';
    if (values.length && values.every((v) => !Number.isNaN(Number(v)))) type = 'number';
    else if (values.length && values.every((v) => /^(true|false)$/i.test(v))) type = 'boolean';
    else if (values.length && values.every((v) => /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) && !Number.isNaN(Date.parse(v)))) type = 'date';
    return { name, type };
  });
  const rows = body.map((r) => Object.fromEntries(names.map((n, i) => [n, (r[i] ?? '') === '' ? null : r[i]])));
  return { columns, rows };
}

function CreateModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [csv, setCsv] = useState<{ file: string; columns: Array<{ name: string; type: DataTableColumnType }>; rows: DataTableRow[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const create = async () => {
    setBusy(true);
    try {
      const t = await Api.createDataTable({ name, columns: csv?.columns ?? [], rows: csv?.rows });
      navigate(`/home/datatables/${t.id}`);
    } catch (e) {
      errorToast('Could not create data table')(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Create data table"
      onClose={onClose}
      width={460}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!name.trim() || busy} onClick={create}>Create</button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <label className="col" style={{ gap: 6 }}>
          <span className="label">Name</span>
          <input autoFocus value={name} placeholder="e.g. Leads" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && create()} />
        </label>
        <div className="col" style={{ gap: 6 }}>
          <span className="label">Start from</span>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const parsed = csvToTable(await file.text());
            setCsv({ file: file.name, ...parsed });
            if (!name) setName(file.name.replace(/\.csv$/i, ''));
          }} />
          <div className="row">
            <button className={!csv ? 'active-choice' : ''} onClick={() => setCsv(null)}><Table2 size={14} /> Empty table</button>
            <button className={csv ? 'active-choice' : ''} onClick={() => fileRef.current?.click()}><Upload size={14} /> Import CSV</button>
          </div>
          {csv && (
            <div className="muted" style={{ fontSize: 12 }}>
              {csv.file}: {csv.rows.length} rows, columns {csv.columns.map((c) => `${c.name} (${c.type})`).join(', ') || 'none'}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function DataTablesPage() {
  const navigate = useNavigate();
  const [list, setList] = useState<Array<IDataTable & { rowCount: number }> | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const refresh = useCallback(() => Api.dataTables().then(setList, errorToast('Could not load data tables')), []);
  useEffect(() => void refresh(), [refresh]);
  const shown = (list ?? []).filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Data tables</h1>
          <div className="muted" style={{ marginTop: 4 }}>Tables stored by 8n8. Read and write them from workflows with the Data Table node.</div>
        </div>
        <button className="primary" onClick={() => setCreating(true)}><Plus size={14} /> Create data table</button>
      </div>
      {list && list.length > 0 && (
        <div className="row" style={{ marginBottom: 12 }}>
          <div className="search-box"><Search size={14} /><input placeholder="Search tables" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
        </div>
      )}
      {list === null ? null : list.length === 0 ? (
        <div className="card empty">
          <Table2 size={28} style={{ opacity: 0.5 }} />
          <div style={{ margin: '10px 0 14px' }}>No data tables yet. Create one to keep data between executions.</div>
          <button className="primary" onClick={() => setCreating(true)}><Plus size={14} /> Create data table</button>
        </div>
      ) : (
        <div className="card">
          <table className="list">
            <thead><tr><th>Name</th><th style={{ width: 110 }}>Columns</th><th style={{ width: 110 }}>Rows</th><th style={{ width: 160 }}>Updated</th><th style={{ width: 40 }} /></tr></thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id} className="clickable" onClick={() => navigate(`/home/datatables/${t.id}`)}>
                  <td><span className="row"><Table2 size={14} className="faint" /> {t.name}</span></td>
                  <td className="muted">{t.columns.length}</td>
                  <td className="muted">{t.rowCount}</td>
                  <td className="muted">{timeAgo(t.updatedAt)}</td>
                  <td>
                    <button className="ghost icon sm danger" title="Delete" onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete "${t.name}" and all its rows?`)) Api.deleteDataTable(t.id).then(refresh, errorToast('Could not delete'));
                    }}><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <CreateModal onClose={() => setCreating(false)} />}
    </div>
  );
}

/** Text shown and edited in a cell. */
const cellText = (v: unknown, type: DataTableColumnType) => {
  if (v === null || v === undefined) return '';
  if (type === 'date') return String(v).replace(/\.000Z$/, 'Z');
  return String(v);
};

function Cell({ row, column, onSave }: { row: DataTableRow; column: IDataTableColumn; onSave: (value: unknown) => Promise<void> }) {
  const value = row[column.name];
  const [draft, setDraft] = useState<string | null>(null);
  if (column.type === 'boolean') {
    return (
      <td className="dt-cell">
        <input type="checkbox" checked={value === true} onChange={(e) => onSave(e.target.checked)} />
      </td>
    );
  }
  const save = async () => {
    if (draft === null) return;
    const text = draft;
    setDraft(null);
    if (text === cellText(value, column.type)) return;
    await onSave(text === '' ? null : text);
  };
  return (
    <td className={`dt-cell ${column.type === 'number' ? 'num' : ''}`}>
      <input
        value={draft ?? cellText(value, column.type)}
        placeholder={column.type === 'date' ? 'YYYY-MM-DD' : ''}
        onFocus={() => setDraft(cellText(value, column.type))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </td>
  );
}

function ColumnHeader({ table, column, sort, onSort, onChanged }: { table: IDataTable; column: IDataTableColumn; sort?: string; onSort: () => void; onChanged: () => void }) {
  const [menu, setMenu] = useState(false);
  const Icon = typeIcon(column.type);
  const act = (p: Promise<unknown>) => p.then(onChanged, errorToast('Could not change column')).finally(() => setMenu(false));
  return (
    <th className="dt-head">
      <div className="row" style={{ gap: 6 }}>
        <button className="ghost dt-sort" onClick={onSort} title={`Sort by ${column.name}`}>
          <Icon size={12} className="faint" /> {column.name}
          {sort === 'asc' && <ArrowUp size={12} />}
          {sort === 'desc' && <ArrowDown size={12} />}
        </button>
        <div style={{ position: 'relative' }}>
          <button className="ghost icon sm" onClick={() => setMenu(!menu)}><MoreHorizontal size={13} /></button>
          <Popover open={menu} onClose={() => setMenu(false)} style={{ right: 0, top: 28, minWidth: 160 }}>
            <button onClick={() => {
              const name = prompt('Column name', column.name);
              if (name && name !== column.name) act(Api.renameDataTableColumn(table.id, column.id, name));
            }}>Rename</button>
            <button disabled={column.index === 0} onClick={() => act(Api.moveDataTableColumn(table.id, column.id, column.index - 1))}><ChevronLeft size={13} /> Move left</button>
            <button disabled={column.index === table.columns.length - 1} onClick={() => act(Api.moveDataTableColumn(table.id, column.id, column.index + 1))}><ChevronRight size={13} /> Move right</button>
            <button className="danger" onClick={() => confirm(`Delete column "${column.name}" and its values?`) && act(Api.deleteDataTableColumn(table.id, column.id))}><Trash2 size={13} /> Delete</button>
          </Popover>
        </div>
      </div>
    </th>
  );
}

function AddColumn({ table, onAdded }: { table: IDataTable; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<DataTableColumnType>('string');
  const add = () =>
    Api.addDataTableColumn(table.id, { name, type }).then(() => {
      setOpen(false);
      setName('');
      onAdded();
    }, errorToast('Could not add column'));
  return (
    <th className="dt-head" style={{ width: 44 }}>
      <div style={{ position: 'relative' }}>
        <button className="ghost icon sm" title="Add column" onClick={() => setOpen(!open)}><Plus size={14} /></button>
        <Popover open={open} onClose={() => setOpen(false)} style={{ right: 0, top: 30, width: 240, padding: 10 }}>
          <div className="col">
            <input autoFocus placeholder="column_name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name && add()} />
            <select value={type} onChange={(e) => setType(e.target.value as DataTableColumnType)}>
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <button className="primary" disabled={!name} onClick={add}>Add column</button>
          </div>
        </Popover>
      </div>
    </th>
  );
}

export function DataTablePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [table, setTable] = useState<IDataTable | null>(null);
  const [rows, setRows] = useState<{ count: number; data: DataTableRow[] }>({ count: 0, data: [] });
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ column: string; dir: 'asc' | 'desc' } | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const loadTable = useCallback(() => Api.dataTable(id!).then(setTable, (e) => {
    errorToast('Could not load data table')(e);
    navigate('/home/datatables');
  }), [id]);
  const loadRows = useCallback(() => {
    const q = new URLSearchParams({ skip: String(page * PAGE_SIZE), take: String(PAGE_SIZE) });
    if (sort) q.set('sortBy', `${sort.column}:${sort.dir}`);
    if (search) q.set('search', search);
    return Api.dataTableRows(id!, q.toString()).then(setRows, errorToast('Could not load rows'));
  }, [id, page, sort, search]);
  useEffect(() => void loadTable(), [loadTable]);
  useEffect(() => {
    const t = setTimeout(loadRows, search ? 250 : 0);
    return () => clearTimeout(t);
  }, [loadRows]);
  const refresh = () => {
    loadTable();
    loadRows();
  };

  if (!table) return null;
  const pages = Math.max(1, Math.ceil(rows.count / PAGE_SIZE));
  const toggleSort = (column: string) => setSort(sort?.column !== column ? { column, dir: 'asc' } : sort.dir === 'asc' ? { column, dir: 'desc' } : null);
  const saveCell = (row: DataTableRow, column: string) => async (value: unknown) => {
    try {
      const updated = await Api.updateDataTableRow(table.id, row.id as number, { [column]: value });
      setRows((r) => ({ ...r, data: r.data.map((x) => (x.id === row.id ? updated : x)) }));
    } catch (e) {
      errorToast('Could not save')(e);
      setRows((r) => ({ ...r }));
    }
  };
  const addRow = async () => {
    await Api.insertDataTableRows(table.id, [{}]).catch(errorToast('Could not add row'));
    const last = Math.max(0, Math.ceil((rows.count + 1) / PAGE_SIZE) - 1);
    if (sort || search || last !== page) {
      setSort(null);
      setSearch('');
      setPage(last);
    } else loadRows();
  };
  const deleteSelected = async () => {
    await Api.deleteDataTableRows(table.id, [...selected]).catch(errorToast('Could not delete rows'));
    setSelected(new Set());
    loadRows();
  };
  const allSelected = rows.data.length > 0 && rows.data.every((r) => selected.has(r.id as number));

  return (
    <div className="page dt-page">
      <div className="page-header">
        <div className="row" style={{ gap: 10 }}>
          <Link to="/home/datatables" className="btn ghost icon" title="All data tables"><ArrowLeft size={16} /></Link>
          <input
            className="dt-title"
            defaultValue={table.name}
            key={table.name}
            onBlur={(e) => e.target.value.trim() && e.target.value !== table.name && Api.renameDataTable(table.id, e.target.value).then(setTable, (err) => {
              errorToast('Could not rename')(err);
              e.target.value = table.name;
            })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <span className="badge">{rows.count} rows</span>
        </div>
        <div className="row">
          <div className="search-box"><Search size={14} /><input placeholder="Search rows" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} /></div>
          {selected.size > 0 && <button className="danger" onClick={deleteSelected}><Trash2 size={14} /> Delete {selected.size}</button>}
          <a className="btn" href={`/rest/data-tables/${table.id}/download-csv`} download><Download size={14} /> CSV</a>
          <button className="ghost icon danger" title="Delete table" onClick={() => confirm(`Delete "${table.name}" and all its rows?`) && Api.deleteDataTable(table.id).then(() => navigate('/home/datatables'), errorToast('Could not delete'))}><Trash2 size={15} /></button>
        </div>
      </div>
      <div className="card dt-grid-wrap">
        <table className="dt-grid">
          <thead>
            <tr>
              <th className="dt-head dt-check"><input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.data.map((r) => r.id as number)))} /></th>
              <th className="dt-head dt-id"><button className="ghost dt-sort" onClick={() => toggleSort('id')}><Hash size={12} className="faint" /> id {sort?.column === 'id' && (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</button></th>
              {table.columns.map((c) => <ColumnHeader key={c.id} table={table} column={c} sort={sort?.column === c.name ? sort.dir : undefined} onSort={() => toggleSort(c.name)} onChanged={refresh} />)}
              <th className="dt-head dt-meta"><button className="ghost dt-sort" onClick={() => toggleSort('updatedAt')}><Calendar size={12} className="faint" /> updatedAt {sort?.column === 'updatedAt' && (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</button></th>
              <AddColumn table={table} onAdded={refresh} />
            </tr>
          </thead>
          <tbody>
            {rows.data.map((r) => (
              <tr key={r.id as number} className={selected.has(r.id as number) ? 'selected' : ''}>
                <td className="dt-check"><input type="checkbox" checked={selected.has(r.id as number)} onChange={() => {
                  const next = new Set(selected);
                  if (next.has(r.id as number)) next.delete(r.id as number);
                  else next.add(r.id as number);
                  setSelected(next);
                }} /></td>
                <td className="dt-id faint">{r.id as number}</td>
                {table.columns.map((c) => <Cell key={c.id} row={r} column={c} onSave={saveCell(r, c.name)} />)}
                <td className="dt-meta faint">{timeAgo(r.updatedAt as string)}</td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>
        {rows.data.length === 0 && <div className="empty" style={{ padding: 28 }}>{search ? 'No rows match your search.' : table.columns.length ? 'No rows yet.' : 'Add a column to start.'}</div>}
        <div className="dt-footer">
          <button className="ghost sm" onClick={addRow}><Plus size={13} /> Add row</button>
          <div className="grow" />
          {pages > 1 && (
            <div className="row">
              <button className="ghost icon sm" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={14} /></button>
              <span className="muted" style={{ fontSize: 12 }}>Page {page + 1} of {pages}</span>
              <button className="ghost icon sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}><ChevronRight size={14} /></button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

