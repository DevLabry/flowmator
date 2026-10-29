import { randomUUID } from 'node:crypto';
import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, ILoadOptionsFunctions, INodeProperties, INodeType, IPollFunctions } from '@8n8/workflow';
import { forEachItem, forOp, listLimit, operationProp, pollTimesProp, returnAllProps } from '../../utils/api';
import { googleAuthProp, googleCredentials, googlePages, googleRequest } from './google';

const API = 'https://www.googleapis.com/calendar/v3';
const CRED = 'googleCalendarOAuth2Api';

type Ctx = { helpers: IExecuteFunctions['helpers'] };
const calendar = (ctx: Ctx, auth: unknown, options: IHttpRequestOptions, i = 0) => googleRequest(ctx, auth, CRED, options, i);
const calendarPath = (id: string) => `${API}/calendars/${encodeURIComponent(id || 'primary')}`;

/** "YYYY-MM-DD" of a date (or date-time) in the given time zone, for all-day events. */
export function dateOnly(value: string, timeZone?: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${value}"`);
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Start/end in Google's shape: { date } for all-day events, otherwise { dateTime, timeZone }. */
export function eventTime(value: string, allDay: boolean, timeZone?: string): IDataObject {
  if (allDay) return { date: dateOnly(value, timeZone) };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${value}"`);
  // strings without an offset are wall-clock times in the event's time zone
  const hasOffset = /([zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  return { dateTime: hasOffset || !timeZone ? d.toISOString() : value.replace(' ', 'T'), ...(timeZone ? { timeZone } : {}) };
}

const calendarProp: INodeProperties = { displayName: 'Calendar', name: 'calendar', type: 'options', default: 'primary', required: true, typeOptions: { loadOptionsMethod: 'getCalendars' }, description: 'Calendar ID or email ("primary" is your main calendar)' };
const eventIdProp: INodeProperties = { displayName: 'Event ID', name: 'eventId', type: 'string', default: '', required: true };
const sendUpdatesProp: INodeProperties = { displayName: 'Send Updates To', name: 'sendUpdates', type: 'options', default: 'none', options: [{ name: 'All Guests', value: 'all' }, { name: 'Guests Outside Your Organisation', value: 'externalOnly' }, { name: 'Nobody', value: 'none' }] };

const eventFields = (forUpdate: boolean): INodeProperties[] => [
  ...(forUpdate ? [{ displayName: 'Start', name: 'start', type: 'dateTime', default: '' } as INodeProperties, { displayName: 'End', name: 'end', type: 'dateTime', default: '' } as INodeProperties] : []),
  { displayName: 'All Day', name: 'allday', type: 'boolean', default: false },
  { displayName: 'Attendees', name: 'attendees', type: 'string', default: '', description: forUpdate ? 'Comma separated emails; replaces the guest list' : 'Comma separated emails' },
  { displayName: 'Color', name: 'colorId', type: 'options', default: '', options: [{ name: 'Calendar Default', value: '' }, ...['Lavender', 'Sage', 'Grape', 'Flamingo', 'Banana', 'Tangerine', 'Peacock', 'Graphite', 'Blueberry', 'Basil', 'Tomato'].map((n, i) => ({ name: n, value: String(i + 1) }))] },
  { displayName: 'Description', name: 'description', type: 'string', typeOptions: { rows: 3 }, default: '' },
  { displayName: 'Add Google Meet Link', name: 'conferenceData', type: 'boolean', default: false },
  { displayName: 'Guests Can Invite Others', name: 'guestsCanInviteOthers', type: 'boolean', default: true },
  { displayName: 'Guests Can Modify', name: 'guestsCanModify', type: 'boolean', default: false },
  { displayName: 'Location', name: 'location', type: 'string', default: '' },
  { displayName: 'Recurrence (RRULE)', name: 'rrule', type: 'string', default: '', placeholder: 'RRULE:FREQ=WEEKLY;COUNT=10' },
  { displayName: 'Show Me As', name: 'transparency', type: 'options', default: 'opaque', options: [{ name: 'Busy', value: 'opaque' }, { name: 'Available', value: 'transparent' }] },
  { displayName: 'Summary (Title)', name: 'summary', type: 'string', default: '' },
  { displayName: 'Time Zone', name: 'timezone', type: 'string', default: '', description: 'IANA name, e.g. Europe/Madrid. Defaults to the calendar\'s.' },
  { displayName: 'Visibility', name: 'visibility', type: 'options', default: 'default', options: ['default', 'public', 'private', 'confidential'].map((v) => ({ name: v, value: v })) },
];

type EventFields = { start?: string; end?: string; allday?: boolean; attendees?: string; colorId?: string; description?: string; conferenceData?: boolean; guestsCanInviteOthers?: boolean; guestsCanModify?: boolean; location?: string; rrule?: string; transparency?: string; summary?: string; timezone?: string; visibility?: string };

/** Event body from the form fields; `start`/`end` come from the required parameters on create. */
export function buildEvent(f: EventFields): { body: IDataObject; withConference: boolean } {
  const body: IDataObject = {};
  const tz = f.timezone || undefined;
  if (f.start) body.start = eventTime(f.start, !!f.allday, tz);
  if (f.end) body.end = eventTime(f.end, !!f.allday, tz);
  for (const k of ['summary', 'description', 'location', 'colorId', 'transparency', 'visibility'] as const) if (f[k]) body[k] = f[k];
  if (f.guestsCanInviteOthers !== undefined) body.guestsCanInviteOthers = f.guestsCanInviteOthers;
  if (f.guestsCanModify !== undefined) body.guestsCanModify = f.guestsCanModify;
  if (f.attendees) body.attendees = f.attendees.split(',').map((e) => e.trim()).filter(Boolean).map((email) => ({ email }));
  if (f.rrule) body.recurrence = [f.rrule.startsWith('RRULE:') ? f.rrule : `RRULE:${f.rrule}`];
  if (f.conferenceData) body.conferenceData = { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  return { body, withConference: !!f.conferenceData };
}

export const GoogleCalendar: INodeType = {
  description: {
    name: '8n8.googleCalendar',
    displayName: 'Google Calendar',
    description: 'Create, find and update events and check availability in Google Calendar',
    group: ['input'],
    version: [1, 1.1, 1.2, 1.3],
    defaults: { name: 'Google Calendar', color: '#4285f4' },
    icon: 'fa:calendar',
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: googleCredentials(CRED),
    codex: { categories: ['Productivity'] },
    properties: [
      googleAuthProp,
      { displayName: 'Resource', name: 'resource', type: 'options', noDataExpression: true, default: 'event', options: [{ name: 'Event', value: 'event' }, { name: 'Calendar', value: 'calendar' }] },
      operationProp('event', [
        { name: 'Create', value: 'create' },
        { name: 'Get', value: 'get' },
        { name: 'Get Many', value: 'getAll' },
        { name: 'Update', value: 'update' },
        { name: 'Delete', value: 'delete' },
      ]),
      operationProp('calendar', [{ name: 'Availability', value: 'availability', description: 'Whether a time slot is free' }]),

      ...forOp('event', ['create', 'get', 'getAll', 'update', 'delete'], [calendarProp]),
      ...forOp('event', ['get', 'update', 'delete'], [eventIdProp]),
      ...forOp('event', 'create', [
        { displayName: 'Start', name: 'start', type: 'dateTime', default: '={{ $now.toISO() }}', required: true },
        { displayName: 'End', name: 'end', type: 'dateTime', default: '={{ $now.plus({ hours: 1 }).toISO() }}', required: true },
        { displayName: 'Additional Fields', name: 'additionalFields', type: 'collection', default: {}, options: eventFields(false) },
        sendUpdatesProp,
      ]),
      ...forOp('event', 'update', [{ displayName: 'Update Fields', name: 'updateFields', type: 'collection', default: {}, options: eventFields(true) }, sendUpdatesProp]),
      ...forOp('event', 'delete', [sendUpdatesProp]),
      ...forOp('event', 'getAll', [
        ...returnAllProps({ resource: ['event'], operation: ['getAll'] }),
        { displayName: 'After', name: 'timeMin', type: 'dateTime', default: '={{ $now.toISO() }}', description: 'Events ending after this time' },
        { displayName: 'Before', name: 'timeMax', type: 'dateTime', default: '={{ $now.plus({ weeks: 1 }).toISO() }}', description: 'Events starting before this time' },
        {
          displayName: 'Options',
          name: 'options',
          type: 'collection',
          default: {},
          options: [
            { displayName: 'Search', name: 'q', type: 'string', default: '', description: 'Free text in title, description, location and attendees' },
            { displayName: 'Expand Recurring Events', name: 'singleEvents', type: 'boolean', default: true, description: 'One item per occurrence, sorted by start time' },
            { displayName: 'Show Deleted', name: 'showDeleted', type: 'boolean', default: false },
            { displayName: 'Updated Since', name: 'updatedMin', type: 'dateTime', default: '' },
            { displayName: 'Time Zone', name: 'timeZone', type: 'string', default: '' },
          ],
        },
      ]),
      ...forOp('event', 'get', [{ displayName: 'Time Zone', name: 'timeZone', type: 'string', default: '' }]),

      ...forOp('calendar', 'availability', [
        calendarProp,
        { displayName: 'Start Time', name: 'timeMin', type: 'dateTime', default: '', required: true },
        { displayName: 'End Time', name: 'timeMax', type: 'dateTime', default: '', required: true },
        { displayName: 'Output', name: 'outputFormat', type: 'options', default: 'availability', options: [{ name: 'Available (true/false)', value: 'availability' }, { name: 'Booked Slots', value: 'bookedSlots' }, { name: 'Raw', value: 'raw' }] },
        { displayName: 'Time Zone', name: 'timezone', type: 'string', default: '' },
      ]),
    ],
  },
  methods: {
    loadOptions: {
      async getCalendars(this: ILoadOptionsFunctions) {
        const r = await calendar(this, this.getCurrentNodeParameters().authentication, { url: `${API}/users/me/calendarList`, qs: { minAccessRole: 'reader' } });
        return ((r.items as IDataObject[]) ?? []).map((c) => ({ name: String(c.summaryOverride ?? c.summary), value: c.primary ? 'primary' : String(c.id) }));
      },
    },
  },
  async execute(this: IExecuteFunctions) {
    const auth = this.getNodeParameter('authentication', 0, 'oAuth2');
    return [
      await forEachItem(this, async (i) => {
        const p = <T = string>(name: string, fallback?: unknown) => this.getNodeParameter(name, i, fallback) as T;
        const call = (options: IHttpRequestOptions) => calendar(this, auth, options, i);
        const cal = p('calendar', 'primary');

        if (p('resource') === 'calendar') {
          const tz = p('timezone', '') || undefined;
          const r = await call({
            url: `${API}/freeBusy`,
            method: 'POST',
            body: { timeMin: new Date(p('timeMin')).toISOString(), timeMax: new Date(p('timeMax')).toISOString(), ...(tz ? { timeZone: tz } : {}), items: [{ id: cal }] },
          });
          const entry = Object.values((r.calendars as IDataObject) ?? {})[0] as { busy?: IDataObject[]; errors?: Array<{ reason: string }> } | undefined;
          if (entry?.errors?.length) throw new Error(`Google Calendar: ${entry.errors.map((e) => e.reason).join(', ')}`);
          const format = p('outputFormat', 'availability');
          if (format === 'raw') return r;
          if (format === 'bookedSlots') return entry?.busy ?? [];
          return { available: !(entry?.busy ?? []).length };
        }

        const op = p('operation');
        const events = `${calendarPath(cal)}/events`;
        const sendUpdates = p('sendUpdates', 'none');

        if (op === 'get') return call({ url: `${events}/${encodeURIComponent(p('eventId'))}`, qs: p('timeZone', '') ? { timeZone: p('timeZone') } : {} });
        if (op === 'delete') {
          await call({ url: `${events}/${encodeURIComponent(p('eventId'))}`, method: 'DELETE', qs: { sendUpdates } });
          return { success: true };
        }
        if (op === 'getAll') {
          const o = p<IDataObject>('options', {});
          const singleEvents = o.singleEvents ?? true;
          const qs: IDataObject = { singleEvents, ...(singleEvents ? { orderBy: 'startTime' } : {}) };
          if (p('timeMin', '')) qs.timeMin = new Date(p('timeMin')).toISOString();
          if (p('timeMax', '')) qs.timeMax = new Date(p('timeMax')).toISOString();
          for (const k of ['q', 'showDeleted', 'timeZone'] as const) if (o[k]) qs[k] = o[k];
          if (o.updatedMin) qs.updatedMin = new Date(String(o.updatedMin)).toISOString();
          return googlePages((pageToken, maxResults) => call({ url: events, qs: { ...qs, maxResults, ...(pageToken ? { pageToken } : {}) } }), 'items', listLimit(this, i), 250);
        }

        const fields = op === 'create' ? { ...p<EventFields>('additionalFields', {}), start: p('start'), end: p('end') } : p<EventFields>('updateFields', {});
        const { body, withConference } = buildEvent(fields);
        const qs: IDataObject = { sendUpdates, ...(withConference ? { conferenceDataVersion: 1 } : {}) };
        if (op === 'create') return call({ url: events, method: 'POST', qs, body });
        // all-day on update needs both ends in date form; PATCH keeps everything not sent
        return call({ url: `${events}/${encodeURIComponent(p('eventId'))}`, method: 'PATCH', qs, body });
      }),
    ];
  },
};

/* ---------------- trigger ---------------- */

const TRIGGER_EVENTS = [
  { name: 'Event Created', value: 'eventCreated' },
  { name: 'Event Updated', value: 'eventUpdated' },
  { name: 'Event Cancelled', value: 'eventCancelled' },
  { name: 'Event Started', value: 'eventStarted' },
  { name: 'Event Ended', value: 'eventEnded' },
];

const timeOf = (t: IDataObject | undefined) => new Date(String(t?.dateTime ?? t?.date ?? 0)).getTime();

export const GoogleCalendarTrigger: INodeType = {
  description: {
    name: '8n8.googleCalendarTrigger',
    displayName: 'Google Calendar Trigger',
    description: 'Starts the workflow when events are created, changed, cancelled, start or end (checks on a schedule)',
    group: ['trigger'],
    version: [1],
    defaults: { name: 'Google Calendar Trigger', color: '#4285f4' },
    icon: 'fa:calendar',
    inputs: [],
    outputs: ['main'],
    credentials: googleCredentials(CRED),
    polling: true,
    properties: [
      googleAuthProp,
      pollTimesProp,
      calendarProp,
      { displayName: 'Trigger On', name: 'triggerOn', type: 'options', default: 'eventCreated', options: TRIGGER_EVENTS },
      { displayName: 'Match Term', name: 'matchTerm', type: 'string', default: '', description: 'Only events containing this text' },
    ],
  },
  async poll(this: IPollFunctions) {
    const auth = this.getNodeParameter('authentication', 'oAuth2');
    const triggerOn = this.getNodeParameter('triggerOn', 'eventCreated') as string;
    const events = `${calendarPath(this.getNodeParameter('calendar', 'primary') as string)}/events`;
    const term = this.getNodeParameter('matchTerm', '') as string;
    const state = this.getWorkflowStaticData('node');
    const manual = this.getMode() === 'manual';
    const now = Date.now();
    if (!manual && !state.lastTimeChecked) {
      state.lastTimeChecked = new Date(now).toISOString();
      return null;
    }
    const since = manual ? now - 7 * 86_400_000 : new Date(String(state.lastTimeChecked)).getTime();
    const list = (qs: IDataObject) =>
      googlePages((pageToken, maxResults) => calendar(this, auth, { url: events, qs: { singleEvents: true, maxResults, ...(term ? { q: term } : {}), ...qs, ...(pageToken ? { pageToken } : {}) } }), 'items', manual ? 50 : 2500, 250);

    let matches: IDataObject[];
    if (triggerOn === 'eventStarted' || triggerOn === 'eventEnded') {
      const field = triggerOn === 'eventStarted' ? 'start' : 'end';
      // events overlapping (since, now], then keep those whose start/end fell inside it
      const candidates = await list({ timeMin: new Date(since).toISOString(), timeMax: new Date(Math.max(now, since + 1)).toISOString(), orderBy: 'startTime' });
      matches = candidates.filter((e) => e.status !== 'cancelled' && timeOf(e[field] as IDataObject) > since && timeOf(e[field] as IDataObject) <= now);
    } else {
      const changed = await list({ updatedMin: new Date(since).toISOString(), showDeleted: triggerOn === 'eventCancelled', orderBy: 'updated' });
      matches = changed.filter((e) => {
        if (triggerOn === 'eventCancelled') return e.status === 'cancelled';
        if (e.status === 'cancelled') return false;
        const created = new Date(String(e.created)).getTime() > since;
        return triggerOn === 'eventCreated' ? created : !created;
      });
    }
    if (!manual) state.lastTimeChecked = new Date(now).toISOString();
    if (manual) matches = matches.slice(-1);
    return matches.length ? [matches.map((json) => ({ json }))] : null;
  },
};
