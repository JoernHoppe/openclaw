import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { resolveUsageCostTranscriptFile } from "./session-cost-usage-collection.js";
import { createNativeStorageUsageAccess } from "./session-cost-usage-collection.test-support.js";
import {
  decodeUsageCostRollup,
  encodeUsageCostRollup,
  type UsageCostRollupEntry,
} from "./session-cost-usage-rollup-codec.js";
import { scanUsageCostRollupInWorker } from "./session-cost-usage-worker-refresh.js";

const timestamp = Date.parse("2026-09-23T12:00:00.000Z");
type Row = { seq: number; event: Record<string, unknown> };
function message(id: string, parentId: string | null, tokens: number): Row["event"] {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: "assistant",
      usage: { input: tokens, output: 0, totalTokens: tokens, cost: { total: tokens } },
    },
  };
}
const initial: Row[] = [
  { seq: 1, event: message("root", null, 1) },
  { seq: 4, event: message("a", "root", 2) },
];
async function scan(rows: Row[], previous?: UsageCostRollupEntry) {
  const storePath = path.resolve("synthetic-usage-paging.sqlite");
  const filePath = formatSqliteSessionFileMarker({
    agentId: "main",
    sessionId: "paging",
    storePath,
  });
  const maxSeq = rows.at(-1)?.seq ?? 0;
  const sizeBytes = rows.reduce(
    (sum, row) => sum + Buffer.byteLength(JSON.stringify(row.event)) + 1,
    0,
  );
  return scanUsageCostRollupInWorker({
    file: {
      kind: "sqlite",
      filePath,
      sourcePath: filePath,
      sessionId: "paging",
      maxSeq,
      eventCount: rows.length,
      size: sizeBytes,
      mtimeMs: timestamp,
    },
    previous,
    pricingFingerprint: "synthetic-pricing",
    resolveCosts: async (pairs) => pairs.map(() => undefined),
    // A short page does not mean end-of-range; decoded byte limits can cut any page.
    readRows: async (_marker, afterSeq, throughSeq) =>
      rows.filter((row) => row.seq > afterSeq && row.seq <= throughSeq).slice(0, 2),
    access: {
      ...createNativeStorageUsageAccess(),
      readSqliteStats: async () => [
        { maxSeq, eventCount: rows.length, sizeBytes, lastMutationAtMs: timestamp },
      ],
    },
  });
}
function expectUsage(entry: UsageCostRollupEntry, tokens: number, records: number, leaf: string) {
  expect(entry.parsedRecords).toBe(records);
  expect(entry.countedRecords).toBe(records);
  expect(
    Object.values(entry.rollup.buckets).reduce(
      (total, bucket) => total + bucket.totals.totalTokens,
      0,
    ),
  ).toBe(tokens);
  expect(entry.checkpoint).toMatchObject({ kind: "sqlite", visibleLeafId: leaf });
}

describe("paged SQLite usage rollups", () => {
  it("selects a branch after reading all short pages and preserves sparse sequence numbers", async () => {
    const result = await scan([
      { seq: 1, event: message("root", null, 1) },
      { seq: 4, event: message("hidden", "root", 100) },
      { seq: 5, event: message("hidden-tail", "hidden", 100) },
      { seq: 8, event: { type: "leaf", id: "switch", parentId: "hidden-tail", targetId: "root" } },
      { seq: 13, event: message("chosen", "switch", 2) },
      { seq: 20, event: message("chosen-tail", "chosen", 3) },
    ]);
    expectUsage(result, 6, 3, "chosen-tail");
    expect(result.checkpoint).toMatchObject({ maxSeq: 20, eventCount: 6 });
  });

  it.each([
    {
      kind: "append",
      suffix: [{ seq: 16, event: message("d", "c", 16) }],
      tokens: 31,
      records: 5,
      leaf: "d",
    },
    {
      kind: "leaf",
      suffix: [{ seq: 20, event: { type: "leaf", id: "switch", parentId: "c", targetId: "root" } }],
      tokens: 1,
      records: 1,
      leaf: "root",
    },
    {
      kind: "reset",
      suffix: [
        { seq: 20, event: { type: "reset", id: "reset", parentId: null } },
        { seq: 25, event: message("after-reset", "root", 16) },
      ],
      tokens: 16,
      records: 1,
      leaf: "after-reset",
    },
  ])(
    "preserves the selected rollup through later $kind pages",
    async ({ suffix, tokens, records, leaf }) => {
      const previous = await scan(initial);
      const result = await scan(
        [
          ...initial,
          { seq: 9, event: message("b", "a", 4) },
          { seq: 12, event: message("c", "b", 8) },
          ...suffix,
        ],
        previous,
      );
      expectUsage(result, tokens, records, leaf);
    },
  );

  it("aggregates duplicate-ID paths in selected ancestry order when sequence numbers go backward", async () => {
    const user = (at: number) => ({
      type: "message",
      id: "user",
      parentId: null,
      timestamp: new Date(at).toISOString(),
      message: { role: "user", content: "synthetic" },
    });
    const result = await scan([
      { seq: 1, event: user(timestamp) },
      {
        seq: 2,
        event: {
          ...message("answer", "user", 3),
          timestamp: new Date(timestamp + 2000).toISOString(),
        },
      },
      { seq: 3, event: user(timestamp + 1000) },
      { seq: 4, event: { type: "leaf", id: "switch", parentId: "user", targetId: "answer" } },
    ]);
    expectUsage(result, 3, 1, "answer");
    expect(result.rollup.lastUserTimestamp).toBe(timestamp + 1000);
    expect(
      Object.values(result.rollup.buckets).find((bucket) => bucket.latency.count > 0)?.latency,
    ).toMatchObject({ count: 1, min: 1000, max: 1000, sum: 1000 });
  });
});

const jsonlDirectories = useAutoCleanupTempDirTracker(afterEach);

it("resumes unsigned legacy JSONL checkpoints, writes signed exact IDs, and rejects replacement", async () => {
  const filePath = path.join(jsonlDirectories.make("usage-exact-identity-"), "session.jsonl");
  const unpriced = (id: string, tokens: number) => ({
    ...message(id, null, tokens),
    message: {
      role: "assistant",
      provider: "synthetic",
      model: id,
      usage: { input: tokens, output: 0, totalTokens: tokens },
    },
  });
  fs.writeFileSync(filePath, `${JSON.stringify(unpriced("root", 7))}\n`);
  const nativeStat = fs.promises.stat;
  const device = -9_223_372_036_854_775_807n;
  let inode = -9_223_372_036_854_775_805n;
  const stat = vi.spyOn(fs.promises, "stat").mockImplementation(async (...args) => {
    const result = await nativeStat(...args);
    if (result && args[0] === filePath) {
      result.dev = typeof result.dev === "bigint" ? device : Number(BigInt.asUintN(64, device));
      result.ino = typeof result.ino === "bigint" ? inode : Number(BigInt.asUintN(64, inode));
    }
    return result;
  });
  try {
    const access = createNativeStorageUsageAccess();
    const pricedModels: Array<string | undefined> = [];
    const scanFile = async (previous?: UsageCostRollupEntry) => {
      const file = await resolveUsageCostTranscriptFile(filePath, access);
      expect(file).toBeDefined();
      return scanUsageCostRollupInWorker({
        file: file!,
        previous,
        pricingFingerprint: "synthetic-pricing",
        resolveCosts: async (pairs) => {
          pricedModels.push(...pairs.map(({ model }) => model));
          return pairs.map(() => ({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }));
        },
        readRows: async () => [],
        access,
      });
    };
    const previous = await scanFile();
    expect(previous.checkpoint).toMatchObject({
      device: "-9223372036854775807",
      inode: "-9223372036854775805",
    });
    if (previous.checkpoint.kind !== "jsonl") {
      throw new Error("Expected JSONL checkpoint");
    }
    // Released checkpoints persisted numeric stats after JS rounded their IDs.
    const encoded = encodeUsageCostRollup({
      ...previous,
      checkpoint: {
        ...previous.checkpoint,
        device: Number(BigInt.asUintN(64, device)),
        inode: Number(BigInt.asUintN(64, inode)),
      },
    });
    const legacy = decodeUsageCostRollup(
      encoded.valueJson,
      previous.pricingFingerprint,
      encoded.blob,
    );
    expect(legacy).toBeDefined();
    pricedModels.length = 0;
    fs.appendFileSync(filePath, `${JSON.stringify(unpriced("appended", 3))}\n`);
    const upgraded = await scanFile(legacy);
    // Already-priced history survives; only the new record needs price resolution.
    expect(pricedModels).toEqual(["appended"]);
    expect(upgraded.checkpoint).toMatchObject({
      device: "-9223372036854775807",
      inode: "-9223372036854775805",
    });
    expect(upgraded.countedRecords).toBe(2);
    expect(Object.values(upgraded.rollup.buckets)[0]?.totals.totalTokens).toBe(10);

    const oldFile = await resolveUsageCostTranscriptFile(filePath, access);
    inode -= 1n;
    expect(Number(BigInt.asUintN(64, inode))).toBe(9_223_372_036_854_776_000);
    await expect(
      scanUsageCostRollupInWorker({
        file: oldFile!,
        pricingFingerprint: "synthetic-pricing",
        resolveCosts: async (pairs) => pairs.map(() => undefined),
        readRows: async () => [],
        access,
      }),
    ).rejects.toThrow("transcript changed identity while scanning");

    fs.renameSync(filePath, `${filePath}.previous`);
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ ...unpriced("replacement", 13), padding: "x".repeat(512) })}\n`,
    );
    pricedModels.length = 0;
    const replacement = await scanFile(upgraded);
    expect(pricedModels).toEqual(["replacement"]);
    expect(replacement.countedRecords).toBe(1);
    expect(Object.values(replacement.rollup.buckets)[0]?.totals.totalTokens).toBe(13);
    expect(replacement.checkpoint).toMatchObject({ inode: "-9223372036854775806" });
  } finally {
    stat.mockRestore();
  }
});
