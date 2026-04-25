import { describe, expect, test } from "vitest";
import { mergeTexts } from "./text-merge";

describe("mergeTexts", () => {
	test("preserves local and remote inserts", () => {
		const result = mergeTexts({
			base: "hello",
			local: "hello local",
			remote: "hello remote",
			localClientId: "b-client",
			remoteClientId: "a-client",
		});

		expect(result.text).toBe("hello remote local");
	});

	test("preserves base deletions while keeping inserts", () => {
		const result = mergeTexts({
			base: "abc",
			local: "ac",
			remote: "abXc",
			localClientId: "local",
			remoteClientId: "remote",
		});

		expect(result.text).toBe("aXc");
	});

	test("treats concurrent replacements as delete plus both payloads", () => {
		const result = mergeTexts({
			base: "middle",
			local: "left",
			remote: "right",
			localClientId: "b-client",
			remoteClientId: "a-client",
		});

		expect(result.text).toBe("rightleft");
	});

	test("handles repeated characters deterministically", () => {
		const result = mergeTexts({
			base: "aaaa",
			local: "aa",
			remote: "aXaaa",
			localClientId: "local",
			remoteClientId: "remote",
		});

		expect(result.text).toBe("aXa");
	});

	test("keeps large markdown additions from both sides", () => {
		const base = "# Title\n\n- one\n- two\n";
		const local = `${base}\n## Local\nLocal note\n`;
		const remote = `${base}\n## Remote\nRemote note\n`;
		const result = mergeTexts({
			base,
			local,
			remote,
			localClientId: "desktop",
			remoteClientId: "phone",
		});

		expect(result.text).toContain("## Local");
		expect(result.text).toContain("## Remote");
	});

	test("returns unchanged for pure no-op", () => {
		const result = mergeTexts({
			base: "same",
			local: "same",
			remote: "same",
			localClientId: "local",
			remoteClientId: "remote",
		});

		expect(result).toEqual({
			text: "same",
			changed: false,
			usedFallbackBackup: false,
		});
	});
});
