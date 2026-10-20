import importlib.util
from pathlib import Path
import os
import tempfile
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

    def test_purge_preserves_login_databases_and_other_accounts(self):
        self.sparse(self.media / "old", 100)
        log = self.sparse(self.account / "qq/nt_qq/global/nt_data/Log/old.log", 100)
        protected = [
            self.sparse(self.account / "qq/nt_qq/global/nt_data/Login/session", 100),
            self.sparse(self.media.parent.parent / "nt_db/nt_msg.db", 100),
            self.sparse(self.account / "config-full/onebot11.json", 100),
            self.sparse(self.root / "second/qq/NapCat/temp/media", 100),
        ]
        self.assertEqual(cache.maintain(self.account, apply=True, purge=True)["afterBytes"], 0)
        self.assertFalse(log.exists())
        self.assertTrue(all(file.exists() for file in protected))

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
                file.write_bytes(b"modified")
                os.utime(file, ns=(original.st_atime_ns, original.st_mtime_ns))
            return files

        with patch.object(cache, "cache_files", side_effect=scan_then_modify):
            with self.assertRaises(RuntimeError):
                cache.maintain(self.account, apply=True, purge=True)
        self.assertEqual(file.read_bytes(), b"modified")


if __name__ == "__main__":
    unittest.main()
