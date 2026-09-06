import "../test-workspace-root.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PrismaClient } from "@anneal/db";

import { createApp } from "../test-app.js";
import { resetFileStores } from "./config.js";

const auth = { Authorization: "Bearer files-operator-token" };

test("operator /files routes use a real filesystem", async (suite) => {
  const root = await mkdtemp(join(tmpdir(), "agentos-files-routes-"));
  const previousRoot = process.env.FILES_ROOT;
  const previousToken = process.env.OPERATOR_TOKEN;
  process.env.FILES_ROOT = root;
  process.env.OPERATOR_TOKEN = "files-operator-token";
  resetFileStores();
  const app = createApp({} as PrismaClient);
  suite.after(async () => {
    resetFileStores();
    if (previousRoot === undefined) delete process.env.FILES_ROOT;
    else process.env.FILES_ROOT = previousRoot;
    if (previousToken === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  });

  await suite.test("upload, list, download, and delete round-trip", async () => {
    const upload = await app.request("/files/content?path=docs%2Fhello.txt", { method: "PUT", headers: auth, body: "hello" });
    assert.equal(upload.status, 200);
    const list = await app.request("/files?dir=docs", { headers: auth });
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json() as Array<{ path: string }>).map(({ path }) => path), ["docs/hello.txt"]);
    const download = await app.request("/files/content?path=docs%2Fhello.txt", { headers: auth });
    assert.equal(download.status, 200);
    assert.match(download.headers.get("Content-Type") ?? "", /^text\/plain/u);
    assert.equal(await download.text(), "hello");
    assert.equal((await app.request("/files?path=docs%2Fhello.txt", { method: "DELETE", headers: auth })).status, 200);
  });

  await suite.test("directory state conflicts are 409, not 400 or 500", async () => {
    await app.request("/files/content?path=state%2Fa.txt", { method: "PUT", headers: auth, body: "a" });
    // A non-empty directory and "that is a directory" are conflicts with the state of the
    // target, not malformed requests: 400 would tell the client not to retry as-is.
    assert.equal((await app.request("/files?path=state", { method: "DELETE", headers: auth })).status, 409);
    assert.equal((await app.request("/files/content?path=state", { headers: auth })).status, 409);
    assert.equal((await app.request("/files/content?path=state", { method: "PUT", headers: auth, body: "x" })).status, 409);
    assert.equal((await app.request("/files?path=state&recursive=true", { method: "DELETE", headers: auth })).status, 200);
  });

  await suite.test("recursive delete removes populated trees while plain delete errors", async () => {
    await app.request("/files/content?path=tree%2Fa%2Fb.txt", { method: "PUT", headers: auth, body: "b" });
    const plain = await app.request("/files?path=tree", { method: "DELETE", headers: auth });
    assert.equal(plain.status, 409);
    const recursive = await app.request("/files?path=tree&recursive=true", { method: "DELETE", headers: auth });
    assert.equal(recursive.status, 200);
    await assert.rejects(stat(join(root, "tree")), { code: "ENOENT" });
  });

  await suite.test("recursive delete removes a tree whose children include symlinks", async () => {
    await app.request("/files/content?path=linked%2Freal.txt", { method: "PUT", headers: auth, body: "real" });
    await symlink("/etc/hosts", join(root, "linked", "link"));
    await symlink("/etc", join(root, "linked", "dirlink"));
    const recursive = await app.request("/files?path=linked&recursive=true", { method: "DELETE", headers: auth });
    assert.equal(recursive.status, 200);
    await assert.rejects(stat(join(root, "linked")), { code: "ENOENT" });
    assert.equal((await stat("/etc/hosts")).isFile(), true);
  });

  await suite.test("Content-Length over 25 MB returns 413 before storing the body", async () => {
    const response = await app.request("/files/content?path=too-large.bin", {
      method: "PUT",
      headers: { ...auth, "Content-Length": String(25 * 1024 * 1024 + 1) },
      body: "must-not-be-stored",
    });
    assert.equal(response.status, 413);
    await assert.rejects(stat(join(root, "too-large.bin")), { code: "ENOENT" });
  });

  await suite.test("chunked upload aborts near the cap instead of materializing the whole stream", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
        if (pulls === 1000) controller.close();
      },
    });
    const request = new Request("http://localhost/files/content?path=chunked.bin", {
      method: "PUT", headers: auth, body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await app.fetch(request);
    assert.equal(response.status, 413);
    assert.equal(pulls <= 402, true, `reader pulled ${pulls} chunks`);
  });

  await suite.test("HTTP boundary rejects once-decoded traversal and missing lists are 404", async () => {
    assert.equal((await app.request("/files/content?path=..%2Fescape", { method: "PUT", headers: auth, body: "bad" })).status, 400);
    assert.equal((await app.request("/files?dir=missing", { headers: auth })).status, 404);
  });

  await suite.test("reserved, spaced, percent, and non-ASCII filenames survive query round trips", async () => {
    const names = ["question?.txt", "hash#.txt", "percent%.txt", "amp&.txt", "a space.txt", "报告.md"];
    for (const name of names) {
      const query = new URLSearchParams({ path: `special/${name}` });
      assert.equal((await app.request(`/files/content?${query}`, { method: "PUT", headers: auth, body: name })).status, 200);
      assert.equal(await readFile(join(root, "special", name), "utf8"), name);
      assert.equal(await (await app.request(`/files/content?${query}`, { headers: auth })).text(), name);
    }
  });
});
