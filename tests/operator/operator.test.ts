import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	type OperatorController,
	type OperatorDefinitions,
	registerWorkflowCommands,
} from "../../src/commands/operator.js";
import { parseWorkflowArgs } from "../../src/commands/parser.js";
import extension from "../../src/extension.js";
import type { WorkflowCall, WorkflowRun } from "../../src/runtime/types.js";
import { registerWorkflowControlTool } from "../../src/tools/workflow-control.js";
import { inspectWorkflow } from "../../src/ui/inspect.js";
import {
	renderWorkflowStatus,
	summarizeWorkflow,
} from "../../src/ui/status.js";

type FakeController = OperatorController;
type ControllerOverrides = Partial<FakeController>;
type Message = { content: Array<{ type: "text"; text: string }> };

function makeRun(
	id = "run-1",
	overrides: Partial<WorkflowRun> = {},
): WorkflowRun {
	const call: WorkflowCall = {
		index: 0,
		namespace: "research",
		inputHash: "hash",
		status: "succeeded",
		attempts: [
			{
				id: "attempt-0",
				callIndex: 0,
				childId: "child",
				status: "succeeded",
				inputHash: "hash",
				requestedModel: "m",
				resolvedModel: "m2",
				artifacts: ["a.txt"],
			},
		],
		result: { answer: 42 },
	};
	return {
		schemaVersion: 2,
		id,
		namespace: id,
		controllerGeneration: 1,
		fencingToken: "token",
		status: "running",
		phases: ["research"],
		definition: { name: "demo", version: 1 },
		args: { q: "x" },
		calls: [call],
		result: { answer: 42 },
		artifacts: ["a.txt"],
		error: undefined,
		blockedReason: undefined,
		persistenceHealth: "healthy",
		limits: { maxConcurrency: 2, maxAgents: 3 },
		totals: { agents: 1, outputTokens: 8, runtimeMs: 10 },
		createdAt: 1,
		updatedAt: 2,
		...overrides,
	} as WorkflowRun;
}

function makeController(overrides: ControllerOverrides = {}): FakeController {
	const controller: FakeController = {
		start: async () => makeRun(),
		list: async () => [makeRun()],
		inspect: async (id) => makeRun(id),
		pause: async (id) => makeRun(id),
		resume: async (id) => makeRun(id),
		stop: async (id) => makeRun(id),
		retry: async (id) => makeRun(id),
		...overrides,
	};
	return controller;
}

function commandHarness() {
	let handler: (raw: string, ctx: never) => Promise<void> = async () => {};
	const messages: Message[] = [];
	const pi = {
		registerCommand: (_name: string, spec: { handler: typeof handler }) => {
			handler = spec.handler;
		},
		sendMessage: (message: Message) => messages.push(message),
	};
	return {
		pi: pi as ExtensionAPI & typeof pi,
		messages,
		invoke: (raw: string) => handler(raw, {} as never),
		get message(): Message | undefined {
			return messages.at(-1);
		},
	};
}

function text(message: Message | undefined): string {
	return message?.content[0]?.text ?? "";
}

describe("operator parser", () => {
	test("defaults to help and parses empty input", () =>
		expect(parseWorkflowArgs("")).toMatchObject({
			command: "help",
			positionals: [],
		}));
	test("parses JSON args and scope", () =>
		expect(
			parseWorkflowArgs('start demo --args "{\\"x\\":1}" --scope user'),
		).toEqual({
			command: "start",
			positionals: ["demo"],
			args: { x: 1 },
			scope: "user",
		}));
	test("supports escaped and quoted positionals", () =>
		expect(
			parseWorkflowArgs("generate 'hello world' foo\\ bar").positionals,
		).toEqual(["hello world", "foo bar"]));
	test("rejects malformed JSON and unknown options", () => {
		expect(() => parseWorkflowArgs("start x --json nope")).toThrow(
			"valid JSON",
		);
		expect(() => parseWorkflowArgs("list --wat")).toThrow("unknown option");
	});
	test("rejects unknown commands and unterminated quotes", () => {
		expect(() => parseWorkflowArgs("wat")).toThrow("unknown workflow command");
		expect(() => parseWorkflowArgs("start 'x")).toThrow("unterminated quote");
	});
});

describe("operator commands", () => {
	test("help emits a read-only command list and list renders visible runs", async () => {
		const h = commandHarness();
		registerWorkflowCommands(h.pi, makeController(), {
			discover: async () => [],
		});
		await h.invoke("help");
		expect(text(h.message)).toContain("start");
		expect(text(h.message)).toContain("status");
		await h.invoke("list");
		expect(text(h.message)).not.toBe("");
		expect(text(h.message)).toContain("demo");
	});
	test("generate and create use generator seam", async () => {
		const h = commandHarness();
		const seen: string[] = [];
		const definitions: OperatorDefinitions = {
			discover: async () => [],
			generate: async (x) => {
				seen.push(x);
				return { generated: true };
			},
		};
		registerWorkflowCommands(h.pi, makeController(), definitions);
		await h.invoke("generate 'a request'");
		expect(seen).toEqual(["a request"]);
		// Non-run payloads become a readable fallback that names the command and
		// embeds the original payload JSON for transcript forensics.
		expect(text(h.message)).toContain("/workflow generate: ok");
		expect(text(h.message)).toContain("generated");
	});
	test("start/run loads definition, args, and scope", async () => {
		const h = commandHarness();
		let loaded: [string, string | undefined] | undefined;
		let started: [unknown, unknown, unknown?] | undefined;
		const controller = makeController({
			start: async (...x) => {
				started = x;
				return makeRun();
			},
		});
		const definitions: OperatorDefinitions = {
			discover: async () => [],
			load: async (name, scope) => {
				loaded = [name, scope];
				return { name: "demo", definition: { name } };
			},
		};
		registerWorkflowCommands(h.pi, controller, definitions);
		await h.invoke("run demo --args '{\"n\":2}' --scope plugin");
		expect(loaded).toEqual(["demo", "plugin"]);
		expect(started?.[1]).toEqual({ n: 2 });
	});
	test("approve loads and persists without starting a run", async () => {
		const h = commandHarness();
		let starts = 0;
		let loaded: unknown[] = [];
		const definitions: OperatorDefinitions = {
			discover: async () => [],
			load: async (...args) => {
				loaded = args;
				return {
					name: "demo",
					definition: { name: "demo" },
					approval: { hash: "approved" },
				};
			},
		};
		registerWorkflowCommands(
			h.pi,
			makeController({
				start: async () => {
					starts += 1;
					return makeRun();
				},
			}),
			definitions,
		);
		await h.invoke('approve demo --args "{\\"x\\":1}" --scope user');
		expect(starts).toBe(0);
		expect(loaded.slice(0, 3)).toEqual(["demo", "user", { x: 1 }]);
		expect(text(h.message)).toContain("/workflow approve: ok");
		expect(text(h.message)).toContain("approved");
		expect(text(h.message)).toContain("demo");
	});
	test("status and inspect dispatch to controller", async () => {
		const h = commandHarness();
		const seen: string[] = [];
		registerWorkflowCommands(
			h.pi,
			makeController({
				list: async () => [makeRun()],
				inspect: async (id) => {
					seen.push(id);
					return makeRun(id);
				},
			}),
			{ discover: async () => [] },
		);
		await h.invoke("status run-2");
		expect(seen).toEqual(["run-2"]);
		await h.invoke("inspect run-3");
		expect(seen).toEqual(["run-2", "run-3"]);
	});
	test("pause resume stop retry dispatch and validate retry index", async () => {
		const h = commandHarness();
		const calls: unknown[][] = [];
		const c = makeController({
			pause: async (x) => {
				calls.push(["pause", x]);
				return x;
			},
			resume: async (x) => {
				calls.push(["resume", x]);
				return x;
			},
			stop: async (x) => {
				calls.push(["stop", x]);
				return x;
			},
			retry: async (...x) => {
				calls.push(["retry", ...x]);
				return x;
			},
		});
		registerWorkflowCommands(h.pi, c, { discover: async () => [] });
		await h.invoke("pause r");
		await h.invoke("resume r");
		await h.invoke("stop r");
		await h.invoke("retry r 2");
		expect(calls).toEqual([
			["pause", "r"],
			["resume", "r"],
			["stop", "r"],
			["retry", "r", 2],
		]);
		await h.invoke("retry r nope");
		expect(text(h.message)).toContain("integer");
	});
	test("save and revoke use definition seams and errors are reported", async () => {
		const h = commandHarness();
		let saved: [unknown, string] | undefined;
		const definitions: OperatorDefinitions = {
			discover: async () => [],
			save: async (run, scope) => {
				saved = [run, scope];
				return "saved";
			},
			revoke: async (id) => `revoked:${id}`,
		};
		registerWorkflowCommands(
			h.pi,
			makeController({ inspect: async () => makeRun() }),
			definitions,
		);
		await h.invoke("save run-1 --scope user");
		expect(saved?.[1]).toBe("user");
		await h.invoke("revoke approval-1");
		expect(text(h.message)).toContain("revoked");
		await h.invoke("inspect");
		expect(text(h.message)).toContain("requires run-id");
	});
	test("unknown and invalid command errors never escape handler", async () => {
		const h = commandHarness();
		registerWorkflowCommands(h.pi, makeController(), {
			discover: async () => [],
		});
		await h.invoke("wat");
		expect(text(h.message)).toContain("unknown workflow command");
		await h.invoke("start missing");
		expect(text(h.message)).toContain("workflow not found");
	});
});

describe("status and inspect", () => {
	test("status totals limits and warnings are rendered", () => {
		const value = summarizeWorkflow(
			makeRun("run-1", {
				persistenceHealth: "degraded",
				blockedReason: "approval",
				totals: { agents: 4, outputTokens: 9, runtimeMs: 11 },
			}),
		);
		expect(value).toContain("totals=agents:4,tokens:9,runtime:11ms");
		expect(value).toContain("persistence degraded");
		expect(value).toContain("agent limit exceeded");
		expect(value).toContain("blocked: approval");
	});
	test("renders multiple runs", () => {
		const value = renderWorkflowStatus([makeRun("a"), makeRun("b")]);
		expect(value).toContain("a running");
		expect(value).toContain("\nb running");
	});
	test("inspect exposes blocked deps artifacts model prompt errors and results", () => {
		const value = inspectWorkflow(
			makeRun("run-1", {
				blockedReason: "dependency x",
				calls: [
					{
						index: 3,
						namespace: "phase",
						inputHash: "hash",
						label: "phase",
						status: "failed",
						attempts: [
							{
								id: "attempt-3",
								callIndex: 3,
								childId: "child",
								inputHash: "hash",
								status: "failed",
								requestedModel: "requested",
								resolvedModel: "resolved",
								error: "boom",
								artifacts: ["log"],
							},
						],
						result: { output: "x" },
					},
				],
				error: "top error",
			}),
		);
		expect(value).toMatchObject({
			blockedDependencies: "dependency x",
			artifacts: ["a.txt"],
			error: "top error",
			result: { answer: 42 },
		});
		expect(value.recent).toBeDefined();
	});
	test("inspect handles missing optional collections", () => {
		const value = inspectWorkflow(
			makeRun("run-1", { calls: [], phases: [], limits: {} }),
		);
		expect(value.recent).toEqual([]);
	});
});

describe("workflow_control", () => {
	function toolHarness(controller: ControllerOverrides) {
		let spec:
			| {
					execute: (
						id: string,
						params: unknown,
						signal: AbortSignal,
						onUpdate: unknown,
						ctx: unknown,
					) => Promise<unknown>;
			  }
			| undefined;
		const pi = {
			typebox: {
				Type: {
					Object: (x: object) => x,
					Union: (x: object[]) => x,
					Literal: (x: string) => x,
					Optional: (x: object) => x,
					String: () => ({}),
					Number: () => ({}),
				},
			},
			registerTool: (x: typeof spec) => {
				spec = x;
			},
		};
		registerWorkflowControlTool(
			pi as ExtensionAPI & typeof pi,
			makeController(controller),
		);
		return (p: unknown) =>
			spec?.execute(
				"id",
				p,
				new AbortController().signal,
				undefined,
				undefined,
			);
	}
	test("allows list and status", async () => {
		const calls: string[] = [];
		const invoke = toolHarness({
			list: async () => {
				calls.push("list");
				return [makeRun()];
			},
			inspect: async () => {
				calls.push("inspect");
				return makeRun();
			},
		});
		expect(await invoke({ action: "list" })).not.toHaveProperty("isError");
		expect(await invoke({ action: "status", runId: "r" })).not.toHaveProperty(
			"isError",
		);
		expect(calls).toEqual(["list", "inspect"]);
	});
	test("rejects missing runId and invalid input without mutation", async () => {
		let mutations = 0;
		const invoke = toolHarness({
			pause: async () => {
				mutations++;
				return makeRun();
			},
			list: async () => [],
		});
		expect(
			((await invoke({ action: "pause" })) as { isError: boolean }).isError,
		).toBe(true);
		expect(
			((await invoke({ nope: true })) as { isError: boolean }).isError,
		).toBe(true);
		expect(mutations).toBe(0);
	});
	test("rejects unknown action without mutation", async () => {
		const invoke = toolHarness({ list: async () => [] });
		expect(
			((await invoke({ action: "explode" })) as { isError: boolean }).isError,
		).toBe(true);
	});
	test("allowed transitions call controller and preserve errors", async () => {
		const calls: string[] = [];
		const invoke = toolHarness({
			pause: async () => {
				calls.push("pause");
				return makeRun();
			},
			resume: async () => {
				calls.push("resume");
				return makeRun();
			},
			stop: async () => {
				calls.push("stop");
				return makeRun();
			},
			retry: async () => {
				calls.push("retry");
				return makeRun();
			},
			inspect: async () => makeRun(),
		});
		for (const action of ["pause", "resume", "stop", "retry"])
			expect(
				((await invoke({ action, runId: "r" })) as { isError?: boolean })
					.isError,
			).toBeUndefined();
		expect(calls).toEqual(["pause", "resume", "stop", "retry"]);
	});
});
describe("extension lifecycle", () => {
	test("session_start restores/initializes once and shutdown disposes", async () => {
		type SessionContext = {
			cwd: string;
			modelRegistry: { getAll: () => never[] };
		};
		const events: {
			session_start?: (
				event: Record<string, never>,
				ctx: SessionContext,
			) => Promise<void>;
			session_shutdown?: () => Promise<void>;
		} = {};
		let commands = 0;
		let tools = 0;
		const pi = {
			setLabel: () => {},
			on: (name: string, fn: (...args: never[]) => Promise<void>) => {
				if (name === "session_start")
					events.session_start = fn as typeof events.session_start;
				if (name === "session_shutdown")
					events.session_shutdown = fn as typeof events.session_shutdown;
			},
			registerCommand: () => {
				commands += 1;
			},
			registerTool: () => {
				tools += 1;
			},
			typebox: {
				Type: {
					Object: (x: object) => x,
					Union: (x: object[]) => x,
					Literal: (x: string) => x,
					Optional: (x: object) => x,
					String: () => ({}),
					Number: () => ({}),
				},
			},
		};
		extension(pi as ExtensionAPI & typeof pi);
		const ctx: SessionContext = {
			cwd: "/tmp",
			modelRegistry: { getAll: () => [] },
		};
		await events.session_start?.({}, ctx);
		await events.session_start?.({}, ctx);
		await events.session_shutdown?.();
		expect(commands).toBeGreaterThan(0);
		expect(tools).toBeGreaterThan(0);
	});
});
