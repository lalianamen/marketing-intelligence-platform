import { AuthShell } from "@/components/AuthShell";
import { Button, Field, Notice } from "@/components/ui";
import { signUpAction } from "../auth-actions";

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  return (
    <AuthShell title="Create your account" footer={<>Already have an account? <a className="font-medium text-brand-700" href="/login">Log in</a></>}>
      <form action={signUpAction} className="space-y-4">
        {sp.error && <Notice tone="red">{sp.error}</Notice>}
        <Field label="Work email" name="email" type="email" required autoComplete="email" />
        <Field label="Password" name="password" type="password" required autoComplete="new-password" hint="At least 10 characters, with letters and numbers." />
        <Button>Create account</Button>
        <p className="text-xs text-gray-500">We will send you an email to confirm your address before you can sign in.</p>
      </form>
    </AuthShell>
  );
}
