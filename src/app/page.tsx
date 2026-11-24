import { redirect } from "next/navigation";
import { getUser } from "@/server/supabase/server";
import { LinkButton } from "@/components/ui";

export default async function Home() {
  const { user } = await getUser();
  if (user) redirect("/app");
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6">
      <p className="text-sm font-semibold tracking-wide text-brand-700">MARKETING INTELLIGENCE</p>
      <h1 className="mt-3 text-4xl font-semibold text-gray-900">All your marketing numbers in one clear dashboard.</h1>
      <p className="mt-4 text-lg text-gray-600">
        Add your companies, connect your data sources or upload a spreadsheet, and see spend, clicks, leads and results side by side,
        with each number labelled by source.
      </p>
      <div className="mt-8 flex gap-3">
        <LinkButton href="/signup">Create an account</LinkButton>
        <LinkButton href="/login" variant="secondary">Log in</LinkButton>
      </div>
      <p className="mt-10 text-xs text-gray-500">Phase 1 · early access.</p>
    </main>
  );
}
