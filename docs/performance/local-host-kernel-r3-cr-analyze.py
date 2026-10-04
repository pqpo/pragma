"""Recompute R3 review performance statistics from the committed raw samples."""

import json, math, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent
DATA = ROOT / (sys.argv[1] if len(sys.argv) > 1 else 'local-host-kernel-r3-cr')

def read(name):
    return json.loads((DATA / name).read_text())

def stats(v):
    v = sorted(v)
    return {'samples': len(v), 'p50': v[math.ceil(len(v) * 0.5) - 1] if len(v) >= 20 else None, 'p95': v[math.ceil(len(v) * 0.95) - 1] if len(v) >= 20 else None}

def trigger(a, b):
    return a is not None and b is not None and (b > a * 1.1) and (b - a > 20)

def metrics(ops, group):
    values = {k: [] for k in ('preparation', 'fixtureCompletionToCoreTerminal', 'coreTerminalToHostStatus', 'activeBindingReleaseToNextDispatch')}
    previous = {}
    for o in ops:
        marks = {m['event']: m['atMs'] for m in o['lifecycleMarkers']}
        if o['group'] == group:
            values['preparation'].append(o['preparationMs'])
            for k, a, b in [('fixtureCompletionToCoreTerminal', 'fixture.model_completed', 'execution.terminal_committed'), ('coreTerminalToHostStatus', 'execution.terminal_committed', 'fixture.mission_status_published')]:
                if a in marks and b in marks:
                    values[k].append(marks[b] - marks[a])
            start = previous.get(o['missionId'], {}).get('session.active_binding_released')
            end = marks.get('fixture.dispatch')
            if start is not None and end is not None and (end >= start):
                values['activeBindingReleaseToNextDispatch'].append(end - start)
        previous[o['missionId']] = marks
    return {k: stats(v) for k, v in values.items()}
summary = {'sourceIdentity': {}, 'groups': [], 'resamples': [], 'threshold': 'candidate P95 > main P95 * 1.1 AND difference >20ms'}
for side in ('main', 'r3'):
    a, b = (read(f'{side}-source-before.json'), read(f'{side}-source-after.json'))
    assert a['sha256'] == b['sha256']
    summary['sourceIdentity'][side] = {'before': a, 'after': b, 'unchanged': True}
for repeat in (1, 2):
    docs = {s: read(f'{s}-compile-{repeat}.json') for s in ('main', 'r3')}
    for d in docs.values():
        assert d['completeProbePassed'] and d['sourceUnchanged'] and (not d['errors'])
    record = {'repeat': repeat, 'scenarios': [], 'storage': [], 'preparation': []}
    for group in dict.fromkeys((o['group'] for o in docs['main']['operations'])):
        item = {'scenario': group, **{s: metrics(d['operations'], group) for s, d in docs.items()}}
        item['triggered'] = [k for k in item['main'] if trigger(item['main'][k]['p95'], item['r3'][k]['p95'])]
        record['scenarios'].append(item)
    for kind, keys in [('storage', ['commitLatencyMs', 'readLatencyMs']), ('preparation', ['foregroundFourOwnerReadDuringPreparation', 'convertedOwnerRead'])]:
        sides = {s: read(f'{s}-{kind}-{repeat}.json')['results'] for s in ('main', 'r3')}
        for a, b in zip(sides['main'], sides['r3']):
            assert a['history'] == b['history']
            if kind == 'storage':
                assert a['canonicalDelivery'] == b['canonicalDelivery'] and a['owners'] == b['owners']
            record[kind].append({'history': a['history'], 'main': a, 'r3': b, 'triggered': [k for k in keys if trigger(a[k]['p95'], b[k]['p95'])]})
    summary['groups'].append(record)
for path in sorted(DATA.glob('main-*-resample-*.json')):
    label = path.name.removeprefix('main-')
    a, b = (read(path.name), read('r3-' + label))
    for d in (a, b):
        assert d['completeProbePassed'] and d['sourceUnchanged'] and (not d['errors'])
    scenario = label.rsplit('-resample-', 1)[0]
    assert scenario in {o['group'] for o in a['operations']}
    item = {'label': label, 'scenario': scenario, 'main': metrics(a['operations'], scenario), 'r3': metrics(b['operations'], scenario)}
    item['triggered'] = [k for k in item['main'] if trigger(item['main'][k]['p95'], item['r3'][k]['p95'])]
    summary['resamples'].append(item)
summary['initialTriggers'] = [{'repeat': r['repeat'], 'scenario': x['scenario'], 'metrics': x['triggered']} for r in summary['groups'] for x in r['scenarios'] if x['triggered']]
summary['storageTriggers'] = [{'repeat': r['repeat'], 'kind': kind, 'history': x['history'], 'metrics': x['triggered']} for r in summary['groups'] for kind in ('storage', 'preparation') for x in r[kind] if x['triggered']]
summary['persistentResampleTriggers'] = []
for scenario in sorted({r['scenario'] for r in summary['resamples']}):
    records = [r for r in summary['resamples'] if r['scenario'] == scenario]
    assert len(records) == 2
    persistent = sorted(set(records[0]['triggered']) & set(records[1]['triggered']))
    if persistent:
        summary['persistentResampleTriggers'].append({'scenario': scenario, 'metrics': persistent})
(DATA / 'comparison.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({k: summary[k] for k in ('initialTriggers', 'storageTriggers', 'persistentResampleTriggers')}, indent=2))
