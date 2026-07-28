import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function atomicWrite(
	file: string,
	data: string | Uint8Array,
): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const temp = `${file}.tmp-${randomUUID()}`;
	const handle = await fs.open(temp, "wx");
	try {
		await handle.writeFile(data);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await fs.copyFile(file, `${file}.bak`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await fs.rename(temp, file);
	// Windows does not support fsync on directory handles; the atomic rename
	// above remains the strongest available durability boundary there.
	if (process.platform === "win32") return;
	const dir = await fs.open(path.dirname(file), "r");
	try {
		await dir.sync();
	} finally {
		await dir.close();
	}
}
export async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}
export type JsonSource = "primary" | "backup" | "missing" | "corrupt";
export async function readJsonWithBackup<T>(
	file: string,
): Promise<{ value?: T; source: JsonSource }> {
	let primaryError: unknown;
	try {
		return {
			value: JSON.parse(await fs.readFile(file, "utf8")) as T,
			source: "primary",
		};
	} catch (error) {
		primaryError = error;
	}
	try {
		return {
			value: JSON.parse(await fs.readFile(`${file}.bak`, "utf8")) as T,
			source: "backup",
		};
	} catch (error) {
		const primaryCode = (primaryError as NodeJS.ErrnoException)?.code;
		const backupCode = (error as NodeJS.ErrnoException)?.code;
		return {
			source:
				primaryCode === "ENOENT" && backupCode === "ENOENT"
					? "missing"
					: "corrupt",
		};
	}
}
