import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type {
	ExtensionUiComponentFactory,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	Theme,
} from "@oh-my-pi/pi-coding-agent";
import {
	containsWorkflowMagicWord,
	createWorkflowIndicator,
	WORKFLOW_MAGIC_WORD,
	type WorkflowClock,
} from "../../src/ui/indicator.js";

type TUI = Parameters<ExtensionUiComponentFactory>[0];

function stripAnsi(text: string): string {
	return stripVTControlCharacters(text);
}
class FakeClock implements WorkflowClock {
	#time = 0;
	#callbacks = new Map<number, () => void>();
	#nextId = 0;

	now() {
		return this.#time;
	}

	setTime(value: number) {
		this.#time = value;
	}

	setRepeating(callback: () => void, _ms: number) {
		const id = ++this.#nextId;
		this.#callbacks.set(id, callback);
		return id;
	}

	clearRepeating(handle: unknown) {
		this.#callbacks.delete(handle as number);
	}

	tick() {
		for (const cb of this.#callbacks.values()) cb();
	}

	get active() {
		return this.#callbacks.size;
	}
}

class FakeTUI {
	renders = 0;

	requestRender() {
		this.renders++;
	}
}

class FakeUI {
	setWidgetCalls: {
		key: string;
		content: unknown;
		options?: ExtensionWidgetOptions;
	}[] = [];

	setWidget(
		key: string,
		content: ExtensionWidgetContent,
		options?: ExtensionWidgetOptions,
	) {
		this.setWidgetCalls.push({ key, content, options });
	}
}

function setup() {
	const host = new FakeUI();
	const clock = new FakeClock();
	const controller = createWorkflowIndicator(host, {
		key: "test-key",
		clock,
	});
	return { host, clock, controller };
}

const makeTheme = () => ({ getColorMode: () => "truecolor" as const });

describe("WORKFLOW_MAGIC_WORD", () => {
	test("is the expected token", () => {
		expect(WORKFLOW_MAGIC_WORD).toBe("workflowz");
	});
});

describe("containsWorkflowMagicWord", () => {
	test("matches standalone tokens", () => {
		expect(containsWorkflowMagicWord("workflowz")).toBe(true);
		expect(containsWorkflowMagicWord("Run workflowz now")).toBe(true);
		expect(containsWorkflowMagicWord("workflowz!")).toBe(true);
		expect(containsWorkflowMagicWord("(workflowz)")).toBe(true);
	});

	test("rejects embedded, suffixed, or prefixed forms", () => {
		expect(containsWorkflowMagicWord("theworkflowz")).toBe(false);
		expect(containsWorkflowMagicWord("workflowzs")).toBe(false);
		expect(containsWorkflowMagicWord("workflowz123")).toBe(false);
		expect(containsWorkflowMagicWord("abcworkflowzdef")).toBe(false);
		expect(containsWorkflowMagicWord("The WorkflowZ keyword.")).toBe(false);
		expect(containsWorkflowMagicWord("")).toBe(false);
		expect(containsWorkflowMagicWord("a workflowzs b")).toBe(false);
	});
});

describe("createWorkflowIndicator", () => {
	test("show uses belowEditor placement and registers a factory", () => {
		const { host, controller } = setup();
		controller.show(["detail one", "detail two"]);

		expect(host.setWidgetCalls).toHaveLength(1);
		expect(host.setWidgetCalls[0].key).toBe("test-key");
		expect(typeof host.setWidgetCalls[0].content).toBe("function");
		expect(host.setWidgetCalls[0].options).toEqual({
			placement: "belowEditor",
		});
	});

	test("factory produces a component that renders colored lines", () => {
		const { controller, clock } = setup();
		controller.show(["line 1", "line 2"]);

		const tui = new FakeTUI();
		const tuiHandle: unknown = tui;
		const themeHandle: unknown = makeTheme();
		const comp = controller.factory(tuiHandle as TUI, themeHandle as Theme);

		clock.setTime(0);
		const lines = comp.render(80);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("\x1b[");
		expect(lines[1]).toContain("\x1b[");
		expect(lines[2]).toContain("\x1b[");
		expect(stripAnsi(lines[1])).toContain("line 1");
		expect(stripAnsi(lines[2])).toContain("line 2");
	});

	test("rendered output changes with injected clock", () => {
		const { controller, clock } = setup();
		controller.show(["line 1"]);

		const tui = new FakeTUI();
		const tuiHandle: unknown = tui;
		const themeHandle: unknown = makeTheme();
		const comp = controller.factory(tuiHandle as TUI, themeHandle as Theme);

		clock.setTime(0);
		const frame1 = comp.render(80);

		clock.setTime(600);
		const frame2 = comp.render(80);

		expect(frame1[0]).not.toBe(frame2[0]);
		expect(frame1[1]).not.toBe(frame2[1]);
	});

	test("timer calls tui.requestRender on each tick", () => {
		const { controller, clock } = setup();
		controller.show(["d"]);

		const tui = new FakeTUI();
		const tuiHandle: unknown = tui;
		const themeHandle: unknown = makeTheme();
		controller.factory(tuiHandle as TUI, themeHandle as Theme);

		expect(clock.active).toBe(1);
		expect(tui.renders).toBe(0);

		clock.tick();
		expect(tui.renders).toBe(1);

		clock.tick();
		expect(tui.renders).toBe(2);
	});

	test("update changes details and requests a rerender", () => {
		const { controller, clock } = setup();
		controller.show(["original"]);

		const tui = new FakeTUI();
		const tuiHandle: unknown = tui;
		const themeHandle: unknown = makeTheme();
		const comp = controller.factory(tuiHandle as TUI, themeHandle as Theme);

		tui.renders = 0;
		controller.update(["updated"]);

		expect(tui.renders).toBe(1);
		clock.setTime(0);
		expect(stripAnsi(comp.render(80)[1])).toContain("updated");
	});

	test("clear calls setWidget with undefined and disposes the timer", () => {
		const { controller, host, clock } = setup();
		controller.show(["d"]);

		const tui = new FakeTUI();
		const tuiHandle: unknown = tui;
		const themeHandle: unknown = makeTheme();
		controller.factory(tuiHandle as TUI, themeHandle as Theme);
		expect(clock.active).toBe(1);

		controller.clear();

		expect(host.setWidgetCalls).toHaveLength(2);
		expect(host.setWidgetCalls[1].key).toBe("test-key");
		expect(host.setWidgetCalls[1].content).toBeUndefined();
		expect(host.setWidgetCalls[1].options).toEqual({
			placement: "belowEditor",
		});
		expect(clock.active).toBe(0);
	});

	test("dispose clears and stops the timer", () => {
		const { controller, host, clock } = setup();
		controller.show(["d"]);

		const tui = new FakeTUI();
		const tuiHandle: unknown = tui;
		const themeHandle: unknown = makeTheme();
		controller.factory(tuiHandle as TUI, themeHandle as Theme);
		expect(clock.active).toBe(1);

		controller.dispose();

		expect(host.setWidgetCalls.some((c) => c.content === undefined)).toBe(true);
		expect(clock.active).toBe(0);
	});

	test("setWidget is not called on update or timer ticks", () => {
		const { controller, host, clock } = setup();
		controller.show(["d"]);

		const tui = new FakeTUI();
		const tuiHandle: unknown = tui;
		const themeHandle: unknown = makeTheme();
		controller.factory(tuiHandle as TUI, themeHandle as Theme);

		controller.update(["e"]);
		clock.tick();

		expect(host.setWidgetCalls).toHaveLength(1);
	});
});
