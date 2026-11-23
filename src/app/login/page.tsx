import { AuthShell } from "@/components/AuthShell";
import { Button, Field, Notice } from "@/components/ui";
import { signInAction } from "../auth-actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; confirmed?: string }> }) {
  const sp = await searchParams;
  return (
    <AuthShell title="Log in" footer={<>No account yet? <a className="font-medium text-brand-700" href="/signup">Create one</a></>}>
      <form action={signInAction} className="space-y-4">
        {sp.error && <Notice tone="red">{sp.error}</Notice>}
        {sp.confirmed && <Notice tone="green">Your email is confirmed. Please log in.</Notice>}
        <Field label="Email" name="email" type="email" required autoComplete="email" />
        <Field label="Password" name="password" type="password" required autoComplete="current-password" />
        <Button>Log in</Button>
        <p className="text-sm"><a className="text-brand-700" href="/forgot-password">Forgot your password?</a></p>
      </form>
    </AuthShell>
  );
}
