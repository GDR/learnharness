import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	writeAtomicFileSync,
	writeAtomicFile,
	writeAtomicJsonSync,
	writeAtomicJson,
} from "../src/core/fs-atomic.ts";

describe("fs-atomic (POSIX atomic write utility)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-test-atomic-"));
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	it("synchronously writes a string atomically", () => {
		const target = path.join(tmpDir, "file.txt");
		writeAtomicFileSync(target, "hello atomic sync");
		assert.equal(fs.readFileSync(target, "utf8"), "hello atomic sync");
	});

	it("synchronously writes a Buffer atomically", () => {
		const target = path.join(tmpDir, "binary.bin");
		const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
		writeAtomicFileSync(target, buf);
		const read = fs.readFileSync(target);
		assert.deepEqual(read, buf);
	});

	it("asynchronously writes string and buffer atomically", async () => {
		const targetStr = path.join(tmpDir, "async.txt");
		await writeAtomicFile(targetStr, "hello atomic async");
		assert.equal(await fs.promises.readFile(targetStr, "utf8"), "hello atomic async");

		const targetBin = path.join(tmpDir, "async.bin");
		const buf = Buffer.from([1, 2, 3, 4, 5]);
		await writeAtomicFile(targetBin, buf);
		const readBin = await fs.promises.readFile(targetBin);
		assert.deepEqual(readBin, buf);
	});

	it("auto-creates nested parent directories", async () => {
		const nestedSync = path.join(tmpDir, "a", "b", "c", "nested-sync.txt");
		writeAtomicFileSync(nestedSync, "nested sync content");
		assert.equal(fs.readFileSync(nestedSync, "utf8"), "nested sync content");

		const nestedAsync = path.join(tmpDir, "x", "y", "z", "nested-async.txt");
		await writeAtomicFile(nestedAsync, "nested async content");
		assert.equal(await fs.promises.readFile(nestedAsync, "utf8"), "nested async content");
	});

	it("atomically replaces existing file content without corrupting", async () => {
		const target = path.join(tmpDir, "replace.txt");
		await writeAtomicFile(target, "initial version");
		assert.equal(await fs.promises.readFile(target, "utf8"), "initial version");

		await writeAtomicFile(target, "updated version 2");
		assert.equal(await fs.promises.readFile(target, "utf8"), "updated version 2");

		writeAtomicFileSync(target, "updated version 3");
		assert.equal(fs.readFileSync(target, "utf8"), "updated version 3");
	});

	it("applies explicit permission mode (0o600)", async () => {
		const target = path.join(tmpDir, "secret.key");
		await writeAtomicFile(target, "private data", { mode: 0o600 });
		const stat = await fs.promises.stat(target);
		// Mask with 0o777 to check file permissions
		assert.equal(stat.mode & 0o777, 0o600);
	});

	it("serializes and writes JSON with newline formatting", async () => {
		const targetSync = path.join(tmpDir, "sync.json");
		const data = { hello: "world", count: 42 };
		writeAtomicJsonSync(targetSync, data);
		const rawSync = fs.readFileSync(targetSync, "utf8");
		assert.ok(rawSync.endsWith("\n"));
		assert.deepEqual(JSON.parse(rawSync), data);

		const targetAsync = path.join(tmpDir, "async.json");
		await writeAtomicJson(targetAsync, data);
		const rawAsync = await fs.promises.readFile(targetAsync, "utf8");
		assert.ok(rawAsync.endsWith("\n"));
		assert.deepEqual(JSON.parse(rawAsync), data);
	});

	it("cleans up temporary files when writing succeeds", async () => {
		const target = path.join(tmpDir, "clean.txt");
		await writeAtomicFile(target, "no temp leftovers");
		const dirContents = await fs.promises.readdir(tmpDir);
		assert.equal(dirContents.length, 1);
		assert.equal(dirContents[0], "clean.txt");
	});

	it("concurrent writes to different files all succeed", async () => {
		const writes = Array.from({ length: 20 }, (_, i) => {
			const target = path.join(tmpDir, `concurrent-${i}.txt`);
			return writeAtomicFile(target, `content ${i}`).then(async () => {
				const read = await fs.promises.readFile(target, "utf8");
				assert.equal(read, `content ${i}`);
			});
		});
		await Promise.all(writes);
	});

	it("concurrent writes to the same file leave it uncorrupted with one valid state", async () => {
		const target = path.join(tmpDir, "shared.txt");
		const writes = Array.from({ length: 15 }, (_, i) =>
			writeAtomicFile(target, `version-${i}`),
		);
		await Promise.all(writes);
		const finalContent = await fs.promises.readFile(target, "utf8");
		assert.match(finalContent, /^version-\d+$/);
	});
});
