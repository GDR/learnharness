/**
 * POSIX-compliant atomic file write utilities.
 *
 * Guarantees crash-safe, atomic file replacement using temporary files
 * in the same directory and atomic rename (POSIX link/rename semantics).
 * Ensures temporary files are flushed to disk (fsync) and unlinked on failure.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface WriteAtomicOptions {
	mode?: number;
	encoding?: BufferEncoding;
}

function getTempFilePath(targetPath: string): string {
	const dir = path.dirname(targetPath);
	const base = path.basename(targetPath);
	const rand = crypto.randomBytes(4).toString("hex");
	return path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}-${rand}`);
}

/**
 * Synchronously writes content to targetPath atomically via a sibling temp file + rename.
 */
export function writeAtomicFileSync(
	targetPath: string,
	content: string | Buffer,
	options?: WriteAtomicOptions,
): void {
	const resolvedPath = path.resolve(targetPath);
	const dir = path.dirname(resolvedPath);
	fs.mkdirSync(dir, { recursive: true });

	const tmpPath = getTempFilePath(resolvedPath);
	let fd: number | null = null;

	try {
		fd = fs.openSync(tmpPath, "w", options?.mode ?? 0o666);
		if (options?.mode !== undefined) {
			fs.fchmodSync(fd, options.mode);
		}

		if (typeof content === "string") {
			fs.writeFileSync(fd, content, { encoding: options?.encoding ?? "utf8" });
		} else {
			fs.writeFileSync(fd, content);
		}

		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = null;

		fs.renameSync(tmpPath, resolvedPath);
	} catch (err) {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {
				// ignore close error during unwinding
			}
		}
		try {
			if (fs.existsSync(tmpPath)) {
				fs.unlinkSync(tmpPath);
			}
		} catch {
			// ignore cleanup error
		}
		throw err;
	}
}

/**
 * Asynchronously writes content to targetPath atomically via a sibling temp file + rename.
 */
export async function writeAtomicFile(
	targetPath: string,
	content: string | Buffer,
	options?: WriteAtomicOptions,
): Promise<void> {
	const resolvedPath = path.resolve(targetPath);
	const dir = path.dirname(resolvedPath);
	await fs.promises.mkdir(dir, { recursive: true });

	const tmpPath = getTempFilePath(resolvedPath);
	let fileHandle: fs.promises.FileHandle | null = null;

	try {
		fileHandle = await fs.promises.open(tmpPath, "w", options?.mode ?? 0o666);
		if (options?.mode !== undefined) {
			await fileHandle.chmod(options.mode);
		}

		if (typeof content === "string") {
			await fileHandle.writeFile(content, { encoding: options?.encoding ?? "utf8" });
		} else {
			await fileHandle.writeFile(content);
		}

		await fileHandle.sync();
		await fileHandle.close();
		fileHandle = null;

		await fs.promises.rename(tmpPath, resolvedPath);
	} catch (err) {
		if (fileHandle !== null) {
			try {
				await fileHandle.close();
			} catch {
				// ignore close error
			}
		}
		try {
			await fs.promises.unlink(tmpPath);
		} catch {
			// ignore cleanup error
		}
		throw err;
	}
}

/**
 * Synchronously serializes data to formatted JSON and writes atomically.
 */
export function writeAtomicJsonSync(
	targetPath: string,
	data: unknown,
	options?: WriteAtomicOptions,
): void {
	const text = JSON.stringify(data, null, "\t") + "\n";
	writeAtomicFileSync(targetPath, text, options);
}

/**
 * Asynchronously serializes data to formatted JSON and writes atomically.
 */
export async function writeAtomicJson(
	targetPath: string,
	data: unknown,
	options?: WriteAtomicOptions,
): Promise<void> {
	const text = JSON.stringify(data, null, "\t") + "\n";
	await writeAtomicFile(targetPath, text, options);
}
