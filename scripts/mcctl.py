#!/usr/bin/env python3
"""Small CLI for the minecraft-ai-operator actuator API."""
import argparse, json, os, sys, urllib.request, urllib.error

DEFAULT_CONFIG = os.environ.get('MC_AI_CONFIG', '/root/.config/minecraft-ai/config.json')

def config(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)

def request(cfg, method, endpoint, payload=None):
    host = cfg.get('apiHost', '127.0.0.1')
    port = int(cfg.get('apiPort', 8765))
    data = None if payload is None else json.dumps(payload).encode()
    headers = {'Content-Type': 'application/json'}
    if cfg.get('apiToken'):
        headers['Authorization'] = 'Bearer ' + cfg['apiToken']
    req = urllib.request.Request(f'http://{host}:{port}{endpoint}', data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try: return json.load(e)
        except Exception: return {'ok': False, 'error': e.read().decode('utf-8', 'replace')}
    except Exception as e:
        return {'ok': False, 'error': str(e)}

def parse_json(text):
    try: return json.loads(text)
    except json.JSONDecodeError as e:
        raise SystemExit(f'Invalid JSON: {e}')

def main():
    p = argparse.ArgumentParser(description='Observe and control the Mineflayer AI actuator')
    p.add_argument('--config', default=DEFAULT_CONFIG)
    sub = p.add_subparsers(dest='cmd', required=True)
    o = sub.add_parser('observe'); o.add_argument('--entity-radius', type=int, default=16); o.add_argument('--block-radius', type=int, default=5); o.add_argument('--no-blocks', action='store_true')
    a = sub.add_parser('act'); a.add_argument('type'); a.add_argument('args', nargs='?', default='{}', help='JSON object')
    r = sub.add_parser('raw'); r.add_argument('json', help='complete action JSON')
    ns = p.parse_args(); cfg = config(ns.config)
    if ns.cmd == 'observe':
        # GET uses server defaults; use observe action when non-default options matter.
        payload = {'type':'observe','args':{'entityRadius':ns.entity_radius,'blockRadius':ns.block_radius,'blocks':not ns.no_blocks}}
        out = request(cfg, 'POST', '/act', payload)
    elif ns.cmd == 'act': out = request(cfg, 'POST', '/act', {'type':ns.type,'args':parse_json(ns.args)})
    else: out = request(cfg, 'POST', '/act', parse_json(ns.json))
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if out.get('ok') else 1

if __name__ == '__main__': sys.exit(main())
