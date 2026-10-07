#!/usr/bin/env python3
"""Собирает /etc/finnik-stage.env из боевого файла: копирует все строки и подменяет пять значений.
Значения берутся из переменных окружения (не из аргументов, чтобы секреты не попадали в список процессов):
STAGE_PORT, STAGE_DATABASE_URL, STAGE_BOT_TOKEN, STAGE_JWT_SECRET, STAGE_APP_BASE_URL.
Использование: make_stage_env.py <боевой_env> <выходной_env>
"""
import os
import sys

OVERRIDES = {
    'PORT': 'STAGE_PORT',
    'DATABASE_URL': 'STAGE_DATABASE_URL',
    'TELEGRAM_BOT_TOKEN': 'STAGE_BOT_TOKEN',
    'JWT_SECRET': 'STAGE_JWT_SECRET',
    'APP_BASE_URL': 'STAGE_APP_BASE_URL',
}


def build(prod_text, env):
    values = {}
    for key, var in OVERRIDES.items():
        v = env.get(var, '')
        if not v or '\n' in v or '\r' in v:
            raise SystemExit(f'не задана переменная {var}')
        values[key] = v
    kept = []
    for line in prod_text.splitlines():
        name = line.split('=', 1)[0].strip()
        if name in OVERRIDES:
            continue
        kept.append(line)
    kept.append('')
    kept.append('# --- тестовая среда: значения ниже подменены ---')
    kept.extend(f'{k}={v}' for k, v in values.items())
    return '\n'.join(kept) + '\n'


def main():
    if len(sys.argv) != 3:
        raise SystemExit('usage: make_stage_env.py <prod_env> <out_env>')
    with open(sys.argv[1], encoding='utf-8') as f:
        text = f.read()
    out = build(text, os.environ)
    fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(out)
    os.chmod(sys.argv[2], 0o600)


if __name__ == '__main__':
    main()
