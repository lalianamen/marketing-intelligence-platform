import { describe, expect, it } from "vitest";
import { parseSupabaseConnection, readerScript } from "@/server/connectors/appDatabase";
import { channelOf, DEFAULT_STAGES, sanitizeStages } from "@/lib/funnel";

describe("App database connector: inputs", () => {
  it("accepts only Supabase pooler strings, never a password, and reads the project id", () => {
    expect(parseSupabaseConnection("postgresql://postgres.vewhmndummfhnbxnrqya:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:5432/postgres")).toEqual({
      host: "aws-0-us-east-1.pooler.supabase.com", port: 5432, database: "postgres", projectRef: "vewhmndummfhnbxnrqya",
    });
    expect(parseSupabaseConnection("postgresql://postgres.vewhmndummfhnbxnrqya:x@aws-1-eu-central-1.pooler.supabase.com:6543/postgres")).toMatchObject({ port: 5432 });
    expect(parseSupabaseConnection("postgresql://postgres:x@10.0.0.5:5432/postgres")).toMatch(/pooler/);
    expect(parseSupabaseConnection("postgresql://postgres:x@db.vewhmndummfhnbxnrqya.supabase.co:5432/postgres")).toMatch(/pooler/);
    expect(parseSupabaseConnection("postgresql://postgres:x@evil.pooler.supabase.com.attacker.io:5432/postgres")).toMatch(/pooler/);
    expect(parseSupabaseConnection("hello")).toMatch(/does not look like/);
  });

  it("the script makes a read-only login limited to marketing_intel; odd passwords are refused", () => {
    const s = readerScript("Abcdefghijklmnopqrstuvwx_1");
    expect(s).toContain("create role mi_reader login password 'Abcdefghijklmnopqrstuvwx_1'");
    expect(s).toContain("default_transaction_read_only = on");
    expect(s).toContain("grant select on all tables in schema marketing_intel to mi_reader");
    expect(s).not.toMatch(/schema public/);
    expect(() => readerScript("x'; drop table users; --")).toThrow();
  });

  it("channels and stages", () => {
    expect(channelOf("google.com", null)).toBe("Search");
    expect(channelOf("com.google.android.gm", null)).toBe("Email");
    expect(channelOf("chatgpt.com", "chatgptcom")).toBe("AI assistants");
    expect(channelOf(null, "fb")).toBe("Social");
    expect(channelOf(null, "em-value_nudge_d4")).toBe("Email");
    expect(channelOf(null, null)).toBe("Direct / unknown");
    expect(channelOf("partner-blog.com", null)).toBe("Referral");
    expect(sanitizeStages([{ label: "A", events: ["page_view"] }, { label: "B", events: ["bad event!", "purchase"] }])).toEqual([
      { label: "A", events: ["page_view"] }, { label: "B", events: ["purchase"] },
    ]);
    expect(sanitizeStages([{ label: "only one", events: ["x"] }])).toEqual(DEFAULT_STAGES);
  });
});
