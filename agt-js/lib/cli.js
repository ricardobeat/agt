// Interactive CLI helpers.

import { generate } from "memorable-ids";
import pc from "picocolors";

const buildPatterns = [
	{
		match: /^(#\d+)\s+(CACHED)$/,
		fmt: (m) => `${pc.gray(m[1])} ${pc.green(m[2])}`,
	},
	{
		match: /^(#\d+)\s+(DONE\s+.*)$/,
		fmt: (m) => `${pc.gray(m[1])} ${pc.green(m[2])}`,
	},
	{
		match: /^(#\d+)\s+(\[.*?\])\s+(.*)$/,
		fmt: (m) => `${pc.gray(m[1])} ${pc.cyan(m[2])} ${pc.bold(m[3])}`,
	},
	{
		match: /^(#\d+)\s+(exporting .*)$/,
		fmt: (m) => `${pc.gray(m[1])} ${pc.yellow(m[2])}`,
	},
	{
		match: /^(#\d+)\s+(sending .*)$/,
		fmt: (m) => `${pc.gray(m[1])} ${pc.yellow(m[2])}`,
	},
	{ match: /^(#\d+)\s+(.*)$/, fmt: (m) => `${pc.gray(m[1])} ${m[2]}` },
];

export function colorizeBuildLine(line) {
	for (const { match, fmt } of buildPatterns) {
		const m = line.match(match);
		if (m) return fmt(m);
	}
	return line;
}

export async function promptBranchName() {
	const {
		createCliRenderer,
		InputRenderable,
		InputRenderableEvents,
		TextRenderable,
	} = await import("@opentui/core");

	const defaultName = generate({ components: 2 });
	const renderer = await createCliRenderer();

	const label = new TextRenderable(renderer, {
		id: "label",
		content: `${pc.bold("Branch name")} ${pc.dim(`(${defaultName})`)} `,
	});

	const input = new InputRenderable(renderer, {
		id: "branch-input",
		width: 30,
		value: "",
		placeholder: defaultName,
		focusable: true,
	});

	label.position = "relative";
	input.position = "relative";
	renderer.root.flexDirection = "row";
	renderer.root.add(label);
	renderer.root.add(input);
	input.focus();

	return new Promise((resolve) => {
		input.on(InputRenderableEvents.ENTER, () => {
			const value = input.plainText.trim() || defaultName;
			renderer.destroy();
			resolve(value);
		});
	});
}
