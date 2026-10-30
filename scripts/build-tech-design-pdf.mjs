#!/usr/bin/env node

/**
 * Generates tech-design documents as PDF + DOCX:
 * - All numbered sections (01-16) → single "tech-design" document
 * - Every other file → individual document
 *
 * Mermaid diagrams rendered, code syntax highlighted.
 *
 * Usage: node scripts/build-tech-design-pdf.mjs
 * Requires: pandoc (brew install pandoc)
 * On GitHub Actions, `npm ci` skips Puppeteer's browsers (see .puppeteerrc.cjs); set
 * PUPPETEER_SKIP_DOWNLOAD=false before installing, or run `npx puppeteer browsers install chrome`
 * and `npx puppeteer browsers install chrome-headless-shell` from the repo root afterwards.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { tmpdir } from "os";
import { execFileSync, execSync } from "child_process";
import { mdToPdf } from "md-to-pdf";

const ROOT = join(import.meta.dirname, "..");
const DESIGN_DIR = join(ROOT, "docs/tech-design");
const OUT_DIR = join(ROOT, "docs/tech-design-output");
const MMDC = join(ROOT, "node_modules/.bin/mmdc");

// --- Check pandoc ---
try {
	execSync("which pandoc", { stdio: "ignore" });
} catch {
	console.error(
		[
			"❌ pandoc is required but not found.",
			"",
			"Install it:",
			"  brew install pandoc      # macOS",
			"  sudo apt install pandoc  # Ubuntu/Debian",
			"  choco install pandoc     # Windows",
			"",
			"See https://pandoc.org/installing.html for other options.",
		].join("\n"),
	);
	process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

const allFiles = readdirSync(DESIGN_DIR)
	.filter((f) => f.endsWith(".md"))
	.sort();

// Group: numbered files together, everything else individual
const numbered = allFiles.filter((f) => /^\d/.test(f));
const others = allFiles.filter((f) => !/^\d/.test(f));

/** @type {{ name: string, files: string[] }[]} */
const documents = [
	{ name: "tech-design", files: numbered },
	...others.map((f) => ({ name: f.replace(/\.md$/, ""), files: [f] })),
];

console.log(`${documents.length} documents to generate (${numbered.length} numbered sections combined, ${others.length} individual)`);

// --- Mermaid ---
const tmpDir = mkdtempSync(join(tmpdir(), "blocks-mermaid-"));
let diagramCount = 0;

function renderMermaid(src, format) {
	const id = diagramCount++;
	const ext = format === "pngb64" ? "png" : format;
	const inFile = join(tmpDir, `${id}.mmd`);
	const outFile = join(tmpDir, `${id}.${ext}`);
	writeFileSync(inFile, src);
	try {
		execFileSync(MMDC, ["-i", inFile, "-o", outFile, "-b", "white", "-s", "3", "--quiet"], {
			timeout: 30_000,
		});
		return outFile;
	} catch {
		console.warn(`⚠️  Mermaid render failed for block ${id}`);
		return null;
	}
}

function replaceMermaid(md, format) {
	return md.replace(/```mermaid\n([\s\S]*?)```/g, (match, diagram) => {
		const result = renderMermaid(diagram.trim(), format);
		if (!result) return match;
		if (format === "pngb64") {
			const b64 = readFileSync(result).toString("base64");
			return `\n<img src="data:image/png;base64,${b64}" style="max-width:100%">\n`;
		}
		return `\n![diagram](${result})\n`;
	});
}

const PDF_CSS = `
	body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 7.5pt; line-height: 1.4; color: #24292e; }
	h1 { font-size: 14pt; border-bottom: 1px solid #e1e4e8; padding-bottom: 3px; margin-top: 24px; }
	h2 { font-size: 11pt; border-bottom: 1px solid #eaecef; padding-bottom: 2px; margin-top: 16px; }
	h3 { font-size: 9pt; margin-top: 12px; }
	h4 { font-size: 8pt; margin-top: 10px; }
	code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 6pt; }
	pre { background: #f6f8fa; border-radius: 3px; padding: 6px 8px; overflow-x: auto; line-height: 1.3; }
	pre code { background: none; font-size: 6pt; }
	table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 7pt; }
	th, td { border: 1px solid #dfe2e5; padding: 3px 6px; text-align: left; }
	th { background: #f6f8fa; font-weight: 600; }
	blockquote { border-left: 2px solid #dfe2e5; color: #6a737d; margin: 8px 0; padding: 0 10px; }
	.page-break { page-break-after: always; }
	img { max-width: 100%; height: auto; }
	p { margin: 4px 0; }
	li { margin: 1px 0; }
	ul, ol { padding-left: 18px; }
`;

const PDF_OPTIONS = {
	format: "A4",
	margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
	printBackground: true,
	displayHeaderFooter: true,
	headerTemplate: `<span></span>`,
	footerTemplate: `
		<div style="width:100%;text-align:center;font-size:7px;color:#aaa;padding:0 12mm;">
			AWS Blocks – Technical Design
			<span style="float:right"><span class="pageNumber"></span>/<span class="totalPages"></span></span>
		</div>`,
};

for (const doc of documents) {
	const label = doc.name;

	// PDF (mermaid as base64 PNG)
	const pdfContent = doc.files
		.map((f) => replaceMermaid(readFileSync(join(DESIGN_DIR, f), "utf-8"), "pngb64"))
		.join('\n\n<div class="page-break"></div>\n\n');

	const pdf = await mdToPdf(
		{ content: pdfContent },
		{ launch_options: { args: ["--no-sandbox"] }, css: PDF_CSS, pdf_options: PDF_OPTIONS },
	);

	if (pdf.content) {
		writeFileSync(join(OUT_DIR, `${label}.pdf`), pdf.content);
	}

	// DOCX (mermaid as PNG)
	const docxContent = doc.files
		.map((f) => replaceMermaid(readFileSync(join(DESIGN_DIR, f), "utf-8"), "png"))
		.join("\n\n\\newpage\n\n");

	const mdFile = join(tmpDir, `${label}.md`);
	writeFileSync(mdFile, docxContent);

	execFileSync(
		"pandoc",
		[
			mdFile,
			"-o",
			join(OUT_DIR, `${label}.docx`),
			"--from=markdown",
			"--syntax-highlighting=kate",
			...(doc.files.length > 1 ? ["--toc", "--toc-depth=2", "-M", "toc-title="] : []),
			"--reference-doc=" + join(ROOT, "scripts/reference.docx"),
			"--lua-filter=" + join(ROOT, "scripts/full-width-images.lua"),
		],
		{ timeout: 120_000 },
	);

	console.log(`✅ ${label} (${doc.files.length} section${doc.files.length > 1 ? "s" : ""})`);
}

rmSync(tmpDir, { recursive: true, force: true });
console.log(`\nDone. ${documents.length * 2} files in ${OUT_DIR}`);
