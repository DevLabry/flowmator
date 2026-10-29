import { autocompletion } from '@codemirror/autocomplete';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { Decoration, EditorView, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useMemo, useState } from 'react';
import { expressionCompletions, previewExpression } from '../lib/expression';

const dark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

/** Highlights {{ … }} segments inside an expression. */
const exprHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private matcher = new MatchDecorator({ regexp: /\{\{[\s\S]*?\}\}/g, decoration: Decoration.mark({ class: 'cm-expr-chunk' }) });
    constructor(view: EditorView) {
      this.decorations = this.matcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = this.matcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

const baseTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent' },
  '.cm-content': { fontFamily: 'var(--mono)', padding: '6px 0' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
});

interface ExpressionEditorProps {
  value: string; // without the leading "="
  onChange: (v: string) => void;
  nodeName: string;
  minHeight?: number;
  autoFocus?: boolean;
}

/** Inline expression editor: highlighted {{ }}, autocomplete and a live result preview. */
export function ExpressionEditor({ value, onChange, nodeName, minHeight = 32, autoFocus }: ExpressionEditorProps) {
  const [focused, setFocused] = useState(false);
  const extensions = useMemo(
    () => [EditorView.lineWrapping, exprHighlighter, baseTheme, autocompletion({ override: [expressionCompletions(nodeName)], activateOnTyping: true })],
    [nodeName],
  );
  const preview = useMemo(() => previewExpression(`=${value}`, nodeName), [value, nodeName]);
  return (
    <div className={`expr-box ${focused ? 'focused' : ''}`}>
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false, autocompletion: false }}
        theme={dark() ? 'dark' : 'light'}
        minHeight={`${minHeight}px`}
        autoFocus={autoFocus}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      {(focused || !preview.ok) && <div className={`expr-preview ${preview.ok ? '' : 'err'}`}>{preview.text}</div>}
    </div>
  );
}

interface CodeEditorProps {
  value: string;
  onChange: (v: string) => void;
  language?: 'javaScript' | 'python' | 'json' | 'sql' | 'html';
  minHeight?: number;
  nodeName?: string;
  readOnly?: boolean;
}

export function CodeEditor({ value, onChange, language = 'javaScript', minHeight = 200, nodeName, readOnly }: CodeEditorProps) {
  const extensions = useMemo(() => {
    const lang = language === 'python' ? python() : language === 'json' ? json() : javascript();
    const ext = [lang, baseTheme];
    if (nodeName && language === 'javaScript') ext.push(autocompletion({ override: [expressionCompletions(nodeName, false)] }));
    return ext;
  }, [language, nodeName]);
  return (
    <div className="expr-box">
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        readOnly={readOnly}
        theme={dark() ? 'dark' : 'light'}
        minHeight={`${minHeight}px`}
        maxHeight="70vh"
        basicSetup={{ foldGutter: true, highlightActiveLine: true, autocompletion: true }}
      />
    </div>
  );
}
