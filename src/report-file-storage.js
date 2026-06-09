import { createReportCsv } from "./report.js";

const REPORT_ROOT_DIRECTORY = "exam-reports";

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function sanitizeFileSegment(value, fallback = "unknown") {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 80);
  return normalized || fallback;
}

function candidateIdentity(record) {
  return record.candidate?.employeeId?.trim() || record.candidate?.name?.trim() || record.attemptId || "unknown";
}

export function getCandidateReportFilename(record) {
  const identity = candidateIdentity(record);
  const label = sanitizeFileSegment(record.candidate?.employeeId || record.candidate?.name, "candidate");
  return `${label}-${stableHash(identity)}.csv`;
}

async function getReportRevisionDirectory(storageManager, exam, create) {
  if (!storageManager?.getDirectory) throw new Error("origin_private_file_system_unavailable");
  const root = await storageManager.getDirectory();
  const reports = await root.getDirectoryHandle(REPORT_ROOT_DIRECTORY, { create });
  const examDirectoryName = `${sanitizeFileSegment(exam.id, "exam")}-${stableHash(exam.id)}`;
  const examDirectory = await reports.getDirectoryHandle(examDirectoryName, { create });
  return examDirectory.getDirectoryHandle(`revision-${exam.revision ?? 1}`, { create });
}

async function writeTextFile(directory, filename, contents) {
  const file = await directory.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(contents);
  await writable.close();
}

async function readCandidateIndex(directory) {
  try {
    const handle = await directory.getFileHandle("index.json");
    const file = await handle.getFile();
    const value = JSON.parse(await file.text());
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export async function persistReportFiles(storageManager, exam, records, aggregateCsv = createReportCsv(exam, records)) {
  try {
    const revisionDirectory = await getReportRevisionDirectory(storageManager, exam, true);
    const candidatesDirectory = await revisionDirectory.getDirectoryHandle("candidates", { create: true });
    const latestRecord = records.at(-1);
    if (!latestRecord) return { stored: false, errorType: "empty_records", paths: [] };

    const recordsByCandidate = new Map();
    for (const record of records) {
      const identity = candidateIdentity(record);
      if (!recordsByCandidate.has(identity)) recordsByCandidate.set(identity, []);
      recordsByCandidate.get(identity).push(record);
    }
    const candidateIndex = await readCandidateIndex(candidatesDirectory);
    const candidateWrites = [];
    const writtenCandidatePaths = [];
    for (const candidateRecords of recordsByCandidate.values()) {
      const lastRecord = candidateRecords.at(-1);
      const filename = getCandidateReportFilename(lastRecord);
      if (candidateIndex[filename] === lastRecord.attemptId) continue;
      candidateWrites.push(writeTextFile(candidatesDirectory, filename, createReportCsv(exam, candidateRecords)));
      candidateIndex[filename] = lastRecord.attemptId;
      writtenCandidatePaths.push(filename);
    }
    await Promise.all([
      writeTextFile(revisionDirectory, "all-attempts.csv", aggregateCsv),
      ...candidateWrites
    ]);
    await writeTextFile(candidatesDirectory, "index.json", JSON.stringify(candidateIndex, null, 2));
    const basePath = `${REPORT_ROOT_DIRECTORY}/${sanitizeFileSegment(exam.id, "exam")}-${stableHash(exam.id)}/revision-${exam.revision ?? 1}`;
    return {
      stored: true,
      errorType: null,
      paths: [`${basePath}/all-attempts.csv`, ...writtenCandidatePaths.map((filename) => `${basePath}/candidates/${filename}`)]
    };
  } catch (error) {
    return { stored: false, errorType: error?.message || "file_storage_unavailable", paths: [] };
  }
}

export async function clearReportFiles(storageManager, exam) {
  try {
    const root = await storageManager.getDirectory();
    const reports = await root.getDirectoryHandle(REPORT_ROOT_DIRECTORY);
    const examDirectoryName = `${sanitizeFileSegment(exam.id, "exam")}-${stableHash(exam.id)}`;
    const examDirectory = await reports.getDirectoryHandle(examDirectoryName);
    await examDirectory.removeEntry(`revision-${exam.revision ?? 1}`, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export async function clearAllReportFiles(storageManager) {
  try {
    const root = await storageManager.getDirectory();
    await root.removeEntry(REPORT_ROOT_DIRECTORY, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
