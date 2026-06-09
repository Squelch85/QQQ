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

test("시험 기록은 기본 보존하고 명시적으로 백업·삭제할 수 있다", async () => {
  const [html, appSource] = await Promise.all([readProjectFile("index.html"), readProjectFile("src/app.js")]);

  assert.match(appSource, /prepareExam\(defaultExam\)/);
  assert.match(appSource, /backupAndClearCurrentHistory/);
  assert.match(appSource, /clearExamReportRecords\(reportStorage, exam\.id, exam\.revision\)/);
  assert.match(appSource, /clearAllExamReportRecords/);
  assert.match(html, /CSV 백업 후 현재 기록 삭제/);
  assert.match(html, /전체 시험 기록 삭제/);
});

test("누적 리포트는 응시자별 디렉터리 자동 저장과 수동 저장을 지원한다", async () => {
  const [html, appSource, directorySource] = await Promise.all([
    readProjectFile("index.html"),
    readProjectFile("src/app.js"),
    readProjectFile("src/directory-report-storage.js")
  ]);

  assert.match(html, /id="report-file" type="file" accept="text\/csv,\.csv"/);
  assert.match(html, /누적 리포트 CSV 다시 저장/);
  assert.match(html, /응시자별 누적 CSV를 저장 창 없이 갱신/);
  assert.match(html, /id="select-directory-button"/);
  assert.match(appSource, /showDirectoryPicker\(\{ id: "candidate-reports", mode: "readwrite" \}\)/);
  assert.match(appSource, /writeCandidateReport\(reportDirectoryHandle, exam, reportState\.records, candidate\)/);
  assert.doesNotMatch(appSource, /storeResult\(result\);\s+downloadReport/);
  assert.match(directorySource, /queryPermission\(\{ mode: "readwrite" \}\)/);
  assert.match(directorySource, /createWritable\(\)/);
  assert.match(appSource, /parseReportCsv\(await file\.text\(\)\)/);
  assert.match(appSource, /type: "text\/csv;charset=utf-8"/);
  assert.doesNotMatch(appSource, /showSaveFilePicker/);
});

test("현재 시험과 답안 상태는 홈 이동 후에도 유지하고 명시적 시험 로드 때만 교체한다", async () => {
  const [html, appSource] = await Promise.all([readProjectFile("index.html"), readProjectFile("src/app.js")]);

  assert.match(html, /id="resume-exam-button"/);
  assert.match(appSource, /function navigateHome\(\)[\s\S]+showView\("load-view"\);/);
  assert.doesNotMatch(appSource, /function navigateHome\(\)[\s\S]*?exam = publicExam = attempt/);
  assert.match(appSource, /function resumeExam\(\)[\s\S]+renderQuestion\(currentQuestionIndex\)/);
  assert.match(appSource, /function prepareExam\(nextExam\)[\s\S]+attempt = new Attempt\(exam\)/);
});
