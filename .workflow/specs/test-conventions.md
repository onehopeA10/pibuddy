---
title: "Test Conventions"
readMode: required
priority: high
category: test
keywords:
  - test
  - coverage
  - mock
  - fixture
  - assertion
  - framework
---

# Test Conventions

## Framework

## Directory Structure

## Naming Conventions

## Patterns

## Entries



<spec-entry category="test" keywords="drift,恒真,断言" date="2026-08-04" sid="S-20260804-x79z" title="数据驱动断言必须自钉数据集非空(防恒真)" description="harvest: FIX-capability-core" source="main@5161c4a">

### 数据驱动断言必须自钉数据集非空(防恒真)

数据驱动断言最易失效的方式是数据集为空。drift/结构测试第一组用例必须钉数据集本身:清单非空且每条字段齐,总量用下界钉住(如 toBeGreaterThanOrEqual)。精确计数会随能力增长频繁变红,下界+非空即可防"清单被清空时断言全绿"。实证:capability-drift.spec.ts:141,146,155。

</spec-entry>

<spec-entry category="test" keywords="sealchannelcontracts,恒真,契约分片" date="2026-08-04" sid="S-20260804-jyfh" title="契约分片封口用运行期 seal,不用编译期穷举" description="harvest: FIX-decouple-log-contracts" source="main@5161c4a">

### 契约分片封口用运行期 seal,不用编译期穷举

分片化后 Record<Channel,...> 的编译期穷举保不住;泛型推断一旦退化成宽类型,断言变恒真(本项目反复踩过)。取运行期 sealChannelContracts:拼错名=编译错误,少一条=加载期抛错,后者由对拍(拆掉确认变红)证明。

</spec-entry>