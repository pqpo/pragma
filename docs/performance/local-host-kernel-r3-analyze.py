"""Rebuild R3 comparison statistics from an external serial-measurement archive."""
import json
import math
import sys
from pathlib import Path

if len(sys.argv) != 2:
    raise SystemExit('Usage: python3 ' + Path(__file__).name + ' <external-sample-directory>')
DATA = Path(sys.argv[1]).expanduser().resolve()
if DATA.is_relative_to(Path(__file__).resolve().parents[2]):
    raise SystemExit('Use a sample directory outside the repository.')

def read(name):
    return json.loads((DATA / name).read_text())

def statistics(values):
    ordered = sorted(values)
    return {'samples': len(values), 'p50': ordered[math.ceil(len(values) * .5) - 1] if len(values) >= 20 else None,
            'p95': ordered[math.ceil(len(values) * .95) - 1] if len(values) >= 20 else None}

def triggered(a, b):
    return a is not None and b is not None and b - a > 20 and b > a * 1.1

def metrics(operations, group=None):
    result = {name: [] for name in ['preparation', 'fixtureCompletionToCoreTerminal', 'coreTerminalToHostStatus', 'activeBindingReleaseToNextDispatch']}
    previous = {}
    for operation in operations:
        markers = {m['event']: m['atMs'] for m in operation['lifecycleMarkers']}
        if group is None or operation['group'] == group:
            result['preparation'].append(operation['preparationMs'])
            for name, start, end in [('fixtureCompletionToCoreTerminal', 'fixture.model_completed', 'execution.terminal_committed'),
                                     ('coreTerminalToHostStatus', 'execution.terminal_committed', 'fixture.mission_status_published')]:
                if start in markers and end in markers:
                    result[name].append(markers[end] - markers[start])
            start = previous.get(operation['missionId'], {}).get('session.active_binding_released')
            end = markers.get('fixture.dispatch')
            if start is not None and end is not None and end >= start:
                result['activeBindingReleaseToNextDispatch'].append(end - start)
        previous[operation['missionId']] = markers
    return {k: statistics(v) for k, v in result.items()}

summary = {'baseCommit': read('main-source-before.json')['commit'], 'candidateCodeCommit': read('r3-source-before.json')['commit'],
           'threshold': 'candidate P95 > main P95 * 1.1 AND difference > 20ms', 'groups': [], 'resamples': [], 'sourceIdentity': {}}
for side in ['main', 'r3']:
    before, after = read(f'{side}-source-before.json'), read(f'{side}-source-after.json')
    assert before['sha256'] == after['sha256']
    summary['sourceIdentity'][side] = {'before': before, 'after': after, 'unchanged': True}
for repeat in [1, 2]:
    documents = {side: read(f'{side}-compile-{repeat}.json') for side in ['main', 'r3']}
    for document in documents.values():
        assert document['completeProbePassed'] and document['sourceUnchanged'] and not document['errors']
    groups = list(dict.fromkeys(o['group'] for o in documents['main']['operations']))
    record = {'repeat': repeat, 'aggregate': {s: metrics(d['operations']) for s, d in documents.items()}, 'scenarios': [], 'storage': [], 'preparation': []}
    for group in groups:
        item = {'scenario': group, **{s: metrics(d['operations'], group) for s, d in documents.items()}}
        item['triggered'] = [k for k in item['main'] if triggered(item['main'][k]['p95'], item['r3'][k]['p95'])]
        record['scenarios'].append(item)
    for kind in ['storage', 'preparation']:
        sides = {side: read(f'{side}-{kind}-{repeat}.json')['results'] for side in ['main', 'r3']}
        for a, b in zip(sides['main'], sides['r3']):
            assert a['history'] == b['history']
            names = ['commitLatencyMs', 'readLatencyMs'] if kind == 'storage' else ['foregroundFourOwnerReadDuringPreparation', 'convertedOwnerRead']
            item = {'history': a['history'], 'main': a, 'r3': b,
                    'triggered': [k for k in names if triggered(a[k]['p95'], b[k]['p95'])]}
            if kind == 'storage':
                assert a['canonicalDelivery'] == b['canonicalDelivery'] and a['owners'] == b['owners']
            record[kind].append(item)
    summary['groups'].append(record)
for scenario, label in [('cold', 'cold'), ('model-invalidation', 'model')]:
    for repeat in [1, 2]:
        sides = {s: read(f'{s}-{label}-resample-{repeat}.json') for s in ['main', 'r3']}
        for d in sides.values():
            assert d['completeProbePassed'] and d['sourceUnchanged'] and not d['errors']
        item = {'scenario': scenario, 'repeat': repeat, **{s: metrics(d['operations'], scenario) for s, d in sides.items()}}
        item['triggered'] = [k for k in item['main'] if triggered(item['main'][k]['p95'], item['r3'][k]['p95'])]
        summary['resamples'].append(item)
summary['remainingMeasuredTriggers'] = [r for r in summary['resamples'] if r['triggered']]
assert not summary['remainingMeasuredTriggers']
(DATA / 'comparison.json').write_text(json.dumps(summary, indent=2) + '\n')

pair = lambda x: '—' if x['p50'] is None else f"{x['p50']:.2f} / {x['p95']:.2f}"
lines = ['# Local Host Kernel R3 串行性能对照', '',
         '2026-10-03；macOS x64，Intel i7-9750H 2.60GHz，Node 24.18.0，pnpm 10.12.1。', '',
         f"main `{summary['baseCommit']}`；R3 工程提交 `{summary['candidateCodeCommit']}`。测量时所有 Agent、测试及构建已停止，两组依次 main→R3；生产源码前后摘要一致。命令、时间、退出码与源码摘要见 [外部采样目录](./) 和 [完整指标 JSON](./comparison.json)。", '',
         '实际 Desktop factory、Project/Mission/Capability/ContextStore/SQLite/Interpreter；Runtime、凭据验证与 health 使用 fixture。没有真实模型、renderer、正常 Memory/Automation 负载。下面的 Host 状态通知不等于 UI 显示，Core active-binding 释放不等于 Native 进程或 Mission lease 释放。', '',
         '## 准备耗时', '', '每场景每侧每组 20 次；单位 ms，单元格为 P50 / P95。暖调用 DSL compiler 为零，失效场景重新编译；每请求一次 pinned Revision 读取、零 head 读取的断言均通过。计数是 API 调用，不是物理 I/O。', '',
         '| 组 | 场景 | main | R3 | 触发阈值 |', '| --- | --- | --- | --- | --- |']
for record in summary['groups']:
    for r in record['scenarios']:
        lines.append(f"| {record['repeat']} | {r['scenario']} | {pair(r['main']['preparation'])} | {pair(r['r3']['preparation'])} | {'是' if 'preparation' in r['triggered'] else '否'} |")
lines += ['', '## 生命周期', '', '下表汇总每组 160 次；每场景的独立指标和阈值在 comparison.json，不能用汇总掩盖单场景异常。相同 Mission 的后续 dispatch 各 140 次；不同 Mission 的 cold 不计算下一轮。', '', '| 组 | 边界 | main | R3 | 样本数/侧 |', '| --- | --- | --- | --- | --- |']
for r in summary['groups']:
    for k in ['fixtureCompletionToCoreTerminal', 'coreTerminalToHostStatus', 'activeBindingReleaseToNextDispatch']:
        lines.append(f"| {r['repeat']} | {k} | {pair(r['aggregate']['main'][k])} | {pair(r['aggregate']['r3'][k])} | {r['aggregate']['main'][k]['samples']} / {r['aggregate']['r3'][k]['samples']} |")
lines += ['', '阈值为 R3 P95 同时比 main 增加 >10% 且 >20ms。初始触发：组 1 cold 准备 267.20→309.14ms；组 2 model-invalidation fixture 完成→Core terminal 121.21→144.83ms。两项均追加两组、每侧每场景 40 次，原异常数据保留。', '',
          'cold 组 1 的 P95 样本定位到 expert_session_open（main 样本 4 为 12.27ms，R3 样本 6 为 91.15ms），而 compile/prompt 未同步变慢；第一个样本两侧均约 1055ms，不作为 R3 特有差异。模型失效异常样本伴随 terminal 提交与 active-binding 释放延迟（样本 14：terminal commit 36.24ms、active release 120.08ms）。观测只定位到这些阶段，不能证明具体 OS/worker 抖动原因；Core/Runtime 生产源码未改。复测未再触发，未宣称消除完整产品退化风险。', '',
          '| 复测 | 场景 | 准备 main→R3 | fixture 完成→terminal main→R3 | 仍触发 |', '| --- | --- | --- | --- | --- |']
for r in summary['resamples']:
    lines.append(f"| {r['repeat']} | {r['scenario']} | {pair(r['main']['preparation'])} → {pair(r['r3']['preparation'])} | {pair(r['main']['fixtureCompletionToCoreTerminal'])} → {pair(r['r3']['fixtureCompletionToCoreTerminal'])} | {'是' if r['triggered'] else '否'} |")
lines += ['', '## SQLite 与首次准备', '', 'WAL/FULL、真实 storage worker；每项 20 次。各项提交/读取 P50/P95、锁/队列、序列化 payload、数据库增长及 macOS 进程 I/O 原始值均保留。进程 I/O 含 worker 和后台 delivery，不作单事务归因。下表为各存储 case 的 P95 范围，不替代逐项 JSON。', '', '| 组 | 指标 | main 范围 | R3 范围 | 阈值触发 |', '| --- | --- | --- | --- | --- |']
for r in summary['groups']:
    for k in ['commitLatencyMs', 'readLatencyMs']:
        a=[x['main'][k]['p95'] for x in r['storage']];b=[x['r3'][k]['p95'] for x in r['storage']]
        lines.append(f"| {r['repeat']} | {k} | {min(a):.2f}–{max(a):.2f} | {min(b):.2f}–{max(b):.2f} | {'是' if any(x['triggered'] for x in r['storage']) else '否'} |")
lines += ['', '使用真实 v12 writer fixture 扩展为四个 owner；准备耗时是单次转换，不能称为 P95。前台四-owner batch 少于 20 样本时省略分位数。', '', '| 组 | 历史量 | 转换 main→R3 (ms) | 前台读取 main→R3 (P50/P95) | 前台样本 main/R3 |', '| --- | --- | --- | --- | --- |']
for r in summary['groups']:
    for x in r['preparation']:
        a,b=x['main'],x['r3'];k='foregroundFourOwnerReadDuringPreparation'
        lines.append(f"| {r['repeat']} | {x['history']} | {a['preparationMs']:.2f} → {b['preparationMs']:.2f} | {pair(a[k])} → {pair(b[k])} | {a[k]['samples']} / {b[k]['samples']} |")
lines += ['', '转换后的 owner 读取各 20 次，逐项 P50/P95 见 JSON；存储与准备可比较分位数未触发阈值。少样本和单次转换继续作为证据限制。', '',
          '## 结论与限制', '', '两组测量、两项触发后的两组复测均完成；复测范围内没有持续触发阈值的退化。fixture 性能证据不能关闭 R1/R2 或 R3 的真实模型、OS 凭据、原生 SDK 全链路、Electron UI 与正常后台负载验收缺口。首次基线启动因缺 Runtime 构建产物失败，补建后重新开始，失败未计入样本。', '']
(DATA / 'local-host-kernel-r3-comparison.md').write_text('\n'.join(lines))
print(json.dumps({'initialTriggers': [{ 'repeat': r['repeat'], 'scenario': x['scenario'], 'metrics': x['triggered']} for r in summary['groups'] for x in r['scenarios'] if x['triggered']], 'remainingMeasuredTriggers': summary['remainingMeasuredTriggers'], 'sourceUnchanged': True}, indent=2))
