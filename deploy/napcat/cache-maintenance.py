#!/usr/bin/env python3
"""Maintain each NapCat account's disposable QQ cache."""
import argparse
import json
import os
from pathlib import Path
import re
import stat

LIMIT = 1024 ** 3
MEDIA = ("Pic", "Video", "Ptt", "File", "log", "log-cache", "Emoji", "avatar")


def scan_error(error):
    raise error


def cache_roots(account):
    qq = account / "qq"
    roots = [qq / "NapCat" / name for name in ("data", "temp")]
    for global_root in (qq / "nt_qq" / "global", qq / "global"):
        roots.extend(global_root / "nt_data" / name for name in ("Log", "Emoji", "Skin"))
        roots.append(global_root / "nt_temp")
    if qq.is_dir() and not qq.is_symlink():
        for profile in qq.iterdir():
            if re.fullmatch(r"nt_qq_[a-f0-9]{32}", profile.name):
                roots.extend(profile / "nt_data" / name for name in MEDIA)
                roots.append(profile / "nt_temp")
    return roots


def cache_files(account):
    files = []
    for root in cache_roots(account):
        if not root.exists():
            continue
        if root.resolve() != root or not root.is_dir():
            raise ValueError("Cache directory is not a plain directory: " + str(root))
        for directory, dirs, names in os.walk(root, followlinks=False, onerror=scan_error):
            dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink()]
            for name in names:
                file = Path(directory) / name
                info = file.lstat()
                if stat.S_ISREG(info.st_mode):
                    files.append((file, info))
    return files


def maintain(account, apply=False, purge=False):
    if account.resolve() != account or not account.is_dir():
        raise ValueError("Account directory is not a plain directory: " + str(account))
    files = cache_files(account)
    total = sum(info.st_size for _, info in files)
    remaining = total
    removed = 0
    changed = 0
    target = 0 if purge else LIMIT
    if total > target:
        for file, original in sorted(files, key=lambda item: (item[1].st_mtime_ns, str(item[0]))):
            if remaining <= target:
                break
            if apply:
                if file.resolve() != file:
                    raise ValueError("Cache path changed: " + str(file))
                try:
                    current = file.lstat()
                except FileNotFoundError:
                    remaining -= original.st_size
                    continue
                identity = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                if not stat.S_ISREG(current.st_mode) or identity(current) != identity(original):
                    changed += 1
                    continue
                file.unlink()
            remaining -= original.st_size
            removed += 1
    after = sum(info.st_size for _, info in cache_files(account)) if apply else total
    result = {
        "account": account.name, "limitBytes": LIMIT, "beforeBytes": total,
        "afterBytes": after, "plannedAfterBytes": remaining, "files": removed,
        "changedFiles": changed, "applied": apply,
    }
    print(json.dumps(result), flush=True)
    if apply and after > target:
        raise RuntimeError("Cache remains above target for account " + account.name)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--accounts-root", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--purge-cache", action="store_true")
    args = parser.parse_args()
    root = args.accounts_root.absolute()
    if root.resolve() != root or not root.is_dir():
        raise ValueError("Accounts root is not a plain directory")
    for account in sorted(root.iterdir()):
        if re.fullmatch(r"[A-Za-z0-9_-]+", account.name) and account.is_dir():
            maintain(account, args.apply, args.purge_cache)


if __name__ == "__main__":
    main()
