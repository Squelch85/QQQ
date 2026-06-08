import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readProjectFile = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("정적 자원과 홈 링크는 설치 디렉토리 경로에 독립적인 상대 주소를 사용한다", async () => {
  const html = await readProjectFile("index.html");

  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /href="\.\/examples\/inspector-evaluation-exam\.json"/);
  assert.match(html, /src="\.\/src\/app\.js"/);
  assert.match(html, /id="home-link"[^>]+href="#load-view"/);
});

test("기본 시험을 새로 선택하면 이전 누적 결과를 초기화한다", async () => {
  const appSource = await readProjectFile("src/app.js");

  assert.match(appSource, /prepareExam\(defaultExam, \{ resetRecords: true \}\)/);
});
