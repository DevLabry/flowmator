import { Cron } from 'croner';
import { DateTime } from 'luxon';
import { NodeOperationError, type IDataObject, type INodeType, type ITriggerFunctions } from '@flowmator/workflow';

export interface ScheduleRule {
  field: 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'cronExpression';
  secondsInterval?: number;
  minutesInterval?: number;
  hoursInterval?: number;
  daysInterval?: number;
  weeksInterval?: number;
  monthsInterval?: number;
  triggerAtHour?: number;
  triggerAtMinute?: number;
  triggerAtDay?: number[];
  triggerAtDayOfMonth?: number;
  expression?: string;
}

/** Converts a rule into a 6-field cron (with seconds) plus an optional week stride croner can't express. */
export function ruleToCron(rule: ScheduleRule): { cron: string; everyNWeeks?: number } {
  const h = rule.triggerAtHour ?? 0;
  const m = rule.triggerAtMinute ?? 0;
  switch (rule.field) {
    case 'seconds':
      return { cron: `*/${rule.secondsInterval ?? 30} * * * * *` };
    case 'minutes':
      return { cron: `0 */${rule.minutesInterval ?? 5} * * * *` };
    case 'hours':
      return { cron: `0 ${m} */${rule.hoursInterval ?? 1} * * *` };
    case 'days':
      return { cron: `0 ${m} ${h} */${rule.daysInterval ?? 1} * *` };
    case 'weeks': {
      const days = rule.triggerAtDay?.length ? rule.triggerAtDay.join(',') : '0';
      return { cron: `0 ${m} ${h} * * ${days}`, everyNWeeks: rule.weeksInterval && rule.weeksInterval > 1 ? rule.weeksInterval : undefined };
    }
    case 'months':
      return { cron: `0 ${m} ${h} ${rule.triggerAtDayOfMonth ?? 1} */${rule.monthsInterval ?? 1} *` };
    case 'cronExpression': {
      const expr = (rule.expression ?? '').trim();
      return { cron: expr.split(/\s+/).length === 5 ? `0 ${expr}` : expr };
    }
  }
}

function scheduleItem(timezone: string): IDataObject {
  const now = DateTime.now().setZone(timezone);
  return {
    timestamp: now.toISO(),
    'Readable date': now.toFormat('MMMM d yyyy, h:mm:ss a'),
    'Readable time': now.toFormat('h:mm:ss a'),
    'Day of week': now.toFormat('cccc'),
    Year: now.toFormat('yyyy'),
    Month: now.toFormat('MMMM'),
    'Day of month': now.toFormat('dd'),
    Hour: now.toFormat('HH'),
    Minute: now.toFormat('mm'),
    Second: now.toFormat('ss'),
    Timezone: `${timezone} (UTC${now.toFormat('ZZ')})`,
  };
}

const intervalField = (name: string, field: string, def: number) => ({
  displayName: `${field[0].toUpperCase()}${field.slice(1)} Between Triggers`,
  name,
  type: 'number' as const,
  default: def,
  typeOptions: { minValue: 1 },
  displayOptions: { show: { field: [field] } },
});

export const ScheduleTrigger: INodeType = {
  description: {
    name: 'flowmator.scheduleTrigger',
    displayName: 'Schedule Trigger',
    description: 'Triggers the workflow on a schedule',
    group: ['trigger', 'schedule'],
    version: [1, 1.1, 1.2],
    defaults: { name: 'Schedule Trigger', color: '#31C49F' },
    icon: 'fa:clock',
    inputs: [],
    outputs: ['main'],
    codex: { alias: ['Time', 'Scheduler', 'Polling', 'Cron', 'Interval'] },
    properties: [
      {
        displayName: 'Trigger Rules',
        name: 'rule',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: { interval: [{ field: 'days' }] },
        options: [
          {
            name: 'interval',
            displayName: 'Trigger Interval',
            values: [
              {
                displayName: 'Trigger Interval',
                name: 'field',
                type: 'options',
                default: 'days',
                options: [
                  { name: 'Seconds', value: 'seconds' },
                  { name: 'Minutes', value: 'minutes' },
                  { name: 'Hours', value: 'hours' },
                  { name: 'Days', value: 'days' },
                  { name: 'Weeks', value: 'weeks' },
                  { name: 'Months', value: 'months' },
                  { name: 'Custom (Cron)', value: 'cronExpression' },
                ],
              },
              intervalField('secondsInterval', 'seconds', 30),
              intervalField('minutesInterval', 'minutes', 5),
              intervalField('hoursInterval', 'hours', 1),
              intervalField('daysInterval', 'days', 1),
              intervalField('weeksInterval', 'weeks', 1),
              intervalField('monthsInterval', 'months', 1),
              { displayName: 'Trigger on Day of Month', name: 'triggerAtDayOfMonth', type: 'number', default: 1, typeOptions: { minValue: 1, maxValue: 31 }, displayOptions: { show: { field: ['months'] } } },
              {
                displayName: 'Trigger on Weekdays',
                name: 'triggerAtDay',
                type: 'multiOptions',
                default: [0],
                displayOptions: { show: { field: ['weeks'] } },
                options: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => ({ name: d, value: i })),
              },
              { displayName: 'Trigger at Hour', name: 'triggerAtHour', type: 'options', default: 0, displayOptions: { show: { field: ['days', 'weeks', 'months'] } },
                options: Array.from({ length: 24 }, (_, i) => ({ name: `${i % 12 || 12}${i < 12 ? 'am' : 'pm'}`, value: i })) },
              { displayName: 'Trigger at Minute', name: 'triggerAtMinute', type: 'number', default: 0, typeOptions: { minValue: 0, maxValue: 59 }, displayOptions: { show: { field: ['hours', 'days', 'weeks', 'months'] } } },
              { displayName: 'Expression', name: 'expression', type: 'string', default: '', placeholder: '0 9 * * 1-5', displayOptions: { show: { field: ['cronExpression'] } } },
            ],
          },
        ],
      },
    ],
  },
  async trigger(this: ITriggerFunctions) {
    const rules = ((this.getNodeParameter('rule', {}) as { interval?: ScheduleRule[] }).interval ?? []) as ScheduleRule[];
    const timezone = this.getTimezone();
    const staticData = this.getWorkflowStaticData('node');
    const emit = () => this.emit([this.helpers.returnJsonArray([scheduleItem(timezone)])]);

    if (this.getMode() === 'manual') {
      return { manualTriggerFunction: async () => emit() };
    }

    const jobs: Cron[] = [];
    rules.forEach((rule, index) => {
      const { cron, everyNWeeks } = ruleToCron(rule);
      try {
        jobs.push(
          new Cron(cron, { timezone }, () => {
            if (everyNWeeks) {
              const week = DateTime.now().setZone(timezone).weekNumber;
              const key = `lastWeek_${index}`;
              const last = staticData[key] as number | undefined;
              if (last !== undefined && week !== last && Math.abs(week - last) < everyNWeeks) return;
              staticData[key] = week;
            }
            emit();
          }),
        );
      } catch (e) {
        throw new NodeOperationError(this.getNode(), `Invalid schedule "${cron}": ${(e as Error).message}`);
      }
    });

    return {
      closeFunction: async () => jobs.forEach((j) => j.stop()),
      manualTriggerFunction: async () => emit(),
    };
  },
};
