import { readFile, writeFile } from "node:fs/promises";

const sourceFiles = [
  "src/exam.js",
  "src/grading.js",
  "src/attempt.js",
  "src/converter.js",
  "src/default-exam.js",
  "src/report.js",
  "src/report-storage.js",
  "src/report-file-storage.js",
  "src/app.js"
];
const outputPath = "src/standalone.js";

function convertModuleToClassicScript(source, path) {
  const importsRemoved = source.replace(/^import .*;\r?\n/gm, "");
  const exportsRemoved = importsRemoved.replace(/^export /gm, "");

  if (/^\s*(?:import|export)\s/m.test(exportsRemoved)) {
    throw new Error(`${path}에 변환되지 않은 import/export 문이 있습니다.`);
  }

  return `\n// ---- ${path} ----\n${exportsRemoved.trim()}\n`;
}

const sections = [];
for (const path of sourceFiles) {
  sections.push(convertModuleToClassicScript(await readFile(path, "utf8"), path));
}

const output = `// 이 파일은 npm run build로 생성됩니다. 직접 수정하지 마세요.\n(() => {\n"use strict";\n${sections.join("")}\n})();\n`;
await writeFile(outputPath, output);
console.log(`${outputPath} 생성 완료 (${output.length} bytes)`);
