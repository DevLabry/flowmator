import type { IDataObject } from '@flowmator/workflow';

/* ---------------- iCalendar (RFC 5545) ---------------- */

export interface IcsEvent {
  title: string;
  start: string | Date;
  end?: string | Date;
  allDay?: boolean;
  description?: string;
  location?: string;
  url?: string;
  uid?: string;
  status?: string;
  busyStatus?: string;
  recurrenceRule?: string;
  organizer?: string;
  attendees?: string[];
  sequence?: number;
  geolocation?: { lat: number; lon: number };
}

const escapeText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const unescapeText = (s: string) => s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

/** Lines longer than 75 octets continue on the next line after a space. */
function fold(line: string) {
  const bytes = Buffer.from(line);
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // don't split a multi-byte character
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString());
    start = end;
    limit = 74;
  }
  return parts.join('\r\n ');
}

const pad = (n: number) => String(n).padStart(2, '0');
const toDate = (v: string | Date) => {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${v}"`);
  return d;
};
const utcStamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
/** All-day dates keep the calendar day that was written, whatever the time zone. */
const dayStamp = (v: string | Date) => {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10).replace(/-/g, '');
  const d = toDate(v);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
};
const nextDay = (stamp: string) => {
  const d = new Date(Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8) + 1));
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
};
const mailto = (who: string) => {
  const m = who.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? `;CN=${JSON.stringify(m[1])}:mailto:${m[2]}` : `:mailto:${who.trim()}`;
};

export function buildIcs(events: IcsEvent[], calName?: string) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//flowmator//flowmator//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  if (calName) lines.push(`X-WR-CALNAME:${escapeText(calName)}`);
  const now = utcStamp(new Date());
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid || crypto.randomUUID()}`, `DTSTAMP:${now}`, `SUMMARY:${escapeText(e.title ?? '')}`);
    if (e.allDay) {
      const start = dayStamp(e.start);
      // DTEND of an all-day event is exclusive
      const end = e.end ? dayStamp(e.end) : start;
      lines.push(`DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end > start ? end : nextDay(start)}`);
    } else {
      const start = toDate(e.start);
      lines.push(`DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(e.end ? toDate(e.end) : new Date(start.getTime() + 3_600_000))}`);
    }
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    if (e.geolocation) lines.push(`GEO:${e.geolocation.lat};${e.geolocation.lon}`);
    if (e.url) lines.push(`URL:${e.url}`);
    if (e.status) lines.push(`STATUS:${e.status.toUpperCase()}`);
    if (e.busyStatus) lines.push(`X-MICROSOFT-CDO-BUSYSTATUS:${e.busyStatus.toUpperCase()}`);
    if (e.recurrenceRule) lines.push(`RRULE:${e.recurrenceRule.replace(/^RRULE:/i, '')}`);
    if (e.sequence !== undefined) lines.push(`SEQUENCE:${e.sequence}`);
    if (e.organizer) lines.push(`ORGANIZER${mailto(e.organizer)}`);
    for (const a of e.attendees ?? []) lines.push(`ATTENDEE;RSVP=TRUE;PARTSTAT=NEEDS-ACTION${mailto(a)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): IcsProperty | null {
  // the value starts at the first colon outside a quoted parameter value
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

/** iCalendar dates as ISO strings: UTC times end in Z, floating/TZID times have no offset, dates are YYYY-MM-DD. */
function icsDate(p: IcsProperty) {
  const m = p.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return p.value;
  if (!m[4]) return `${m[1]}-${m[2]}-${m[3]}`;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? 'Z' : ''}`;
}

const person = (p: IcsProperty) => ({ ...(p.params.CN ? { name: p.params.CN } : {}), email: p.value.replace(/^mailto:/i, ''), ...(p.params.PARTSTAT ? { status: p.params.PARTSTAT } : {}) });

const EVENT_FIELDS: Record<string, string> = {
  UID: 'uid',
  SUMMARY: 'summary',
  DESCRIPTION: 'description',
  LOCATION: 'location',
  URL: 'url',
  STATUS: 'status',
  RRULE: 'rrule',
  SEQUENCE: 'sequence',
  TRANSP: 'transparency',
  CLASS: 'class',
  CATEGORIES: 'categories',
};
const DATE_FIELDS: Record<string, string> = { DTSTART: 'start', DTEND: 'end', DTSTAMP: 'timestamp', CREATED: 'created', 'LAST-MODIFIED': 'lastModified', 'RECURRENCE-ID': 'recurrenceId' };

/** Parses the events (and to-dos) of an .ics file. */
export function parseIcs(text: string): IDataObject {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter((l) => l.trim());
  const calendar: IDataObject = { events: [], todos: [] };
  const stack: string[] = [];
  let current: IDataObject | null = null;
  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      stack.push(p.value.toUpperCase());
      if (p.value.toUpperCase() === 'VEVENT' || p.value.toUpperCase() === 'VTODO') current = {};
      continue;
    }
    if (p.name === 'END') {
      const done = stack.pop();
      if (current && (done === 'VEVENT' || done === 'VTODO')) {
        (calendar[done === 'VEVENT' ? 'events' : 'todos'] as IDataObject[]).push(current);
        current = null;
      }
      continue;
    }
    const where = stack.at(-1);
    if (where === 'VCALENDAR') {
      if (p.name === 'X-WR-CALNAME') calendar.name = unescapeText(p.value);
      else if (p.name === 'X-WR-TIMEZONE') calendar.timezone = p.value;
      else if (p.name === 'PRODID') calendar.prodId = p.value;
      continue;
    }
    if (!current || (where !== 'VEVENT' && where !== 'VTODO')) continue;
    if (DATE_FIELDS[p.name]) {
      const key = DATE_FIELDS[p.name];
      current[key] = icsDate(p);
      if (p.params.TZID) current[`${key}Timezone`] = p.params.TZID;
      if (p.name === 'DTSTART') current.allDay = p.params.VALUE === 'DATE' || /^\d{8}$/.test(p.value);
    } else if (p.name === 'ORGANIZER') current.organizer = person(p);
    else if (p.name === 'ATTENDEE') current.attendees = [...((current.attendees as IDataObject[]) ?? []), person(p)];
    else if (p.name === 'GEO') {
      const [lat, lon] = p.value.split(';').map(Number);
      current.geolocation = { lat, lon };
    } else if (EVENT_FIELDS[p.name]) {
      const key = EVENT_FIELDS[p.name];
      current[key] = key === 'sequence' ? Number(p.value) : key === 'categories' ? p.value.split(',').map(unescapeText) : unescapeText(p.value);
    }
  }
  if (!(calendar.todos as unknown[]).length) delete calendar.todos;
  return calendar;
}
