import importlib.util
from pathlib import Path
import os
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "cache_maintenance", Path(__file__).resolve().parents[2] / "deploy/napcat/cache-maintenance.py"
)
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


class CacheMaintenanceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.account = self.root / "primary"
        self.media = self.account / "qq" / ("nt_qq_" + "a" * 32) / "nt_data" / "Pic"
        self.media.mkdir(parents=True)

    def tearDown(self):
        self.temporary.cleanup()

    def sparse(self, path, size, mtime=1):
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as stream:
            stream.truncate(size)
        os.utime(path, (mtime, mtime))
        return path

    def test_threshold_dry_run_and_oldest_first(self):
        old = self.sparse(self.media / "old", 128 * 1024 ** 2)
        recent = self.sparse(self.media / "recent", cache.LIMIT, 2)
        self.assertEqual(cache.maintain(self.account)["plannedAfterBytes"], cache.LIMIT)
        self.assertTrue(old.exists())
        result = cache.maintain(self.account, apply=True)
        self.assertEqual(result["afterBytes"], cache.LIMIT)
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())
        self.assertEqual(cache.maintain(self.account, apply=True)["files"], 0)

    def test_new_global_cache_obeys_threshold(self):
        global_root = self.account / "qq/global"
        old = self.sparse(global_root / "nt_data/Log/old.log", 128 * 1024 ** 2)
        recent = self.sparse(global_root / "nt_temp/recent", cache.LIMIT, 2)
        preview = cache.maintain(self.account)
        self.assertEqual(preview["beforeBytes"], cache.LIMIT + 128 * 1024 ** 2)
        self.assertEqual(preview["plannedAfterBytes"], cache.LIMIT)
        self.assertTrue(old.exists())
        self.assertTrue(recent.exists())
        result = cache.maintain(self.account, apply=True)
        self.assertEqual(result["afterBytes"], cache.LIMIT)
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())

    def test_old_and_new_global_share_account_limit(self):
        size = 512 * 1024 ** 2
        old = self.sparse(self.account / "qq/nt_qq/global/nt_data/Emoji/old", size)
        recent = self.sparse(self.account / "qq/global/nt_data/Skin/recent", size, 2)
        media = self.sparse(self.media / "recent", 128 * 1024 ** 2, 3)
        result = cache.maintain(self.account, apply=True)
        self.assertEqual(result["beforeBytes"], cache.LIMIT + 128 * 1024 ** 2)
        self.assertEqual(result["afterBytes"], size + 128 * 1024 ** 2)
        self.assertEqual(result["files"], 1)
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())
        self.assertTrue(media.exists())

    def test_purge_preserves_login_databases_and_other_accounts(self):
        self.sparse(self.media / "old", 100)
        disposable = []
        protected = [
            self.sparse(self.media.parent.parent / "nt_db/nt_msg.db", 100),
            self.sparse(self.account / "config-full/onebot11.json", 100),
            self.sparse(self.root / "second/qq/NapCat/temp/media", 100),
        ]
        for global_root in (self.account / "qq/nt_qq/global", self.account / "qq/global"):
            for directory in ("nt_data/Log", "nt_data/Emoji", "nt_data/Skin", "nt_temp"):
                disposable.append(self.sparse(global_root / directory / "old", 100))
            for relative in ("nt_data/Login/session", "nt_data/Config/device", "nt_db/nt_msg.db", "machine-id"):
                file = self.sparse(global_root / relative, 100)
                file.write_bytes(("synthetic:" + relative).encode())
                protected.append(file)
        original = {file: file.read_bytes() for file in protected}
        self.assertEqual(cache.maintain(self.account, apply=True, purge=True)["afterBytes"], 0)
        self.assertTrue(all(not file.exists() for file in disposable))
        self.assertEqual({file: file.read_bytes() for file in protected}, original)

    def test_symbolic_links_do_not_delete_targets(self):
        outside = self.sparse(self.root / "outside/keep", 100)
        (self.media / "linked-file").symlink_to(outside)
        (self.media / "linked-dir").symlink_to(outside.parent, target_is_directory=True)
        cache.maintain(self.account, apply=True, purge=True)
        self.assertTrue(outside.exists())
        (self.account / "qq/NapCat").mkdir()
        (self.account / "qq/NapCat/temp").symlink_to(outside.parent, target_is_directory=True)
        with self.assertRaises(ValueError):
            cache.maintain(self.account, apply=True)
        self.assertTrue(outside.exists())

    def test_scan_permission_errors_are_reported(self):
        self.sparse(self.media / "blocked/file", 10)
        (self.media / "blocked").chmod(0)
        try:
            with self.assertRaises(PermissionError):
                cache.maintain(self.account, apply=True)
        finally:
            (self.media / "blocked").chmod(0o700)

    def test_modified_same_size_and_restored_mtime_is_retained(self):
        file = self.media / "changing"
        file.write_bytes(b"original")
        original = file.stat()
        scan = cache.cache_files
        first = True

        def scan_then_modify(account):
            nonlocal first
            files = scan(account)
            if first:
                first = False
                time.sleep(0.02)
                file.write_bytes(b"modified")
                os.utime(file, ns=(original.st_atime_ns, original.st_mtime_ns))
            return files

        with patch.object(cache, "cache_files", side_effect=scan_then_modify):
            with self.assertRaises(RuntimeError):
                cache.maintain(self.account, apply=True, purge=True)
        self.assertEqual(file.read_bytes(), b"modified")


if __name__ == "__main__":
    unittest.main()
