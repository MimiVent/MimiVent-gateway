import importlib.util
import unittest
from datetime import datetime, timezone
from pathlib import Path


SOURCE = Path(__file__).with_name("time_health_provider.py")
SPEC = importlib.util.spec_from_file_location("time_health_provider", SOURCE)
provider = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(provider)


class ChronyHealthTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 7, 12, 0, 5, tzinfo=timezone.utc)
        self.tracking = """\
Stratum : 3
Ref time (UTC) : Sat Nov  7 12:00:00 2026
System time : 0.000000100 seconds fast of NTP time
RMS offset : 0.000000200 seconds
Leap status : Normal
"""

    def test_recent_synced_sample_is_healthy(self):
        healthy, age_ms, accuracy_ms = provider.parse_chrony_tracking(self.tracking, self.now)
        self.assertTrue(healthy)
        self.assertEqual(age_ms, 5000)
        self.assertAlmostEqual(accuracy_ms, 0.0002)

    def test_unsynchronized_and_stale_samples_fail_closed(self):
        unhealthy = self.tracking.replace("Leap status : Normal", "Leap status : Not synchronised")
        self.assertFalse(provider.parse_chrony_tracking(unhealthy, self.now)[0])
        old = self.tracking.replace("Sat Nov  7 12:00:00 2026", "Sat Nov  7 03:59:59 2026")
        self.assertFalse(provider.parse_chrony_tracking(old, self.now)[0])

    def test_large_offset_fails_closed(self):
        inaccurate = self.tracking.replace("0.000000100 seconds", "1.500000000 seconds")
        self.assertFalse(provider.parse_chrony_tracking(inaccurate, self.now)[0])


class SystemdTimesyncdHealthTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 7, 12, 0, 0, tzinfo=timezone.utc)
        self.status = """\
Server: ntp.tencent.com (106.55.184.199)
Leap: normal
Stratum: 2
Root distance: 33.690ms (max: 5s)
Offset: +5.997ms
Jitter: 10.095ms
"""

    def test_recent_synchronized_sample_reports_conservative_accuracy(self):
        healthy, age_ms, accuracy_ms = provider.parse_systemd_timesync_status(
            self.status, self.now,
            datetime(2026, 11, 7, 11, 55, 0, tzinfo=timezone.utc),
        )
        self.assertTrue(healthy)
        self.assertEqual(age_ms, 300000)
        self.assertAlmostEqual(accuracy_ms, 49.782)

    def test_missing_sync_or_stale_marker_fails_closed(self):
        stale = datetime(2026, 11, 7, 5, 59, 59, tzinfo=timezone.utc)
        self.assertFalse(provider.parse_systemd_timesync_status(self.status, self.now, stale)[0])
        self.assertFalse(provider.parse_systemd_timesync_status(
            self.status, self.now, self.now, service_active=False)[0])
        self.assertFalse(provider.parse_systemd_timesync_status(
            self.status, self.now, self.now, synchronized=False)[0])

    def test_bad_leap_stratum_accuracy_or_missing_fields_fails_closed(self):
        self.assertFalse(provider.parse_systemd_timesync_status(
            self.status.replace('Leap: normal', 'Leap: unsynchronised'),
            self.now, self.now)[0])
        self.assertFalse(provider.parse_systemd_timesync_status(
            self.status.replace('Stratum: 2', 'Stratum: 16'),
            self.now, self.now)[0])
        self.assertFalse(provider.parse_systemd_timesync_status(
            self.status.replace('Offset: +5.997ms', 'Offset: +1.5s'),
            self.now, self.now)[0])
        self.assertFalse(provider.parse_systemd_timesync_status(
            self.status.replace('Jitter: 10.095ms\n', ''),
            self.now, self.now)[0])


if __name__ == "__main__":
    unittest.main()
