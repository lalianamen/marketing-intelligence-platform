import { redirect } from "next/navigation";
import { AuthShell } from "@/components/AuthShell";
import { Button, Field, Notice } from "@/components/ui";
import { getUser } from "@/server/supabase/server";
import { resetPasswordAction } from "../auth-actions";

export default async function Reset({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const { user } = await getUser();
  if (!user) redirect("/forgot-password");
  return (
    <AuthShell title="Choose a new password">
      <form action={resetPasswordAction} className="space-y-4">
        {sp.error && <Notice tone="red">{sp.error}</Notice>}
        <Field label="New password" name="password" type="password" required autoComplete="new-password" hint="At least 10 characters, with letters and numbers." />
        <Button>Save new password</Button>
      </form>
    </AuthShell>
  );
}
