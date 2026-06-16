# ADR 0003: 자격 인증 평가 모델 확정

- 상태: 승인
- 날짜: 2026-06-16

## 배경

기존 필기시험 중심 모델은 검사원 자격 인증에 필요한 R&R 결과, 교육 증빙, 승인 이력, 인증서 발행 차단 조건을 표현하기 어렵다.

## 결정

평가 유형은 `written_exam`, `attribute_rr`, `variable_rr`, `training_verification` 네 가지로 확정한다. 자격 유형별 `AssessmentPlan`은 필수 평가와 조건부 필수 평가를 정의하고, `AssessmentSession`은 한 응시자의 자격 인증 평가 묶음을 표현한다. 인증서는 `CertificationDecision.decision=approved`인 경우에만 발행한다.

## 결과

자격 인증은 단순 점수 기준이 아니라 필수 평가와 증빙 충족 기준으로 판정한다. 누락 항목은 `missing_requirements_json`과 차단 사유로 남긴다.
