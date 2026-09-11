"""Tests for the per-home travel-time table format (data/build_tables.py).

The decoder here is written from the spec, not from ``build_tables``: it uses
plain ``struct``/``int.from_bytes`` so that a change to the writer's constants
cannot silently agree with itself. If these tests and ``web/src/table.ts``
disagree, the spec in ``build_tables.__doc__`` decides.

Run with ``uv run pytest`` (no r5py needed — the r5py imports in
``build_tables`` are all inside functions).
"""

from __future__ import annotations

import datetime as dt
import gzip
import struct

import numpy as np
import pytest

import build_tables as bt

HEADER_SIZE = 32


def decode(blob: bytes) -> tuple[dict, np.ndarray]:
    """Independent reader: header dict plus minutes[dayType][hour][stopIdx]."""
    magic = blob[0:4]
    version, day_types, hour_start, hour_count = struct.unpack_from("<BBBB", blob, 4)
    stop_count = int.from_bytes(blob[8:12], "little")
    home_id = int.from_bytes(blob[12:16], "little")
    build_id = blob[16:32].rstrip(b"\0").decode("ascii")
    header = {
        "magic": magic,
        "version": version,
        "dayTypes": day_types,
        "hourStart": hour_start,
        "hourCount": hour_count,
        "stopCount": stop_count,
        "homeId": home_id,
        "buildId": build_id,
    }
    expected = HEADER_SIZE + 2 * day_types * hour_count * stop_count
    assert len(blob) == expected, f"body length {len(blob)} != {expected}"
    minutes = np.frombuffer(blob, dtype="<u2", offset=HEADER_SIZE).reshape(
        day_types, hour_count, stop_count
    )
    return header, minutes


def synthetic(stop_count: int = 5) -> np.ndarray:
    """minutes[d][h][i] = d*1000 + h*10 + i, with one unreachable cell."""
    minutes = np.fromfunction(
        lambda d, h, i: d * 1000 + h * 10 + i,
        (bt.DAY_TYPES, bt.HOUR_COUNT, stop_count),
        dtype=np.int64,
    ).astype(np.uint16)
    if stop_count > 4:
        minutes[2, 3, 4] = bt.UNREACHABLE
    return minutes


def test_header_fields_match_the_spec():
    header, _ = decode(bt.encode_table(8507000, "2026-09-11-4b9110db", synthetic()))
    assert header == {
        "magic": b"XSBT",
        "version": 1,
        "dayTypes": 3,
        "hourStart": 6,
        "hourCount": 16,
        "stopCount": 5,
        "homeId": 8507000,
        # 19-character meta.json ids are truncated to the 16-byte field.
        "buildId": "2026-09-11-4b911",
    }


def test_short_build_id_is_nul_padded_not_space_padded():
    blob = bt.encode_table(8503000, "abc", synthetic(1))
    assert blob[16:32] == b"abc" + b"\0" * 13
    assert decode(blob)[0]["buildId"] == "abc"


def test_round_trip_preserves_every_cell_and_the_index_order():
    minutes = synthetic(stop_count=7)
    _, decoded = decode(bt.encode_table(8505000, "buildid", minutes))
    assert np.array_equal(decoded, minutes)
    # dayType is the slowest axis, stopIdx the fastest.
    assert decoded[1, 2, 3] == 1 * 1000 + 2 * 10 + 3
    flat = np.frombuffer(bt.encode_table(8505000, "buildid", minutes), dtype="<u2", offset=HEADER_SIZE)
    assert flat[(1 * bt.HOUR_COUNT + 2) * 7 + 3] == decoded[1, 2, 3]


def test_unreachable_survives_as_65535():
    _, decoded = decode(bt.encode_table(1, "b", synthetic()))
    assert decoded[2, 3, 4] == 65535
    assert (decoded == 65535).sum() == 1


def test_wrong_shape_is_rejected():
    with pytest.raises(ValueError, match="expected shape"):
        bt.encode_table(1, "b", np.zeros((bt.DAY_TYPES, bt.HOUR_COUNT - 1, 4), dtype=np.uint16))


def test_nan_becomes_unreachable_and_long_trips_are_clamped():
    minutes = bt.minutes_from_travel_times(np.array([[0.0, 12.4, 12.6, np.nan, 70000.0]]))
    assert minutes.tolist() == [[0, 12, 13, bt.UNREACHABLE, bt.MAX_MINUTES]]


def test_missing_checkpoints_are_written_as_unreachable(tmp_path):
    """A tiered run (one day type, a few hours) still yields a usable table."""
    stop_count, home_id, day_type, hour = 4, 8509000, 1, 9
    values = np.array([11, 22, bt.UNREACHABLE, 44], dtype=np.uint16)
    bt.save_checkpoint(
        bt.checkpoint_path(tmp_path, home_id, day_type), {hour: values}, dt.date(2026, 10, 3)
    )

    assert bt.write_tables(tmp_path / "out", tmp_path, [home_id], "bid", stop_count) == 1
    blob = gzip.decompress((tmp_path / "out" / f"{home_id}.bin.gz").read_bytes())
    header, minutes = decode(blob)

    assert header["homeId"] == home_id
    assert np.array_equal(minutes[day_type, hour - bt.HOUR_START], values)
    assert (minutes == bt.UNREACHABLE).sum() == bt.DAY_TYPES * bt.HOUR_COUNT * stop_count - 3


def test_checkpoints_merge_hour_by_hour(tmp_path):
    path = bt.checkpoint_path(tmp_path, 8503000, 0)
    bt.save_checkpoint(path, {6: np.array([1, 2], dtype=np.uint16)}, dt.date(2026, 10, 5))
    merged = bt.load_checkpoint(path, 2)
    merged[7] = np.array([3, 4], dtype=np.uint16)
    bt.save_checkpoint(path, merged, dt.date(2026, 10, 5))

    assert bt.checkpoint_hours(path) == {6, 7}
    assert bt.load_checkpoint(path, 2)[7].tolist() == [3, 4]
    # A checkpoint built against a different stop list must not be reused.
    assert bt.load_checkpoint(path, 3) == {}


def test_the_plain_copy_is_written_only_with_also_plain(tmp_path):
    """table.ts fetches the .gz; the .bin is the DecompressionStream fallback."""
    home_id = 8503000
    bt.save_checkpoint(
        bt.checkpoint_path(tmp_path, home_id, 0),
        {6: np.array([7, 8], dtype=np.uint16)},
        dt.date(2026, 10, 5),
    )
    out = tmp_path / "out"

    bt.write_tables(out, tmp_path, [home_id], "bid", 2)
    assert not (out / f"{home_id}.bin").exists()

    bt.write_tables(out, tmp_path, [home_id], "bid", 2, also_plain=True)
    assert (out / f"{home_id}.bin").read_bytes() == gzip.decompress(
        (out / f"{home_id}.bin.gz").read_bytes()
    )

    # A plain copy from an earlier run is removed, never served stale.
    bt.write_tables(out, tmp_path, [home_id], "bid", 2)
    assert not (out / f"{home_id}.bin").exists()


def test_hour_spec_is_parsed_and_clamped_to_the_header_range():
    assert bt.parse_hours("6-21") == list(range(6, 22))
    assert bt.parse_hours("9,12, 15") == [9, 12, 15]
    assert bt.parse_hours("0-8") == [6, 7, 8]
    with pytest.raises(ValueError):
        bt.parse_hours("0-5")


def test_representative_dates_are_the_right_weekdays_and_avoid_holidays():
    # 2026-08-01 (Swiss National Day) is a Saturday; the Saturday sample must
    # step over it. Easter 2026 is 2026-04-05.
    dates = bt.pick_dates(dt.date(2026, 1, 1), dt.date(2026, 12, 12), dt.date(2026, 7, 20), [0, 1, 2])
    assert [d.weekday() for d in (dates[0], dates[1], dates[2])] == [0, 5, 6]
    assert all(d >= dt.date(2026, 7, 27) for d in dates.values())
    assert dates[1] != dt.date(2026, 8, 1)
    assert bt.easter(2026) == dt.date(2026, 4, 5)
    assert dt.date(2026, 8, 1) in bt.ch_holidays(2026)
