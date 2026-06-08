import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (path) => readFile(resolve(projectRoot, path), "utf8");

test("정적 자원과 홈 링크는 설치 디렉토리 경로에 독립적인 상대 주소를 사용한다", async () => {
  const html = await readProjectFile("index.html");

  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /href="\.\/examples\/inspector-evaluation-exam\.json"/);
  assert.match(html, /src="\.\/src\/standalone\.js"/);
  assert.doesNotMatch(html, /<script[^>]+type="module"/);
  assert.match(html, /id="home-link"[^>]+href="#load-view"/);
});

test("직접 파일로 열 수 있는 스크립트는 모든 모듈 소스를 포함하며 다시 생성해도 동일하다", async () => {
  const before = await readProjectFile("src/standalone.js");

  await execFileAsync(process.execPath, ["tools/build-standalone.mjs"], { cwd: projectRoot });
  const after = await readProjectFile("src/standalone.js");

  assert.equal(after, before);
  assert.doesNotMatch(after, /^\s*(?:import|export)\s/m);
  assert.match(after, /const defaultExam =/);
  assert.match(after, /document\.getElementById\("default-exam-button"\)/);
  await stat(resolve(projectRoot, "src/standalone.js"));
});

test("시험을 다시 선택해도 이전 인원별 결과를 유지한다", async () => {
  const appSource = await readProjectFile("src/app.js");

  assert.match(appSource, /prepareExam\(defaultExam\)/);
  assert.doesNotMatch(appSource, /clearExamReportRecords|resetRecords/);
});

test("누적 리포트는 CSV 파일로 저장하고 불러온다", async () => {
  const [html, appSource] = await Promise.all([readProjectFile("index.html"), readProjectFile("src/app.js")]);

  assert.match(html, /id="report-file" type="file" accept="text\/csv,\.csv"/);
  assert.match(html, /누적 리포트 CSV 다시 저장/);
  assert.match(html, /최신 누적 CSV도 자동 저장/);
  assert.match(appSource, /const records = storeResult\(result\);\s+downloadReport\(records\);\s+renderResult\(result, records\);/);
  assert.match(appSource, /createReportCsv\(exam, records\)/);
  assert.match(appSource, /parseReportCsv\(await file\.text\(\)\)/);
  assert.match(appSource, /type: "text\/csv;charset=utf-8"/);
});
