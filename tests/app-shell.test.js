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

test("시험 결과는 CSV 자동 저장 없이 SQLite API에 저장한다", async () => {
  const [html, appSource] = await Promise.all([readProjectFile("index.html"), readProjectFile("src/app.js")]);

  assert.match(appSource, /prepareExam\(defaultExam\)/);
  assert.match(appSource, /await saveExamResult\(candidate, result, exam\)/);
  assert.match(appSource, /await uploadCertificate\(saved\.cert_id, png\)/);
  assert.doesNotMatch(appSource, /writeCandidateReport/);
  assert.doesNotMatch(html, /자동 저장 디렉터리 선택/);
  assert.match(html, /SQLite DB에 저장/);
});

test("인증 검증과 관리자 검색·재발행·취소·CSV 내보내기를 제공한다", async () => {
  const [html, appSource, apiSource] = await Promise.all([
    readProjectFile("index.html"),
    readProjectFile("src/app.js"),
    readProjectFile("src/result-api.js")
  ]);

  assert.match(html, /id="verify-form"/);
  assert.match(html, /id="admin-search-form"/);
  assert.match(html, /조회 조건 CSV 내보내기/);
  assert.match(appSource, /verifyCertificate/);
  assert.match(appSource, /cancelCertificate/);
  assert.match(appSource, /createCertificatePng\(record, url\)/);
  assert.match(apiSource, /\/api\/results\.csv/);
});

test("결과 화면은 인증서 미리보기, 메타데이터, 분리된 열기·저장 동작을 제공한다", async () => {
  const [html, appSource] = await Promise.all([readProjectFile("index.html"), readProjectFile("src/app.js")]);

  assert.match(html, /id="certificate-preview"/);
  assert.match(html, /id="certificate-id"/);
  assert.match(html, /id="certificate-path"/);
  assert.match(html, /id="certificate-hash"/);
  assert.match(html, /id="certificate-open-button"[^>]*>원본 PNG 열기/);
  assert.match(html, /id="certificate-download-button"[^>]*>PNG 저장/);
  assert.match(appSource, /certificatePreviewUrl = URL\.createObjectURL\(blob\)/);
  assert.match(appSource, /image\.src = certificatePreviewUrl/);
  assert.match(appSource, /URL\.revokeObjectURL\(url\)/);
  assert.match(appSource, /const png = await createCertificatePng\(saved, verificationUrl\);[\s\S]+showCertificatePreview\(saved, png\);[\s\S]+uploadCertificate\(saved\.cert_id, png\)/);
});

test("관리자 재발행은 기존 인증 ID를 검증하고 새 PNG 미리보기를 갱신한다", async () => {
  const [html, appSource] = await Promise.all([readProjectFile("index.html"), readProjectFile("src/app.js")]);

  assert.match(html, /id="admin-certificate-preview"/);
  assert.match(html, /id="admin-certificate-reissued-at"/);
  assert.match(appSource, /const originalCertId = record\.cert_id/);
  assert.match(appSource, /uploadCertificate\(originalCertId, png\)/);
  assert.match(appSource, /saved\.cert_id !== originalCertId/);
  assert.match(appSource, /adminCertificatePreviewUrl = URL\.createObjectURL\(png\)/);
  assert.match(appSource, /saved\.cert_status === "CANCELLED"/);
});

test("현재 시험과 답안 상태는 홈 이동 후에도 유지하고 명시적 시험 로드 때만 교체한다", async () => {
  const [html, appSource] = await Promise.all([readProjectFile("index.html"), readProjectFile("src/app.js")]);

  assert.match(html, /id="resume-exam-button"/);
  assert.match(appSource, /function navigateHome\(\)[\s\S]+showView\("load-view"\);/);
  assert.doesNotMatch(appSource, /function navigateHome\(\)[\s\S]*?exam = publicExam = attempt/);
  assert.match(appSource, /function resumeExam\(\)[\s\S]+renderQuestion\(currentQuestionIndex\)/);
  assert.match(appSource, /function prepareExam\(nextExam\)[\s\S]+attempt = new Attempt\(exam\)/);
});
