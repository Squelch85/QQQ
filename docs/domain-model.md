# 도메인 모델

## 1. 제품 도메인 개요

도메인은 필기시험 단일 흐름에서 검사원 자격 인증 평가 흐름으로 확장한다. 기존 필기시험 모델은 유지하되, 자격 유형, 평가 계획, 평가 세션, R&R, 교육 이수, 자격 판정, 인증서 이력을 상위 모델로 연결한다.

현재 구현은 필기시험 MVP가 중심이며, 이 문서의 자격 인증 상위 모델과 R&R 모델은 후속 SQLite 전환과 기능 확장의 목표 모델이다.

## 2. 기존 필기시험 모델

| 엔터티 | 주요 속성 | 책임 |
| --- | --- | --- |
| `Exam` | ID, 코드, revision, 제목, 제한 시간, 만점, 합격 기준 | 필기시험 마스터 |
| `Question` | ID, 시험 ID, 유형, 본문, 배점, 순서, 해설 | 응시 문항 정의 |
| `Choice` | ID, 문제 ID, 표시 내용, 순서 | 객관식 선택지 정의 |
| `ScoringRule` | 문제 ID, 정답, 정규화 규칙, 부분 점수 정책 | 문항별 평가 기준 정의 |
| `Attempt` | attemptId, examineeId, assessmentSessionId, examId, 상태 | 한 번의 필기시험 응시 생명주기 |
| `Answer` | attemptId, questionId, 값, 변경 시각 | 제출 전 문제별 현재 답안 |
| `Submission` | attemptId, 제출 시각, answersJson, locked | 제출 시점의 변경 불가능한 답안 스냅샷 |
| `GradeResult` | attemptId, 점수, 만점, 합격 상태, 등급, 문항별 결과 | 필기시험 채점 결과 |

## 3. 자격 인증 상위 모델

| 엔터티 | 주요 속성 | 책임 |
| --- | --- | --- |
| `Examinee` | 사번, 성명, 부서, 직책, 활성 상태 | 응시자와 검사원 기본 정보 |
| `QualificationType` | code, name, description, active | 자격 유형 마스터 |
| `AssessmentPlan` | qualificationTypeId, revision, required flags, passRuleJson | 자격 유형별 필수 평가 계획 |
| `AssessmentSession` | sessionCode, examineeId, qualificationTypeId, assessmentPlanId, status | 한 응시자의 자격 평가 묶음 |
| `CertificationDecision` | sessionId, decision, reason, missingRequirementsJson, approvedBy | 최종 자격 판정 |
| `Certificate` | certId, sessionId, issueDate, expireDate, path, hash, status, issueMode | 인증서 발행·취소·재발행 이력 |
| `AuditLog` | entityType, entityId, action, actor, reason, redactedBeforeJson, redactedAfterJson, metadataJson | 민감 정보를 제거한 주요 변경과 발행 이력 감사 |

`AuditLog`는 답안 원문, 정답, 기준값, 개인정보를 저장하지 않는다. 변경 전후 스냅샷이 필요하면 민감 필드를 제거한 JSON만 저장하고, 재현에 필요한 원본은 entity id와 해시·파일 경로 참조로 연결한다.

`Certificate.issueMode`는 `official`과 `local_only`를 구분한다. `local_only`는 DB 장애 시 생성되는 임시 출력물이며 정식 인증서가 아니다.

## 4. 평가별 모델

### 4.1 `WrittenExamResult`

필기시험 결과는 기존 `GradeResult`를 자격 평가 세션에 연결해 사용한다. 필수 평가 여부와 합격 기준은 `AssessmentPlan`과 `Exam.revision` 기준으로 판정한다.

### 4.2 계수형 R&R 모델

| 엔터티 | 주요 속성 | 책임 |
| --- | --- | --- |
| `AttributeRrSet` | rrSetCode, revision, title, sampleMode, roundCount, criteriaJson | 계수형 R&R 세트 정의 |
| `AttributeRrSample` | rrSetId, sampleCode, sampleMode, imagePath, imageHash, physicalSampleCode, referenceStatus, defectType | 기준 샘플 마스터 |
| `AttributeRrTrial` | trialId, sessionId, rrSetId, sampleId, examineeId, roundNo, judgment, defectType, locked | 검사원 판정 원본 |
| `AttributeRrResult` | totalAgreementRate, okAgreementRate, ngDetectionRate, repeatAgreementRate, type1ErrorRate, type2ErrorRate, finalDecision | 계수형 R&R 산출 결과 |

사진 기반 샘플은 독립 평가가 아니라 `AttributeRrSample.sampleMode=image`로 표현한다. 실물 샘플은 `sampleMode=physical_sample`, 혼합 세트는 `AttributeRrSet.sampleMode=mixed`로 표현한다.

### 4.3 계량형 R&R 모델

| 엔터티 | 주요 속성 | 책임 |
| --- | --- | --- |
| `VariableRrStudy` | studyCode, revision, studyPurpose, measurementItem, unit, instrument, lsl, usl, partCount, trialCount, method, criteriaJson | 계량형 R&R 평가 계획 |
| `VariableMeasurement` | sessionId, studyId, examineeId, partNo, trialNo, measurementValue, locked | 측정 원본 |
| `VariableRrResult` | ev, av, grr, partVariation, totalVariation, percentGrr, ndc, tolerance, percentTolerance, finalDecision | 계량형 R&R 산출 결과 |

`studyPurpose`는 `process_msa`와 `inspector_qualification`을 구분한다. 이번 리뉴얼의 기본 목적은 `inspector_qualification`이다.

### 4.4 교육 이수 모델

| 엔터티 | 주요 속성 | 책임 |
| --- | --- | --- |
| `TrainingRecord` | examineeId, qualificationTypeId, trainingCode, completedAt, hours, evidencePath, verifiedBy, status | 교육 이수와 증빙 충족 여부 |

교육 시간은 점수 항목이 아니라 필수 충족 항목이다.

## 5. SQLite 테이블 초안

SQLite는 원본 저장소다. 핵심 테이블은 다음과 같다.

```text
examinees
qualification_types
assessment_plans
assessment_sessions
exams
attempts
submissions
grade_results
attribute_rr_sets
attribute_rr_samples
attribute_rr_trials
attribute_rr_results
variable_rr_studies
variable_measurements
variable_rr_results
training_records
certification_decisions
certificates
audit_logs
```

### 5.1 필수 필드 요약

- `assessment_plans`: `requires_written_exam`, `requires_attribute_rr`, `requires_variable_rr`, `requires_training`, `attribute_rr_required_mode`, `variable_rr_required_condition`, `pass_rule_json`
- `attribute_rr_results`: `total_agreement_rate`, `ok_agreement_rate`, `ng_detection_rate`, `repeat_agreement_rate`, `type1_error_rate`, `type2_error_rate`, `defect_type_agreement_rate`, `final_decision`
- `variable_rr_results`: `ev`, `av`, `grr`, `part_variation`, `total_variation`, `percent_grr`, `ndc`, `tolerance`, `percent_tolerance`, `final_decision`
- `certificates`: `cert_id`, `certificate_path`, `certificate_hash`, `status`, `issue_mode`, `issued_by`, `issued_at`, `revoked_reason`
- `audit_logs`: `entity_type`, `entity_id`, `action`, `actor`, `reason`, `redacted_before_json`, `redacted_after_json`, `metadata_json`, `created_at`

## 6. 불변 조건

1. 하나의 `Attempt`에는 하나의 `Submission`만 존재한다.
2. 제출 이후 `Submission.answers_json`은 수정하지 않는다.
3. 제출 이후 `AttributeRrTrial.locked=true`인 판정 원본은 수정하지 않는다.
4. 확정 이후 `VariableMeasurement.locked=true`인 측정 원본은 수정하지 않는다.
5. 시험·평가 기준이 변경되면 기존 결과를 수정하지 않고 `revision`을 증가시킨다.
6. 정식 인증서는 `CertificationDecision.decision=approved`일 때만 발행한다.
7. `local_only` 인증서 출력물은 정식 인증서로 조회하거나 승인 이력으로 취급하지 않는다.
8. 인증서 재발행 또는 취소 시 기존 `Certificate` 이력을 삭제하지 않는다.
9. CSV import 또는 export가 있어도 원본 판정 기준은 SQLite에 있다.

## 7. 계수형 R&R 계산 기준

```text
total_agreement_rate = 기준값과 검사원 판정이 일치한 건수 / 전체 판정 건수
ok_agreement_rate = 기준 OK 샘플을 OK로 판정한 건수 / 기준 OK 샘플 판정 건수
ng_detection_rate = 기준 NG 샘플을 NG로 판정한 건수 / 기준 NG 샘플 판정 건수
type1_error_rate = 기준 OK 샘플을 NG로 판정한 건수 / 기준 OK 샘플 판정 건수
type2_error_rate = 기준 NG 샘플을 OK로 판정한 건수 / 기준 NG 샘플 판정 건수
repeat_agreement_rate = 동일 샘플 반복 제시 시 동일 판정을 유지한 비율
defect_type_agreement_rate = NG 판정 중 불량 유형까지 기준과 일치한 비율
```

## 8. 계량형 R&R 계산 기준

초기 구현은 `range` 방식을 우선한다. 산출 결과에는 EV, AV, GRR, Part Variation, Total Variation, %GRR, ndc, 공차 대비 변동을 포함한다. 기준값은 `criteria_json`으로 관리하며 예시는 다음과 같다.

```json
{
  "maxPercentGrrPass": 10,
  "maxPercentGrrConditional": 30,
  "minNdc": 5
}
```

## 9. 인증서 발행 차단 조건

다음 중 하나라도 해당하면 정식 인증서 발행을 차단한다.

- 필수 필기시험 결과 누락 또는 불합격
- 필기시험 항목별 과락 기준 미충족
- 필수 계수형 R&R 결과 누락 또는 기준 미달
- 계측기 사용 검사자의 필수 계량형 R&R 결과 누락 또는 기준 미달
- 필수 교육 기록, 교육 시간, 증빙 누락
- 검토자 승인 누락
- `certification_decision`이 `approved`가 아님
