import { AuthShell } from "@/components/AuthShell";
import { Button, Notice } from "@/components/ui";
import { resendConfirmationAction } from "../auth-actions";

export default async function CheckEmail({ searchParams }: { searchParams: Promise<{ email?: string; resent?: string }> }) {
  const sp = await searchParams;
  return (
    <AuthShell title="Check your email">
      <div className="space-y-4 text-sm text-gray-700">
        <p>We sent a confirmation link{sp.email ? <> to <strong>{sp.email}</strong></> : null}. Open it to activate your account.</p>
        {/127\.0\.0\.1|localhost/.test(process.env.APP_URL ?? "") ? (
          <p className="text-gray-500">Local development: emails are captured by Mailpit at http://127.0.0.1:54324 (nothing is actually sent).</p>
        ) : (
          <p className="text-gray-500">Didn&apos;t get it? Check your Spam or Promotions folder. Open the link in this same browser.</p>
        )}
        {sp.resent && <Notice tone="green">If the address is registered, a new link is on its way.</Notice>}
        {sp.email && (
          <form action={resendConfirmationAction}>
            <input type="hidden" name="email" value={sp.email} />
            <Button variant="secondary">Send the link again</Button>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
