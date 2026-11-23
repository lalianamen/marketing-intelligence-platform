import { getAppContext } from "@/server/appContext";
import { CsvUploader } from "@/components/CsvUploader";
import { Card, EmptyState, Notice } from "@/components/ui";
import { OPTIONAL_COLUMNS, REQUIRED_COLUMNS } from "@/server/ingestion/csv";

export default async function CsvPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const ctx = await getAppContext();
  if (!ctx.company) return <EmptyState title="Add a company first">Upload data for a company. <a className="text-brand-700" href="/app/companies">Add a company</a>.</EmptyState>;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <h1 className="text-2xl font-semibold">Upload a CSV</h1>
        {sp.error && <Notice tone="red">{sp.error}</Notice>}
        <CsvUploader companyId={ctx.company.id} companyName={ctx.company.name} />
      </div>
      <Card title="File format">
        <div className="space-y-3 text-sm text-gray-700">
          <p>One row per <strong>day + source + campaign</strong>.</p>
          <p><span className="font-medium">Required:</span> {REQUIRED_COLUMNS.join(", ")}</p>
          <p><span className="font-medium">Optional:</span> {OPTIONAL_COLUMNS.join(", ")}</p>
          <ul className="list-disc space-y-1 pl-5 text-gray-600">
            <li>Dates as YYYY-MM-DD.</li>
            <li>Leave a cell empty when a number is not available. Empty is not the same as 0.</li>
            <li>Numbers without currency symbols. Spend or revenue needs a 3-letter currency (USD).</li>
            <li>revenue_type: <em>attributed</em> (platform-reported, default) or <em>billed</em> (actually invoiced).</li>
            <li>Conversions keep the meaning they have in your source. We never add them up across sources.</li>
          </ul>
          <a className="font-medium text-brand-700" href="/sample-marketing-data.csv">Download the template with synthetic example rows</a>
        </div>
      </Card>
    </div>
  );
}
