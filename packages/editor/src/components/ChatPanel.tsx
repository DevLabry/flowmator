import { RotateCcw, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useWorkflow } from '../store/workflow';

interface Message {
  role: 'user' | 'bot' | 'error';
  text: string;
}

const newSession = () => crypto.randomUUID();

/** Resolves when the current manual run ends, with its final status. */
function waitForRun(): Promise<string> {
  return new Promise((resolve) => {
    let started = false;
    const unsub = useWorkflow.subscribe((s) => {
      if (s.status === 'running') started = true;
      if (started && s.status !== 'running') {
        unsub();
        resolve(s.status);
      }
    });
  });
}

/** Reply = first item of the node that finished last (usually the agent). */
function lastOutput(): unknown {
  const { runData } = useWorkflow.getState();
  let best: { end: number; json: Record<string, unknown> | undefined } = { end: -1, json: undefined };
  for (const runs of Object.values(runData)) {
    const task = runs.at(-1);
    if (!task) continue;
    const end = task.startTime + task.executionTime;
    if (end >= best.end) best = { end, json: task.data?.main?.[0]?.[0]?.json as Record<string, unknown> | undefined };
  }
  const j = best.json;
  if (!j) return '(no output)';
  return j.output ?? j.text ?? j;
}

/** Test chat for workflows that start with a chat trigger; each message is a manual run. */
export function ChatPanel({ trigger, onClose }: { trigger: string; onClose: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState(newSession);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages]);

  const send = async () => {
    const chatInput = text.trim();
    if (!chatInput || busy) return;
    setText('');
    setBusy(true);
    setMessages((m) => [...m, { role: 'user', text: chatInput }]);
    const done = waitForRun();
    await useWorkflow.getState().run({ triggerNode: trigger, triggerData: [{ json: { sessionId, action: 'sendMessage', chatInput } }] });
    const status = useWorkflow.getState().status === 'error' ? 'error' : await done;
    if (status === 'error') {
      const err = useWorkflow.getState().executionError;
      setMessages((m) => [...m, { role: 'error', text: err ? `${err.node ? `${err.node}: ` : ''}${err.message}` : 'The workflow failed' }]);
    } else {
      const out = lastOutput();
      setMessages((m) => [...m, { role: 'bot', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }]);
    }
    setBusy(false);
  };

  return (
    <div className="chat-panel">
      <div className="chat-head">
        <strong className="grow">Chat</strong>
        <button className="ghost sm icon" title="New session (forget the conversation)" onClick={() => { setSessionId(newSession()); setMessages([]); }}><RotateCcw size={13} /></button>
        <button className="ghost sm icon" onClick={onClose}><X size={14} /></button>
      </div>
      <div className="chat-log" ref={logRef}>
        {!messages.length && <div className="faint" style={{ textAlign: 'center', marginTop: 40 }}>Send a message to run the workflow.<br />Session {sessionId.slice(0, 8)}</div>}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>{m.text}</div>
        ))}
        {busy && <div className="chat-msg bot faint">Thinking…</div>}
      </div>
      <div className="chat-input">
        <textarea
          value={text}
          placeholder="Type a message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="primary icon" disabled={busy || !text.trim()} onClick={send}><Send size={14} /></button>
      </div>
    </div>
  );
}
