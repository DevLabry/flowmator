import { LoaderCircle } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Api } from '../lib/api';
import { useAuth } from '../store/auth';

/** Same rules as the server: 8–64 characters, a number and an uppercase letter. */
export function passwordProblem(password: string) {
  if (password.length < 8 || password.length > 64) return 'Use 8 to 64 characters';
  if (!/\d/.test(password)) return 'Include at least one number';
  if (!/[A-Z]/.test(password)) return 'Include at least one uppercase letter';
  return null;
}

function AuthCard({ title, subtitle, children, onSubmit, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; onSubmit: (e: FormEvent) => void; footer?: ReactNode }) {
  return (
    <div className="auth-page">
      <form className="card auth-card col" onSubmit={onSubmit}>
        <div className="row" style={{ gap: 8, marginBottom: 6 }}>
          <span className="brand-mark">fm</span>
          <strong style={{ fontSize: 15 }}>Flowmator</strong>
        </div>
        <h1>{title}</h1>
        {subtitle && <div className="muted">{subtitle}</div>}
        {children}
      </form>
      {footer && <div className="muted" style={{ marginTop: 14 }}>{footer}</div>}
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string | null }) {
  return (
    <label className="col" style={{ gap: 4 }}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="faint" style={{ fontSize: 12 }}>{hint}</span>}
    </label>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

const ErrorLine = ({ error }: { error: string | null }) => (error ? <div className="auth-error">{error}</div> : null);
const SubmitButton = ({ busy, children }: { busy: boolean; children: ReactNode }) => (
  <button className="primary" type="submit" disabled={busy} style={{ justifyContent: 'center', marginTop: 4 }}>
    {busy && <LoaderCircle size={14} className="spin" />} {children}
  </button>
);

/** First visit: create the owner account. Existing workflows and credentials become theirs. */
export function SetupPage() {
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', password: '' });
  const { busy, error, run } = useSubmit();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const problem = form.password ? passwordProblem(form.password) : null;
  return (
    <AuthCard
      title="Set up owner account"
      subtitle="The owner manages users and instance settings. Everything already on this instance will belong to this account."
      onSubmit={run(async () => {
        if (problem) throw new Error(problem);
        await useAuth.getState().signedIn(await Api.setupOwner(form));
      })}
    >
      <Field label="Email"><input type="email" required autoFocus autoComplete="email" value={form.email} onChange={set('email')} /></Field>
      <div className="row">
        <Field label="First name"><input required autoComplete="given-name" value={form.firstName} onChange={set('firstName')} /></Field>
        <Field label="Last name"><input required autoComplete="family-name" value={form.lastName} onChange={set('lastName')} /></Field>
      </div>
      <Field label="Password" hint={problem ?? '8+ characters, at least one number and one uppercase letter'}>
        <input type="password" required autoComplete="new-password" value={form.password} onChange={set('password')} />
      </Field>
      <ErrorLine error={error} />
      <SubmitButton busy={busy}>Next</SubmitButton>
    </AuthCard>
  );
}

export function SigninPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useSubmit();
  return (
    <AuthCard title="Sign in" onSubmit={run(async () => useAuth.getState().signedIn(await Api.login(email, password)))} footer={<Link to="/forgot-password">Forgot my password</Link>}>
      <Field label="Email"><input type="email" required autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Password"><input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <ErrorLine error={error} />
      <SubmitButton busy={busy}>Sign in</SubmitButton>
    </AuthCard>
  );
}

/** Accepting an invitation: /signup?token=… */
export function SignupPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [email, setEmail] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [form, setForm] = useState({ firstName: '', lastName: '', password: '' });
  const { busy, error, run } = useSubmit();
  const navigate = useNavigate();
  useEffect(() => {
    Api.invitation(token).then((r) => setEmail(r.email), (e) => setInvalid((e as Error).message));
  }, [token]);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const problem = form.password ? passwordProblem(form.password) : null;

  if (invalid) {
    return (
      <AuthCard title="Invitation not valid" subtitle={invalid} onSubmit={(e) => { e.preventDefault(); navigate('/signin'); }}>
        <SubmitButton busy={false}>Go to sign in</SubmitButton>
      </AuthCard>
    );
  }
  return (
    <AuthCard
      title="Set up your account"
      subtitle={email ? <>You were invited as <strong>{email}</strong></> : 'Checking your invitation…'}
      onSubmit={run(async () => {
        if (problem) throw new Error(problem);
        await useAuth.getState().signedIn(await Api.acceptInvitation(token, form));
        navigate('/home/workflows', { replace: true });
      })}
    >
      <div className="row">
        <Field label="First name"><input required autoFocus autoComplete="given-name" value={form.firstName} onChange={set('firstName')} /></Field>
        <Field label="Last name"><input required autoComplete="family-name" value={form.lastName} onChange={set('lastName')} /></Field>
      </div>
      <Field label="Password" hint={problem ?? '8+ characters, at least one number and one uppercase letter'}>
        <input type="password" required autoComplete="new-password" value={form.password} onChange={set('password')} />
      </Field>
      <ErrorLine error={error} />
      <SubmitButton busy={busy || !email}>Finish setup</SubmitButton>
    </AuthCard>
  );
}

export function ForgotPasswordPage() {
  const smtpSetup = useAuth((s) => s.smtpSetup);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useSubmit();
  if (!smtpSetup) {
    return (
      <AuthCard title="Forgot password" subtitle="Email isn't set up on this instance. Ask your owner or an admin for a password reset link." onSubmit={(e) => e.preventDefault()} footer={<Link to="/signin">Back to sign in</Link>}>
        <span />
      </AuthCard>
    );
  }
  return (
    <AuthCard
      title="Forgot password"
      subtitle={sent ? `If ${email} has an account, a reset link is on its way.` : 'We will email you a link to choose a new password.'}
      onSubmit={run(async () => {
        await Api.forgotPassword(email);
        setSent(true);
      })}
      footer={<Link to="/signin">Back to sign in</Link>}
    >
      {!sent && (
        <>
          <Field label="Email"><input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <ErrorLine error={error} />
          <SubmitButton busy={busy}>Email me a link</SubmitButton>
        </>
      )}
    </AuthCard>
  );
}

/** From a reset link: /change-password?token=… */
export function ChangePasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [invalid, setInvalid] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const { busy, error, run } = useSubmit();
  const navigate = useNavigate();
  useEffect(() => {
    Api.resolvePasswordToken(token).catch((e) => setInvalid((e as Error).message));
  }, [token]);
  const problem = password ? passwordProblem(password) : null;
  if (invalid) {
    return (
      <AuthCard title="Link not valid" subtitle={invalid} onSubmit={(e) => { e.preventDefault(); navigate('/signin'); }}>
        <SubmitButton busy={false}>Go to sign in</SubmitButton>
      </AuthCard>
    );
  }
  return (
    <AuthCard
      title="Choose a new password"
      onSubmit={run(async () => {
        if (problem) throw new Error(problem);
        if (password !== repeat) throw new Error('The passwords are different');
        await useAuth.getState().signedIn(await Api.changePassword(token, password));
        navigate('/home/workflows', { replace: true });
      })}
    >
      <Field label="New password" hint={problem ?? '8+ characters, at least one number and one uppercase letter'}>
        <input type="password" required autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Field label="Repeat password"><input type="password" required autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} /></Field>
      <ErrorLine error={error} />
      <SubmitButton busy={busy}>Change password</SubmitButton>
    </AuthCard>
  );
}
