import type { FastifyInstance } from 'fastify';
import type { DataTableColumnType, DataTableRow, IDataTableFilter } from '@flowmator/workflow';
import type { AccessService } from '../access';
import type { User } from '../users';
import type { AppContext } from '../context';
import type { DataTableService } from '../data-tables';

type Params = { id: string; columnId?: string };

/** `sortBy=name:desc` → { column, direction } */
function parseSort(sortBy?: string) {
  if (!sortBy) return undefined;
  const [column, dir] = sortBy.split(':');
  return { column, direction: dir?.toUpperCase() === 'DESC' ? ('DESC' as const) : ('ASC' as const) };
}

function parseFilter(filter?: string | IDataTableFilter): IDataTableFilter | undefined {
  if (!filter) return undefined;
  return typeof filter === 'string' ? (JSON.parse(filter) as IDataTableFilter) : filter;
}

/**
 * Every `${prefix}/:id...` route needs the table's project: reading for GET, creating (editing) otherwise.
 * Register before the routes so the hook covers them.
 */
export function guardDataTables(app: FastifyInstance, access: AccessService, prefix: string) {
  app.addHook('preHandler', async (req) => {
    const url = req.routeOptions.url ?? '';
    const id = (req.params as Partial<Params> | undefined)?.id;
    if (!id || !url.startsWith(`${prefix}/:id`)) return;
    access.requireProjectItem(req.user!, 'data_tables', id, req.method === 'GET' ? 'read' : 'create');
  });
}

/** Tables the user can see, optionally of one project. */
export function visibleTables<T extends { id: string }>(access: AccessService, req: { user: User | null }, tables: T[], projectId?: string) {
  if (projectId) access.requireProject(req.user!, projectId, 'read');
  const visible = access.projectItems('data_tables', req.user!, projectId);
  return tables.filter((t) => !visible || visible.has(t.id));
}

/** Row routes shared by the editor (/rest) and the public API (/api/v1). */
export function dataTableRowRoutes(app: FastifyInstance, dataTables: DataTableService, prefix: string) {
  app.get(`${prefix}/:id/rows`, async (req) => {
    const q = req.query as { skip?: string; take?: string; limit?: string; sortBy?: string; filter?: string; search?: string };
    const take = q.take ?? q.limit;
    return {
      data: dataTables.getRowsSync((req.params as Params).id, {
        skip: q.skip ? Number(q.skip) : undefined,
        take: take ? Number(take) : undefined,
        sortBy: parseSort(q.sortBy),
        filter: parseFilter(q.filter),
        search: q.search,
      }),
    };
  });
  app.post(`${prefix}/:id/rows`, async (req) => {
    const b = req.body as { data: DataTableRow[] | DataTableRow };
    return { data: dataTables.insertRowsSync((req.params as Params).id, Array.isArray(b.data) ? b.data : [b.data]) };
  });
  app.patch(`${prefix}/:id/rows`, async (req) => {
    const b = req.body as { filter: IDataTableFilter; data: DataTableRow; dryRun?: boolean };
    return { data: await dataTables.updateRows((req.params as Params).id, b.filter, b.data, { dryRun: b.dryRun }) };
  });
  app.post(`${prefix}/:id/rows/upsert`, async (req) => {
    const b = req.body as { filter: IDataTableFilter; data: DataTableRow };
    return { data: await dataTables.upsertRow((req.params as Params).id, b.filter, b.data) };
  });
  app.delete(`${prefix}/:id/rows`, async (req) => {
    const q = req.query as { ids?: string; filter?: string; dryRun?: string };
    const { id } = req.params as Params;
    if (q.ids) return { data: dataTables.deleteByIds(id, q.ids.split(',').map(Number), q.dryRun === 'true') };
    return { data: await dataTables.deleteRows(id, parseFilter(q.filter)!, { dryRun: q.dryRun === 'true' }) };
  });
}

export function dataTableRoutes(app: FastifyInstance, ctx: AppContext) {
  const { dataTables, access, users } = ctx;
  guardDataTables(app, access, '/rest/data-tables');

  app.get('/rest/data-tables', async (req) => {
    const q = req.query as { name?: string; projectId?: string };
    return { data: visibleTables(access, req, dataTables.listWithStats({ name: q.name }), q.projectId) };
  });
  app.post('/rest/data-tables', async (req) => {
    const b = req.body as { name: string; columns?: Array<{ name: string; type: DataTableColumnType }>; rows?: DataTableRow[]; projectId?: string };
    const projectId = b.projectId || users.personalProject(req.user!.id).id;
    access.requireProject(req.user!, projectId, 'create');
    const table = dataTables.createTableSync(b.name, b.columns ?? []);
    access.setItemProject('data_tables', table.id, projectId);
    // created from a CSV upload: the editor sends the parsed rows along
    if (b.rows?.length) {
      try {
        dataTables.insertRowsSync(table.id, b.rows);
      } catch (e) {
        await dataTables.deleteTable(table.id);
        throw e;
      }
    }
    return { data: dataTables.findTable(table.id) };
  });
  app.get('/rest/data-tables/:id', async (req) => ({ data: dataTables.requireTable((req.params as Params).id) }));
  app.patch('/rest/data-tables/:id', async (req) => ({ data: await dataTables.renameTable((req.params as Params).id, (req.body as { name: string }).name) }));
  app.delete('/rest/data-tables/:id', async (req) => {
    await dataTables.deleteTable((req.params as Params).id);
    return { data: true };
  });
  app.get('/rest/data-tables/:id/download-csv', async (req, reply) => {
    const table = dataTables.requireTable((req.params as Params).id);
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${table.name.replace(/[^\w.-]+/g, '_')}.csv"`);
    return dataTables.toCsv(table.id);
  });

  app.post('/rest/data-tables/:id/columns', async (req) => ({ data: await dataTables.addColumn((req.params as Params).id, req.body as { name: string; type: DataTableColumnType }) }));
  app.patch('/rest/data-tables/:id/columns/:columnId', async (req) => {
    const { id, columnId } = req.params as Required<Params>;
    return { data: dataTables.renameColumn(id, columnId, (req.body as { name: string }).name) };
  });
  app.patch('/rest/data-tables/:id/columns/:columnId/move', async (req) => {
    const { id, columnId } = req.params as Required<Params>;
    dataTables.moveColumn(id, columnId, (req.body as { targetIndex: number }).targetIndex);
    return { data: true };
  });
  app.delete('/rest/data-tables/:id/columns/:columnId', async (req) => {
    const { id, columnId } = req.params as Required<Params>;
    dataTables.deleteColumn(id, columnId);
    return { data: true };
  });

  /** Single-row edit from the editor grid. */
  app.patch('/rest/data-tables/:id/rows/:rowId', async (req) => {
    const { id, rowId } = req.params as { id: string; rowId: string };
    return { data: dataTables.updateRowById(id, Number(rowId), req.body as DataTableRow) };
  });

  dataTableRowRoutes(app, dataTables, '/rest/data-tables');
}
