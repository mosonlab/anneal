import { contains, normalizeRelPath } from "./paths.js";

export type FileOperation = "list" | "stat" | "read" | "write" | "delete";
export type FileCapability = "canRead" | "canWrite" | "canDelete";
export type GrantLike = { folderPath: string; canRead: boolean; canWrite: boolean; canDelete: boolean };

export const requiredCapability = (operation: FileOperation): FileCapability => {
  if (operation === "list" || operation === "stat" || operation === "read") return "canRead";
  if (operation === "write") return "canWrite";
  return "canDelete";
};

/**
 * Maps a normalized Files-Root-relative path to the key both sides of the comparison are
 * expressed in, or null when the path is not addressable inside the root. `identityKey`
 * is the syntactic fallback; `filesystemKey` (files/alias.ts) is what production uses, so
 * that a grant and a request cannot disagree about which physical subtree they name.
 */
export type GrantKey = (normalized: string) => Promise<string | null>;

export const identityKey: GrantKey = async (normalized) => normalized;

export const grantAdmits = async (
  grants: GrantLike[],
  operation: FileOperation,
  path: string,
  key: GrantKey,
): Promise<{ admitted: true } | { admitted: false; missing: FileCapability }> => {
  const capability = requiredCapability(operation);
  const denied = { admitted: false, missing: capability } as const;
  const pathKey = await key(normalizeRelPath(path));
  if (pathKey === null) return denied;
  for (const grant of grants) {
    let prefix: string;
    try {
      prefix = normalizeRelPath(grant.folderPath);
    } catch {
      continue;
    }
    if (prefix !== grant.folderPath) continue;
    const prefixKey = await key(prefix);
    if (prefixKey === null || !contains(prefixKey, pathKey)) continue;
    if (grant[capability]) return { admitted: true };
  }
  return denied;
};
