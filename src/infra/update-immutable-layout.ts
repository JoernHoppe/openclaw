import fsSync from "node:fs";
import path from "node:path";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { packageActivationRuntimeIdentity } from "./package-update-activation-paths.js";
import type { ImmutableInstallDescriptor } from "./update-immutable-install-schema.js";
import type { ImmutableProtectionSnapshot } from "./update-immutable-protection-schema.js";
const SHA = /^[a-f0-9]{40}$/u;

export function directoryIdentity(file: string): string {
  const stat = fsSync.lstatSync(file, { bigint: true });
  if (!stat.isDirectory() || stat.uid !== 0n || (stat.mode & 0o022n) !== 0n) {
    throw new Error(`Immutable installation directory must be root-owned and protected: ${file}`);
  }
  return `${stat.dev}:${stat.ino}`;
}

export function readImmutableLayout(root: string) {
  if (fsSync.realpathSync(root) !== root) {
    throw new Error("Immutable installation must have a canonical physical root.");
  }
  const rootIdentity = directoryIdentity(root);
  const releases = path.join(root, "releases");
  const releasesIdentity = directoryIdentity(releases);
  const pointer = path.join(root, "current");
  const stat = fsSync.lstatSync(pointer, { bigint: true });
  const target = stat.isSymbolicLink() ? fsSync.readlinkSync(pointer) : "";
  const generationPath = path.resolve(root, target);
  const sha = path.basename(generationPath);
  if (
    !stat.isSymbolicLink() ||
    stat.uid !== 0n ||
    !SHA.test(sha) ||
    path.dirname(generationPath) !== releases
  ) {
    throw new Error(
      "Immutable current must select a root-owned direct releases/<40-hex SHA> generation.",
    );
  }
  const identity = directoryIdentity(generationPath);
  if (
    fsSync.realpathSync(pointer) !== generationPath ||
    rootIdentity.split(":")[0] !== releasesIdentity.split(":")[0] ||
    identity.split(":")[0] !== releasesIdentity.split(":")[0]
  ) {
    throw new Error("Immutable release layout must be contained on one filesystem.");
  }
  return {
    identityEncoding: "exact" as const,
    rootIdentity,
    releasesIdentity,
    current: { sha, path: generationPath, identity, pointerIdentity: `${stat.dev}:${stat.ino}` },
  };
}

export type ImmutableIdentityEncoding = "exact" | "legacy";

function isImmutableIdentity(
  identity: string,
  encoding: ImmutableIdentityEncoding | undefined,
): boolean {
  return encoding === "exact"
    ? /^-?\d+:-?\d+$/u.test(identity)
    : /^\d+:\d+$/u.test(identity) &&
        identity.split(":").every((part) => Number.isFinite(Number(part)));
}

/** Released numeric-stat receipts compare in their original, rounded Number domain. */
export function immutableIdentityMatches(
  observed: string,
  recorded: string,
  encoding: ImmutableIdentityEncoding | undefined,
): boolean {
  if (!/^-?\d+:-?\d+$/u.test(observed) || !isImmutableIdentity(recorded, encoding)) {
    return false;
  }
  return encoding === "exact"
    ? observed === recorded
    : observed.split(":").every((part, index) => {
        // Bigint stats expose signed int64 IDs; numeric stats used uint64 IDs.
        // Positive legacy audit strings can already be rounded past uint64 max.
        const value = BigInt(part);
        const projected = value < 0n ? Number(BigInt.asUintN(64, value)) : Number(part);
        return projected === Number(recorded.split(":")[index]);
      });
}

export function assertImmutableIdentityEncoding(
  encoding: ImmutableIdentityEncoding | undefined,
  identities: readonly string[],
): void {
  if (
    (encoding !== undefined && encoding !== "exact" && encoding !== "legacy") ||
    identities.some((identity) => !isImmutableIdentity(identity, encoding))
  ) {
    throw new Error("Immutable receipt contains an invalid file identity or encoding.");
  }
}

export function assertImmutableDescriptorIdentityEncoding(
  descriptor: ImmutableInstallDescriptor,
): void {
  assertImmutableIdentityEncoding(descriptor.identityEncoding, [
    descriptor.rootIdentity,
    descriptor.releasesIdentity,
  ]);
  assertImmutableIdentityEncoding(
    descriptor.current.identityEncoding ?? descriptor.identityEncoding,
    [descriptor.current.identity, descriptor.current.pointerIdentity],
  );
}

export function assertImmutableDescriptorCurrent(descriptor: ImmutableInstallDescriptor): void {
  assertImmutableDescriptorIdentityEncoding(descriptor);
  const layout = readImmutableLayout(descriptor.root);
  if (
    !immutableIdentityMatches(
      layout.rootIdentity,
      descriptor.rootIdentity,
      descriptor.identityEncoding,
    ) ||
    !immutableIdentityMatches(
      layout.releasesIdentity,
      descriptor.releasesIdentity,
      descriptor.identityEncoding,
    ) ||
    layout.current.sha !== descriptor.current.sha ||
    layout.current.path !== descriptor.current.path ||
    !immutableIdentityMatches(
      layout.current.identity,
      descriptor.current.identity,
      descriptor.current.identityEncoding ?? descriptor.identityEncoding,
    ) ||
    !immutableIdentityMatches(
      layout.current.pointerIdentity,
      descriptor.current.pointerIdentity,
      descriptor.current.identityEncoding ?? descriptor.identityEncoding,
    ) ||
    packageActivationRuntimeIdentity(descriptor.runtime.path) !== descriptor.runtime.identity
  ) {
    throw new Error("Immutable installation changed since adoption; current was not modified.");
  }
}

export function refreshImmutableProtectionIdentities(
  snapshot: ImmutableProtectionSnapshot,
): ImmutableProtectionSnapshot {
  if (snapshot.identityEncoding === "exact") {
    return snapshot;
  }
  const files = [snapshot.state, ...snapshot.config];
  const identities = files.map((file) => {
    const stat = fsSync.lstatSync(file.pathProof.targetPath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    const stored = file.identity;
    return stat?.isFile() &&
      stat.nlink === 1n &&
      (stat.mode & 0o777n) === BigInt(stored.mode) &&
      stat.uid === BigInt(stored.uid) &&
      stat.gid === BigInt(stored.gid) &&
      immutableIdentityMatches(`${stat.dev}:${stat.ino}`, `${stored.dev}:${stored.ino}`, "legacy")
      ? Object.assign({}, stored, { dev: String(stat.dev), ino: String(stat.ino) })
      : null;
  });
  // An audited startup may already have replaced config. Retain that chain's
  // original legacy identity until the protection owner captures its new baseline.
  if (
    identities.some((identity) => identity === null) ||
    snapshot.config.some(
      (file) => sha256Hex(fsSync.readFileSync(file.pathProof.targetPath, "utf8")) !== file.hash,
    )
  ) {
    return { ...snapshot, identityEncoding: "legacy" };
  }
  return {
    ...snapshot,
    identityEncoding: "exact",
    state: { ...snapshot.state, identity: identities[0]! },
    config: snapshot.config.map((file, index) => ({ ...file, identity: identities[index + 1]! })),
  };
}
