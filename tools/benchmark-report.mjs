import { performance } from "node:perf_hooks";
import { createReportCsv, parseReportCsv } from "../src/report.js";
import { validExam } from "../tests/fixtures.js";

const RUNS = 7;
const sizes = [1_000, 10_000];
const exam = validExam();

function quantile(sorted, ratio) {
  const index = (sorted.length - 1) * ratio;
  const lower = Math.floor(index);
  const fraction = index - lower;
  return sorted[lower] + ((sorted[lower + 1] ?? sorted[lower]) - sorted[lower]) * fraction;
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return { median: quantile(sorted, 0.5), iqr: quantile(sorted, 0.75) - quantile(sorted, 0.25) };
}

for (const size of sizes) {
  const records = Array.from({ length: size }, (_, index) => ({
    attemptId: `attempt-${index}`,
    submittedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    candidate: { name: `수검자 ${index}`, employeeId: `E${index}`, department: "품질" },
    score: index % 61,
    maxScore: 60,
    items: exam.questions.map((question, questionIndex) => ({ questionId: question.id, status: (index + questionIndex) % 3 ? "correct" : "incorrect", prompt: question.prompt }))
  }));
  const writeTimes = [];
  const readTimes = [];
  let csv = "";
  for (let run = 0; run < RUNS; run += 1) {
    let startedAt = performance.now();
    csv = createReportCsv(exam, records, "2026-06-08T00:00:00.000Z");
    writeTimes.push(performance.now() - startedAt);
    startedAt = performance.now();
    parseReportCsv(csv);
    readTimes.push(performance.now() - startedAt);
  }
  const write = summarize(writeTimes);
  const read = summarize(readTimes);
  const bytes = new TextEncoder().encode(csv).byteLength;
  console.log(`${size}건 | CSV ${bytes} bytes | 생성 중앙값 ${write.median.toFixed(2)}ms (IQR ${write.iqr.toFixed(2)}ms) | 파싱 중앙값 ${read.median.toFixed(2)}ms (IQR ${read.iqr.toFixed(2)}ms)`);
}
