import { parse } from 'acorn';
import { EXTENSION_METHOD_NAMES } from './extensions';

type AnyNode = { type: string; start: number; end: number; [key: string]: any };

/**
 * Rewrites `value.method(args)` into `__ext(value, "method", [args])` when `method` is one of the
 * data transformation helpers. At runtime `__ext` calls the native method if the value has one,
 * so rewriting `arr.includes(x)` or `dt.plus(...)` is harmless.
 */
export function transformExtensions(code: string): string {
  if (!EXTENSION_METHOD_NAMES.some((m) => code.includes(`.${m}`))) return code;
  let ast: AnyNode;
  try {
    ast = parse(`(${code}\n)`, { ecmaVersion: 'latest', sourceType: 'script' }) as unknown as AnyNode;
  } catch {
    // Not a single expression (e.g. statements). Leave untouched; evaluation will report the syntax error.
    return code;
  }
  const src = `(${code}\n)`;
  const out = generate(ast, src);
  return out.slice(1, -2);
}

function childNodes(node: AnyNode): AnyNode[] {
  const children: AnyNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'type') continue;
    if (Array.isArray(value)) {
      for (const v of value) if (v && typeof v === 'object' && typeof v.type === 'string') children.push(v);
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      children.push(value);
    }
  }
  return children.sort((a, b) => a.start - b.start);
}

function generate(node: AnyNode, src: string): string {
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    !node.callee.optional &&
    !node.optional &&
    node.callee.object.type !== 'Super' &&
    EXTENSION_METHOD_NAMES.includes(node.callee.property.name)
  ) {
    const obj = generate(node.callee.object, src);
    const args = node.arguments.map((a: AnyNode) => generate(a, src)).join(', ');
    return `__ext(${obj}, ${JSON.stringify(node.callee.property.name)}, [${args}])`;
  }
  let out = '';
  let pos = node.start;
  for (const child of childNodes(node)) {
    out += src.slice(pos, child.start) + generate(child, src);
    pos = child.end;
  }
  return out + src.slice(pos, node.end);
}
