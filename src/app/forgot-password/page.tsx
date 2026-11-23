import { AuthShell } from "@/components/AuthShell";
import { Button, Field, Notice } from "@/components/ui";
import { forgotPasswordAction } from "../auth-actions";

export default async function Forgot({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const sp = await searchParams;
  return (
    <AuthShell title="Reset your password" footer={<a className="text-brand-700" href="/login">Back to log in</a>}>
      <form action={forgotPasswordAction} className="space-y-4">
        {sp.sent && <Notice tone="green">If an account exists for that email, we sent a reset link.</Notice>}
        <Field label="Email" name="email" type="email" required autoComplete="email" />
        <Button>Send reset link</Button>
      </form>
    </AuthShell>
  );
}
