# 시스템 아키텍처

## 1. 선택 방향

시스템은 온라인 서버 없이 한 실행 단위에서 검사원 자격 인증 평가를 수행하는 **로컬 단일 애플리케이션**으로 구축한다. 최종 원본 저장소는 SQLite이며, CSV는 내보내기·백업·외부 제출용 보조 형식이다.

현재 구현은 필기시험 중심 로컬 웹 MVP다. 이 문서의 목표 모듈과 SQLite 통합 구조는 후속 구현 기준이며, 현재 코드에 모두 존재한다는 뜻이 아니다.

## 2. 현재 구현 구성

| 현재 파일/모듈 | 책임 |
| --- | --- |
| `index.html`, `styles.css` | 필기시험 UI와 결과 화면 |
| `src/app.js` | 화면 상태, 시험 시작, 제출, 결과 표시 흐름 |
| `src/exam.js` | 필기시험 JSON 파싱과 검증 |
| `src/attempt.js` | 필기시험 응시 상태와 제출 스냅샷 |
| `src/grading.js` | 필기시험 채점 순수 함수 |
| `src/converter.js` | 문항 TSV 입력을 시험지 JSON으로 변환 |
| `src/report.js` | 필기시험 리포트 CSV 생성과 집계 |
| `src/report-storage.js`, `src/directory-report-storage.js` | 브라우저 저장소와 디렉터리 기반 CSV 보관 |
| `src/certificate.js`, `src/certificate-ui.js` | 필기시험 결과 기반 인증서 PNG 생성과 표시 |
| `src/result-api.js`, `server.py` | 로컬 HTTP API, SQLite 저장, 인증서 파일 저장 경계 |
| `src/default-exam.js`, `src/standalone.js` | 기본 시험 데이터와 단일 파일 실행 산출물 |

## 3. 목표 논리 구성

```text
[시험/R&R/교육 설정] --> [로컬 자격 인증 애플리케이션] --> [SQLite 원본 DB]
                                      |
                                      |--> [결과 화면/로컬 조회]
                                      |--> [CSV export/import 보조]
                                      |--> [PNG 인증서 + SHA-256 해시]
```

## 4. 목표 모듈

| 목표 모듈 | 책임 | 상태 |
| --- | --- | --- |
| `exam-loader` | 필기시험 JSON 파싱과 스키마 검증 | 기존 구현 기반 |
| `attempt` / `submission` | 필기시험 응시 상태와 제출 스냅샷 관리 | 기존 구현 기반 |
| `grading` | 필기시험 채점 순수 함수 | 기존 구현 기반 |
| `qualification` | 자격 유형, 필수 평가 계획, 평가 세션 관리 | 후속 구현 |
| `attribute-rr` | 계수형 R&R 세트, 샘플, 판정 원본, 결과 계산 | 후속 구현 |
| `variable-rr` | 계량형 R&R 계획, 측정 원본, range 방식 결과 계산 | 후속 구현 |
| `training` | 교육 이수와 증빙 충족 여부 관리 | 후속 구현 |
| `certification` | 발행 가능성 검증, 자격 판정, 인증서 발행 이력 | 후속 구현 |
| `sqlite-store` | SQLite 원본 저장과 조회 경계 | 후속 확장 |
| `csv-io` | CSV import/export 보조 기능과 수식 인젝션 방지 | 기존 리포트 기능에서 전환 |
| `audit-log` | 제출, 계산, 판정, 발행, 취소, 재발행 감사 이력 | 후속 구현 |

도메인 계산 모듈은 UI와 파일 시스템에 직접 의존하지 않는 순수 로직으로 유지한다.

## 5. 데이터 경계

- 제출 전 UI 모델에는 정답, 기준값, 채점 규칙, 샘플 기준 설명을 포함하지 않는다.
- 필기 답안, 계수형 판정값, 계량형 측정값은 제출 또는 확정 시 SQLite에 잠긴 원본으로 저장한다.
- 기존 CSV/브라우저 저장 흐름은 SQLite 전환 전까지의 호환 계층으로 취급하고, 전환 후에는 내보내기·백업 보조 기능으로 제한한다.
- CSV export는 SQLite 원본에서 파생한다.
- CSV import는 계량형 측정값 입력 편의 기능이며, import 후 원본은 SQLite에 저장한다.
- 정식 인증서는 SQLite에 확정된 결과와 자격 판정만 읽어 생성한다.
- 사진 기반 샘플은 `attribute_rr`의 `sampleMode=image`이며, 독립 `image_judgment` 모듈이나 테이블은 만들지 않는다.

## 6. SQLite 저장 구조

초기 스키마는 다음 도메인을 포함한다.

```text
examinees, qualification_types, assessment_plans, assessment_sessions,
exams, attempts, submissions, grade_results,
attribute_rr_sets, attribute_rr_samples, attribute_rr_trials, attribute_rr_results,
variable_rr_studies, variable_measurements, variable_rr_results,
training_records, certification_decisions, certificates, audit_logs
```

DB 파일 기본 위치는 `data/exam_results.sqlite3`로 문서화한다. 백업 파일과 CSV export 파일은 원본이 아니라 운영 편의를 위한 산출물이다.

## 7. 인증서 발행 경계

`certification` 모듈은 `validateCertificationReadiness()`로 필수 평가와 증빙을 확인한다. 미충족 항목이 있으면 정식 인증서 발행 UI와 PNG 생성 흐름을 모두 차단한다.

DB 장애 시 브라우저에서 생성되는 `LOCAL_ONLY` 출력물은 정식 인증서가 아니다. 이 출력물은 임시 확인용이며 중앙 조회, 감사 이력, 정식 인증서 ID를 보장하지 않는다. DB가 복구되면 SQLite에 확정된 결과와 승인 이력을 기준으로 정식 인증서를 재발행해야 한다.

## 8. 배포와 확장 제한

온라인 서버, 계정 시스템, 실시간 동기화, 실시간 감독은 추가하지 않는다. 실제 병목이 확인되기 전에는 IndexedDB 전환, 캐시, 병렬화, 복잡한 상태관리 도입을 하지 않는다.
