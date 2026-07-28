import { describe, expect, test } from "bun:test";
import { DEFAULT_UI_MODE, resolveUiMode } from "../../src/ui/mode.js";

class InMemoryConfigSource {
	constructor(private readonly value: unknown) {}
	async readConfig(_home: string): Promise<unknown> {
		return this.value;
	}
}

class ThrowingConfigSource {
	constructor(private readonly message: string) {}
	async readConfig(_home: string): Promise<unknown> {
		throw new Error(this.message);
	}
}

describe("resolveUiMode", () => {
	test("absent config defaults to operator with no warning", async () => {
		const result = await resolveUiMode({
			source: new InMemoryConfigSource(undefined),
		});
		expect(result.mode).toBe(DEFAULT_UI_MODE);
		expect(result.source).toBe("default");
		expect(result.warnings).toEqual([]);
	});

	test('config { "ui": "operator" } returns operator without warning', async () => {
		const result = await resolveUiMode({
			source: new InMemoryConfigSource({ ui: "operator" }),
		});
		expect(result.mode).toBe("operator");
		expect(result.source).toBe("config");
		expect(result.warnings).toEqual([]);
	});

	test('config { "ui": "dashboard" } returns dashboard without warning', async () => {
		const result = await resolveUiMode({
			source: new InMemoryConfigSource({ ui: "dashboard" }),
		});
		expect(result.mode).toBe("dashboard");
		expect(result.source).toBe("config");
		expect(result.warnings).toEqual([]);
	});

	test("unknown string falls back to operator with concise warning", async () => {
		const result = await resolveUiMode({
			source: new InMemoryConfigSource({ ui: "neon" }),
		});
		expect(result.mode).toBe("operator");
		expect(result.source).toBe("fallback");
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("ui");
		expect(result.warnings[0]).toContain("operator");
	});

	test("non-string ui value falls back with concise warning", async () => {
		const result = await resolveUiMode({
			source: new InMemoryConfigSource({ ui: 42 }),
		});
		expect(result.mode).toBe("operator");
		expect(result.source).toBe("fallback");
		expect(result.warnings[0]).toContain('"operator" or "dashboard"');
	});

	test("array at top level falls back with concise warning", async () => {
		const result = await resolveUiMode({
			source: new InMemoryConfigSource(["operator"]),
		});
		expect(result.mode).toBe("operator");
		expect(result.source).toBe("fallback");
		expect(result.warnings[0]).toContain("JSON object");
	});

	test("unknown keys alongside ui do not change selected mode but surface a warning", async () => {
		const result = await resolveUiMode({
			source: new InMemoryConfigSource({ ui: "dashboard", theme: "neon" }),
		});
		expect(result.mode).toBe("dashboard");
		expect(result.source).toBe("fallback");
		expect(result.warnings[0]).toContain("ignores unknown keys");
		expect(result.warnings[0]).toContain("theme");
	});

	test("io failure falls back to operator with concise warning", async () => {
		const result = await resolveUiMode({
			source: new ThrowingConfigSource("unreadable config: EACCES"),
		});
		expect(result.mode).toBe("operator");
		expect(result.source).toBe("fallback");
		expect(result.warnings[0]).toContain("failed to read");
	});
});
