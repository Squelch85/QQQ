# ADR 0005: 계량형 R&R 초기 계산 방식

- 상태: 승인
- 날짜: 2026-06-16

## 배경

검사원 자격 인증 목적의 계량형 R&R은 EV, AV, GRR, %GRR, ndc를 일관되게 계산해야 한다. 초기 구현에서 복잡한 ANOVA 방식을 먼저 도입하면 검증 범위가 커진다.

## 결정

초기 구현은 `range` 방식을 우선 적용하고 계산 공식과 고정 테스트 벡터를 문서화한다. `VariableRrStudy.method`에는 `range`와 `anova`를 둘 수 있으나, `anova`는 후속 확장으로 둔다.

## 결과

계량형 R&R 계산은 순수 함수 `calculateVariableRrResult(measurements, studyPlan, criteria)`로 구현한다. 산출 결과는 EV, AV, GRR, Part Variation, Total Variation, %GRR, ndc, 공차 대비 변동, 최종 판정을 포함한다.
