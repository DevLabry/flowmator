export type TemplateChunk = { kind: 'text'; value: string } | { kind: 'code'; value: string };

/**
 * Splits `Hello {{ $json.name }}!` into text and code chunks.
 * Braces inside the code (object literals, template strings, string quotes) are tracked so that
 * `{{ {a: 1}.a }}` and `{{ "}}" }}` parse correctly.
 */
export function splitTemplate(template: string): TemplateChunk[] {
  const chunks: TemplateChunk[] = [];
  let i = 0;
  let text = '';
  while (i < template.length) {
    if (template[i] === '{' && template[i + 1] === '{') {
      const end = findCodeEnd(template, i + 2);
      if (end === -1) {
        // unterminated: treat the rest as text
        text += template.slice(i);
        break;
      }
      if (text) chunks.push({ kind: 'text', value: text });
      text = '';
      chunks.push({ kind: 'code', value: template.slice(i + 2, end) });
      i = end + 2;
      continue;
    }
    text += template[i];
    i++;
  }
  if (text) chunks.push({ kind: 'text', value: text });
  return chunks;
}

function findCodeEnd(s: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  const templateDepth: number[] = []; // brace depth at each `${` inside template literals
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (quote === '`' && c === '$' && s[i + 1] === '{') {
        templateDepth.push(depth);
        depth++;
        quote = null;
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '{') {
      depth++;
      continue;
    }
    if (c === '}') {
      if (depth === 0 && s[i + 1] === '}') return i;
      depth--;
      if (templateDepth.length && templateDepth[templateDepth.length - 1] === depth) {
        templateDepth.pop();
        quote = '`';
      }
    }
  }
  return -1;
}
