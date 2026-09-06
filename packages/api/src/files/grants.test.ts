import assert from "node:assert/strict";
import test from "node:test";

import { grantAdmits, identityKey, requiredCapability, type GrantKey, type GrantLike } from "./grants.js";

const grant = (folderPath: string, permissions: Partial<GrantLike> = {}): GrantLike => ({
  folderPath, canRead: false, canWrite: false, canDelete: false, ...permissions,
});

test("requiredCapability covers the full operation matrix", () => {
  for (const operation of ["list", "stat", "read"] as const) assert.equal(requiredCapability(operation), "canRead");
  assert.equal(requiredCapability("write"), "canWrite");
  assert.equal(requiredCapability("delete"), "canDelete");
});

test("drop-box, overlap, and root grant semantics admit any sufficient grant", async () => {
  const dropbox = grant("drop", { canWrite: true });
  assert.deepEqual(await grantAdmits([dropbox], "write", "drop/item", identityKey), { admitted: true });
  assert.deepEqual(await grantAdmits([dropbox], "read", "drop/item", identityKey), { admitted: false, missing: "canRead" });
  assert.deepEqual(await grantAdmits([grant("a", { canRead: true }), grant("a/b", { canWrite: true })], "write", "a/b/x", identityKey), { admitted: true });
  assert.deepEqual(await grantAdmits([grant("", { canRead: true })], "read", "every/folder", identityKey), { admitted: true });
});

test("dirty historical grant rows fail closed", async () => {
  for (const folderPath of ["/abs", "a/../..", "..\\x", "a/"]) {
    assert.deepEqual(await grantAdmits([grant(folderPath, { canRead: true })], "read", "a/x", identityKey), { admitted: false, missing: "canRead" });
  }
});

test("a path the key cannot address inside the root is denied, whatever the grants say", async () => {
  const unaddressable: GrantKey = async () => null;
  assert.deepEqual(
    await grantAdmits([grant("", { canRead: true, canWrite: true, canDelete: true })], "read", "a/x", unaddressable),
    { admitted: false, missing: "canRead" },
  );
});

test("grant and request are compared in one key, so an alias spelling cannot dodge either way", async () => {
  // Stands in for a case-insensitive volume: both spellings name one physical folder.
  const caseFolding: GrantKey = async (normalized) => normalized.toLowerCase();
  const readOnly = [grant("Protected", { canRead: true })];
  assert.deepEqual(await grantAdmits(readOnly, "read", "protected/value.txt", caseFolding), { admitted: true });
  assert.deepEqual(await grantAdmits(readOnly, "write", "protected/value.txt", caseFolding), { admitted: false, missing: "canWrite" });
  // Byte-exact comparison would have denied the read outright and told the operator the
  // folder was not granted, while the filesystem happily served the same directory.
  assert.deepEqual(await grantAdmits(readOnly, "read", "protected/value.txt", identityKey), { admitted: false, missing: "canRead" });
});
